import {AsyncResource} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {captureMemberHistoryLaneEligibility} from './kalshiMemberReadBudget';
/** One process-wide pool. Legacy/default-off work remains <=2; only an active
 * verified prepaid snapshot can use six. Both classes together stay <=6.
 * This is not provider-wide quota. Failed/canceled work drains before release. */
const GLOBAL_CAP=6, LEGACY_CAP=2, CREDENTIAL_CAP=6, QUEUE_CAP=64;
type Job={key:string;signal:AbortSignal;eligibility:(()=>boolean)|null;start:()=>void;reject:(error:unknown)=>void;onAbort:()=>void};
const queued:Job[]=[],activeByKey=new Map<string,number>();let active=0,legacyActive=0;
export const historyLaneCredentialKey=(keyId:string)=>createHash('sha256').update(keyId).digest('hex');
function valid(job:Job){return !job.signal.aborted&&(!job.eligibility||job.eligibility());}
function pump(){
 for(let i=0;i<queued.length&&active<GLOBAL_CAP;){
  const job=queued[i];
  if(!valid(job)){queued.splice(i,1);job.signal.removeEventListener('abort',job.onAbort);job.reject(job.signal.reason??Error('bounded_history_context_expired'));continue;}
  if((!job.eligibility&&legacyActive>=LEGACY_CAP)||(activeByKey.get(job.key)??0)>=CREDENTIAL_CAP){i++;continue;}
  queued.splice(i,1);job.signal.removeEventListener('abort',job.onAbort);job.start();
 }
}
export function inBoundedHistoryReadLane<T>(key:string,signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
 const boundOperation=AsyncResource.bind(operation);
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}
  if(queued.length>=QUEUE_CAP){reject(Error('bounded_history_lane_busy'));return;}
  // Capture inside executor so failure is a rejected promise, allowing allSettled drain.
  const eligibility=captureMemberHistoryLaneEligibility();
  const job:Job={key,signal,eligibility,reject,onAbort:()=>{const at=queued.indexOf(job);if(at>=0){queued.splice(at,1);reject(signal.reason);pump();}},start:()=>{
   active++;if(!eligibility)legacyActive++;activeByKey.set(key,(activeByKey.get(key)??0)+1);
   Promise.resolve().then(()=>{signal.throwIfAborted();if(eligibility&&!eligibility())throw Error('bounded_history_context_expired');return boundOperation();}).then(resolve,reject).finally(()=>{
    active--;if(!eligibility)legacyActive--;const n=(activeByKey.get(key)??1)-1;if(n)activeByKey.set(key,n);else activeByKey.delete(key);pump();
   });
  }};
  signal.addEventListener('abort',job.onAbort,{once:true});queued.push(job);pump();
 });
}
