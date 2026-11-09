/** Fixed-size, non-authoritative transaction phase observations. No SQL, pool
 * interception, extra await, retries, source-clock changes or result mutation.
 * Intervals include local scheduling/JS and network waits; never label DB CPU.
 */
const phases=['requested','transaction_callback','lease_locked','position_read',
 'window_ready','history_ready','classified','work_complete','lease_renewed','committed'] as const;
export type ForwardTransactionPhase=typeof phases[number];
export type ForwardTransactionObserver=(phase:ForwardTransactionPhase)=>void;
const intervalNames=['poolAndBeginMs','leaseLockMs','positionReadMs','windowPreparationMs',
 'historyPreparationMs','classificationPreparationMs','strategyPersistenceMs','leaseRenewalMs','commitAndReleaseMs'] as const;
export type ForwardTransactionSnapshot=Readonly<Record<typeof intervalNames[number],number|null>&{complete:boolean}>;
export function observeForwardTransaction(observer:ForwardTransactionObserver|undefined,phase:ForwardTransactionPhase):void {
 try{observer?.(phase);}catch{/* Optional observer cannot alter SQL or errors. */}
}
export class ForwardTransactionTiming {
 private points:number[]=[];private invalid=false;
 constructor(private readonly clock:()=>number=()=>performance.now()){}
 readonly mark:ForwardTransactionObserver=phase=>{
  try{
   if(this.invalid)return;
   const at=this.clock();
   if(phase!==phases[this.points.length]||!Number.isFinite(at)||at<0||
      (this.points.length>0&&(at<this.points[this.points.length-1]||at-this.points[0]>3_600_000))){this.invalid=true;return;}
   this.points.push(at);
  }catch{this.invalid=true;}
 };
 snapshot():ForwardTransactionSnapshot {
  const complete=!this.invalid&&this.points.length===phases.length;
  const result={complete} as Record<string,number|null|boolean>;
  for(let i=0;i<intervalNames.length;i++)result[intervalNames[i]]=complete
    ?Math.round((this.points[i+1]-this.points[i])*1000)/1000:null;
  return Object.freeze(result) as ForwardTransactionSnapshot;
 }
}
/** Explicit allowlist for any snapshot entering structured logs. */
export function serializeForwardTransaction(value:ForwardTransactionSnapshot|undefined):ForwardTransactionSnapshot|null {
 if(!value)return null;
 const complete=value.complete===true&&intervalNames.every(key=>{const n=value[key];return typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=3_600_000;});
 const out={complete} as Record<string,number|null|boolean>;
 for(const key of intervalNames)out[key]=complete?value[key]:null;
 return Object.freeze(out) as ForwardTransactionSnapshot;
}
