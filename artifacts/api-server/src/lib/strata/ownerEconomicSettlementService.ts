/** Explicit owner-only economic recovery. This module NEVER submits an order,
 * changes a worker, clears a hold, or manufactures a terminal transport result. */
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {canonical,digest,requireProof,type Request} from '../v13-production/types';
import {deployedGitSha} from './deployedGitSha';
import {pinOwnerProtectiveHistory} from './ownerProtectiveHistoryPreviewPin';
import {readVerifiedRoleAuthority} from './accountCredentialControls';
import {inspectRestrictedKeyMetadata,inspectSubaccount1} from './accountCredentialProbe';
import {getOwnedProductionKalshiJson,personalAccountSnapshot} from './personalExchangeRead';
import {readBracketedSettledCash} from './settledCashBracket';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import type {ReconciledReleaseHistory} from './reconciledReleaseRenewalHistory';
import {proveEconomicSettlement,economicSettlementPlan,type EconomicSettlementAccount,type EconomicSettlementPlan} from './ownerEconomicSettlementProof';
import {commitEconomicSettlement,economicSettlementOutcome,cancelEconomicSettlement} from './ownerEconomicSettlementCommit';

export const ECONOMIC_SETTLEMENT_CONFIRM='I_AUTHORIZE_EXACT_SIGNED_SETTLEMENT_ACCOUNTING_ONLY_KEEP_UNKNOWN_EXIT_RESERVE_AND_WORKER_HOLD';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;const HASH=/^[a-f0-9]{64}$/;
type Row=Record<string,unknown>;
const record=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
type Query=Pick<PoolClient,'query'>;
type Deps={db?:Pool;now?:()=>number;sha?:()=>string;enabled?:()=>boolean;isScheduled:(owner:string,account:string)=>boolean};
const no=(reason:string)=>({ok:false as const,reason,accountingPosted:false,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,
 transportOutcome:'UNKNOWN' as const,reserveReleased:false,leaseReleased:false});
const safe=(e:unknown)=>no(e instanceof Error&&/^economic_settlement_[a-z_]+$/.test(e.message)?e.message:'economic_settlement_verification_refused');
export function economicSettlementEnabled(env=process.env){const sha=deployedGitSha(env);return SHA.test(sha)&&env.STRATA_ECONOMIC_SETTLEMENT_RECOVERY_SHA===sha;}

async function retainedHistory(db:Query,account:string,owner:string,lock=false):Promise<ReconciledReleaseHistory>{
 const h=await readNeverPostedReleaseHistory(db,account,lock,{expiredExitOwnerId:owner}),suffix=lock?' FOR SHARE':'';
 const read=async(table:string,where:string,key:string,limit:number)=>(await db.query(`SELECT t.*,t.xmin::text AS row_revision FROM ${table} t WHERE ${where}=$1 ORDER BY ${key} LIMIT ${limit+1}${suffix}`,[account])).rows as Row[];
 const events=await read('public.v13_production_event','account_id','event_id',3000);
 const positions=await read('public.v13_production_position','account_id','id',1000);
 const markers=await read('private.strata_emergency_exit_reservations','execution_account_id','reservation_id',1000);
 const receipts=await read('private.strata_protective_exit_reconciliations','execution_account_id','reservation_id',1000);
 requireProof(events.length<=3000&&positions.length<=1000&&markers.length<=1000&&receipts.length<=1000,'economic_settlement_history_bound_exceeded');
 const accountingOnlyExitClients:string[]=[];
 return {...h,events,positions,markers,receipts,accountingOnlyExitClients,
  reconciliationDigest:digest({history:h.historyDigest,events,positions,markers,receipts,accountingOnlyExitClients})};
}

/** Account row is locked first by the writer. Every mutable scope row is then
 * locked before reusing evidence. Reads use a short coherent snapshot, not a
 * long database transaction held open while the venue is queried. */
async function capture(db:Query,owner:string,sha:string,now:number,scheduled:Deps['isScheduled'],lock=false){
 const pin=await pinOwnerProtectiveHistory(db,owner,sha);
 requireProof(pin,'economic_settlement_owned_unknown_exit_scope_missing');const id=String(pin.row.account_id);
 const a=(await db.query('SELECT * FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid',[id,owner])).rows[0] as Row|undefined;
 requireProof(a&&!scheduled(owner,id),'economic_settlement_worker_must_be_stopped');
 const workers=(await db.query(`SELECT w.*,w.xmin::text AS row_revision FROM private.kalshi_account_worker_lease w
  WHERE execution_account_id=$1 AND owner_user_id=$2::uuid${lock?' FOR UPDATE':''}`,[id,owner])).rows as Row[];
 requireProof(workers.length===1,'economic_settlement_worker_scope_ambiguous');const worker=workers[0]!;
 const heartbeat=worker.heartbeat_at instanceof Date?worker.heartbeat_at.getTime():Date.parse(String(worker.heartbeat_at));
 requireProof(worker.arm_requested===false&&['owned','released','killed'].includes(String(worker.state))&&
  (worker.state==='released'||Number.isSafeInteger(heartbeat)&&heartbeat<=now-30000),
  'economic_settlement_worker_not_stale_or_released');
 if(lock){
  // Account -> lease -> owned connection -> credentials -> financial history.
  // Connection/credential replacement must not race the last evidence check.
  const connections=await db.query(`SELECT fa.id FROM public.financial_accounts fa
   JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
   WHERE fa.id=$1 AND fa.user_id=$2::uuid AND fa.provider='kalshi' AND pc.id=$3::uuid FOR UPDATE OF fa,pc`,
   [a.kalshi_connection_id,owner,worker.provider_connection_id]);
  requireProof(connections.rows.length===1,'economic_settlement_connection_changed');
 }
 const credentialRows=(await db.query(`SELECT c.id::text,c.provider_connection_id::text,c.financial_account_id,
  c.role,c.key_fingerprint,c.vault_secret_id::text,c.xmin::text AS row_revision
  FROM private.kalshi_connection_credentials c WHERE c.owner_user_id=$1::uuid AND c.financial_account_id=$2
   AND c.provider_connection_id=$3::uuid AND c.role IN ('verification','restricted_execution')
   AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
  ORDER BY c.role,c.id${lock?' FOR SHARE':''}`,[owner,a.kalshi_connection_id,worker.provider_connection_id])).rows as Row[];
 requireProof(credentialRows.length===2&&new Set(credentialRows.map(c=>c.role)).size===2&&
  credentialRows.find(c=>c.role==='restricted_execution')?.key_fingerprint===a.key_fingerprint,
  'economic_settlement_current_credential_pair_unverified');
 const history=await retainedHistory(db,id,owner,lock);
 const exit=history.rows.find(i=>i.client_order_id===pin.row.client_order_id);
 requireProof(exit,'economic_settlement_exit_missing');
 const account:EconomicSettlementAccount={id,owner_user_id:owner,subaccount:Number(a.subaccount),exchange_index:Number(a.exchange_index),key_fingerprint:String(a.key_fingerprint),
  revision:String(a.revision),cash_micros:String(a.cash_micros),initial_cash_micros:String(a.initial_cash_micros),reserved_micros:String(a.reserved_micros)};
 const scopeDigest=digest({pin:pin.digest,history:history.reconciliationDigest,credentials:credentialRows,
  controlEpoch:String(a.owner_control_epoch),workerFence:String(worker.fencing_token)});
 if(lock){
  const finalPin=await pinOwnerProtectiveHistory(db,owner,sha);
  requireProof(finalPin?.digest===pin.digest,'economic_settlement_locked_identity_changed');
 }
 return {pin,account,history,worker,credentialRows,exitId:String(exit.id),scopeDigest,controlEpoch:String(a.owner_control_epoch)};
}

export function createEconomicSettlementService(deps:Deps){
 const db=deps.db??pool,now=deps.now??Date.now,sha=deps.sha??deployedGitSha,enabled=deps.enabled??economicSettlementEnabled;
 const check=()=>{const build=sha();requireProof(enabled()&&SHA.test(build),'economic_settlement_release_not_qualified');return build;};
 const readCapture=async(owner:string,build:string)=>{
  const tx=await db.connect();try{
   await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await tx.query("SET LOCAL statement_timeout='3000ms'");
   const result=await capture(tx,owner,build,now(),deps.isScheduled);
   const verification=await readVerifiedRoleAuthority(tx,owner,String(result.worker.provider_connection_id),'verification');
   const restricted=await readVerifiedRoleAuthority(tx,owner,String(result.worker.provider_connection_id),'restricted_execution');
   requireProof(verification.ok&&restricted.ok&&restricted.authority.expectedFingerprint===result.account.key_fingerprint,
    'economic_settlement_signing_material_unverified');
   return {...result,verification,restricted};
  }finally{try{await tx.query('ROLLBACK');}finally{tx.release();}}
 };
 const collect=async(owner:string,build:string,expectedScope?:string)=>{
  const first=await readCapture(owner,build);
  requireProof(expectedScope===undefined||expectedScope===first.scopeDigest,'economic_settlement_preview_scope_changed');
  const observed=now(),signal=AbortSignal.timeout(5000);
  const get:typeof getOwnedProductionKalshiJson=(c,path,query,fetchImpl,_host,_owner,inner)=>
   getOwnedProductionKalshiJson(c,path,query,fetchImpl,undefined,owner,inner?AbortSignal.any([signal,inner]):signal);
  // Verified management authority attests the CURRENT restricted-key binding;
  // balance or an empty order list alone cannot establish account identity.
  const metadata=await inspectRestrictedKeyMetadata(first.restricted.authority.material.keyId,first.verification.authority,get);
  requireProof(metadata.ok,'economic_settlement_current_key_metadata_unverified');
  const inventory=await inspectSubaccount1(first.verification.authority,get);
  requireProof(inventory.ok&&inventory.exists===true&&inventory.exchangeIndex2Exists===true,'economic_settlement_subaccount_inventory_unverified');
  const feed=await readBracketedSettledCash(first.restricted.authority.material,observed,{get,now});
  requireProof(feed.ok&&feed.historicalCoverageComplete===true,'economic_settlement_complete_signed_bracket_required');
  const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:first.account.key_fingerprint},feed,first.history.requests as Request[]);
  requireProof('identity' in snapshot,'economic_settlement_snapshot_unverified');
  const market=String(first.pin.row.market_ticker),settlements=feed.settlements.filter(record).filter(x=>x.ticker===market),positions=feed.positions.filter(record).filter(x=>x.ticker===market);
  requireProof(settlements.length===1&&positions.length===1,'economic_settlement_exact_market_evidence_missing');
  const proof=proveEconomicSettlement({account:first.account,history:first.history,snapshot,exitId:first.exitId,
   reservationId:String(first.pin.row.reservation_id),rawSettlement:settlements[0]!,rawPosition:positions[0]!,nowMs:now()});
  requireProof(check()===build&&!deps.isScheduled(owner,first.account.id),'economic_settlement_release_or_worker_changed');
  return {first,proof,build};
 };
 return {
  enabled,
  async preview(owner:string){
   if(!UUID.test(owner))return no('economic_settlement_authenticated_owner_required');
   try{
    const build=check(),{first,proof}=await collect(owner,build),p=economicSettlementPlan(proof);
    return {ok:true as const,reason:'economic_settlement_preview_no_financial_writes',scopeDigest:first.scopeDigest,releaseSha:build,
     market:p.settlement.market,cashBeforeMicros:p.cashBeforeMicros,cashAfterMicros:p.cashAfterMicros,cashDeltaMicros:p.cashDeltaMicros,
     pnlMicros:p.pnlMicros,reservedMicros:p.reservedMicros,observedAt:new Date(p.observedAtMs).toISOString(),
     accountingPosted:false,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,transportOutcome:'UNKNOWN',reserveReleased:false,leaseReleased:false};
   }catch(e){return safe(e);}
  },
  async apply(owner:string,input:unknown){
   if(!UUID.test(owner)||!input||typeof input!=='object'||Array.isArray(input))return no('economic_settlement_explicit_owner_scope_required');
   const v=input as Row;
   if(Object.keys(v).sort().join(',')!=='confirmation,releaseSha,requestId,scopeDigest'||v.confirmation!==ECONOMIC_SETTLEMENT_CONFIRM||
    !UUID.test(String(v.requestId))||!SHA.test(String(v.releaseSha))||!HASH.test(String(v.scopeDigest)))return no('economic_settlement_explicit_owner_scope_required');
   try{
    const build=check();requireProof(build===v.releaseSha,'economic_settlement_release_changed');
    const prior=await economicSettlementOutcome(owner,String(v.requestId),db);
    if(prior.ok){requireProof(prior.scopeDigest===v.scopeDigest&&prior.releaseSha===v.releaseSha,'economic_settlement_request_id_scope_conflict');return prior;}
    if(prior.status==='UNKNOWN'||prior.status==='CANCELED')return prior;
    const {first,proof}=await collect(owner,build,String(v.scopeDigest));
    const result=await commitEconomicSettlement(proof,{requestId:String(v.requestId),ownerId:owner,scopeDigest:first.scopeDigest,
     releaseSha:build,controlEpoch:first.controlEpoch,workerFence:String(first.worker.fencing_token)},
    {db,now,verifyLocked:async(tx,a,p:EconomicSettlementPlan)=>{
     requireProof(check()===build&&a.id===p.accountId,'economic_settlement_release_changed');
     const current=await capture(tx,owner,build,now(),deps.isScheduled,true);
     requireProof(current.scopeDigest===first.scopeDigest&&digest(current.history)===p.historyDigest&&
      canonical(current.credentialRows)===canonical(first.credentialRows),'economic_settlement_locked_scope_changed');
    }});
    if(result.ok||result.status==='UNKNOWN')return result;
    // A simultaneous request may already have committed. Read its immutable
    // receipt once; never resend/retry a writer to resolve an uncertain result.
    const outcome=await economicSettlementOutcome(owner,String(v.requestId),db);
    return outcome.ok||outcome.status==='UNKNOWN'||outcome.status==='CANCELED'?outcome:result;
   }catch(e){return safe(e);}
  },
  async cancel(owner:string,requestId:string){return cancelEconomicSettlement(owner,requestId,db);},
  async outcome(owner:string,requestId:string){
   // Readback remains available across release rotation; it conveys no new authority.
   return economicSettlementOutcome(owner,requestId,db);
  },
 };
}