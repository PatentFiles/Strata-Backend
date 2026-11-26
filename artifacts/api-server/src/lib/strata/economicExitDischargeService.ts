import {pool,type Pool,type PoolClient} from '@workspace/db';
import {readEconomicPendingMoneyBatch} from './economicRecoveryReadBatch';
import {canonical,digest,requireProof,type Request} from '../v13-production/types';
import {deployedGitSha} from './deployedGitSha';
import {captureEconomicSettlementScope,type EconomicAlreadyLockedScope} from './ownerEconomicSettlementService';
import {PIN_SQL,validateOwnerProtectiveHistoryPinRows} from './ownerProtectiveHistoryPreviewPin';
import {readVerifiedRoleAuthority} from './accountCredentialControls';
import {inspectRestrictedKeyMetadata,inspectSubaccount1} from './accountCredentialProbe';
import {getOwnedProductionKalshiJson,personalAccountSnapshot} from './personalExchangeRead';
import {readBracketedSettledCash} from './settledCashBracket';
import {economicExitFinalityEnabled} from './economicExitDischargeScope';
import {proveEconomicDischarge,economicDischargePlan} from './economicExitDischargeEvidence';
import {commitEconomicDischarge,economicDischargeOutcome,cancelEconomicDischarge,dischargeNo} from './economicExitDischargeCommit';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
type Row=Record<string,unknown>;const record=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x);
export const ECONOMIC_DISCHARGE_CONFIRM='I_AUTHORIZE_VERIFIED_FINAL_SETTLEMENT_RESERVE_AND_STALE_LEASE_DISCHARGE_KEEP_TRANSPORT_UNKNOWN_AND_TRADING_OFF';
export function economicDischargeEnabled(env=process.env){const sha=deployedGitSha(env);return env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED==='true'&&SHA.test(sha)&&env.STRATA_ECONOMIC_EXIT_DISCHARGE_SHA===sha;}
const TRANSFER_LIMIT=200;
/** Kalshi's terminal transfer page can omit the optional cursor. Never treat a
 * full page with no cursor, malformed tokens or a paging cycle as exhaustion. */
export async function readEconomicTransferPages(getPage:(cursor:string|undefined)=>Promise<unknown>):Promise<Row[]>{
 const rows:Row[]=[],cursors=new Set<string>();let cursor:string|undefined;
 for(let page=0;page<20;page++){
  const response=await getPage(cursor);
  requireProof(record(response)&&Array.isArray(response.transfers)&&response.transfers.length<=TRANSFER_LIMIT&&response.transfers.every(record),'economic_discharge_transfer_page_unverified');
  rows.push(...response.transfers);
  const next=response.cursor;
  if(next===undefined){
   requireProof(response.transfers.length<TRANSFER_LIMIT,'economic_discharge_transfer_cursor_unverified');
   return rows;
  }
  requireProof(typeof next==='string','economic_discharge_transfer_cursor_unverified');
  if(next==='')return rows;
  requireProof(next.length<=1024&&next.trim().length>0&&!/[\u0000-\u001f\u007f]/.test(next)&&!cursors.has(next),'economic_discharge_transfer_cursor_unverified');
  cursors.add(next);cursor=next;
 }
 throw Error('economic_discharge_transfer_history_incomplete');
}
const dischargeStages=['priorOutcome','localScope','providerIdentity','openingCut','signedHistory','closingCut','proof','lockedScope','lockedHistoryAndBinding','lockedPinAndBooking','transaction'] as const;
type DischargeStage=typeof dischargeStages[number];
export type EconomicDischargeTiming=(stage:DischargeStage,ms:number)=>void;
const measured=(observe?:EconomicDischargeTiming)=>async<T>(stage:DischargeStage,work:()=>T|Promise<T>):Promise<T>=>{
 const start=performance.now();
 try{return await work();}finally{
  try{observe?.(stage,Math.round(performance.now()-start));}catch{/* Diagnostics cannot change the result. */}
 }
};
/** Both reads must finish, within the existing evidence clock. Run the market
 * GET alongside the serialized transfer chains, never across either history
 * scan. Keep failure precedence and do not leave pending siblings on refusal. */
export async function readEconomicDischargeCut<A,B>(transfers:()=>Promise<A>,market:()=>Promise<B>):Promise<[A,B]>{
 const [t,m]=await Promise.allSettled([Promise.resolve().then(transfers),Promise.resolve().then(market)]);
 if(t.status==='rejected')throw t.reason;
 if(m.status==='rejected')throw m.reason;
 return [t.value,m.value];
}
type Deps={db?:Pool;now?:()=>number;sha?:()=>string;enabled?:()=>boolean;isScheduled:(owner:string,account:string)=>boolean};
const refusal=(e:unknown)=>dischargeNo(e instanceof Error&&/^economic_discharge_[a-z_]+$/.test(e.message)?e.message:'economic_discharge_verification_refused');
/** Other monetary operations are separate obligations. A quiet cash snapshot
 * does not cancel an unresolved transfer or auto-withdrawal maintenance claim. */
function verifyPendingMoney(histories:Row[][]){
 const allowedStates=[['completed','cancelled'],['completed'],['completed'],['completed','expired'],['completed']];
 for(const [index,rows] of histories.entries()){
  requireProof(rows.length<=1000&&rows.every(r=>allowedStates[index]!.includes(String(r.state))),'economic_discharge_pending_money_requires_review');
  rows.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
 }
 return digest(histories);
}
export function createEconomicDischargeService(deps:Deps){
 const db=deps.db??pool,now=deps.now??Date.now,sha=deps.sha??deployedGitSha,enabled=deps.enabled??economicDischargeEnabled;
 const check=()=>{const build=sha();requireProof(enabled()&&economicExitFinalityEnabled()&&SHA.test(build),'economic_discharge_release_not_qualified');return build;};
 const capture=async(tx:Pick<PoolClient,'query'>,owner:string,build:string,lock=false,alreadyLocked?:EconomicAlreadyLockedScope,observe?:EconomicDischargeTiming)=>{
  const first=await (alreadyLocked?measured(observe)('lockedHistoryAndBinding',()=>captureEconomicSettlementScope(tx,owner,build,now(),deps.isScheduled,lock,alreadyLocked)):
   captureEconomicSettlementScope(tx,owner,build,now(),deps.isScheduled,lock,alreadyLocked));
  // This exact account was already read in the coherent capture (and is
  // FOR UPDATE locked by the writer). Do not add a second network round trip.
  requireProof(first.blockedReason===null,'economic_discharge_unrelated_hold_requires_review');
  const beat=first.worker.heartbeat_at instanceof Date?first.worker.heartbeat_at.getTime():Date.parse(String(first.worker.heartbeat_at));
  requireProof(first.worker.state==='released'||Number.isSafeInteger(beat)&&beat<now()-120000,'economic_discharge_worker_not_stale');
  const maintenanceDigest=verifyPendingMoney(first.pendingMoney??await readEconomicPendingMoneyBatch(tx,first.account.id,lock));
  const combined=first.finalPinRequiredWithBooking;
  const readBooking=()=>tx.query(`WITH ${combined?`current_pin AS MATERIALIZED (${PIN_SQL.replaceAll('$1','$2')}),`:''} pending AS MATERIALIZED (
    SELECT 1 FROM private.kalshi_owner_topup_legs l JOIN private.kalshi_owner_topups p ON p.id=l.topup_id
    WHERE p.execution_account_id=$1 AND l.state IN ('claimed','uncertain') ${combined?'AND (SELECT count(*) FROM current_pin)>=0':''} LIMIT 1${lock?' FOR SHARE OF l':''}
   ), booking AS MATERIALIZED (
    SELECT b.* FROM private.strata_economic_settlement_receipt b WHERE b.execution_account_id=$1 AND b.owner_user_id=$2::uuid
     AND b.exit_intent_id=$3 AND b.reservation_id=$4::uuid LIMIT 2
   ) SELECT booking.*, EXISTS (SELECT 1 FROM pending) AS has_pending
     ${combined?", coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM current_pin p),'[]'::jsonb) AS checked_pin":""}
     FROM (SELECT 1) AS probe LEFT JOIN booking ON TRUE`,
   [first.account.id,owner,first.exitId,first.pin.row.reservation_id]);
  const rows=(await (combined?measured(observe)('lockedPinAndBooking',readBooking):readBooking())).rows as Row[];
  if(combined){
   const pins=rows[0]?.checked_pin;
   requireProof(Array.isArray(pins)&&validateOwnerProtectiveHistoryPinRows(pins as Row[],owner,build)?.digest===first.pin.digest,
    'economic_settlement_locked_identity_changed');
  }
  requireProof(rows.length===1&&rows[0]!.request_id,'economic_discharge_booked_settlement_required');
  const {has_pending,checked_pin:_checkedPin,...booking}=rows[0]!;
  requireProof(has_pending===false,'economic_discharge_pending_money_requires_review');
  return {...first,booking,maintenanceDigest,dischargeScopeDigest:digest({scope:first.scopeDigest,booking,maintenanceDigest})};
 };
 const collect=async(owner:string,build:string,expected?:string,observe?:EconomicDischargeTiming)=>{
  const measure=measured(observe);
  const {first,verification,restricted}=await measure('localScope',async()=>{
  const tx=await db.connect();let first:Awaited<ReturnType<typeof capture>>;
  let verification:Awaited<ReturnType<typeof readVerifiedRoleAuthority>>,restricted:Awaited<ReturnType<typeof readVerifiedRoleAuthority>>;
  try{
   await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='4000ms'");
   first=await capture(tx,owner,build);
   requireProof(expected===undefined||expected===first.dischargeScopeDigest,'economic_discharge_preview_scope_changed');
   verification=await readVerifiedRoleAuthority(tx,owner,String(first.worker.provider_connection_id),'verification');
   restricted=await readVerifiedRoleAuthority(tx,owner,String(first.worker.provider_connection_id),'restricted_execution');
   requireProof(verification.ok&&restricted.ok&&restricted.authority.expectedFingerprint===first.account.key_fingerprint,'economic_discharge_signer_unverified');
  }finally{try{await tx.query('ROLLBACK');}finally{tx.release();}}
  return {first,verification,restricted};
  });
  const management=verification.authority,execution=restricted.authority;
  const observed=now(),signal=AbortSignal.timeout(5000);let high=observed;
  const live=()=>{const at=now();requireProof(Number.isSafeInteger(at)&&at>=high&&at-observed<=5000&&!signal.aborted,'economic_discharge_evidence_expired');high=at;};
  const get:typeof getOwnedProductionKalshiJson=(c,p,q,fetchImpl,_host,_owner,inner)=>{live();return getOwnedProductionKalshiJson(c,p,q,fetchImpl,undefined,owner,inner?AbortSignal.any([signal,inner]):signal);};
  await measure('providerIdentity',async()=>{
  const [metadata,inventory]=await readEconomicDischargeCut(
   ()=>inspectRestrictedKeyMetadata(execution.material.keyId,management,get),()=>inspectSubaccount1(management,get));
  requireProof(metadata.ok,'economic_discharge_current_key_binding_unverified');
  requireProof(inventory.ok&&inventory.exists===true&&inventory.exchangeIndex2Exists===true,'economic_discharge_pair_unverified');
  });
  const transfers=async()=>{
   const pages=(path:string)=>readEconomicTransferPages(async cursor=>{
    const response=await get(management.material,path,'?limit='+TRANSFER_LIMIT+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    live();return response;
   });
   const [subaccount,crossExchange]=await readEconomicDischargeCut(
    ()=>pages('/trade-api/v2/portfolio/subaccounts/transfers'),
    ()=>pages('/trade-api/v2/portfolio/intra_exchange_instance_transfers'));
   return {subaccount,crossExchange,complete:true};
  };
  const marketPath='/trade-api/v2/markets/'+String(first.pin.row.market_ticker);
  const cut=()=>readEconomicDischargeCut(transfers,()=>get(execution.material,marketPath,''));
  const [before,marketBefore]=await measure('openingCut',cut);live();
  requireProof(record(marketBefore)&&record(marketBefore.market),'economic_discharge_market_unverified');
  const openingMarket=marketBefore.market;
  const feed=await measure('signedHistory',()=>readBracketedSettledCash(execution.material,observed,{get,now}));live();
  requireProof(feed.ok&&feed.historicalCoverageComplete===true,'economic_discharge_signed_history_incomplete');
  const [after,marketAfter]=await measure('closingCut',cut);live();
  return measure('proof',()=>{
  requireProof(canonical(before)===canonical(after)&&record(marketAfter)&&record(marketAfter.market),'economic_discharge_provider_cut_changed');
  // Compare only finality fields, not changing display metadata or quote caches.
  const fields=['ticker','exchange_index','market_type','status','result','settlement_ts','close_time','settlement_value_dollars','is_provisional'];
  const pick=(m:Row)=>Object.fromEntries(fields.filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));
  const market=pick(openingMarket);requireProof(canonical(market)===canonical(pick(marketAfter.market)),'economic_discharge_market_changed');
  const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:first.account.key_fingerprint},feed,first.history.requests as Request[]);
  requireProof('identity' in snapshot,'economic_discharge_snapshot_unverified');
  const matching=(rows:unknown[])=>rows.filter(record).filter(r=>r.ticker===first.pin.row.market_ticker);
  const settlements=matching(feed.settlements),positions=matching(feed.positions);
  requireProof(settlements.length===1&&positions.length===1,'economic_discharge_market_scope_unverified');
  const proof=proveEconomicDischarge({account:first.account,history:first.history,snapshot,exitId:first.exitId,reservationId:String(first.pin.row.reservation_id),
   rawSettlement:settlements[0]!,rawPosition:positions[0]!,nowMs:now(),booking:first.booking,market,transfers:after});
  live();requireProof(check()===build&&!deps.isScheduled(owner,first.account.id),'economic_discharge_release_or_worker_changed');
  return {first,proof};
  });
 };
 return {enabled,
  async preview(owner:string,observe?:EconomicDischargeTiming){if(!UUID.test(owner))return dischargeNo('economic_discharge_authenticated_owner_required');try{
   const build=check(),{first,proof}=await collect(owner,build,undefined,observe),p=economicDischargePlan(proof);
   return {ok:true as const,reason:'economic_discharge_preview_no_writes',scopeDigest:first.dischargeScopeDigest,releaseSha:build,market:p.settlement.market,
    cashMicros:p.cashMicros,releaseReserveMicros:p.releaseReserveMicros,observedAt:new Date(p.observedAtMs).toISOString(),transportOutcome:'UNKNOWN',
    reserveReleased:false,leaseReleased:false,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false};
  }catch(e){return refusal(e);}},
  async apply(owner:string,input:unknown,observe?:EconomicDischargeTiming){
   if(!UUID.test(owner)||!record(input)||Object.keys(input).sort().join(',')!=='confirmation,releaseSha,requestId,scopeDigest'||
    input.confirmation!==ECONOMIC_DISCHARGE_CONFIRM||!UUID.test(String(input.requestId))||!SHA.test(String(input.releaseSha))||!HASH.test(String(input.scopeDigest)))return dischargeNo('economic_discharge_explicit_owner_scope_required');
   try{
    const build=check();requireProof(build===input.releaseSha,'economic_discharge_release_changed');
    const measure=measured(observe);
    const prior=await measure('priorOutcome',()=>economicDischargeOutcome(owner,String(input.requestId),db));
    if(prior.ok){requireProof(prior.scopeDigest===input.scopeDigest&&prior.releaseSha===build,'economic_discharge_request_scope_conflict');return prior;}
    if(prior.status==='UNKNOWN'||prior.status==='CANCELED')return prior;
    const {first,proof}=await collect(owner,build,String(input.scopeDigest),observe);
    return await measure('transaction',()=>commitEconomicDischarge(proof,{ownerId:owner,requestId:String(input.requestId),scopeDigest:first.dischargeScopeDigest,releaseSha:build,
     controlEpoch:first.controlEpoch,workerFence:String(first.worker.fencing_token)},{db,now,verifyLocked:async(tx,a,p)=>{
      requireProof(check()===build&&a.id===p.accountId,'economic_discharge_release_changed');
      const locked=await measure('lockedScope',()=>capture(tx,owner,build,true,{account:a as unknown as Row,pin:first.pin},observe));
      requireProof(locked.dischargeScopeDigest===first.dischargeScopeDigest&&digest(locked.history)===p.historyDigest,'economic_discharge_locked_scope_changed');
     }}));
   }catch(e){return refusal(e);}
  },
  async outcome(owner:string,id:string){return economicDischargeOutcome(owner,id,db);},
  async cancel(owner:string,id:string){return cancelEconomicDischarge(owner,id,db);},
 };
}
