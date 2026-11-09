/** Non-authoritative local timing. No prices, account data, network or DB writes.
 * Clock reads are separate from the strategy clock and never gate a cycle.
 * State is bounded to 32 engines; counters reset on process restart/eviction.
 */
export type CycleTiming = {
 cycleObservedAtMs:number|null; feedsDecodedObservedAtMs:number|null;
 classifierStartedAtMs:number|null; classifierFinishedAtMs:number|null;
 commitReturnedAtMs:number|null;
};
export function diagnosticWallNow(clock:()=>number=Date.now):number|null {
 try { const n=clock();return Number.isSafeInteger(n)&&n>=0?n:null; } catch{return null;}
}
type State={providerAt:number|null;receivedAt:number|null;observations:number;
 duplicateProviderTimestamps:number;regressedProviderTimestamps:number;
 receiveGapsOver30Seconds:number;lastEmit:number|null};
export class ForwardCycleDiagnostics {
 private queued=false;
 private readonly states=new Map<string,State>();
 constructor(private readonly emit:(event:Record<string,unknown>)=>void,
  private readonly monotonicNow:()=>number=()=>performance.now(),
  private readonly schedule:(callback:()=>void)=>void=callback=>{setImmediate(callback);}){}
 observe(engineId:string,providerAt:number,receivedAt:number):void {
  try {
   if(!Number.isSafeInteger(providerAt)||!Number.isSafeInteger(receivedAt))return;
   let state=this.states.get(engineId);
   if(!state){
    if(this.states.size>=32)this.states.delete(this.states.keys().next().value!);
    state={providerAt:null,receivedAt:null,observations:0,duplicateProviderTimestamps:0,
     regressedProviderTimestamps:0,receiveGapsOver30Seconds:0,lastEmit:null};
    this.states.set(engineId,state);
   }
   const inc=(n:number)=>Math.min(Number.MAX_SAFE_INTEGER,n+1);
   state.observations=inc(state.observations);
   if(state.providerAt===providerAt)state.duplicateProviderTimestamps=inc(state.duplicateProviderTimestamps);
   if(state.providerAt!==null&&providerAt<state.providerAt)state.regressedProviderTimestamps=inc(state.regressedProviderTimestamps);
   if(state.receivedAt!==null&&receivedAt-state.receivedAt>30_000)state.receiveGapsOver30Seconds=inc(state.receiveGapsOver30Seconds);
   state.providerAt=providerAt;state.receivedAt=receivedAt;
  }catch{/* Never affect strategy. */}
 }
 committed(engineId:string,timing:CycleTiming,source:{evaluationId:string|null;evaluatedAtMs:number;btcProviderAtMs:number;
  btcReceivedAtMs:number;marketDecodedAtMs:number}):void {
  try {
   const state=this.states.get(engineId);if(!state)return;
   const mono=this.monotonicNow();if(!Number.isFinite(mono)||mono<0)return;
   if(state.lastEmit!==null&&mono-state.lastEmit<30_000)return;
   state.lastEmit=mono;
   // Explicit allowlist: never spread caller data into telemetry.
   const event={event:'forward_cycle_timing',schemaVersion:1,authority:'DIAGNOSTIC_ONLY',
    evaluationId:source.evaluationId&&/^[a-f0-9-]{36}$/i.test(source.evaluationId)?source.evaluationId:null,
    timestampAuthority:'LOCAL_WALL_CLOCK_OBSERVATIONS',coverage:'SAMPLED_COMMITTED_CYCLES',
    counterScope:'PROCESS_LOCAL_BOUNDED_ENGINE_STATE',
    cycleObservedAtMs:timing.cycleObservedAtMs,feedsDecodedObservedAtMs:timing.feedsDecodedObservedAtMs,
    classifierStartedAtMs:timing.classifierStartedAtMs,classifierFinishedAtMs:timing.classifierFinishedAtMs,
    commitReturnedAtMs:timing.commitReturnedAtMs,legacyEvaluatedAtMs:source.evaluatedAtMs,
    btcProviderAtMs:source.btcProviderAtMs,btcReceivedAtMs:source.btcReceivedAtMs,
    marketDecodedAtMs:source.marketDecodedAtMs,
    observations:state.observations,duplicateProviderTimestamps:state.duplicateProviderTimestamps,
    regressedProviderTimestamps:state.regressedProviderTimestamps,receiveGapsOver30Seconds:state.receiveGapsOver30Seconds};
   if(this.queued)return;this.queued=true;
   try{this.schedule(()=>{try{this.emit(event);}catch{}finally{this.queued=false;}});}
   catch{this.queued=false;}
  }catch{/* Logging failure must not fail committed strategy work. */}
 }
}
