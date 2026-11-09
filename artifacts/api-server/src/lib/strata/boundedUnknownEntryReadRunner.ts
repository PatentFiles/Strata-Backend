/** Unregistered server-only read runner. Constructor dependency must be the
 * existing authenticated, bounded, GET-only collector; no request-body ports.
 * Never treats success as ledger/account/position proof. A timeout abandons
 * this instance forever, even if the collector ignores cancellation.
 */
export function createBoundedUnknownEntryReadRunner<T>(deps:{
 now:()=>number; deadlineMs?:number; externalSignal?:AbortSignal;
 authorizeRead:(signal:AbortSignal)=>Promise<void>;
 read:(signal:AbortSignal)=>Promise<T>;
}){
 const {now:readClock,authorizeRead,read,deadlineMs,externalSignal}=deps;
 let used=false;
 return async function run():Promise<
  {ok:true;snapshot:T;attempts:number;tradingAuthorized:false}|
  {ok:false;reason:string;attempts:number;tradingAuthorized:false}
 >{
  const no=(reason:string,attempts:number)=>({ok:false as const,reason,attempts,tradingAuthorized:false as const});
  if(used)return no('recovery_runner_already_consumed',0);
  used=true;
  const start=readClock();
  if(!Number.isSafeInteger(start)||start<=0||start>8640000000000000-15000)return no('invalid_recovery_clock',0);
  const deadline=deadlineMs??start+15000;
  if(!Number.isSafeInteger(deadline)||deadline<=start||deadline-start>15000)return no('invalid_recovery_deadline',0);
  const controller=new AbortController();
  if(externalSignal?.aborted)return no("recovery_external_stop",0);
  let timer:ReturnType<typeof setTimeout>|undefined;
  let stop:(()=>void)|undefined;
  const timeout=new Promise<{timeout:true}>(resolve=>{
   stop=()=>{controller.abort();resolve({timeout:true});};
   externalSignal?.addEventListener("abort",stop,{once:true});
   timer=setTimeout(stop,deadline-start);
  });
  let lastNow=start;
  try{
   for(let attempt=1;attempt<=3;attempt++){
    const now=readClock();
    if(!Number.isSafeInteger(now)||now<lastNow||now>=deadline)return no('recovery_clock_or_deadline',attempt-1);
    lastNow=now;
    // Authorization refusal is terminal, not a retryable feed failure.
    const admitted=await Promise.race([authorizeRead(controller.signal).then(()=>({admitted:true as const}),()=>({admitted:false as const})),timeout]);
    if('timeout' in admitted)return no('recovery_deadline_transport_abandoned',attempt-1);
    if(!admitted.admitted)return no('recovery_read_authorization_refused',attempt-1);
    if(controller.signal.aborted)return no('recovery_deadline_transport_abandoned',attempt-1);
    const beforeRead=readClock();
    if(!Number.isSafeInteger(beforeRead)||beforeRead<lastNow||beforeRead>=deadline)return no('recovery_clock_or_deadline',attempt-1);
    lastNow=beforeRead;
    const result=await Promise.race([read(controller.signal).then(snapshot=>({snapshot}),()=>({failed:true as const})),timeout]);
    if('timeout' in result)return no('recovery_deadline_transport_abandoned',attempt);
    const completed=readClock();
    if(!Number.isSafeInteger(completed)||completed<lastNow||completed>=deadline)return no('recovery_clock_or_deadline',attempt);
    lastNow=completed;
    if('snapshot' in result)return {ok:true,snapshot:result.snapshot,attempts:attempt,tradingAuthorized:false};
    // The previous underlying promise settled before retry. No Promise.race
    // timeout ever reaches this branch, so an ignored abort cannot overlap.
   }
   return no('recovery_attempts_exhausted',3);
  }finally{if(timer)clearTimeout(timer);if(stop)externalSignal?.removeEventListener("abort",stop);controller.abort();}
 };
}
