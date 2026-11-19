/** Scoped signed balance-only observation; never release/clearance evidence. */
import type {getOwnedProductionKalshiJson} from './personalExchangeRead';
import type {balanceEvidence} from './settledCashBracket';
type Header={owner:string,id:string,held:boolean,fingerprint:string,cash:string,fence:string};
type Get=typeof getOwnedProductionKalshiJson;
type Ports={exactOwnerGate:(owner:string)=>boolean;heldHeader:(owner:string)=>Promise<Header|null>;
 verifiedMaterial:(owner:string,id:string,fingerprint:string)=>Promise<Parameters<Get>[0]|null>;
 observeTransport?:(read:1|2)=>void;scopedGet:Get;parseBalance:typeof balanceEvidence;wall:()=>number;mono:()=>number};
type Status='balance_observation_unverified'|'balance_matches_local_cash_history_unverified'|'balance_differs_from_local_cash_history_unverified';
const UINT=/^(0|[1-9]\d{0,18})$/;
const HASH=/^[a-f0-9]{64}$/;
const OWNER=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_AGE=5000, PATH='/trade-api/v2/portfolio/balance', QUERY='?subaccount=1&exchange_index=2';
const label=(status:Status)=>({status,historyUnverified:true as const,accountWritesPerformed:false as const,
 observationPersisted:false as const,ordersSubmitted:false as const,tradingAuthorized:false as const});
export const STOPPED_BALANCE_FAILURE_STAGES=[
 'held_scope_unverified','credential_unverified','scope_changed_before_read','clock_unverified',
 'opening_read_before_fetch','opening_fetch_unverified','closing_read_before_fetch','closing_fetch_unverified',
 'balance_changed','scope_changed_after_read','deadline_elapsed','observation_unavailable',
] as const;
type Stage=typeof STOPPED_BALANCE_FAILURE_STAGES[number];
const no=(failureStage:Stage)=>({...label('balance_observation_unverified'),failureStage});
const validHeader=(x:Header|null,owner:string):x is Header=>x?.owner===owner&&x.held===true&&typeof x.id==='string'&&x.id.length>0&&
 HASH.test(x.fingerprint)&&HASH.test(x.fence)&&typeof x.cash==='string'&&UINT.test(x.cash);
const same=(a:Header,b:Header)=>b.id===a.id&&b.fingerprint===a.fingerprint&&b.fence===a.fence&&b.cash===a.cash;
const validCash=(x:ReturnType<typeof balanceEvidence>):x is NonNullable<ReturnType<typeof balanceEvidence>>=>typeof x?.cash==='string'&&UINT.test(x.cash)&&Number.isSafeInteger(x.updated)&&x.updated>0;
export async function observeStoppedBalanceOnly(session:{subject:unknown;aal:unknown},p:Ports){
 const owner=session?.subject;
 if(typeof owner!=='string'||!OWNER.test(owner)||session.aal!=='aal2'||p.exactOwnerGate(owner)!==true)return no('observation_unavailable');
 // No production registration: header must project existing exact stopped scope and fingerprint.
 let stage:Stage='held_scope_unverified';
 try{
  const initial=await p.heldHeader(owner);if(!validHeader(initial,owner))return no(stage);
  const a=Object.freeze({...initial});
  stage='credential_unverified';
  const material=await p.verifiedMaterial(owner,a.id,a.fingerprint);
  if(!material||p.exactOwnerGate(owner)!==true)return no(stage);
  stage='scope_changed_before_read';
  const pre=await p.heldHeader(owner);
  if(!validHeader(pre,owner)||!same(a,pre)||p.exactOwnerGate(owner)!==true)return no(stage);
  const start=p.wall(), mono=p.mono();
  if(!Number.isSafeInteger(start)||start<=0||!Number.isFinite(mono)||mono<0)return no('clock_unverified');
  const signal=AbortSignal.timeout(MAX_AGE);
  let lastWall=start,lastMono=mono;
  const live=()=>{const wall=p.wall(),m=p.mono();if(!Number.isSafeInteger(wall)||wall<lastWall||
    !Number.isFinite(m)||m<lastMono||wall-start>=MAX_AGE||m-mono>=MAX_AGE||signal.aborted)return false;
    lastWall=wall;lastMono=m;return true;};
  const read=async(leg:1|2)=>{
   stage=leg===1?'opening_read_before_fetch':'closing_read_before_fetch';
   const payload=await p.scopedGet(material,PATH,QUERY,undefined,undefined,owner,signal,()=>{
    stage=leg===1?'opening_fetch_unverified':'closing_fetch_unverified';
    try{p.observeTransport?.(leg);}catch{/* diagnostics do not affect observation */}
   });
   return p.parseBalance(payload,lastWall);
  };
  const head=await read(1);if(!live())return no('deadline_elapsed');if(!validCash(head))return no(stage);
  if(p.exactOwnerGate(owner)!==true)return no('observation_unavailable');
  const tail=await read(2);if(!live())return no('deadline_elapsed');if(!validCash(tail))return no(stage);
  if(head.cash!==tail.cash||head.updated!==tail.updated)return no('balance_changed');
  stage='scope_changed_after_read';
  const b=await p.heldHeader(owner);
  if(!validHeader(b,owner)||!same(a,b)||p.exactOwnerGate(owner)!==true)return no(stage);
  if(!live())return no('deadline_elapsed');
  return {...label(head.cash===a.cash?'balance_matches_local_cash_history_unverified':'balance_differs_from_local_cash_history_unverified'),
   observedAt:new Date(start).toISOString()};
 }catch{return no(stage);}
}
