import {BoundedAnalyticsQueue} from './boundedAnalyticsQueue';
import {randomUUID} from "node:crypto";
import {pool,type Pool,type PoolClient} from "@workspace/db";
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET} from "@workspace/v13-strategy";
import {deployedGitSha} from "../strata/deployedGitSha";

export type LiveDecisionPolicy = {
 policyHash?:string|null; policyRevision?:number|null;
 configuredStakeCents?:number|null; allocationPreset?:string|null;
};
export type LiveDecisionInput = LiveDecisionPolicy & {
 accountId:string; ownerId:string; releaseSha:string;
 observedAtMs:number; stage:"OBSERVATION"|"ENTRY_GATE"|"PREPARE"|"DISPATCH";
 outcome:"PASS"|"QUALIFIED"|"BLOCKED"|"ERROR"; reasonCode:string;
 reasonDetail?:string|null; market?:string|null; direction?:string|null;
 signal?:string|null; sourceId?:string|null;
 // Only code-owned scalar market observations; never transport bodies, keys,
 // signature headers, arbitrary error messages, or an execution capability.
 facts?:Record<string,number|string|boolean|null>;
};
type Stored = {
 id:string; execution_account_id:string; owner_user_id:string; observed_at:string;
 release_commit_sha:string; stage:LiveDecisionInput["stage"]; outcome:LiveDecisionInput["outcome"];
 reason_code:string; reason_detail:string|null; market_ticker:string|null; direction:string|null;
 signal:string|null; direct_source_id:string|null; policy_hash:string|null; policy_revision:number|null;
 configured_stake_cents:number|null; allocation_preset:string|null; strategy_version:string;
 strategy_parameter_hash:string; facts:Record<string,unknown>;
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const code=/^[a-z][a-z0-9_]{0,127}$/;
const numberOrNull=(n:unknown)=>typeof n==="number"&&Number.isFinite(n)?n:null;
const positiveInt=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0&&n<=2147483647?n:null;
const text=(v:unknown,max:number)=>typeof v==="string"&&v.length>0&&v.length<=max?v:null;
const observedKeys=new Set(["btcPrice","target","distance","previousBuffer","velocity","separation","upOffer","downOffer","entryOffer","candidateOffer","marketOpenMs","marketCloseMs","btcProviderAgeMs","btcReceiveAgeMs","marketAgeMs","freshCross","qualifyingTrigger","continuous","needsEntryPrice","sourceObservationAtMs","targetReadiness"]);
/** Fixed code-owned error categories only. Never persist arbitrary exception text. */
export function liveAnalyticsFailure(error:unknown):string{
 const m=error instanceof Error?error.message:"";
 // Preserve this fixed, non-sensitive refusal instead of hiding price protection.
 if(m==="live_money_best_ask_above_signal_ceiling")return m;
 return /^(?:direct_entry_|direct_live_|production_|personal_exchange_|entry_|account_|stale_worker_|durable_fee_)[a-z0-9_]{1,96}$/.test(m)?m:"live_evaluation_or_execution_failed";
}
export function normalizeLiveDecision(input:LiveDecisionInput):Stored|null{
 if(!UUID.test(input.ownerId)||!SHA.test(input.releaseSha)||!text(input.accountId,200)||
    !Number.isSafeInteger(input.observedAtMs)||input.observedAtMs<=0||
    !Number.isFinite(new Date(input.observedAtMs).getTime())||
    !["OBSERVATION","ENTRY_GATE","PREPARE","DISPATCH"].includes(input.stage)||
    !["PASS","QUALIFIED","BLOCKED","ERROR"].includes(input.outcome)||!code.test(input.reasonCode))return null;
 const facts:Record<string,unknown>={};
 for(const [k,v] of Object.entries(input.facts??{})){
  if(!observedKeys.has(k))continue;
  facts[k]=typeof v==="boolean"?v:numberOrNull(v);
 }
 return {id:randomUUID(),execution_account_id:input.accountId,owner_user_id:input.ownerId,
  observed_at:new Date(input.observedAtMs).toISOString(),release_commit_sha:input.releaseSha,
  stage:input.stage,outcome:input.outcome,reason_code:input.reasonCode,
  reason_detail:text(input.reasonDetail,512),market_ticker:text(input.market,128),
  direction:["UP","DOWN","NONE"].includes(input.direction??"")?input.direction!:null,
  signal:["PASS","WATCH","SCOUT","CONFIRM","EXIT"].includes(input.signal??"")?input.signal!:null,
  direct_source_id:input.sourceId&&UUID.test(input.sourceId)?input.sourceId:null,
  policy_hash:input.policyHash&&HASH.test(input.policyHash)?input.policyHash:null,
  policy_revision:positiveInt(input.policyRevision),configured_stake_cents:positiveInt(input.configuredStakeCents),
  allocation_preset:text(input.allocationPreset,120),strategy_version:"V1.3",
  strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
  facts:{...facts,thresholds:V13_CHAMPION_PARAMETER_SET.parameters}};
}
type Query=Pick<Pool|PoolClient,"query">;
export async function writeLiveDecisionBatch(db:Query,rows:Stored[]):Promise<number>{
 if(rows.length===0)return 0;
 const out=await db.query(`INSERT INTO private.strata_live_decision_log_v1
  (id,execution_account_id,owner_user_id,observed_at,release_commit_sha,stage,outcome,reason_code,reason_detail,
   market_ticker,direction,signal,direct_source_id,policy_hash,policy_revision,configured_stake_cents,
   allocation_preset,strategy_version,strategy_parameter_hash,facts)
 SELECT r.id,r.execution_account_id,r.owner_user_id,r.observed_at,r.release_commit_sha,r.stage,r.outcome,
  r.reason_code,r.reason_detail,r.market_ticker,r.direction,r.signal,r.direct_source_id,r.policy_hash,
  r.policy_revision,r.configured_stake_cents,r.allocation_preset,r.strategy_version,r.strategy_parameter_hash,r.facts
 FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,execution_account_id text,owner_user_id uuid,
  observed_at timestamptz,release_commit_sha text,stage text,outcome text,reason_code text,reason_detail text,
  market_ticker text,direction text,signal text,direct_source_id text,policy_hash text,policy_revision integer,
  configured_stake_cents integer,allocation_preset text,strategy_version text,strategy_parameter_hash text,facts jsonb)
 JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
 WHERE a.subaccount=1 AND a.exchange_index=2
 ON CONFLICT(id) DO NOTHING RETURNING id`,[JSON.stringify(rows)]);
 return out.rows.length;
}
// Keep the exact observed context for linked stage refusals without adding a
// provider read or an awaited database request to the order-admission window.
// This cache is telemetry-only: it never returns a trading source/capability.
const contexts=new Map<string,{at:number;row:Stored}>();
const contextKey=(v:{owner_user_id:string;execution_account_id:string;direct_source_id:string|null;release_commit_sha:string})=>
 JSON.stringify([v.owner_user_id,v.execution_account_id,v.direct_source_id,v.release_commit_sha]);
export function normalizeLinkedLiveDecision(input:LiveDecisionInput):Stored|null{
 const row=normalizeLiveDecision(input);if(!row)return null;
 const now=Date.now();
 for(const [key,value] of contexts){if(now-value.at>60_000)contexts.delete(key);else break;}
 if(row.direct_source_id){
  const key=contextKey(row);
  if(row.stage==='OBSERVATION'){
   contexts.delete(key);contexts.set(key,{at:now,row});
   while(contexts.size>256)contexts.delete(contexts.keys().next().value!);
  }else{
   const original=contexts.get(key)?.row;
   if(original){
    row.market_ticker??=original.market_ticker;row.direction??=original.direction;row.signal??=original.signal;
    row.policy_hash??=original.policy_hash;row.policy_revision??=original.policy_revision;
    row.configured_stake_cents??=original.configured_stake_cents;row.allocation_preset??=original.allocation_preset;
    row.facts={...original.facts,...row.facts,sourceObservationAtMs:Date.parse(original.observed_at)};
   }
  }
 }
 return row;
}
let invalid=0,lastFailureLog=0;
function noteGap(){
 const now=Date.now();if(now-lastFailureLog<60_000)return;lastFailureLog=now;
 try{console.warn('strata_live_analytics_delivery_gap',liveDecisionDeliveryStatus());}catch{}
}
// Exact retained identity is checked after an uncertain commit retry. The UUID
// is generated at enqueue, not at each attempt; an existing different row does
// not count as successful delivery. No financial record is updated here.
export async function confirmedBatch(client:PoolClient,rows:Stored[]):Promise<number>{
 await writeLiveDecisionBatch(client,rows);
 const result=await client.query<{confirmed:number}>(`SELECT count(*)::integer AS confirmed
  FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,execution_account_id text,owner_user_id uuid,
   observed_at timestamptz,release_commit_sha text,stage text,outcome text,reason_code text,reason_detail text,
   market_ticker text,direction text,signal text,direct_source_id text,policy_hash text,policy_revision integer,
   configured_stake_cents integer,allocation_preset text,strategy_version text,strategy_parameter_hash text,facts jsonb)
  JOIN private.strata_live_decision_log_v1 d ON d.id=r.id AND (to_jsonb(d)-'recorded_at')=to_jsonb(r)
  JOIN public.v13_production_account a ON a.id=d.execution_account_id AND a.owner_user_id=d.owner_user_id
  WHERE a.subaccount=1 AND a.exchange_index=2`,[JSON.stringify(rows)]);
 return result.rows[0]?.confirmed??0;
}
const queue=new BoundedAnalyticsQueue<Stored>(async rows=>{
 let client:PoolClient|undefined,discard:Error|undefined;
 try{
  client=await pool.connect();await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='1500ms'; SET LOCAL lock_timeout='500ms'");
  const confirmed=await confirmedBatch(client,rows);await client.query('COMMIT');return confirmed;
 }catch(error){
  if(client)try{await client.query('ROLLBACK');}catch{discard=Error('live_analytics_rollback_failed');}
  throw error;
 }finally{client?.release(discard);}
},{onGap:noteGap});
export function liveDecisionDeliveryStatus(){return {...queue.snapshot(),invalid,mode:'bounded_retried_async' as const};}
export const flushLiveDecisionAnalytics=(timeoutMs=5000)=>queue.flush(timeoutMs);
export function liveDecisionAnalyticsEnabled(){
 return process.env.NODE_ENV==='production'&&process.env.STRATA_LIVE_DECISION_ANALYTICS_ENABLED==='true'&&SHA.test(deployedGitSha());
}
export function enqueueLiveDecision(input:LiveDecisionInput):void{
 if(!liveDecisionAnalyticsEnabled())return;
 try{const row=normalizeLinkedLiveDecision(input);if(row)queue.enqueue(row);else{invalid++;noteGap();}}
 catch{invalid++;noteGap();}
}
