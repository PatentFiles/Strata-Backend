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
const USD = 100;
const BALANCE = "/trade-api/v2/portfolio/balance";
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
 ON CONFLICT (execution_account_id) DO NOTHING
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
 AND prepared_at >= now()-interval '60 seconds'
 AND authority_credential_id=$3::uuid AND authority_fingerprint=$4
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
  if(row.subaccount!==undefined&&row.subaccount!==subaccount &&
     row.subaccount_number!==subaccount)return null;
  if(row.exchange_index!==undefined&&row.exchange_index!==2)return null;
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
    return readOnly("pilot_prepared","prepared",attemptId,balances.primary,balances.bot);
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
    Date.now()-Number(plan.prepared_ms)>60_000)
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
    claimed=x.rows.length===1;
    await client.query("COMMIT");
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
