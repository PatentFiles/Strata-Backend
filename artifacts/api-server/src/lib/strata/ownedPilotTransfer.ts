import { randomUUID } from "node:crypto";
import { dedicatedSignerFingerprint } from "./commissioning";
import { normalizeKalshiMoney } from "./kalshiUserRead";
import { getScopedKalshiJson, postScopedKalshiPilotTransfer } from "../kalshiAccountClient";

/**
 * First-production pilot only: PRIMARY (0) -> bot Subaccount 1 on shard 2.
 * A durable DB row commits BEFORE the exchange POST. Any ambiguous outcome
 * becomes UNCERTAIN and cannot be sent again, even across worker restarts.
 * This endpoint never commissions or enables trading.
 */
const PILOT_CENTS = 2500;
const BALANCE = "/trade-api/v2/portfolio/balance";
const TRANSFERS = "/trade-api/v2/portfolio/subaccounts/transfers";
export const OWNER_PILOT_TRANSFER_CONFIRMATION = "TRANSFER_25_USD_PRIMARY_TO_BOT_SUBACCOUNT_1_INDEX_2";
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
type Row = Record<string, unknown>;
type Query = { query(text: string, params?: unknown[]): Promise<{rows: Row[]; rowCount?: number|null}> };
type TxDb = Query & { connect?: () => Promise<Query & { release():void }> };
type Creds = { keyId:string; privateKey:string };
type Get = (creds:Creds,path:string,query:string)=>Promise<unknown>;
type Post = (creds:Creds,clientTransferId:string)=>Promise<{ status:number; body:unknown; unreadable:boolean }>;
export type PilotResult = {
  ok:boolean; reason:string; state:"unavailable"|"prepared"|"attempted"|"uncertain"|"completed";
  attemptId:string|null; amountCents:2500; primaryCents:number|null; botCents:number|null;
  transferAttempted:boolean;
};
const readOnly = (reason:string,state:PilotResult["state"]="unavailable",attemptId:string|null=null,
  primaryCents:number|null=null,botCents:number|null=null,transferAttempted=false):PilotResult =>
  ({ok:reason==="pilot_prepared"||reason==="pilot_completed",reason,state,attemptId,
    amountCents:PILOT_CENTS,primaryCents,botCents,transferAttempted});

const ACCOUNT_SQL = `
 -- pilot-transfer:owner-read
 SELECT a.id, a.owner_user_id::text AS owner_user_id,
        a.kalshi_connection_id::text AS financial_account_id,pc.id::text AS connection_id,
        a.subaccount,a.exchange_index,a.kill_switch,a.execution_enabled,a.commissioned,
        a.cash_precision_verified,a.cash_micros::text AS cash_micros,
        a.reserved_micros::text AS reserved_micros,
        (SELECT count(*)::int FROM v13_production_position x WHERE x.account_id=a.id
          AND x.quantity_hundredths > 0) AS open_positions,
        (SELECT count(*)::int FROM v13_production_intent x WHERE x.account_id=a.id
          AND x.state NOT IN ('TERMINAL','BLOCKED')) AS unresolved_orders,
        (SELECT count(*)::int FROM private.kalshi_account_worker_lease x
          WHERE x.execution_account_id=a.id AND x.state='owned') AS active_workers,
        gate.manual_kill_switch, gate.live_execution_enabled,
        c.id::text AS credential_id,c.key_fingerprint,
        s.decrypted_secret
 FROM v13_production_account a
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id
   AND c.financial_account_id=fa.id AND c.provider_connection_id=pc.id
   AND c.role='account_setup_execution' AND c.revoked_at IS NULL
   AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
 CROSS JOIN live_execution_config gate
 WHERE a.owner_user_id=$1::uuid AND a.owner_user_id IS NOT NULL
   AND gate.id='singleton'
`;
const RECONCILE_READ_SQL = `
 -- pilot-transfer:reconcile-read
 SELECT t.id::text AS id,t.owner_user_id::text AS owner_user_id,
        t.execution_account_id,t.authority_credential_id::text AS authority_credential_id,
        t.authority_fingerprint,t.state,t.primary_before_cents,t.bot_before_cents,
        (extract(epoch FROM t.attempted_at))::bigint AS attempted_seconds
 FROM private.kalshi_owner_pilot_transfers t
 JOIN v13_production_account a ON a.id=t.execution_account_id
 WHERE t.owner_user_id=$1::uuid AND a.owner_user_id=$1::uuid
 ORDER BY t.prepared_at DESC LIMIT 1
`;
const RECONCILE_COMPLETE_SQL = `
 -- pilot-transfer:reconcile-complete
 UPDATE private.kalshi_owner_pilot_transfers
 SET state='completed', completed_at=now(),
     primary_after_cents=$3,bot_after_cents=$4,
     failure_reason=NULL,verified_exchange_transfer_id=$5,verified_at=now(),
     updated_at=now()
 WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state IN ('attempted','uncertain')
   AND primary_before_cents=$3+2500 AND bot_before_cents=0
   AND verified_exchange_transfer_id IS NULL
 RETURNING id
`;
const STATUS_SQL = `
 -- pilot-transfer:status
 SELECT t.id::text AS id,t.state,t.primary_after_cents,t.bot_after_cents,
        t.primary_before_cents,t.bot_before_cents
 FROM private.kalshi_owner_pilot_transfers t
 JOIN v13_production_account a ON a.id=t.execution_account_id
 WHERE t.owner_user_id=$1::uuid AND a.owner_user_id=$1::uuid
 ORDER BY t.prepared_at DESC LIMIT 1
`;
const PREPARE_SQL = `
 -- pilot-transfer:prepare
 INSERT INTO private.kalshi_owner_pilot_transfers
  (id,owner_user_id,execution_account_id,financial_account_id,provider_connection_id,
   authority_credential_id,authority_fingerprint,primary_before_cents,bot_before_cents)
 VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,0)
 ON CONFLICT (execution_account_id) DO UPDATE
 SET primary_before_cents=EXCLUDED.primary_before_cents,
     authority_credential_id=EXCLUDED.authority_credential_id,
     authority_fingerprint=EXCLUDED.authority_fingerprint,
     prepared_at=now(),updated_at=now()
 WHERE private.kalshi_owner_pilot_transfers.state='prepared'
   AND private.kalshi_owner_pilot_transfers.owner_user_id=EXCLUDED.owner_user_id
 RETURNING id::text AS id
`;
const READ_ATTEMPT_SQL = `
 -- pilot-transfer:read-attempt
 SELECT id::text AS id,owner_user_id::text AS owner_user_id,execution_account_id,
        authority_credential_id::text AS authority_credential_id,authority_fingerprint,
        state,primary_before_cents,bot_before_cents,
        (extract(epoch FROM prepared_at)*1000)::bigint AS prepared_ms
 FROM private.kalshi_owner_pilot_transfers WHERE owner_user_id=$1::uuid AND id=$2::uuid
`;
const CLAIM_SQL = `
 -- pilot-transfer:claim-once
 UPDATE private.kalshi_owner_pilot_transfers
 SET state='attempted',attempted_at=now(),updated_at=now()
 WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='prepared'
 AND prepared_at >= now()-interval '5 minutes'
 AND authority_credential_id=$3::uuid AND authority_fingerprint=$4
 AND EXISTS (
   SELECT 1 FROM v13_production_account a
   JOIN live_execution_config g ON g.id='singleton'
   WHERE a.id=execution_account_id AND a.owner_user_id=$2::uuid
     AND a.subaccount=1 AND a.exchange_index=2
     AND a.commissioned=false AND a.execution_enabled=false
     AND a.kill_switch=true AND g.manual_kill_switch=true
     AND g.live_execution_enabled=false AND a.reserved_micros=0
     AND NOT EXISTS(SELECT 1 FROM v13_production_position p
       WHERE p.account_id=a.id AND p.quantity_hundredths>0)
     AND NOT EXISTS(SELECT 1 FROM v13_production_intent i
       WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED'))
     AND NOT EXISTS(SELECT 1 FROM private.kalshi_account_worker_lease l
       WHERE l.execution_account_id=a.id AND l.state='owned')
 )
 RETURNING id::text AS id
`;
const RESOLVE_SQL = `
 -- pilot-transfer:resolve
 UPDATE private.kalshi_owner_pilot_transfers
 SET state=$3, completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END,
  failure_reason=$4, primary_after_cents=$5,bot_after_cents=$6,updated_at=now()
 WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='attempted'
 RETURNING id
`;

function validOwner(row:Row):boolean {
  return Number(row.subaccount)===1 && Number(row.exchange_index)===2 &&
    row.kill_switch===true && row.execution_enabled===false &&
    row.commissioned===false && row.manual_kill_switch===true &&
    row.live_execution_enabled===false && row.reserved_micros==="0" &&
    Number(row.open_positions)===0 && Number(row.unresolved_orders)===0 &&
    Number(row.active_workers)===0;
}
function credentials(row:Row):Creds|null {
  if(typeof row.decrypted_secret!=="string" || typeof row.key_fingerprint!=="string")return null;
  try {
    const body:unknown=JSON.parse(row.decrypted_secret);
    if(!body||typeof body!=="object"||Array.isArray(body))return null;
    const v=body as Record<string,unknown>;
    if(typeof v.api_key_id!=="string"||typeof v.private_key!=="string")return null;
    const creds={keyId:v.api_key_id,privateKey:v.private_key};
    return dedicatedSignerFingerprint(creds.keyId,creds.privateKey)===row.key_fingerprint?creds:null;
  }catch{return null;}
}
function scopedMoney(value:unknown,subaccount:0|1):number|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const root=value as Record<string,unknown>;
  const nested=root.balance;
  const row=nested&&typeof nested==="object"&&!Array.isArray(nested)
    ? nested as Record<string,unknown>:root;
  if(row.subaccount!==undefined&&Number(row.subaccount)!==subaccount)return null;
  if(row.subaccount_number!==undefined&&Number(row.subaccount_number)!==subaccount)return null;
  if(row.exchange_index!==undefined&&Number(row.exchange_index)!==2)return null;
  // Legacy cash is integer cents; fixed-point balance_dollars is exact.
  const cents=normalizeKalshiMoney(row).cashCents;
  return cents!==null&&Number.isSafeInteger(cents)&&cents>=0?cents:null;
}
async function scopedBalances(creds:Creds,get:Get):Promise<{primary:number;bot:number}|null>{
  try{
    const [primary,bot]=await Promise.all([
      get(creds,BALANCE,"?subaccount=0&exchange_index=2"),
      get(creds,BALANCE,"?subaccount=1&exchange_index=2"),
    ]);
    const a=scopedMoney(primary,0), b=scopedMoney(bot,1);
    return a===null||b===null?null:{primary:a,bot:b};
  }catch{return null;}
}
async function boundOwner(db:Query,userId:string):Promise<{row:Row;creds:Creds}|null>{
  try{
    const result=await db.query(ACCOUNT_SQL,[userId]);
    if(result.rows.length!==1||!validOwner(result.rows[0]!))return null;
    const creds=credentials(result.rows[0]!);
    return creds?{row:result.rows[0]!,creds}:null;
  }catch{return null;}
}
const defaultGet:Get=(creds,path,query)=>getScopedKalshiJson(creds,path,query);
const defaultPost:Post=(creds,id)=>postScopedKalshiPilotTransfer(creds,id);

/** Signed PREVIEW + immutable one-shot intent. This never calls POST on Kalshi. */
export async function prepareOwnedPilotTransfer(db:TxDb,userId:string,options:{get?:Get}={}):Promise<PilotResult>{
  const bound=await boundOwner(db,userId);
  if(!bound)return readOnly("owner_transfer_authority_or_safety_unproven");
  const balances=await scopedBalances(bound.creds,options.get??defaultGet);
  if(!balances)return readOnly("index2_cash_unproven");
  if(balances.primary<PILOT_CENTS)return readOnly("index2_primary_cash_insufficient","unavailable",null,balances.primary,balances.bot);
  if(balances.bot!==0)return readOnly("bot_subaccount_not_empty","unavailable",null,balances.primary,balances.bot);
  // Transactions must be available: no autocommit imitation for financial state.
  if(typeof db.connect!=="function")return readOnly("transfer_transaction_unavailable");
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const again=await client.query(ACCOUNT_SQL,[userId]);
    if(again.rows.length!==1||!validOwner(again.rows[0]!)||
      again.rows[0]!.credential_id!==bound.row.credential_id||
      again.rows[0]!.key_fingerprint!==bound.row.key_fingerprint){
      await client.query("ROLLBACK");return readOnly("transfer_preflight_changed");
    }
    const attemptId=randomUUID();
    const inserted=await client.query(PREPARE_SQL,[attemptId,userId,bound.row.id,
      bound.row.financial_account_id,bound.row.connection_id,bound.row.credential_id,
      bound.row.key_fingerprint,balances.primary]);
    await client.query("COMMIT");
    if(inserted.rows.length!==1){
      const existing=await db.query(STATUS_SQL,[userId]);
      const row=existing.rows[0];
      if(row?.state==="prepared")return readOnly("existing_transfer_prepared","prepared",String(row.id),balances.primary,balances.bot);
      return readOnly("existing_transfer_requires_reconciliation",
        row?.state==="completed"?"completed":"uncertain",typeof row?.id==="string"?row.id:null,balances.primary,balances.bot);
    }
    return readOnly("pilot_prepared","prepared",String(inserted.rows[0]?.id),balances.primary,balances.bot);
  }catch{
    try{await client.query("ROLLBACK");}catch{/* fail closed */}
    return readOnly("transfer_preparation_failed");
  }finally{client.release();}
}

/** No network POST unless owner confirms the persisted UUID *separately*. */
export async function executeOwnedPilotTransfer(db:TxDb,userId:string,input:{
  attemptId:unknown;confirmation:unknown;
},options:{get?:Get;post?:Post;allowTestTransport?:boolean}={}):Promise<PilotResult>{
  if(input.confirmation!==OWNER_PILOT_TRANSFER_CONFIRMATION ||
    typeof input.attemptId!=="string"||!UUID.test(input.attemptId))
    return readOnly("explicit_transfer_consent_required");
  const attemptId=input.attemptId;
  if(!options.allowTestTransport&&process.env.KALSHI_API_ENVIRONMENT!=="production")
    return readOnly("production_kalshi_environment_required");
  const bound=await boundOwner(db,userId);
  if(!bound)return readOnly("owner_transfer_authority_or_safety_unproven");
  const found=await db.query(READ_ATTEMPT_SQL,[userId,attemptId]);
  const plan=found.rows[0];
  if(found.rows.length!==1||plan?.state!=="prepared")
    return readOnly("transfer_already_attempted_or_not_found","uncertain",attemptId);
  if(plan.authority_credential_id!==bound.row.credential_id ||
    plan.authority_fingerprint!==bound.row.key_fingerprint ||
    plan.execution_account_id!==bound.row.id ||
    Date.now()-Number(plan.prepared_ms)>300_000)
    return readOnly("transfer_plan_expired_or_changed","prepared",attemptId);
  const get=options.get??defaultGet;
  const balances=await scopedBalances(bound.creds,get);
  if(!balances||balances.bot!==0||balances.primary!==Number(plan.primary_before_cents))
    return readOnly("transfer_preflight_balance_changed","prepared",attemptId,
      balances?.primary??null,balances?.bot??null);
  if(typeof db.connect!=="function")return readOnly("transfer_transaction_unavailable");
  // Commit the once-only claim before contacting the exchange.
  const client=await db.connect();let claimed=false;
  try{
    await client.query("BEGIN");
    const x=await client.query(CLAIM_SQL,[attemptId,userId,bound.row.credential_id,bound.row.key_fingerprint]);
    const matched=x.rows.length===1;
    await client.query("COMMIT");
    // Never issue a financial POST if the durable claim's COMMIT failed
    // or its outcome is unknown: the persisted idempotency fence must exist.
    claimed=matched;
  }catch{
    try{await client.query("ROLLBACK");}catch{/* fail closed */}
  }finally{client.release();}
  if(!claimed)return readOnly("transfer_already_attempted_or_expired","uncertain",attemptId);
  let reason="transfer_response_uncertain",state:PilotResult["state"]="uncertain";
  let after:{primary:number;bot:number}|null=null;
  try{
    const response=await (options.post??defaultPost)(bound.creds,attemptId);
    const empty=response.body===null||response.body===undefined||
      (typeof response.body==="object"&&!Array.isArray(response.body)&&
        Object.keys(response.body as Record<string,unknown>).length===0);
    if(response.status===200&&!response.unreadable&&empty){
      after=await scopedBalances(bound.creds,get);
      if(after&&after.primary===balances.primary-PILOT_CENTS&&after.bot===PILOT_CENTS){
        reason="pilot_completed";state="completed";
      }else reason="transfer_balance_reconciliation_pending";
    }else reason="transfer_response_uncertain";
  }catch{/* never send again */}
  try{
    const written=await db.query(RESOLVE_SQL,[attemptId,userId,state,reason,
      after?.primary??null,after?.bot??null]);
    if(written.rows.length!==1)return readOnly("transfer_outcome_persistence_uncertain","uncertain",attemptId,
      after?.primary??null,after?.bot??null,true);
  }catch{return readOnly("transfer_outcome_persistence_uncertain","uncertain",attemptId,
    after?.primary??null,after?.bot??null,true);}
  return readOnly(reason,state,attemptId,after?.primary??null,after?.bot??null,true);
}
/**
 * Non-money-moving reconciliation. Kalshi's subaccount-transfer POST can
 * return 200 before its shard-scoped balance read catches up. Never retry it.
 * Require BOTH a unique eligible transfer-history receipt and exact scoped
 * after-balances; a balance alone is not proof of this particular transfer.
 *
 * No live orders, credentials, strategies, approvals, or kill switches change.
 */
export async function reconcileOwnedPilotTransfer(
  db:Query,userId:string,options:{get?:Get}={}
):Promise<PilotResult>{
  const found=await db.query(RECONCILE_READ_SQL,[userId]).catch(()=>null);
  if(!found||found.rows.length!==1)return readOnly("pilot_reconciliation_record_unavailable");
  const plan=found.rows[0]!;
  const id=String(plan.id??"");
  if(!UUID.test(id))return readOnly("pilot_reconciliation_record_invalid");
  if(plan.state==="completed")return ownedPilotTransferStatus(db,userId);
  if(plan.state!=="attempted"&&plan.state!=="uncertain")
    return readOnly("pilot_transfer_not_submitted",plan.state==="prepared"?"prepared":"unavailable",id);
  const bound=await boundOwner(db,userId);
  if(!bound||String(bound.row.id)!==String(plan.execution_account_id)||
     String(bound.row.credential_id)!==String(plan.authority_credential_id)||
     bound.row.key_fingerprint!==plan.authority_fingerprint)
    return readOnly("pilot_reconciliation_owner_or_safety_unproven","uncertain",id);
  const pre=Number(plan.primary_before_cents), attempted=Number(plan.attempted_seconds);
  if(!Number.isSafeInteger(pre)||pre<2500||!Number.isSafeInteger(attempted)||attempted<=0||
     Number(plan.bot_before_cents)!==0)
    return readOnly("pilot_reconciliation_baseline_invalid","uncertain",id);
  const get=options.get??defaultGet;
  const balances=await scopedBalances(bound.creds,get);
  if(!balances)return readOnly("pilot_reconciliation_cash_unavailable","uncertain",id);
  if(balances.primary!==pre-2500||balances.bot!==2500)
    return readOnly("pilot_reconciliation_cash_not_settled","uncertain",id,
      balances.primary,balances.bot,true);

  // Kalshi records contain transfer_id, amount_cents, origin, destination,
  // exchange_index and created_ts. Paginate fully within a strict bounded
  // scan; incomplete pagination or ambiguous duplicates cannot prove history.
  const seenIds=new Set<string>();
  const matches:{id:string;clientId:string|null}[]=[];
  const visited=new Set<string>();
  let cursor="";
  let exhausted=false;
  for(let page=0;page<5;page++){
    let payload:unknown;
    try{
      payload=await get(bound.creds,TRANSFERS,
        `?limit=100${cursor?"&cursor="+encodeURIComponent(cursor):""}`);
    }catch{return readOnly("pilot_reconciliation_history_unavailable","uncertain",id,
      balances.primary,balances.bot,true);}
    if(!payload||typeof payload!=="object"||Array.isArray(payload))
      return readOnly("pilot_reconciliation_history_invalid","uncertain",id,balances.primary,balances.bot,true);
    const obj=payload as Record<string,unknown>;
    if(!Array.isArray(obj.transfers))
      return readOnly("pilot_reconciliation_history_invalid","uncertain",id,balances.primary,balances.bot,true);
    for(const record of obj.transfers){
      if(!record||typeof record!=="object"||Array.isArray(record))
        return readOnly("pilot_reconciliation_history_invalid","uncertain",id,balances.primary,balances.bot,true);
      const row=record as Record<string,unknown>;
      const receipt=row.transfer_id;
      if(typeof receipt!=="string"||receipt.length<8||receipt.length>128||seenIds.has(receipt))
        return readOnly("pilot_reconciliation_history_invalid","uncertain",id,balances.primary,balances.bot,true);
      seenIds.add(receipt);
      // Refuse missing exchange-index, invalid timestamp or approximate money.
      if(row.from_subaccount!==0||row.to_subaccount!==1||
         row.exchange_index!==2||row.amount_cents!==2500)continue;
      const ts=Number(row.created_ts);
      if(!Number.isSafeInteger(ts)||ts<attempted-120||ts>attempted+300)continue;
      const client=row.client_transfer_id;
      if(client!==undefined&&client!==null&&client!==id)continue;
      matches.push({id:receipt,clientId:typeof client==="string"?client:null});
    }
    const next=obj.cursor;
    if(next===undefined||next===null||next===""){exhausted=true;break;}
    if(typeof next!=="string"||next.length>1024||visited.has(next))
      return readOnly("pilot_reconciliation_history_invalid","uncertain",id,balances.primary,balances.bot,true);
    visited.add(next);cursor=next;
  }
  if(!exhausted)return readOnly("pilot_reconciliation_history_incomplete","uncertain",id,balances.primary,balances.bot,true);
  if(matches.length!==1)return readOnly(
    matches.length?"pilot_reconciliation_history_ambiguous":"pilot_reconciliation_receipt_missing",
    "uncertain",id,balances.primary,balances.bot,true);
  // Kalshi history does not always expose client_transfer_id. A unique
  // timestamped receipt PLUS exact scoped cash movement is required.
  try{
    const saved=await db.query(RECONCILE_COMPLETE_SQL,
      [id,userId,balances.primary,balances.bot,matches[0]!.id]);
    if(saved.rows.length!==1)return readOnly("pilot_reconciliation_persistence_unverified",
      "uncertain",id,balances.primary,balances.bot,true);
  }catch{return readOnly("pilot_reconciliation_persistence_unverified",
    "uncertain",id,balances.primary,balances.bot,true);}
  return readOnly("pilot_completed","completed",id,balances.primary,balances.bot,true);
}


export type HistoricalFundingResult = {
  ok: boolean; reason: string; historicalVerified: boolean;
  historicalVerifiedAt: string | null; botCents: number | null;
  transferAttempted: false;
};
const HISTORY_STATUS_SQL = `
 -- historical-funding:status
 SELECT h.verified_at::text AS verified_at FROM private.kalshi_owner_historical_funding h
 JOIN v13_production_account a ON a.id=h.execution_account_id
 WHERE a.owner_user_id=$1::uuid AND h.owner_user_id=$1::uuid
   AND a.subaccount=1 AND a.exchange_index=2
 ORDER BY h.verified_at DESC LIMIT 1
`;
const HISTORY_SAVE_SQL = `
 -- historical-funding:record
 INSERT INTO private.kalshi_owner_historical_funding
   (owner_user_id,execution_account_id,exchange_transfer_id,transfer_created_at,
    primary_after_cents,bot_after_cents,verified_at)
 VALUES ($1::uuid,$2,$3,to_timestamp($4::bigint),$5,$6,now())
 ON CONFLICT (execution_account_id) DO UPDATE
   SET exchange_transfer_id=EXCLUDED.exchange_transfer_id,
       transfer_created_at=EXCLUDED.transfer_created_at,
       primary_after_cents=EXCLUDED.primary_after_cents,
       bot_after_cents=EXCLUDED.bot_after_cents,
       verified_at=now()
 WHERE private.kalshi_owner_historical_funding.owner_user_id=EXCLUDED.owner_user_id
   AND private.kalshi_owner_historical_funding.transfer_created_at <= EXCLUDED.transfer_created_at
 RETURNING verified_at::text AS verified_at
`;
export async function historicalFundingStatus(db:Query,userId:string):Promise<HistoricalFundingResult>{
  try {
    const result=await db.query(HISTORY_STATUS_SQL,[userId]);
    const verified=result.rows.length===1&&typeof result.rows[0]!.verified_at==="string";
    return {ok:verified,reason:verified?"historical_funding_verified":"historical_funding_unverified",
      historicalVerified:verified,historicalVerifiedAt:verified?String(result.rows[0]!.verified_at):null,
      botCents:null,transferAttempted:false};
  }catch{
    return {ok:false,reason:"historical_funding_status_unavailable",
      historicalVerified:false,historicalVerifiedAt:null,botCents:null,transferAttempted:false};
  }
}
/**
 * Record a verified EXISTING transfer independently from the newly introduced
 * transfer-intent ledgers. Signed GETs only. Never creates/retroactively
 * completes a new transfer attempt; never approves or enables execution.
 */
export async function verifyOwnedHistoricalFunding(
  db:Query,userId:string,options:{get?:Get;nowSeconds?:()=>number}={}
):Promise<HistoricalFundingResult>{
  const refusal=(reason:string,botCents:number|null=null):HistoricalFundingResult=>
    ({ok:false,reason,historicalVerified:false,historicalVerifiedAt:null,botCents,transferAttempted:false});
  const bound=await boundOwner(db,userId);
  if(!bound)return refusal("historical_owner_or_safety_unproven");
  const read=options.get??defaultGet;
  const balances=await scopedBalances(bound.creds,read);
  if(!balances)return refusal("historical_cash_unavailable");
  // This pilot has exactly $25 in bot subaccount 1 on exchange shard 2.
  if(balances.primary!==0||balances.bot!==PILOT_CENTS)
    return refusal("historical_cash_pair_mismatch",balances.bot);
  const seen=new Set<string>();
  const rows:Array<{id:string;time:number;from:number;to:number;amount:number;index:number}>=[];
  const visited=new Set<string>();let cursor="";let exhausted=false;
  for(let page=0;page<5;page++){
    let payload:unknown;
    try{payload=await read(bound.creds,TRANSFERS,
      `?limit=100${cursor?"&cursor="+encodeURIComponent(cursor):""}`);}
    catch{return refusal("historical_transfer_history_unavailable",balances.bot);}
    if(!payload||typeof payload!=="object"||Array.isArray(payload))
      return refusal("historical_transfer_history_invalid",balances.bot);
    const data=payload as Record<string,unknown>;
    if(!Array.isArray(data.transfers))return refusal("historical_transfer_history_invalid",balances.bot);
    for(const raw of data.transfers){
      if(!raw||typeof raw!=="object"||Array.isArray(raw))
        return refusal("historical_transfer_history_invalid",balances.bot);
      const row=raw as Record<string,unknown>;
      const id=row.transfer_id;
      const time=row.created_ts;
      const from=row.from_subaccount,to=row.to_subaccount;
      const amount=row.amount_cents,index=row.exchange_index;
      if(typeof id!=="string"||id.length<8||id.length>128||seen.has(id)||
        !Number.isSafeInteger(time)||Number(time)<=0||
        !Number.isSafeInteger(from)||!Number.isSafeInteger(to)||
        !Number.isSafeInteger(amount)||!Number.isSafeInteger(index))
        return refusal("historical_transfer_history_invalid",balances.bot);
      seen.add(id);
      rows.push({id,time:Number(time),from:Number(from),to:Number(to),
        amount:Number(amount),index:Number(index)});
    }
    const next=data.cursor;
    if(next===undefined||next===null||next===""){exhausted=true;break;}
    if(typeof next!=="string"||next.length>1024||visited.has(next))
      return refusal("historical_transfer_history_invalid",balances.bot);
    visited.add(next);cursor=next;
  }
  if(!exhausted)return refusal("historical_transfer_history_incomplete",balances.bot);
  // The last Index-2 movement involving the bot must be a unique $25 inbound
  // receipt; older inbound and outbound transfers remain historical context.
  const relevant=rows.filter(r=>r.index===2&&(r.from===1||r.to===1));
  if(!relevant.length)return refusal("historical_transfer_receipt_missing",balances.bot);
  relevant.sort((a,b)=>b.time-a.time);
  const latest=relevant[0]!;
  const now=options.nowSeconds?.()??Math.floor(Date.now()/1000);
  if(relevant.length>1&&relevant[1]!.time===latest.time)
    return refusal("historical_transfer_history_ambiguous",balances.bot);
  if(latest.from!==0||latest.to!==1||latest.amount!==PILOT_CENTS||
    latest.time>now+120||latest.time<now-30*86400)
    return refusal("historical_transfer_latest_mismatch",balances.bot);
  // Never attach a receipt to another owner's account, even if it was
  // previously stored by another user (DB unique receipt constraint).
  try {
    const saved=await db.query(HISTORY_SAVE_SQL,
      [userId,bound.row.id,latest.id,latest.time,balances.primary,balances.bot]);
    if(saved.rows.length!==1||typeof saved.rows[0]!.verified_at!=="string")
      return refusal("historical_funding_persistence_unverified",balances.bot);
    return {ok:true,reason:"historical_funding_verified",historicalVerified:true,
      historicalVerifiedAt:String(saved.rows[0]!.verified_at),
      botCents:balances.bot,transferAttempted:false};
  }catch{return refusal("historical_funding_persistence_unverified",balances.bot);}
}

export async function ownedPilotTransferStatus(db:Query,userId:string):Promise<PilotResult>{
  try{
    const found=await db.query(STATUS_SQL,[userId]);
    if(found.rows.length!==1)return readOnly("no_transfer_prepared");
    const row=found.rows[0]!;
    const state=row.state;
    if(state!=="prepared"&&state!=="attempted"&&state!=="uncertain"&&state!=="completed")
      return readOnly("transfer_status_invalid");
    const primary=state==="completed"?Number(row.primary_after_cents):Number(row.primary_before_cents);
    const bot=state==="completed"?Number(row.bot_after_cents):Number(row.bot_before_cents);
    return readOnly(state==="completed"?"pilot_completed":state==="prepared"?"pilot_prepared":"transfer_requires_reconciliation",
      state,String(row.id),Number.isSafeInteger(primary)?primary:null,Number.isSafeInteger(bot)?bot:null,false);
  }catch{return readOnly("transfer_status_unavailable");}
}
