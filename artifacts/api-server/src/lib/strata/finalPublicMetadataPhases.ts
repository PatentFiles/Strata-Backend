import {AsyncLocalStorage} from 'node:async_hooks';
import {CommittedPublicMetadataCoordinator,type MetadataPrefetchScope,type PreparedMetadataSource,type PrefetchedPublicMetadata,type PhaseMetadataAttempt} from './committedPublicMetadata';
export type FinalPublicMetadataContext=Readonly<{intentId:string;invocation:symbol;source:PreparedMetadataSource}>;
export interface FinalPublicMetadataHooks {
 start(phase:'FINAL_MARKET'|'WIRE_FEE',context:FinalPublicMetadataContext):void;
 finalMarket<T>(context:FinalPublicMetadataContext,operation:()=>Promise<T>):Promise<T>;
 finish(intentId:string,invocation:symbol):void;
}
/** Public bytes only. No retained account snapshot, fee approval or order authority.
 * One owned session shares the existing process-wide coordinator budget.
 */
export class FinalPublicMetadataPhases implements FinalPublicMetadataHooks {
 private readonly contexts=new AsyncLocalStorage<FinalPublicMetadataContext>();
 private readonly attempts=new Map<string,{context:FinalPublicMetadataContext;phase:'FINAL_MARKET'|'WIRE_FEE';attempt:PhaseMetadataAttempt}>();
 constructor(private readonly coordinator:CommittedPublicMetadataCoordinator,
  private readonly scope:()=>MetadataPrefetchScope,private readonly allowed:()=>boolean,
  private readonly releasePrepare:()=>void=()=>{}){}
 start(phase:'FINAL_MARKET'|'WIRE_FEE',context:FinalPublicMetadataContext):void {
  // Optional scheduling cannot introduce an earlier authority/provider denial.
  try {
   if(!this.allowed()||this.attempts.has(context.intentId)||this.attempts.size)return;
   if(phase==='FINAL_MARKET')this.releasePrepare();
   const attempt=this.coordinator.startPhase(this.scope(),context.source,{phase,intentId:context.intentId});
   if(attempt)this.attempts.set(context.intentId,{context:Object.freeze({intentId:context.intentId,invocation:context.invocation,source:Object.freeze({...context.source})}),phase,attempt});
  }catch{/* An unstarted advisory attempt leaves the original fresh path. */}
 }
 async finalMarket<T>(context:FinalPublicMetadataContext,operation:()=>Promise<T>):Promise<T>{
  try{return await this.contexts.run(context,operation);}finally{this.finishPhase(context.intentId,'FINAL_MARKET',context.invocation);}
 }
 consumeFinalMarket(market:string):PrefetchedPublicMetadata|undefined {
  const context=this.contexts.getStore();if(!context)return undefined;
  const entry=this.attempts.get(context.intentId);
  if(entry&&entry.context.invocation!==context.invocation)throw Error('phase_metadata_invocation_mismatch');
  return this.consume(context.intentId,market,'FINAL_MARKET',context.source);
 }
 consumeWire(clientOrderId:string,market:string):PrefetchedPublicMetadata|undefined {
  const id=clientOrderId.startsWith('v13p-')?clientOrderId.slice(5):'';
  return this.consume(id,market,'WIRE_FEE');
 }
 private consume(id:string,market:string,phase:'FINAL_MARKET'|'WIRE_FEE',source?:PreparedMetadataSource):PrefetchedPublicMetadata|undefined {
  const entry=this.attempts.get(id);
  if(!entry){if(this.attempts.size)throw Error('phase_metadata_intent_mismatch');return undefined;}
  if(!this.allowed()){entry.attempt.discard('phase_metadata_authority_hold');throw Error('phase_metadata_authority_hold');}
  if(entry.phase!==phase||entry.context.source.marketTicker!==market)throw Error('phase_metadata_consumer_mismatch');
  return entry.attempt.consume(this.scope(),source??entry.context.source,{phase,intentId:id});
 }
 private finishPhase(id:string,phase:'FINAL_MARKET'|'WIRE_FEE',invocation:symbol){
  const entry=this.attempts.get(id);if(entry?.phase===phase&&entry.context.invocation===invocation){entry.attempt.discard();this.attempts.delete(id);}
 }
 finish(id:string,invocation:symbol):void {const entry=this.attempts.get(id);if(entry&&entry.context.invocation===invocation){entry.attempt.discard();this.attempts.delete(id);}}
 discardAll():void {
  // Keep started/cancelled attempts until their owning dispatch finishes.
  // Otherwise a concurrent consumer would mistake cancellation for no attempt
  // and perform a fresh retry after STOP. The map is bounded to one intent.
  for(const entry of this.attempts.values())entry.attempt.discard("phase_metadata_cancelled");
 }
}
