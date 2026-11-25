/** Advisory telemetry only. No order execution, credentials, or owner authority.
 * Capacity includes the in-flight batch. Retry the SAME immutable objects after
 * uncertain commits; the writer must verify their idempotent persisted identity.
 * This is not a crash-durable queue and never reports complete coverage. */
export class BoundedAnalyticsQueue<T> {
 private queue:{value:T;attempts:number}[]=[];
 private flight:Promise<void>|null=null;
 private inFlight=0;
 private timer:ReturnType<typeof setTimeout>|null=null;
 private closing=false;
 private totals={accepted:0,confirmed:0,overflow:0,retryExhausted:0,rejected:0,retries:0,afterClose:0};
 constructor(private readonly write:(rows:T[])=>Promise<number>,
  private readonly options:{capacity?:number;batchSize?:number;maxAttempts?:number;delayMs?:number;onGap?:()=>void}={}) {
  for(const n of [options.capacity??256,options.batchSize??64,options.maxAttempts??3,options.delayMs??1000])
   if(!Number.isSafeInteger(n)||n<1)throw Error('analytics_queue_config_invalid');
  if((options.batchSize??64)>(options.capacity??256))throw Error('analytics_queue_batch_exceeds_capacity');
 }
 enqueue(value:T):boolean {
  if(this.closing){this.totals.afterClose++;this.gap();return false;}
  if(this.queue.length+this.inFlight>=(this.options.capacity??256)){
   this.totals.overflow++;this.gap();return false;
  }
  this.queue.push({value,attempts:0});this.totals.accepted++;this.schedule();return true;
 }
 snapshot(){return {...this.totals,pending:this.queue.length+this.inFlight,accepting:!this.closing,complete:false as const};}
 private gap(){try{this.options.onGap?.();}catch{/* Diagnostics cannot interrupt trading. */}}
 private schedule(){
  if(this.closing||this.timer||this.flight||!this.queue.length)return;
  this.timer=setTimeout(()=>{this.timer=null;void this.drain();},this.options.delayMs??1000);this.timer.unref();
 }
 /** Exposed for bounded shutdown and deterministic, disconnected tests. */
 drain():Promise<void>{
  if(this.flight)return this.flight;
  if(!this.queue.length)return Promise.resolve();
  if(this.timer){clearTimeout(this.timer);this.timer=null;}
  const batch=this.queue.splice(0,this.options.batchSize??64);this.inFlight=batch.length;
  const run=async()=>{
   try{
    const confirmed=await this.write(batch.map(v=>v.value));
    if(!Number.isSafeInteger(confirmed)||confirmed<0||confirmed>batch.length)throw Error('analytics_confirmation_invalid');
    this.totals.confirmed+=confirmed;this.totals.rejected+=batch.length-confirmed;
    if(confirmed!==batch.length)this.gap();
   }catch{
    const retry:typeof batch=[];
    for(const item of batch){
     item.attempts++;
     if(item.attempts<(this.options.maxAttempts??3)){retry.push(item);this.totals.retries++;}
     else this.totals.retryExhausted++;
    }
    // New enqueues included this batch in capacity while it was in flight.
    this.queue.unshift(...retry);
    if(retry.length!==batch.length)this.gap();
   }finally{this.inFlight=0;}
  };
  this.flight=Promise.resolve().then(run).finally(()=>{this.flight=null;this.schedule();});
  return this.flight;
 }
 async flush(timeoutMs=5000):Promise<boolean>{
  this.closing=true;if(this.timer){clearTimeout(this.timer);this.timer=null;}
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const work=async()=>{while(this.queue.length||this.flight)await this.drain();return true;};
  try{return await Promise.race([work(),new Promise<false>(resolve=>{timeout=setTimeout(()=>resolve(false),timeoutMs);})]);}
  finally{if(timeout)clearTimeout(timeout);}
 }
}
