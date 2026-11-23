/** Internal read-only assembly. No configured provider, HTTP route, or writer. */
import {randomBytes} from 'node:crypto';
import {verifyCurrentCashIssuerProof as verify} from './currentCashIssuerProof';
type Challenge=Parameters<typeof verify>[1];
type Pin=Parameters<typeof verify>[2][number];
type Scope=Omit<Challenge,'nonce'|'issuedAtMs'>;
type Ports={
 // Must resolve scope and settlement from trusted account state, never the returned packet.
 readStoppedScope:()=>Promise<Scope|null>;
 trustPins:()=>readonly Pin[];
 fetchRecord?:(challenge:Readonly<Challenge>,signal:AbortSignal)=>Promise<unknown>;
 now?:()=>number;
};
const no=(reason:string)=>({ok:false as const,reason,holdCleared:false as const,tradingAuthorized:false as const});
const same=(a:Scope,b:Scope)=>a.accountScopeDigest===b.accountScopeDigest&&a.buildSha===b.buildSha&&
 a.stopRevisionDigest===b.stopRevisionDigest&&a.settlementId===b.settlementId&&a.settlementDigest===b.settlementDigest;
export async function observeCurrentCashIssuerRecord(p:Ports){
 let timer:ReturnType<typeof setTimeout>|undefined;
 const abort=new AbortController();
 const now=p.now??Date.now;
 const fetchRecord=p.fetchRecord;
 if(!fetchRecord)return no('issuer_source_unconfigured');
 const read=async()=>{
  try{
   const found=await p.readStoppedScope();
   if(!found||abort.signal.aborted)return no('stopped_scope_unverified');
   const initial=Object.freeze({...found});
   const activePins=p.trustPins().filter(pin=>pin.accountScopeDigest===initial.accountScopeDigest&&pin.buildSha===initial.buildSha);
   if(!activePins.length)return no('issuer_trust_unconfigured');
   // Single-use per invocation; never accept a body-provided challenge or reuse it after return.
   const challenge=Object.freeze({...initial,nonce:randomBytes(32).toString('hex'),issuedAtMs:now()});
   const packet=await fetchRecord(challenge,abort.signal);
   if(abort.signal.aborted)return no('issuer_observation_timeout');
   const final=await p.readStoppedScope();
   if(!final||!same(initial,final)||abort.signal.aborted)return no('stopped_scope_changed');
   // Check current pin validity and permit revocation while a read is in flight.
   return verify(packet,challenge,p.trustPins(),now());
  }catch{return no('issuer_observation_unavailable');}
 };
 try{
  const timeout=new Promise<ReturnType<typeof no>>(resolve=>{
   timer=setTimeout(()=>{abort.abort();resolve(no('issuer_observation_timeout'));},5000);
  });
  return await Promise.race([read(),timeout]);
 }finally{clearTimeout(timer);abort.abort();}
}
