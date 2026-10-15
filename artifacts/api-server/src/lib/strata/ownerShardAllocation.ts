import { randomUUID } from "node:crypto";
import { dedicatedSignerFingerprint } from "./commissioning";
import { normalizeKalshiMoney } from "./kalshiUserRead";
import { getScopedKalshiJson, postScopedKalshiShardAllocation } from "../kalshiAccountClient";

/**
 * Primary subaccount 0, shard 0 -> primary subaccount 0, shard 2.
 * This is strictly separate from the existing 0->1 bot subaccount transfer.
 * Every owner has one immutable transfer ID; an unknown result is never POSTed again.
 */
export const SHARD_ALLOCATION_CONFIRMATION = "ALLOCATE_25_USD_PRIMARY_EXCHANGE_0_TO_PRIMARY_EXCHANGE_2";
const AMOUNT = 2500;
const BALANCE = "/trade-api/v2/portfolio/balance";
const TRANSFER_DETAIL = "/trade-api/v2/portfolio/intra_exchange_instance_transfers/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
type Query = { query(text: string, params?: unknown[]): Promise<{ rows: Row[] }> };
type Pool = Query & { connect?: () => Promise<Query & { release(): void }> };
type Creds = { keyId: string; privateKey: string };
type Read = (creds: Creds, path: string, query: string) => Promise<unknown>;
type Write = (creds: Creds, uuid: string) => Promise<{ status: number; body: unknown; unreadable: boolean }>;
export type ShardAllocationView = {
  ok: boolean; reason: string;
  state: "unavailable" | "prepared" | "attempted" | "uncertain" | "completed";
  attemptId: string | null; amountCents: 2500; sourceCents: number | null;
  destinationCents: number | null; botCents: number | null; exchangeTransferId: string | null;
  transferAttempted: boolean;
};
function view(reason: string, state: ShardAllocationView["state"]="unavailable",
  attemptId: string|null=null, sourceCents: number|null=null,
  destinationCents: number|null=null, botCents: number|null=null,
  exchangeTransferId: string|null=null, transferAttempted=false): ShardAllocationView {
  return { ok: reason==="shard_prepared" || reason==="shard_completed", reason, state,
    attemptId, amountCents: AMOUNT, sourceCents, destinationCents, botCents,
    exchangeTransferId, transferAttempted };
}
const ACCOUNT_SQL = `
 -- shard-allocation:owner
 SELECT a.id,a.owner_user_id::text,a.kalshi_connection_id::text AS financial_account_id,
   pc.id::text AS connection_id,c.id::text AS credential_id,c.key_fingerprint,
   a.subaccount,a.exchange_index,a.kill_switch,a.execution_enabled,a.commissioned,
   a.reserved_micros::text,a.cash_micros::text,
   (SELECT count(*)::int FROM v13_production_position p WHERE p.account_id=a.id AND p.quantity_hundredths>0) AS positions,
   (SELECT count(*)::int FROM v13_production_intent i WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED')) AS intents,
   (SELECT count(*)::int FROM private.kalshi_account_worker_lease l WHERE l.execution_account_id=a.id AND l.state='owned') AS workers,
   g.manual_kill_switch,g.live_execution_enabled,s.decrypted_secret
 FROM v13_production_account a
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id
   AND c.financial_account_id=fa.id AND c.provider_connection_id=pc.id
   AND c.role='account_setup_execution' AND c.revoked_at IS NULL
   AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
 CROSS JOIN live_execution_config g
 WHERE a.owner_user_id=$1::uuid AND g.id='singleton'
`;
const STATUS_SQL = `
 -- shard-allocation:status
 SELECT t.id::text,t.state,t.source_before_cents,t.destination_before_cents,
   t.bot_before_cents,t.source_after_cents,t.destination_after_cents,t.bot_after_cents,
   t.exchange_transfer_id
 FROM private.kalshi_owner_shard_allocations t
 JOIN v13_production_account a ON a.id=t.execution_account_id AND a.owner_user_id=t.owner_user_id
 WHERE t.owner_user_id=$1::uuid ORDER BY t.prepared_at DESC LIMIT 1
`;
const PREPARE_SQL = `
 -- shard-allocation:prepare
 INSERT INTO private.kalshi_owner_shard_allocations
  (id,owner_user_id,execution_account_id,financial_account_id,
   provider_connection_id,authority_credential_id,authority_fingerprint,
   source_before_cents,destination_before_cents,bot_before_cents)
 VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,0,0)
 ON CONFLICT (execution_account_id) DO UPDATE
   SET source_before_cents=EXCLUDED.source_before_cents,
       prepared_at=now(),updated_at=now()
   WHERE private.kalshi_owner_shard_allocations.state='prepared'
     AND private.kalshi_owner_shard_allocations.owner_user_id=EXCLUDED.owner_user_id
     AND private.kalshi_owner_shard_allocations.authority_credential_id=EXCLUDED.authority_credential_id
     AND private.kalshi_owner_shard_allocations.authority_fingerprint=EXCLUDED.authority_fingerprint
 RETURNING id::text AS id
`;
const ATTEMPT_SQL = `
 -- shard-allocation:attempt
 SELECT t.id::text,t.state,t.execution_account_id,t.authority_credential_id::text,
   t.authority_fingerprint,t.source_before_cents,t.destination_before_cents,
   t.bot_before_cents,(extract(epoch FROM t.prepared_at)*1000)::bigint AS prepared_ms,
   t.exchange_transfer_id
 FROM private.kalshi_owner_shard_allocations t
 WHERE t.owner_user_id=$1::uuid AND t.id=$2::uuid
`;
const CLAIM_SQL = `
 -- shard-allocation:claim-once
 UPDATE private.kalshi_owner_shard_allocations t
 SET state='attempted',attempted_at=now(),updated_at=now()
 WHERE t.id=$1::uuid AND t.owner_user_id=$2::uuid AND t.state='prepared'
 AND t.prepared_at>now()-interval '5 minutes'
 AND t.authority_credential_id=$3::uuid AND t.authority_fingerprint=$4
 AND EXISTS (SELECT 1 FROM v13_production_account a
   JOIN live_execution_config g ON g.id='singleton'
   WHERE a.id=t.execution_account_id AND a.owner_user_id=$2::uuid
   AND a.subaccount=1 AND a.exchange_index=2
   AND a.commissioned=false AND a.execution_enabled=false AND a.kill_switch=true
   AND a.reserved_micros=0 AND g.manual_kill_switch=true AND g.live_execution_enabled=false
   AND NOT EXISTS (SELECT 1 FROM v13_production_position p WHERE p.account_id=a.id AND p.quantity_hundredths>0)
   AND NOT EXISTS (SELECT 1 FROM v13_production_intent i WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED'))
   AND NOT EXISTS (SELECT 1 FROM private.kalshi_account_worker_lease l WHERE l.execution_account_id=a.id AND l.state='owned')
 )
 RETURNING id::text AS id
`;
const OUTCOME_SQL = `
 -- shard-allocation:outcome
 UPDATE private.kalshi_owner_shard_allocations
 SET state='uncertain',exchange_transfer_id=$3,failure_reason=$4,updated_at=now()
 WHERE owner_user_id=$1::uuid AND id=$2::uuid AND state='attempted'
 RETURNING id
`;
const COMPLETE_SQL = `
 -- shard-allocation:complete-verified
 UPDATE private.kalshi_owner_shard_allocations
 SET state='completed',completed_at=now(),verified_at=now(),
   source_after_cents=$3,destination_after_cents=$4,bot_after_cents=$5,
   failure_reason=NULL,updated_at=now()
 WHERE owner_user_id=$1::uuid AND id=$2::uuid AND state IN ('uncertain','attempted')
 RETURNING id
`;

function parseKey(row:Row):Creds|null {
  if (typeof row.decrypted_secret !== "string" || typeof row.key_fingerprint !== "string") return null;
  try {
    const x = JSON.parse(row.decrypted_secret) as Record<string,unknown>;
    if (typeof x?.api_key_id !== "string" || typeof x?.private_key !== "string") return null;
    return dedicatedSignerFingerprint(x.api_key_id,x.private_key)===row.key_fingerprint
      ? {keyId:x.api_key_id,privateKey:x.private_key}:null;
  } catch { return null; }
}
function ownerSafe(row:Row):boolean {
  return Number(row.subaccount)===1 && Number(row.exchange_index)===2
    && row.kill_switch===true && row.execution_enabled===false
    && row.commissioned===false && row.manual_kill_switch===true
    && row.live_execution_enabled===false && row.reserved_micros==="0"
    && Number(row.positions)===0 && Number(row.intents)===0 && Number(row.workers)===0;
}
async function owner(db: Query, uid: string):Promise<{row:Row;creds:Creds}|null> {
  try {
    const x=await db.query(ACCOUNT_SQL,[uid]);
    if(x.rows.length!==1 || !ownerSafe(x.rows[0]!))return null;
    const creds=parseKey(x.rows[0]!);
    return creds?{row:x.rows[0]!,creds}:null;
  }catch{return null;}
}
/** Read only a fixed signed account/shard; unknown or mismatched identity fails closed. */
function money(value:unknown, shard:0|2, sub:0|1):number|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const root=value as Row;
  const x=root.balance && typeof root.balance==="object" && !Array.isArray(root.balance)
    ? root.balance as Row:root;
  if(x.subaccount!==undefined&&Number(x.subaccount)!==sub)return null;
  if(x.subaccount_number!==undefined&&Number(x.subaccount_number)!==sub)return null;
  if(x.exchange_index!==undefined&&Number(x.exchange_index)!==shard)return null;
  const cash=normalizeKalshiMoney(x).cashCents;
  return cash!==null && Number.isSafeInteger(cash) && cash>=0?cash:null;
}
type Balances={source:number;destination:number;bot:number};
async function balances(creds:Creds,get:Read):Promise<Balances|null>{
  try{
    const [a,b,c]=await Promise.all([
      get(creds,BALANCE,"?subaccount=0&exchange_index=0"),
      get(creds,BALANCE,"?subaccount=0&exchange_index=2"),
      get(creds,BALANCE,"?subaccount=1&exchange_index=2"),
    ]);
    const source=money(a,0,0),destination=money(b,2,0),bot=money(c,2,1);
    return source===null||destination===null||bot===null?null:{source,destination,bot};
  }catch{return null;}
}
const defaultRead: Read=(c,p,q)=>getScopedKalshiJson(c,p,q);
const defaultPost: Write=(c,id)=>postScopedKalshiShardAllocation(c,id);
const prepared=(v:Balances,id:string)=>view("shard_prepared","prepared",id,v.source,v.destination,v.bot);

/** Signed reads + DB record only. No Kalshi POST. */
export async function prepareOwnerShardAllocation(db:Pool,uid:string,
  opts:{read?:Read}={}):Promise<ShardAllocationView>{
  const bound=await owner(db,uid);
  if(!bound)return view("owner_shard_authority_or_safety_unproven");
  const v=await balances(bound.creds,opts.read??defaultRead);
  if(!v)return view("shard_cash_unproven");
  if(v.source<AMOUNT)return view("shard0_primary_cash_insufficient","unavailable",null,v.source,v.destination,v.bot);
  if(v.destination!==0||v.bot!==0)return view("destination_shard_not_empty","unavailable",null,v.source,v.destination,v.bot);
  if(!db.connect)return view("shard_transaction_unavailable");
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const still=await client.query(ACCOUNT_SQL,[uid]);
    if(still.rows.length!==1||!ownerSafe(still.rows[0]!)||
      still.rows[0]!.credential_id!==bound.row.credential_id||
      still.rows[0]!.key_fingerprint!==bound.row.key_fingerprint){
      await client.query("ROLLBACK");
      return view("shard_preflight_changed");
    }
    const id=randomUUID();
    const result=await client.query(PREPARE_SQL,[id,uid,bound.row.id,bound.row.financial_account_id,
      bound.row.connection_id,bound.row.credential_id,bound.row.key_fingerprint,v.source]);
    await client.query("COMMIT");
    if(result.rows.length===1)return prepared(v,String(result.rows[0]!.id));
    const status=await ownerShardAllocationStatus(db,uid);
    return status.state==="prepared" ? status : view("shard_previous_attempt_requires_reconciliation",
      "uncertain",status.attemptId,v.source,v.destination,v.bot,status.exchangeTransferId);
  }catch{
    try{await client.query("ROLLBACK");}catch{/* closed */}
    return view("shard_preparation_failed");
  }finally{client.release();}
}

/** Status is persisted, not a claim that cash moved. */
export async function ownerShardAllocationStatus(db:Query,uid:string):Promise<ShardAllocationView>{
  try{
    const x=await db.query(STATUS_SQL,[uid]);
    if(x.rows.length!==1)return view("shard_no_plan");
    const v=x.rows[0]!,state=v.state;
    if(state!=="prepared"&&state!=="attempted"&&state!=="uncertain"&&state!=="completed")
      return view("shard_status_unproven");
    const after=state==="completed";
    const parse=(x:unknown)=>x!==null&&x!==undefined&&Number.isSafeInteger(Number(x))?Number(x):null;
    return view(after?"shard_completed":state==="prepared"?"shard_prepared":"shard_reconciliation_required",
      state,String(v.id),parse(after?v.source_after_cents:v.source_before_cents),
      parse(after?v.destination_after_cents:v.destination_before_cents),
      parse(after?v.bot_after_cents:v.bot_before_cents),
      typeof v.exchange_transfer_id==="string"?v.exchange_transfer_id:null,
      state!=="prepared");
  }catch{return view("shard_status_unavailable");}
}

/**
 * Explicit execution requires TWO independent decisions:
 * (1) owner clicks a separate, persisted-ID-specific confirmation, and
 * (2) ops enables this dedicated deployment flag AFTER reviewing the launch.
 * Neither deployment nor migration enables a transfer.
 */
export async function executeOwnerShardAllocation(db:Pool,uid:string,input:{
  attemptId:unknown;confirmation:unknown
},opts:{read?:Read;post?:Write;enableTestPost?:boolean}={}):Promise<ShardAllocationView>{
  if(input.confirmation!==SHARD_ALLOCATION_CONFIRMATION||
    typeof input.attemptId!=="string"||!UUID.test(input.attemptId))
      return view("explicit_shard_allocation_consent_required");
  if(!opts.enableTestPost && (process.env.STRATA_ENABLE_SHARD_ALLOCATION_POST!=="true" ||
     process.env.KALSHI_API_ENVIRONMENT!=="production"))
    return view("shard_execution_not_enabled");
  const bound=await owner(db,uid);
  if(!bound)return view("owner_shard_authority_or_safety_unproven");
  const x=await db.query(ATTEMPT_SQL,[uid,input.attemptId]);
  const plan=x.rows[0];
  if(x.rows.length!==1||plan?.state!=="prepared")return view("shard_already_attempted_or_missing","uncertain",input.attemptId);
  if(plan.execution_account_id!==bound.row.id||plan.authority_credential_id!==bound.row.credential_id||
    plan.authority_fingerprint!==bound.row.key_fingerprint||
    Date.now()-Number(plan.prepared_ms)>300000)
    return view("shard_plan_expired_or_changed","prepared",input.attemptId);
  const before=await balances(bound.creds,opts.read??defaultRead);
  if(!before||before.source!==Number(plan.source_before_cents)||before.destination!==0||before.bot!==0)
    return view("shard_balance_changed","prepared",input.attemptId,
      before?.source??null,before?.destination??null,before?.bot??null);
  if(!db.connect)return view("shard_transaction_unavailable");
  const client=await db.connect();let claimed=false;
  try{
    await client.query("BEGIN");
    const v=await client.query(CLAIM_SQL,[input.attemptId,uid,bound.row.credential_id,bound.row.key_fingerprint]);
    await client.query("COMMIT");
    claimed=v.rows.length===1;
  }catch{try{await client.query("ROLLBACK");}catch{/* closed */}}
  finally{client.release();}
  if(!claimed)return view("shard_attempt_claim_unproven","uncertain",input.attemptId);
  // The claim is COMMITTED before any exchange call. Never retry on HTTP error or timeout.
  let externalId:string|null=null,reason="shard_exchange_response_uncertain";
  try{
    const x=await (opts.post??defaultPost)(bound.creds,input.attemptId);
    if(x.status===200&&!x.unreadable && x.body &&
       typeof x.body==="object"&&!Array.isArray(x.body)){
      const id=(x.body as Row).transfer_id;
      if(typeof id==="string" && /^[a-zA-Z0-9_-]{8,128}$/.test(id)){
        externalId=id;reason="shard_accepted_pending_reconciliation";
      }
    }
  }catch{/* response uncertain; do not repeat */}
  try{
    const update=await db.query(OUTCOME_SQL,[uid,input.attemptId,externalId,reason]);
    if(update.rows.length!==1)return view("shard_outcome_persistence_uncertain","uncertain",input.attemptId,
      null,null,null,externalId,true);
  }catch{return view("shard_outcome_persistence_uncertain","uncertain",input.attemptId,
    null,null,null,externalId,true);}
  return view(reason,"uncertain",input.attemptId,null,null,null,externalId,true);
}
/** Read-only reconciliation: authenticated receipt AND exact before/after cash. */
export async function reconcileOwnerShardAllocation(db:Pool,uid:string,
  opts:{read?:Read}={}):Promise<ShardAllocationView>{
  const bound=await owner(db,uid);
  if(!bound)return view("owner_shard_authority_or_safety_unproven");
  const x=await db.query(STATUS_SQL,[uid]);const plan=x.rows[0];
  if(x.rows.length!==1)return view("shard_no_plan");
  if(plan?.state==="completed")return ownerShardAllocationStatus(db,uid);
  if((plan?.state!=="uncertain"&&plan?.state!=="attempted")||
    typeof plan.exchange_transfer_id!=="string"||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(plan.exchange_transfer_id))
    return view("shard_reconciliation_manual_review_required","uncertain",String(plan?.id??""));
  try{
    const get=opts.read??defaultRead;
    const raw=await get(bound.creds,TRANSFER_DETAIL+encodeURIComponent(plan.exchange_transfer_id),"");
    const x=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:null;
    const t=x && x.transfer && typeof x.transfer==="object"&&!Array.isArray(x.transfer)
      ? x.transfer as Row:null;
    if(!t||t.transfer_id!==plan.exchange_transfer_id||t.status!=="completed"||
      t.source!=="event_contract"||t.destination!=="event_contract"||
      Number(t.source_exchange_shard)!==0||Number(t.destination_exchange_shard)!==2||
      // Authenticated transfer receipt uses a 4-decimal dollar string.
      t.amount!=="25.0000")return view("shard_exchange_receipt_not_complete","uncertain",String(plan.id),
      null,null,null,plan.exchange_transfer_id,true);
    const v=await balances(bound.creds,get);
    if(!v||v.source!==Number(plan.source_before_cents)-AMOUNT ||
      v.destination!==AMOUNT||v.bot!==0)
      return view("shard_balance_reconciliation_pending","uncertain",String(plan.id),
        v?.source??null,v?.destination??null,v?.bot??null,plan.exchange_transfer_id,true);
    const wrote=await db.query(COMPLETE_SQL,[uid,plan.id,v.source,v.destination,v.bot]);
    if(wrote.rows.length!==1)return view("shard_reconciliation_write_unproven","uncertain",String(plan.id),
      v.source,v.destination,v.bot,plan.exchange_transfer_id,true);
    return view("shard_completed","completed",String(plan.id),v.source,v.destination,v.bot,
      plan.exchange_transfer_id,true);
  }catch{return view("shard_receipt_unavailable","uncertain",String(plan.id),
    null,null,null,plan.exchange_transfer_id,true);}
}
