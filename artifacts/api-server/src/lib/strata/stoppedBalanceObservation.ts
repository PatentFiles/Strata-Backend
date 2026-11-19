/** Scoped signed balance-only observation; never release/clearance evidence. */
import type {getOwnedProductionKalshiJson} from './personalExchangeRead';
import type {balanceEvidence} from './settledCashBracket';
type Header={owner:string,id:string,held:boolean,fingerprint:string,cash:string,fence:string};
type Get=typeof getOwnedProductionKalshiJson;
type Ports={exactOwnerGate:(owner:string)=>boolean;heldHeader:(owner:string)=>Promise<Header|null>;
 verifiedMaterial:(owner:string,id:string,fingerprint:string)=>Promise<Parameters<Get>[0]|null>;
 scopedGet:Get;parseBalance:typeof balanceEvidence;wall:()=>number;mono:()=>number};
type Status='balance_observation_unverified'|'balance_matches_local_cash_history_unverified'|'balance_differs_from_local_cash_history_unverified';
const UINT=/^(0|[1-9]\d{0,18})$/;
const HASH=/^[a-f0-9]{64}$/;
const OWNER=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_AGE=5000, PATH='/trade-api/v2/portfolio/balance', QUERY='?subaccount=1&exchange_index=2';
const label=(status:Status)=>({status,historyUnverified:true as const,accountWritesPerformed:false as const,
 observationPersisted:false as const,ordersSubmitted:false as const,tradingAuthorized:false as const});
const no=()=>label('balance_observation_unverified');
const validHeader=(x:Header|null,owner:string):x is Header=>x?.owner===owner&&x.held===true&&typeof x.id==='string'&&x.id.length>0&&
 HASH.test(x.fingerprint)&&HASH.test(x.fence)&&typeof x.cash==='string'&&UINT.test(x.cash);
const same=(a:Header,b:Header)=>b.id===a.id&&b.fingerprint===a.fingerprint&&b.fence===a.fence&&b.cash===a.cash;
const validCash=(x:ReturnType<typeof balanceEvidence>):x is NonNullable<ReturnType<typeof balanceEvidence>>=>typeof x?.cash==='string'&&UINT.test(x.cash)&&Number.isSafeInteger(x.updated)&&x.updated>0;
export async function observeStoppedBalanceOnly(session:{subject:unknown;aal:unknown},p:Ports){
 const owner=session?.subject;
 if(typeof owner!=='string'||!OWNER.test(owner)||session.aal!=='aal2'||p.exactOwnerGate(owner)!==true)return no();
 // No production registration: header must project existing exact stopped scope and fingerprint.
 try{
  const initial=await p.heldHeader(owner);if(!validHeader(initial,owner))return no();
  const a=Object.freeze({...initial});
  const material=await p.verifiedMaterial(owner,a.id,a.fingerprint);
  if(!material||p.exactOwnerGate(owner)!==true)return no();
  const pre=await p.heldHeader(owner);
  if(!validHeader(pre,owner)||!same(a,pre)||p.exactOwnerGate(owner)!==true)return no();
  const start=p.wall(), mono=p.mono();
  if(!Number.isSafeInteger(start)||start<=0||!Number.isFinite(mono)||mono<0)return no();
  const signal=AbortSignal.timeout(MAX_AGE);
  let lastWall=start,lastMono=mono;
  const live=()=>{const wall=p.wall(),m=p.mono();if(!Number.isSafeInteger(wall)||wall<lastWall||
    !Number.isFinite(m)||m<lastMono||wall-start>=MAX_AGE||m-mono>=MAX_AGE||signal.aborted)return false;
    lastWall=wall;lastMono=m;return true;};
  const read=async()=>p.parseBalance(await p.scopedGet(material,PATH,QUERY,undefined,undefined,owner,signal),lastWall);
  const head=await read();if(!live()||!validCash(head))return no();
  if(p.exactOwnerGate(owner)!==true)return no();
  const tail=await read();if(!live()||!validCash(tail)||head.cash!==tail.cash||head.updated!==tail.updated)return no();
  const b=await p.heldHeader(owner);
  if(!validHeader(b,owner)||!same(a,b)||p.exactOwnerGate(owner)!==true||!live())return no();
  return {...label(head.cash===a.cash?'balance_matches_local_cash_history_unverified':'balance_differs_from_local_cash_history_unverified'),
   observedAt:new Date(start).toISOString()};
 }catch{return no();}
}
