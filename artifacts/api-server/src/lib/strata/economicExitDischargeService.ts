import {pool,type Pool,type PoolClient} from '@workspace/db';
import {canonical,digest,requireProof,type Request} from '../v13-production/types';
import {deployedGitSha} from './deployedGitSha';
import {captureEconomicSettlementScope} from './ownerEconomicSettlementService';
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
type Deps={db?:Pool;now?:()=>number;sha?:()=>string;enabled?:()=>boolean;isScheduled:(owner:string,account:string)=>boolean};
const refusal=(e:unknown)=>dischargeNo(e instanceof Error&&/^economic_discharge_[a-z_]+$/.test(e.message)?e.message:'economic_discharge_verification_refused');
/** Other monetary operations are separate obligations. A quiet cash snapshot
 * does not cancel an unresolved transfer or auto-withdrawal maintenance claim. */
async function readPendingMoney(tx:Pick<PoolClient,'query'>,account:string,lock:boolean){
 const histories:Row[][]=[];
 for(const [table,allowed] of [
  ['private.kalshi_owner_topups',['completed','cancelled']],
  ['private.kalshi_owner_shard_allocations',['completed']],
  ['private.kalshi_owner_pilot_transfers',['completed']],
  ['private.strata_manual_profit_withdrawals',['completed','expired']],
  ['private.strata_auto_withdrawal_maintenance',['completed']],
 ] as const){
  const rows=(await tx.query(`SELECT t.*,t.xmin::text AS row_revision FROM ${table} t WHERE execution_account_id=$1 LIMIT 1001${lock?' FOR SHARE':''}`,[account])).rows as Row[];
  requireProof(rows.length<=1000&&rows.every(r=>(allowed as readonly string[]).includes(String(r.state))),'economic_discharge_pending_money_requires_review');histories.push(rows.sort((a,b)=>canonical(a).localeCompare(canonical(b))));
 }
 const legs=(await tx.query(`SELECT l.*,l.xmin::text AS row_revision FROM private.kalshi_owner_topup_legs l JOIN private.kalshi_owner_topups p ON p.id=l.topup_id
  WHERE p.execution_account_id=$1 AND l.state IN ('claimed','uncertain') LIMIT 1${lock?' FOR SHARE OF l':''}`,[account])).rows;
 requireProof(!legs.length,'economic_discharge_pending_money_requires_review');return digest(histories);
}
export function createEconomicDischargeService(deps:Deps){
 const db=deps.db??pool,now=deps.now??Date.now,sha=deps.sha??deployedGitSha,enabled=deps.enabled??economicDischargeEnabled;
 const check=()=>{const build=sha();requireProof(enabled()&&economicExitFinalityEnabled()&&SHA.test(build),'economic_discharge_release_not_qualified');return build;};
 const capture=async(tx:Pick<PoolClient,'query'>,owner:string,build:string,lock=false)=>{
  const first=await captureEconomicSettlementScope(tx,owner,build,now(),deps.isScheduled,lock);
  const a=(await tx.query('SELECT blocked_reason FROM public.v13_production_account WHERE id=$1',[first.account.id])).rows;
  requireProof(a.length===1&&a[0]!.blocked_reason===null,'economic_discharge_unrelated_hold_requires_review');
  const beat=first.worker.heartbeat_at instanceof Date?first.worker.heartbeat_at.getTime():Date.parse(String(first.worker.heartbeat_at));
  requireProof(first.worker.state==='released'||Number.isSafeInteger(beat)&&beat<now()-120000,'economic_discharge_worker_not_stale');
  const receipts=(await tx.query(`SELECT b.* FROM private.strata_economic_settlement_receipt b WHERE b.execution_account_id=$1 AND b.owner_user_id=$2::uuid
    AND b.exit_intent_id=$3 AND b.reservation_id=$4::uuid LIMIT 2`,[first.account.id,owner,first.exitId,first.pin.row.reservation_id])).rows as Row[];
  requireProof(receipts.length===1,'economic_discharge_booked_settlement_required');
  const maintenanceDigest=await readPendingMoney(tx,first.account.id,lock),booking=receipts[0]!;
  return {...first,booking,maintenanceDigest,dischargeScopeDigest:digest({scope:first.scopeDigest,booking,maintenanceDigest})};
 };
 const collect=async(owner:string,build:string,expected?:string)=>{
  const tx=await db.connect();let first:Awaited<ReturnType<typeof capture>>;
  let verification:Awaited<ReturnType<typeof readVerifiedRoleAuthority>>,restricted:Awaited<ReturnType<typeof readVerifiedRoleAuthority>>;
  try{
   await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await tx.query("SET LOCAL statement_timeout='4000ms'");
   first=await capture(tx,owner,build);
   requireProof(expected===undefined||expected===first.dischargeScopeDigest,'economic_discharge_preview_scope_changed');
   verification=await readVerifiedRoleAuthority(tx,owner,String(first.worker.provider_connection_id),'verification');
   restricted=await readVerifiedRoleAuthority(tx,owner,String(first.worker.provider_connection_id),'restricted_execution');
   requireProof(verification.ok&&restricted.ok&&restricted.authority.expectedFingerprint===first.account.key_fingerprint,'economic_discharge_signer_unverified');
  }finally{try{await tx.query('ROLLBACK');}finally{tx.release();}}
  const management=verification.authority,execution=restricted.authority;
  const observed=now(),signal=AbortSignal.timeout(5000);let high=observed;
  const live=()=>{const at=now();requireProof(Number.isSafeInteger(at)&&at>=high&&at-observed<=5000&&!signal.aborted,'economic_discharge_evidence_expired');high=at;};
  const get:typeof getOwnedProductionKalshiJson=(c,p,q,fetchImpl,_host,_owner,inner)=>{live();return getOwnedProductionKalshiJson(c,p,q,fetchImpl,undefined,owner,inner?AbortSignal.any([signal,inner]):signal);};
  const metadata=await inspectRestrictedKeyMetadata(execution.material.keyId,management,get);
  requireProof(metadata.ok,'economic_discharge_current_key_binding_unverified');
  const inventory=await inspectSubaccount1(management,get);
  requireProof(inventory.ok&&inventory.exists===true&&inventory.exchangeIndex2Exists===true,'economic_discharge_pair_unverified');
  const transfers=async()=>{
   const pages=(path:string)=>readEconomicTransferPages(async cursor=>{
    const response=await get(management.material,path,'?limit='+TRANSFER_LIMIT+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    live();return response;
   });
   const subaccount=await pages('/trade-api/v2/portfolio/subaccounts/transfers');
   const crossExchange=await pages('/trade-api/v2/portfolio/intra_exchange_instance_transfers');
   return {subaccount,crossExchange,complete:true};
  };
  const marketPath='/trade-api/v2/markets/'+String(first.pin.row.market_ticker);
  const before=await transfers(),marketBefore=await get(execution.material,marketPath,'');
  requireProof(record(marketBefore)&&record(marketBefore.market),'economic_discharge_market_unverified');
  const feed=await readBracketedSettledCash(execution.material,observed,{get,now});live();
  requireProof(feed.ok&&feed.historicalCoverageComplete===true,'economic_discharge_signed_history_incomplete');
  const after=await transfers(),marketAfter=await get(execution.material,marketPath,'');live();
  requireProof(canonical(before)===canonical(after)&&record(marketAfter)&&record(marketAfter.market),'economic_discharge_provider_cut_changed');
  // Compare only finality fields, not changing display metadata or quote caches.
  const fields=['ticker','exchange_index','market_type','status','result','settlement_ts','close_time','settlement_value_dollars','is_provisional'];
  const pick=(m:Row)=>Object.fromEntries(fields.filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));
  const market=pick(marketBefore.market);requireProof(canonical(market)===canonical(pick(marketAfter.market)),'economic_discharge_market_changed');
  const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:first.account.key_fingerprint},feed,first.history.requests as Request[]);
  requireProof('identity' in snapshot,'economic_discharge_snapshot_unverified');
  const matching=(rows:unknown[])=>rows.filter(record).filter(r=>r.ticker===first.pin.row.market_ticker);
  const settlements=matching(feed.settlements),positions=matching(feed.positions);
  requireProof(settlements.length===1&&positions.length===1,'economic_discharge_market_scope_unverified');
  const proof=proveEconomicDischarge({account:first.account,history:first.history,snapshot,exitId:first.exitId,reservationId:String(first.pin.row.reservation_id),
   rawSettlement:settlements[0]!,rawPosition:positions[0]!,nowMs:now(),booking:first.booking,market,transfers:after});
  live();requireProof(check()===build&&!deps.isScheduled(owner,first.account.id),'economic_discharge_release_or_worker_changed');
  return {first,proof};
 };
 return {enabled,
  async preview(owner:string){if(!UUID.test(owner))return dischargeNo('economic_discharge_authenticated_owner_required');try{
   const build=check(),{first,proof}=await collect(owner,build),p=economicDischargePlan(proof);
   return {ok:true as const,reason:'economic_discharge_preview_no_writes',scopeDigest:first.dischargeScopeDigest,releaseSha:build,market:p.settlement.market,
    cashMicros:p.cashMicros,releaseReserveMicros:p.releaseReserveMicros,observedAt:new Date(p.observedAtMs).toISOString(),transportOutcome:'UNKNOWN',
    reserveReleased:false,leaseReleased:false,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false};
  }catch(e){return refusal(e);}},
  async apply(owner:string,input:unknown){
   if(!UUID.test(owner)||!record(input)||Object.keys(input).sort().join(',')!=='confirmation,releaseSha,requestId,scopeDigest'||
    input.confirmation!==ECONOMIC_DISCHARGE_CONFIRM||!UUID.test(String(input.requestId))||!SHA.test(String(input.releaseSha))||!HASH.test(String(input.scopeDigest)))return dischargeNo('economic_discharge_explicit_owner_scope_required');
   try{
    const build=check();requireProof(build===input.releaseSha,'economic_discharge_release_changed');
    const prior=await economicDischargeOutcome(owner,String(input.requestId),db);
    if(prior.ok){requireProof(prior.scopeDigest===input.scopeDigest&&prior.releaseSha===build,'economic_discharge_request_scope_conflict');return prior;}
    if(prior.status==='UNKNOWN'||prior.status==='CANCELED')return prior;
    const {first,proof}=await collect(owner,build,String(input.scopeDigest));
    return await commitEconomicDischarge(proof,{ownerId:owner,requestId:String(input.requestId),scopeDigest:first.dischargeScopeDigest,releaseSha:build,
     controlEpoch:first.controlEpoch,workerFence:String(first.worker.fencing_token)},{db,now,verifyLocked:async(tx,a,p)=>{
      requireProof(check()===build&&a.id===p.accountId,'economic_discharge_release_changed');
      const locked=await capture(tx,owner,build,true);
      requireProof(locked.dischargeScopeDigest===first.dischargeScopeDigest&&digest(locked.history)===p.historyDigest,'economic_discharge_locked_scope_changed');
     }});
   }catch(e){return refusal(e);}
  },
  async outcome(owner:string,id:string){return economicDischargeOutcome(owner,id,db);},
  async cancel(owner:string,id:string){return cancelEconomicDischarge(owner,id,db);},
 };
}
