/** Internal unmounted read-only assembly. No configured issuer or writer. */
import {createHash,randomBytes} from 'node:crypto';
import {verifyCurrentObligationsProof,verifyPostedSettlementProof,type CashCommonChallenge,type CashIssuerPin,
 type CurrentObligationsChallenge,type PostedSettlementChallenge} from './currentCashIssuerProof';
type Scope<C>=Omit<C,'nonce'|'issuedAtMs'>;
type Ports<C>={
 readStoppedScope:()=>Promise<Scope<C>|null>;
 trustPins:()=>readonly CashIssuerPin[];
 fetchRecord?:(challenge:Readonly<C>,signal:AbortSignal)=>Promise<unknown>;
 now?:()=>number;
};
const no=(reason:string)=>({ok:false as const,reason,holdCleared:false as const,tradingAuthorized:false as const});
const sameCommon=(a:Scope<CashCommonChallenge>,b:Scope<CashCommonChallenge>)=>a.accountScopeDigest===b.accountScopeDigest&&
 a.buildSha===b.buildSha&&a.stopRevisionDigest===b.stopRevisionDigest;
// Snapshots include key bytes and pin validity. Reject a trust change during
// the observation; a newly trusted issuer cannot validate an already-started challenge.
function snapshotPins(pins:readonly CashIssuerPin[],scope:Scope<CashCommonChallenge>){
 const scopedIds=new Set(pins.filter(pin=>pin.accountScopeDigest===scope.accountScopeDigest&&pin.buildSha===scope.buildSha)
  .map(pin=>pin.issuerKeyId));
 // Preserve the verifier’s global duplicate-ID refusal for relevant IDs.
 const applicable=pins.filter(pin=>scopedIds.has(pin.issuerKeyId)).map(pin=>Object.freeze({...pin}));
 const fingerprint=createHash('sha256').update(JSON.stringify(applicable.map(pin=>JSON.stringify([
  pin.issuerKeyId,pin.accountScopeDigest,pin.buildSha,pin.notBeforeMs,pin.expiresAtMs,pin.publicKey.export({type:'spki',format:'der'}).toString('hex'),
 ])).sort())).digest('hex');
 return {applicable,fingerprint};
}
async function observe<C extends CashCommonChallenge,R>(p:Ports<C>,
 same:(a:Scope<C>,b:Scope<C>)=>boolean,verify:(body:unknown,challenge:C,pins:readonly CashIssuerPin[],now:number)=>R){
 let timer:ReturnType<typeof setTimeout>|undefined;
 const abort=new AbortController(),now=p.now??Date.now,fetchRecord=p.fetchRecord;
 const start=performance.now(),live=()=>!abort.signal.aborted&&performance.now()-start<5000;
 if(!fetchRecord)return no('issuer_source_unconfigured');
 const read=async()=>{
  try{
   const found=await p.readStoppedScope();
   if(!found||!live())return no('stopped_scope_unverified');
   const initial=Object.freeze({...found});
   const startPins=snapshotPins(p.trustPins(),initial);
   if(!startPins.applicable.length)
    return no('issuer_trust_unconfigured');
   const challenge=Object.freeze({...initial,nonce:randomBytes(32).toString('hex'),issuedAtMs:now()}) as unknown as Readonly<C>;
   const packet=await fetchRecord(challenge,abort.signal);
   if(!live())return no('issuer_observation_timeout');
   const final=await p.readStoppedScope();
   if(!final||!sameCommon(initial,final)||!same(initial,final)||!live())return no('stopped_scope_changed');
   const endPins=snapshotPins(p.trustPins(),initial);
   if(startPins.fingerprint!==endPins.fingerprint)return no('issuer_trust_changed');
   const result=verify(packet,challenge,startPins.applicable,now());
   return live()?result:no('issuer_observation_timeout');
  }catch{return no('issuer_observation_unavailable');}
 };
 try{
  const timeout=new Promise<ReturnType<typeof no>>(resolve=>{
   timer=setTimeout(()=>{abort.abort();resolve(no('issuer_observation_timeout'));},5000);
  });
  return await Promise.race([read(),timeout]);
 }finally{clearTimeout(timer);abort.abort();}
}
/** readStoppedScope must supply currentCutDigest from a COMPLETE code-owned
 * exact-pair cash + order + inventory cut, never packet/client-supplied. */
export const observeCurrentCashObligations=(p:Ports<CurrentObligationsChallenge>)=>
 observe(p,(a,b)=>a.currentCutDigest===b.currentCutDigest,verifyCurrentObligationsProof);
/** Selected settlement identity and digest come from trusted incident records. */
export const observePostedSettlement=(p:Ports<PostedSettlementChallenge>)=>
 observe(p,(a,b)=>a.settlementId===b.settlementId&&a.settlementDigest===b.settlementDigest,verifyPostedSettlementProof);
