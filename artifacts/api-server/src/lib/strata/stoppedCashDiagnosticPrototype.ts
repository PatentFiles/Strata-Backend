/** Offline, unmounted prototype: only immutable/read-only ports plus normal
 * quota-bookkept signed GETs; no recovery, observation or execution adapter. */
import {canonical,digest,type Request,type Snapshot} from '../v13-production/types';
import {deployedGitSha} from './deployedGitSha';

const FREEZE='production_external_cash_mismatch';
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const INTEGER=/^(0|[1-9][0-9]{0,18})$/;
const SIGNED_INTEGER=/^(0|-?[1-9][0-9]{0,18})$/;
const MAX_AGE=5000;
type Material={keyId:string;privateKey:string};
export type StoppedCashDiagnosticHeld={
 owner:string;id:string;armRequested:boolean;leaseState:string;scheduled:boolean;freeze:string;
 executionEnabled:boolean;killSwitch:boolean;leaseAccountKill:boolean;
 subaccount:number;exchangeIndex:number;cashMicros:string;initialCashMicros:string;reservedMicros:string;
 commissioned:boolean;cashPrecisionVerified:boolean;approvedPolicy:boolean;
 positionCount:number;outstandingCount:number;reservationCount:number;releaseSha:string;
 // Require xmins/revisions for account, holder, policy, credential, financial
 // account, provider and Vault binding; pass a digest of these, never raw IDs.
 holdFence:string;keyFingerprint:string;historyDigest:string;
 requests:Request[];
 neverPosted:Array<{clientOrderId:string;requestDigest:string;receiptDigest:string}>;
 expectedOrders:Array<{request:Request;orderId:string;filledHundredths:string;createdAtMs:number}>;
 events:Array<{id:string;digest:string;cashDeltaMicros:string;realizedPnlMicros:string}>;
 closedPositionBasisMicros:string;closedPositionPnlMicros:string;
};
type Held=StoppedCashDiagnosticHeld;
type Ports={
 env:()=>NodeJS.ProcessEnv; wall:()=>number; mono:()=>number;
 // Production implementation must use scoped read-only PostgreSQL
 // transactions, no locks spanning network; exact-owner SELECT only.
 loadHeld:(subject:string)=>Promise<Held|null>;
 verifiedMaterial:(subject:string,accountId:string,fingerprint:string)=>Promise<Material|null>;
 // Production composition must use readBracketedSettledCash, with its real
 // production transport and normal quota bookkeeping, then map the result.
 // This port cannot express writes or return credential-bearing data.
 bracket:(subject:string,material:Material,at:number,requests:Request[],fingerprint:string)=>Promise<Snapshot|null>;
};
const no=(reason:string)=>Object.freeze({ok:false as const,reason,accountWritesPerformed:false as const,
 observationPersisted:false as const,ordersSubmitted:false as const,tradingAuthorized:false as const});
const pass=(snapshot:Snapshot,at:number,tookMs:number)=>Object.freeze({ok:true as const,
 reason:'stopped_cash_diagnostic_complete',accountWritesPerformed:false as const,
 observationPersisted:false as const,ordersSubmitted:false as const,tradingAuthorized:false as const,
 observedAt:new Date(at).toISOString(),elapsedMs:Math.ceil(tookMs),
 cashMatchesLedger:true as const,openOrders:0 as const,openPositions:0 as const,
 terminalOrders:snapshot.orders.length,fills:snapshot.fills.length,settlements:snapshot.settlements.length});
function gate(env:NodeJS.ProcessEnv){
 const expected=env.STRATA_STOPPED_CASH_DIAGNOSTIC_SHA??'';
 return env.NODE_ENV==='production'&&env.STRATA_STOPPED_CASH_DIAGNOSTIC_ENABLED==='true'&&
  env.STRATA_STOPPED_CASH_DIAGNOSTIC_REVIEWED==='true'&&SHA.test(expected)&&deployedGitSha(env)===expected?expected:null;
}
const boundedHistory=(a:Held)=>a.requests.length<=1000&&a.expectedOrders.length<=1000&&a.neverPosted.length<=1000&&a.events.length<=3000;
function held(a:Held|null,subject:string,sha:string):a is Held{
 return Boolean(a&&a.owner===subject&&a.id&&a.releaseSha===sha&&
  a.subaccount===1&&a.exchangeIndex===2&&a.commissioned===true&&a.cashPrecisionVerified===true&&
  a.approvedPolicy===true&&a.leaseState==='released'&&a.scheduled===false&&a.armRequested===false&&
  // STOP releases the lease; KILL separately flips durable switches. This
  // diagnostic records their exact preexisting values, never changes them.
  typeof a.executionEnabled==='boolean'&&typeof a.killSwitch==='boolean'&&a.leaseAccountKill===false&&
  a.freeze===FREEZE&&a.positionCount===0&&a.outstandingCount===0&&a.reservationCount===0&&a.reservedMicros==='0'&&
  INTEGER.test(a.cashMicros)&&INTEGER.test(a.initialCashMicros)&&HASH.test(a.keyFingerprint)&&
  HASH.test(a.holdFence)&&HASH.test(a.historyDigest)&&Array.isArray(a.requests)&&Array.isArray(a.expectedOrders)&&Array.isArray(a.neverPosted)&&
  Array.isArray(a.events)&&boundedHistory(a)&&
  INTEGER.test(a.closedPositionBasisMicros)&&SIGNED_INTEGER.test(a.closedPositionPnlMicros)&&
  a.events.every(e=>(typeof e.id==='string'&&e.id.length<=256&&HASH.test(e.digest)&&
    SIGNED_INTEGER.test(e.cashDeltaMicros)&&SIGNED_INTEGER.test(e.realizedPnlMicros)))&&
  a.expectedOrders.every(o=>Number.isSafeInteger(o.createdAtMs)&&o.createdAtMs>0&&INTEGER.test(o.filledHundredths))&&
  consistentRequests(a));;
}
/** The read-only loader must derive these receipt IDs/digests from the validated
 * no-send verifier. A null exchange order ID alone is not proof of no POST. */
function consistentRequests(a:Held){
 const proved=new Map<string,string>();
 for(const x of a.expectedOrders){
  if(!x.request.clientOrderId||!x.orderId||proved.has(x.request.clientOrderId))return false;
  proved.set(x.request.clientOrderId,digest(x.request));
 }
 for(const x of a.neverPosted){
  if(!x.clientOrderId||!HASH.test(x.receiptDigest)||!HASH.test(x.requestDigest)||proved.has(x.clientOrderId))return false;
  proved.set(x.clientOrderId,x.requestDigest);
 }
 if(proved.size!==a.requests.length||new Set(a.requests.map(r=>r.clientOrderId)).size!==a.requests.length)return false;
 return a.requests.every(r=>r.clientOrderId&&proved.get(r.clientOrderId)===digest(r));
}
function matches(a:Held,b:Snapshot,at:number){
 if(!b.authenticated||!b.complete||!b.cashExact||b.unexplainedCashActivity||b.observedAtMs!==at||
  !Number.isSafeInteger(b.historyFromMs)||b.historyFromMs<0||
  b.historyFromMs>Math.min(at,...a.expectedOrders.map(x=>x.createdAtMs))||b.identity.subaccount!==1||b.identity.exchangeIndex!==2||
  b.identity.keyFingerprint!==a.keyFingerprint||b.cashMicros!==a.cashMicros||
  b.positions.length!==0||b.orders.length!==a.expectedOrders.length||
  b.orders.length>1000||b.fills.length+b.settlements.length>3000)return false;
 const wanted=new Map(a.expectedOrders.map(o=>[o.request.clientOrderId,o]));
 if(wanted.size!==a.expectedOrders.length)return false;
 const orderIds=new Map<string,bigint>(),clients=new Set<string>();
 for(const order of b.orders){
  const local=wanted.get(order.request.clientOrderId);
  if(!local||!order.orderId||!order.request.clientOrderId||!order.terminal||orderIds.has(order.orderId)||clients.has(order.request.clientOrderId)||
   local.orderId!==order.orderId||local.filledHundredths!==order.filledHundredths||!INTEGER.test(order.filledHundredths)||
   digest(local.request)!==digest(order.request))return false;
  orderIds.set(order.orderId,BigInt(order.filledHundredths));clients.add(order.request.clientOrderId);
 }
 const fillTotals=new Map<string,bigint>(),seen=new Map<string,string>();
 for(const [kind,entries] of [['fill',b.fills],['settlement',b.settlements]] as const)for(const event of entries){
  const id=kind+':'+event.id;
  if(!event.id||seen.has(id)||!Number.isSafeInteger(event.occurredAtMs)||event.occurredAtMs>at)return false;
  seen.set(id,digest(event));
  if('orderId' in event){
   if(!orderIds.has(event.orderId)||!INTEGER.test(event.quantityHundredths))return false;
   fillTotals.set(event.orderId,(fillTotals.get(event.orderId)??0n)+BigInt(event.quantityHundredths));
  }
 }
 if([...orderIds].some(([id,total])=>total!==(fillTotals.get(id)??0n)))return false;
 if(a.events.length!==seen.size||new Set(a.events.map(e=>e.id)).size!==a.events.length||
  a.events.some(e=>seen.get(e.id)!==e.digest))return false;
 const cashDelta=a.events.reduce((sum,e)=>sum+BigInt(e.cashDeltaMicros),0n),
  pnl=a.events.reduce((sum,e)=>sum+BigInt(e.realizedPnlMicros),0n);
 const cash=BigInt(a.cashMicros),initial=BigInt(a.initialCashMicros);
 return cash===initial+cashDelta&&cash+BigInt(a.closedPositionBasisMicros)===initial+pnl&&
  BigInt(a.closedPositionPnlMicros)===pnl;
}
export async function inspectStoppedCashDiagnosticPrototype(session:{subject:unknown;aal:unknown},ports:Ports){
 const owner=session.subject;
 if(session.aal!=='aal2'||typeof owner!=='string'||!UUID.test(owner))return no('owner_aal2_required');
 const sha=gate(ports.env());if(!sha)return no('stopped_cash_diagnostic_disabled');
 try{
  const before=await ports.loadHeld(owner);
  if(!held(before,owner,sha))return no('stopped_cash_scope_unverified');
  const proof=canonical(before);
  let material=await ports.verifiedMaterial(owner,before.id,before.keyFingerprint);
  if(!material)return no('stopped_cash_signer_unverified');
  // Detect signer/lease revision changes before dispatch, and recheck again
  // after all awaits. No claim that in-flight GET is an account mutation.
  const dispatch=await ports.loadHeld(owner);
  if(!held(dispatch,owner,sha)||proof!==canonical(dispatch)||gate(ports.env())!==sha)return no('stopped_cash_scope_changed');
  const at=ports.wall(),start=ports.mono();
  if(!Number.isSafeInteger(at)||at<=0||!Number.isFinite(start))return no('stopped_cash_clock_invalid');
  let snapshot:Snapshot|null=null;
  try{snapshot=await ports.bracket(owner,material,at,before.requests,before.keyFingerprint);}
  finally{material=null;}
  if(!snapshot)return no('stopped_cash_bracket_unverified');
  const after=await ports.loadHeld(owner),readDoneWall=ports.wall(),readDone=ports.mono();
  if(!Number.isSafeInteger(readDoneWall)||readDoneWall<at||readDoneWall-at>=MAX_AGE||
   !Number.isFinite(readDone)||readDone<start||readDone-start>=MAX_AGE)return no('stopped_cash_proof_expired');
  if(!held(after,owner,sha)||proof!==canonical(after)||gate(ports.env())!==sha)return no('stopped_cash_scope_changed');
  if(!matches(after,snapshot,at))return no('stopped_cash_history_not_reconciled');
  // Digesting hundreds of rows is part of the original deadline as well.
  const verifiedAt=ports.wall(),finished=ports.mono();
  if(!Number.isSafeInteger(verifiedAt)||verifiedAt<readDoneWall||verifiedAt-at>=MAX_AGE||
   !Number.isFinite(finished)||finished<readDone||finished-start>=MAX_AGE)return no('stopped_cash_proof_expired');
  return pass(snapshot,at,finished-start);
 }catch{return no('stopped_cash_diagnostic_unavailable');}
}
