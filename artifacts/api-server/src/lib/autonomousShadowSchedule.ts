/** Optional daily research scheduling only. No timers, DB, or live authority.
 * Retry a failed/uncertain attempt at most twice: the job must re-read its
 * durable per-day candidate before inserting, as runAutonomousShadowResearch does.
 * A successful COLLECTING/NO_CHANGE/CAPACITY result completes that UTC date.
 */
export class AutonomousShadowSchedule {
 private pending:Promise<void>|null=null;
 private day:number|null=null;
 private lastClock:number|null=null;
 private attempts=0;
 private complete=false;
 private nextAttemptAt=0;
 private stopped=false;
 constructor(private readonly clock:()=>number=Date.now){}
 submit<T>(nowMs:number,work:(at:Date)=>Promise<T>,
  onResult:(result:T)=>void,onError:(error:unknown)=>void):boolean{
  if(this.stopped||!Number.isSafeInteger(nowMs)||!Number.isFinite(new Date(nowMs).getTime())||
    nowMs<0||(this.lastClock!==null&&nowMs<this.lastClock))return false;
  this.lastClock=nowMs;
  if(this.pending)return false;
  const day=Math.floor(nowMs/86_400_000);
  if(this.day===null||day>this.day){
   this.day=day;this.attempts=0;this.complete=false;this.nextAttemptAt=0;
  }
  if(day!==this.day||this.complete||this.attempts>=3||nowMs<this.nextAttemptAt)return false;
  this.attempts++;
  this.pending=Promise.resolve().then(()=>work(new Date(nowMs))).then(result=>{
   this.complete=true;
   try{onResult(result);}catch{/* A log failure cannot rerun a successful job. */}
  },error=>{
   const observed=this.clock();
   const failedAt=Number.isSafeInteger(observed)&&observed>=nowMs?observed:nowMs;
   this.nextAttemptAt=failedAt+(this.attempts===1?60_000:300_000);
   try{onError(error);}catch{/* Research reporting never affects production. */}
  }).finally(()=>{this.pending=null;});
  return true;
 }
 stop(){this.stopped=true;}
 async drain(){await this.pending;}
}
