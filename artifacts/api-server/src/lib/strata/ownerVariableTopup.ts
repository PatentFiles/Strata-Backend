import {randomUUID} from "node:crypto";
import {getScopedKalshiJson,postScopedOwnerVariableTopup} from "../kalshiAccountClient";
import {dedicatedSignerFingerprint} from "./commissioning";
import {readOwnedKalshiFeeds} from "./personalExchangeRead";

/**
 * Variable owner top-ups are separate from immutable commissioning transfers.
 * This module never bypasses account disarm, exact signed exchange cash,
 * one-shot durable POST claims, or authoritative receipt reconciliation.
 * A successful POST is deliberately NOT a completed funding credit.
 */
export const OWNER_TOPUP_CONFIRM="I_AUTHORIZE_THIS_EXACT_KALSHI_TOPUP_AMOUNT_AND_DESTINATION";
export type TopupStatus={
 ok:boolean;reason:string;planId:string|null;attemptId:string|null;
 state:"unavailable"|"prepared"|"claimed"|"uncertain"|"completed";
 kind:"shard"|"bot"|null;amountCents:number|null;transferAttempted:boolean;
};
type Row=Record<string,unknown>;
type Conn={query(sql:string,params?:unknown[]):Promise<{rows:Row[]}>;release():void};
type Pool={query:Conn["query"];connect():Promise<Conn>};
type Creds={keyId:string;privateKey:string};
type Get=(c:Creds,path:string,q:string)=>Promise<unknown>;
type Post=(c:Creds,id:string,amount:number,kind:"shard"|"bot")=>
  Promise<{status:number;body:unknown;unreadable:boolean}>;
type Deps={get?:Get;post?:Post;allowTestPost?:boolean;now?:()=>number};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const BALANCE="/trade-api/v2/portfolio/balance";
const TRANSFERS="/trade-api/v2/portfolio/subaccounts/transfers";
const SHARD_DETAIL="/trade-api/v2/portfolio/intra_exchange_instance_transfers/";
const MICROS_PER_CENT=10000n;
const CENTS_LIMIT=2_500_000;
const block=(reason:string,state:TopupStatus["state"]="unavailable",planId:string|null=null,
  attemptId:string|null=null,kind:TopupStatus["kind"]=null,amountCents:number|null=null,
  transferAttempted=false):TopupStatus=>({
  ok:false,reason,state,planId,attemptId,kind,amountCents,transferAttempted,
});
const num=(x:unknown)=> (typeof x==="number"||typeof x==="string") && x!=="" &&
  Number.isSafeInteger(Number(x))&&Number(x)>=0?Number(x):null;
const str=(x:unknown)=>typeof x==="string"?x:"";
const micros=(x:unknown):bigint|null=>{
 if(typeof x!=="string"||!/^\d+$/.test(x))return null;
 const n=BigInt(x);return n<=9223372036854775807n?n:null;
};
const cents=(x:bigint):number|null=> {
 const n=x/MICROS_PER_CENT;return n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
};
const dollarsMicro=(v:unknown):bigint|null=>{
 if(typeof v!=="string"||!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(v))return null;
 const [a,b=""]=v.split(".");const n=BigInt(a!)*1000000n+BigInt(b.padEnd(6,"0"));
 return n<=9223372036854775807n?n:null;
};
export function exactSignedCash(value:unknown,sub:0|1,shard:0|2):bigint|null{
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 const root=value as Row;
 const r=root.balance&&typeof root.balance==="object"&&!Array.isArray(root.balance)
   ?root.balance as Row:root;
 if((r.subaccount!==undefined&&Number(r.subaccount)!==sub)||
    (r.subaccount_number!==undefined&&Number(r.subaccount_number)!==sub)||
    (r.exchange_index!==undefined&&Number(r.exchange_index)!==shard))return null;
 // Integer-cents API and fixed-point dollar API are mutually exclusive views.
 const d=r.balance_dollars??r.available_balance_dollars;
 if(d!==undefined)return dollarsMicro(d);
 const n=r.balance??r.available_balance;
 return Number.isSafeInteger(n)&&typeof n==="number"&&n>=0?BigInt(n)*MICROS_PER_CENT:null;
}
type Snapshot={zero:bigint;primary:bigint;bot:bigint};
async function balances(creds:Creds,get:Get):Promise<Snapshot|null>{
 try {
  const [z,p,b]=await Promise.all([
   get(creds,BALANCE,"?subaccount=0&exchange_index=0"),
   get(creds,BALANCE,"?subaccount=0&exchange_index=2"),
   get(creds,BALANCE,"?subaccount=1&exchange_index=2"),
  ]);
  const zero=exactSignedCash(z,0,0),primary=exactSignedCash(p,0,2),bot=exactSignedCash(b,1,2);
  return zero===null||primary===null||bot===null?null:{zero,primary,bot};
 }catch{return null;}
}
const OWNER_SQL=`
 SELECT a.id,a.owner_user_id::text, a.commissioned,a.execution_enabled,a.kill_switch,
   a.cash_precision_verified,a.blocked_reason,a.cash_micros::text,a.reserved_micros::text,
   a.subaccount,a.exchange_index,a.reconciled_at,a.key_fingerprint AS restricted_fingerprint,
   (SELECT count(*)::int FROM public.v13_production_position p
     WHERE p.account_id=a.id AND p.quantity_hundredths>0) AS positions,
   (SELECT count(*)::int FROM public.v13_production_intent i
     WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED')) AS intents,
   (SELECT count(*)::int FROM private.kalshi_account_worker_lease l
     WHERE l.execution_account_id=a.id AND l.state='owned') AS workers,
   c.id::text AS credential_id,c.key_fingerprint,
   s.decrypted_secret
 FROM public.v13_production_account a
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON
   c.owner_user_id=a.owner_user_id AND c.financial_account_id=fa.id
   AND c.provider_connection_id=pc.id AND c.role='account_setup_execution'
   AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL
   AND c.verification_reason='credential_verified'
 JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
`;
function safe(row:Row,allowMaintenance:boolean):boolean{
 const blocked=row.blocked_reason;
 return row.commissioned===true&&row.execution_enabled===false&&row.kill_switch===true&&
 row.cash_precision_verified===true&&(blocked==null||
 blocked==="awaiting_account_commissioning"||
 (allowMaintenance&&blocked==="owner_topup_maintenance"))&&
 str(row.reserved_micros)==="0"&&
 num(row.positions)===0&&num(row.intents)===0&&num(row.workers)===0;
}
function signer(row:Row):Creds|null{
 if(typeof row.decrypted_secret!=="string")return null;
 try{
  const obj=JSON.parse(row.decrypted_secret) as Row;
  if(typeof obj.api_key_id!=="string"||typeof obj.private_key!=="string")return null;
  return dedicatedSignerFingerprint(obj.api_key_id,obj.private_key)===row.key_fingerprint
   ?{keyId:obj.api_key_id,privateKey:obj.private_key}:null;
 }catch{return null;}
}
async function authority(db:Pool,uid:string,maintenance=false){
 if(!UUID.test(uid))return null;
 try{
  const x=await db.query(OWNER_SQL,[uid]);
  if(x.rows.length!==1||!safe(x.rows[0]!,maintenance))return null;
  const creds=signer(x.rows[0]!);
  return creds?{row:x.rows[0]!,creds}:null;
 }catch{return null;}
}
const READ_SQL=`
 SELECT p.id::text,p.execution_account_id,p.owner_user_id::text,
   p.authority_credential_id::text,p.authority_fingerprint,p.amount_cents,
   p.source_exchange_index,p.state AS plan_state,p.prior_blocked_reason,
   l.id::text AS attempt_id,l.leg,l.kind,l.state,l.amount_cents AS leg_amount_cents,
   l.shard_zero_before_micros::text,l.primary_two_before_micros::text,
   l.bot_two_before_micros::text,l.exchange_transfer_id,
   (extract(epoch from l.created_at)*1000)::bigint AS created_ms,
   (extract(epoch from l.attempted_at))::bigint AS attempted_seconds
 FROM private.kalshi_owner_topups p
 JOIN LATERAL (SELECT * FROM private.kalshi_owner_topup_legs l
   WHERE l.topup_id=p.id ORDER BY l.leg DESC LIMIT 1) l ON true
 JOIN public.v13_production_account a ON a.id=p.execution_account_id
 WHERE p.owner_user_id=$1::uuid AND a.owner_user_id=p.owner_user_id
 ORDER BY p.created_at DESC LIMIT 1
`;
const readPlan=async(db:Pool,uid:string)=>{
 const r=await db.query(READ_SQL,[uid]).catch(()=>null);
 return r?.rows.length===1?r.rows[0]!:null;
};
const output=(p:Row,reason:string,ok=false):TopupStatus=>({
 ok,reason,planId:str(p.id)||null,attemptId:str(p.attempt_id)||null,
 state:p.plan_state==="completed"?"completed":
 ["prepared","claimed","uncertain"].includes(str(p.state))
 ?str(p.state) as TopupStatus["state"]:"unavailable",
 kind:p.kind==="shard"?"shard":p.kind==="bot"?"bot":null,
 amountCents:num(p.amount_cents),transferAttempted:p.state!=="prepared",
});
export async function ownerTopupStatus(db:Pool,uid:string):Promise<TopupStatus>{
 const p=await readPlan(db,uid);
 return p?output(p,p.plan_state==="completed"?"topup_completed":"topup_requires_next_action",
  p.plan_state==="completed"):block("topup_not_prepared");
}
async function exchangeClear(creds:Creds,expectedBot:bigint,now:number,get:Get):Promise<boolean>{
 try{
  const f=await readOwnedKalshiFeeds(creds,now,get);
  if(!f.ok||micros(f.cashMicros)!==expectedBot)return false;
  // Prior historical fills/settlements may exist. Current exposure and any
  // unresolved order cannot exist; provider inventory must be fully paginated.
  if(f.positions.some(v=>{
   const r=v as Row;
   const n=r.position_fp??r.position??r.net_position_fp;
   return n===undefined||n===null||!Number.isFinite(Number(n))||Number(n)!==0;
  }))return false;
  return !f.orders.some(v=>["resting","pending","open","unknown"].includes(
    str((v as Row).status).toLowerCase()));
 }catch{return false;}
}
const insertLeg=(kind:"shard"|"bot",step:number,id:string,topupId:string,amount:number,b:Snapshot)=>
  ({sql:`INSERT INTO private.kalshi_owner_topup_legs
     (id,topup_id,leg,kind,amount_cents,shard_zero_before_micros,
      primary_two_before_micros,bot_two_before_micros)
     VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::bigint,$7::bigint,$8::bigint)`,
   args:[id,topupId,step,kind,amount,String(b.zero),String(b.primary),String(b.bot)]});
/** Preparation is the *only* point that establishes a durable maintenance freeze. */
export async function prepareOwnerTopup(db:Pool,uid:string,amount:number,deps:Deps={}):Promise<TopupStatus>{
 if(!Number.isSafeInteger(amount)||amount<100||amount>CENTS_LIMIT)
  return block("topup_amount_outside_permitted_range");
 // A prepare persists a real account maintenance hold. Never allow that
 // irreversible side effect while the corresponding production transfer
 // capability is disabled or the database migration is not commissioned.
 if(process.env.STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED!=="true" ||
    process.env.KALSHI_API_ENVIRONMENT!=="production")
  return block("variable_topup_not_commissioned");
 const who=await authority(db,uid);
 if(!who)return block("owner_commissioned_account_not_safely_disarmed");
 const snapshot=await balances(who.creds,deps.get??getScopedKalshiJson);
 if(!snapshot)return block("authenticated_source_balances_missing");
 if(snapshot.bot!==micros(who.row.cash_micros))return block("bot_cash_ledger_mismatch_reconcile_first");
 if(!await exchangeClear(who.creds,snapshot.bot,(deps.now??Date.now)(),deps.get??getScopedKalshiJson))
  return block("authenticated_exchange_exposure_unproven");
 const transferMicros=BigInt(amount)*MICROS_PER_CENT;
 const kind:"bot"|"shard"=snapshot.primary>=transferMicros?"bot":"shard";
 if((kind==="shard"&&snapshot.zero<transferMicros))
  return block("insufficient_verified_kalshi_primary_cash");
 const group=randomUUID(),legId=randomUUID();
 const client=await db.connect();let committed=false;
 try{
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SET LOCAL lock_timeout='1500ms'");
  const locked=await client.query(`
    SELECT a.id,a.blocked_reason,a.commissioned,a.execution_enabled,a.kill_switch,
      a.cash_precision_verified,a.reserved_micros::text,a.cash_micros::text,
      (SELECT count(*)::int FROM public.v13_production_intent i WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED')) intents,
      (SELECT count(*)::int FROM public.v13_production_position p WHERE p.account_id=a.id AND p.quantity_hundredths>0) positions,
      (SELECT count(*)::int FROM private.kalshi_account_worker_lease l WHERE l.execution_account_id=a.id AND l.state='owned') workers
    FROM public.v13_production_account a WHERE a.id=$1 AND a.owner_user_id=$2::uuid FOR UPDATE`,
    [who.row.id,uid]);
  const a=locked.rows[0];
  if(locked.rows.length!==1||!a||!safe(a,false)||micros(a.cash_micros)!==snapshot.bot){
   await client.query("ROLLBACK");return block("topup_preparation_raced_with_account_state");
  }
  const created=await client.query(`INSERT INTO private.kalshi_owner_topups
      (id,owner_user_id,execution_account_id,authority_credential_id,
       authority_fingerprint,amount_cents,source_exchange_index,prior_blocked_reason)
      VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8)
      RETURNING id`,[group,uid,who.row.id,who.row.credential_id,
      who.row.key_fingerprint,amount,kind==="bot"?2:0,a.blocked_reason??null]);
  if(created.rows.length!==1)throw Error("topup_parent_not_persisted");
  const stmt=insertLeg(kind,1,legId,group,amount,snapshot);
  await client.query(stmt.sql,stmt.args);
  const held=await client.query(`UPDATE public.v13_production_account
    SET blocked_reason='owner_topup_maintenance' WHERE id=$1 AND owner_user_id=$2::uuid
      AND execution_enabled=false AND kill_switch=true
      AND (blocked_reason IS NULL OR blocked_reason='awaiting_account_commissioning')
    RETURNING id`,[who.row.id,uid]);
  if(held.rows.length!==1)throw Error("account_maintenance_hold_not_persisted");
  await client.query("COMMIT");committed=true;
 }catch{
  try{await client.query("ROLLBACK");}catch{/* committed ambiguity: never POST */}
 }finally{client.release();}
 return committed?{
  ok:true,reason:"topup_prepared_owner_confirmation_required",
  state:"prepared",planId:group,attemptId:legId,kind,amountCents:amount,
  transferAttempted:false,
 }:block("topup_preparation_failed_or_state_ambiguous");
}

/** Separate confirmation + transactionally committed, single-use claim. */
export async function executeOwnerTopup(db:Pool,uid:string,input:unknown,deps:Deps={}):Promise<TopupStatus>{
 const args=input&&typeof input==="object"&&!Array.isArray(input)?input as Row:{};
 if(args.confirmation!==OWNER_TOPUP_CONFIRM||typeof args.attemptId!=="string"||
    !UUID.test(args.attemptId))return block("topup_explicit_owner_consent_required");
 if(!deps.allowTestPost&&
    (process.env.KALSHI_API_ENVIRONMENT!=="production"||
     process.env.STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED!=="true"))
  return block("variable_topup_post_not_activated");
 const who=await authority(db,uid,true),p=await readPlan(db,uid);
 if(!who||!p||p.plan_state!=="active"||p.state!=="prepared"||
    p.attempt_id!==args.attemptId||p.execution_account_id!==who.row.id||
    p.authority_credential_id!==who.row.credential_id||
    p.authority_fingerprint!==who.row.key_fingerprint||
    who.row.blocked_reason!=="owner_topup_maintenance")
   return block("topup_missing_or_not_prepared");
 const kind=p.kind==="shard"?"shard":p.kind==="bot"?"bot":null;
 const amount=num(p.amount_cents);
 if(!kind||amount===null||amount<100||amount>CENTS_LIMIT||
    (deps.now??Date.now)()-Number(p.created_ms)>300000)
  return output(p,"topup_plan_expired_or_invalid");
 const b=await balances(who.creds,deps.get??getScopedKalshiJson);
 if(!b||b.zero!==micros(p.shard_zero_before_micros)||
    b.primary!==micros(p.primary_two_before_micros)||
    b.bot!==micros(p.bot_two_before_micros)||
    !await exchangeClear(who.creds,b.bot,(deps.now??Date.now)(),deps.get??getScopedKalshiJson))
  return output(p,"topup_signed_balances_or_exposure_changed");
 const claim=await db.connect();let claimed=false;
 try{
  await claim.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await claim.query("SET LOCAL lock_timeout='1500ms'");
  const x=await claim.query(`UPDATE private.kalshi_owner_topup_legs l
    SET state='claimed',attempted_at=now(),updated_at=now()
    FROM private.kalshi_owner_topups p
    WHERE l.id=$1::uuid AND l.topup_id=p.id AND p.owner_user_id=$2::uuid
      AND p.state='active' AND l.state='prepared'
      AND l.created_at>now()-interval '5 minutes'
      AND EXISTS(SELECT 1 FROM public.v13_production_account a
        WHERE a.id=p.execution_account_id AND a.owner_user_id=$2::uuid
          AND a.execution_enabled=false AND a.kill_switch=true
          AND a.blocked_reason='owner_topup_maintenance'
          AND a.reserved_micros=0
          AND NOT EXISTS(SELECT 1 FROM private.kalshi_account_worker_lease w
            WHERE w.execution_account_id=a.id AND w.state='owned')
          AND NOT EXISTS(SELECT 1 FROM public.v13_production_position q
            WHERE q.account_id=a.id AND q.quantity_hundredths>0)
          AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent i
            WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED')))
      RETURNING l.id`,[args.attemptId,uid]);
  await claim.query("COMMIT");claimed=x.rows.length===1;
 }catch{
  try{await claim.query("ROLLBACK");}catch{/* fail closed */}
 }finally{claim.release();}
 if(!claimed)return output(p,"topup_already_claimed_or_transaction_ambiguous");
 let exchangeId:string|null=null;
 try{
  const x=await (deps.post??postScopedOwnerVariableTopup)(
    who.creds,args.attemptId,amount,kind);
  if(x.status===200&&!x.unreadable&&kind==="shard"&&x.body&&
     typeof x.body==="object"&&!Array.isArray(x.body)){
   const id=(x.body as Row).transfer_id;
   if(typeof id==="string"&&/^[a-zA-Z0-9_-]{8,128}$/.test(id))exchangeId=id;
  }
 }catch{/* claimed; no retry even if server did not respond */}
 try{
  await db.query(`UPDATE private.kalshi_owner_topup_legs
    SET state='uncertain',exchange_transfer_id=$3,updated_at=now()
    WHERE id=$1::uuid AND topup_id IN (
      SELECT id FROM private.kalshi_owner_topups WHERE owner_user_id=$2::uuid
    ) AND state='claimed' RETURNING id`,[args.attemptId,uid,exchangeId]);
 }catch{/* unknown COMMIT remains claimed: recovery will read it */}
 return {...output(p,"topup_post_attempted_exchange_receipt_required"),state:"uncertain",
  transferAttempted:true};
}
/** Strict provider receipt + exact signed after balances. NEVER retries POST. */
export async function reconcileOwnerTopup(db:Pool,uid:string,deps:Deps={}):Promise<TopupStatus>{
 const p=await readPlan(db,uid);
 if(!p)return block("topup_no_plan");
 if(p.plan_state==="completed")return output(p,"topup_completed",true);
 if(p.state==="prepared")return output(p,"topup_not_submitted");
 if(p.state!=="claimed"&&p.state!=="uncertain")
  return output(p,"topup_state_invalid");
 const who=await authority(db,uid,true);
 if(!who||who.row.id!==p.execution_account_id||who.row.blocked_reason!=="owner_topup_maintenance"||
    who.row.credential_id!==p.authority_credential_id||
    who.row.key_fingerprint!==p.authority_fingerprint)
  return output(p,"owner_or_funding_hold_unverified");
 const kind=p.kind==="shard"?"shard":p.kind==="bot"?"bot":null;
 const amount=num(p.amount_cents),secs=num(p.attempted_seconds);
 if(!kind||amount===null||secs===null||secs===0)return output(p,"receipt_identity_invalid");
 const before=[micros(p.shard_zero_before_micros),micros(p.primary_two_before_micros),
   micros(p.bot_two_before_micros)];
 if(before.some(v=>v===null))return output(p,"topup_baseline_invalid");
 const diff=BigInt(amount)*MICROS_PER_CENT;
 const b=await balances(who.creds,deps.get??getScopedKalshiJson);
 if(!b||b.zero!==(kind==="shard"?before[0]!-diff:before[0])||
    b.primary!==(kind==="shard"?before[1]!+diff:before[1]!-diff)||
    b.bot!==(kind==="bot"?before[2]!+diff:before[2]))
  return output(p,"topup_exact_signed_after_balances_unverified");
 // Evidence of a specific transfer is independent of a balance movement.
 if(kind==="shard"){
  if(!str(p.exchange_transfer_id))return output(p,"shard_receipt_id_missing_manual_reconciliation");
  let data:unknown;
  try{data=await(deps.get??getScopedKalshiJson)(who.creds,
    SHARD_DETAIL+encodeURIComponent(str(p.exchange_transfer_id)),"");}
  catch{return output(p,"shard_receipt_read_unavailable");}
  const root=data&&typeof data==="object"?data as Row:{};
  const rec=root.transfer&&typeof root.transfer==="object"?root.transfer as Row:{};
  if(rec.transfer_id!==p.exchange_transfer_id||rec.status!=="complete"||
     Number(rec.source_exchange_shard)!==0||Number(rec.destination_exchange_shard)!==2||
     rec.source!=="event_contract"||rec.destination!=="event_contract"||
     dollarsMicro(rec.amount)!==diff)
    return output(p,"shard_specific_receipt_not_completed");
 }else{
  const get=deps.get??getScopedKalshiJson;
  let cursor="",complete=false,found=0;const visited=new Set<string>();
  for(let page=0;page<15;page++){
   let payload:unknown;
   try{payload=await get(who.creds,TRANSFERS,
      `?limit=100${cursor?"&cursor="+encodeURIComponent(cursor):""}`);}
   catch{return output(p,"bot_transfer_history_unavailable");}
   if(!payload||typeof payload!=="object"||Array.isArray(payload))
    return output(p,"bot_transfer_history_malformed");
   const doc=payload as Row;
   if(!Array.isArray(doc.transfers))return output(p,"bot_transfer_history_malformed");
   for(const v of doc.transfers){
    if(!v||typeof v!=="object"||Array.isArray(v))return output(p,"bot_transfer_history_malformed");
    const t=v as Row;
    if(t.client_transfer_id===p.attempt_id &&
       Number(t.from_subaccount)===0&&Number(t.to_subaccount)===1&&
       Number(t.exchange_index)===2&&Number(t.amount_cents)===amount&&
       Number(t.created_ts)>=secs-120&&Number(t.created_ts)<=secs+300)found++;
   }
   const next=doc.cursor;
   if(next===undefined||next===null||next===""){complete=true;break;}
   if(typeof next!=="string"||next.length>1024||visited.has(next))
    return output(p,"bot_transfer_cursor_invalid");
   visited.add(next);cursor=next;
  }
  if(!complete||found!==1)return output(p,"bot_unique_transfer_receipt_unverified");
 }
 // Do NOT mark complete unless financial ledger and next-leg attempt are
 // atomically committed while account maintenance remains held.
 const client=await db.connect();let result:TopupStatus|undefined;
 try{
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SET LOCAL lock_timeout='1500ms'");
  const locked=await client.query(`SELECT a.id,a.owner_user_id::text,a.blocked_reason,
     a.cash_micros::text,a.reserved_micros::text,a.execution_enabled,a.kill_switch,
     (SELECT count(*)::int FROM private.kalshi_account_worker_lease w
       WHERE w.execution_account_id=a.id AND w.state='owned') workers,
     (SELECT count(*)::int FROM public.v13_production_intent i
       WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED')) intents,
     (SELECT count(*)::int FROM public.v13_production_position x
       WHERE x.account_id=a.id AND x.quantity_hundredths>0) positions
   FROM public.v13_production_account a WHERE a.id=$1 AND a.owner_user_id=$2::uuid FOR UPDATE`,
  [who.row.id,uid]);
  const a=locked.rows[0];
  if(!a||a.blocked_reason!=="owner_topup_maintenance"||a.execution_enabled!==false||
     a.kill_switch!==true||str(a.reserved_micros)!=="0"||
     num(a.workers)!==0||num(a.intents)!==0||num(a.positions)!==0||
     micros(a.cash_micros)!==before[2])
    throw Error("account_maintenance_state_changed");
  const checked=await client.query(`UPDATE private.kalshi_owner_topup_legs
    SET state='completed',verified_at=now(),updated_at=now(),
      shard_zero_after_micros=$3::bigint,primary_two_after_micros=$4::bigint,
      bot_two_after_micros=$5::bigint
    WHERE id=$1::uuid AND topup_id IN(
      SELECT id FROM private.kalshi_owner_topups WHERE owner_user_id=$2::uuid AND state='active')
      AND state IN ('claimed','uncertain') RETURNING id`,
      [p.attempt_id,uid,String(b.zero),String(b.primary),String(b.bot)]);
  if(checked.rows.length!==1)throw Error("topup_already_completed");
  if(kind==="shard"){
   const id=randomUUID();const stmt=insertLeg("bot",2,id,str(p.id),amount,b);
   await client.query(stmt.sql,stmt.args);
   result={ok:true,reason:"shard_verified_next_bot_leg_requires_new_consent",
     state:"prepared",planId:str(p.id),attemptId:id,kind:"bot",
     amountCents:amount,transferAttempted:false};
  }else{
   const credit=await client.query(`UPDATE public.v13_production_account
     SET cash_micros=$3::bigint,reconciled_at=now(),
       blocked_reason=$4
     WHERE id=$1 AND owner_user_id=$2::uuid
       AND blocked_reason='owner_topup_maintenance' AND kill_switch=true
       AND execution_enabled=false AND reserved_micros=0
       AND cash_micros=$5::bigint RETURNING id`,
     [who.row.id,uid,String(b.bot),p.prior_blocked_reason??null,String(before[2])]);
   if(credit.rows.length!==1)throw Error("topup_credit_not_reconciled");
   const done=await client.query(`UPDATE private.kalshi_owner_topups
      SET state='completed',completed_at=now(),updated_at=now()
      WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='active' RETURNING id`,
      [p.id,uid]);
   if(done.rows.length!==1)throw Error("topup_completion_not_recorded");
   result={ok:true,reason:"topup_completed_signed_cash_and_receipt_verified",
    state:"completed",planId:str(p.id),attemptId:str(p.attempt_id),
    kind:"bot",amountCents:amount,transferAttempted:true};
  }
  await client.query("COMMIT");
 }catch{
  try{await client.query("ROLLBACK");}catch{/* fail closed */}
  return output(p,"topup_reconciliation_commit_unverified");
 }finally{client.release();}
 return result??output(p,"topup_reconciliation_unverified");
}
