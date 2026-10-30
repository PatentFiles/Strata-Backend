export function producerDelayMs(periodMs:number,elapsedMs:number):number {
 if(!Number.isFinite(periodMs)||periodMs<250||!Number.isFinite(elapsedMs)||elapsedMs<0)throw Error("invalid_producer_clock");
 return Math.max(250,Math.ceil(periodMs-elapsedMs));
}
export class OptionalResearchLane {
 private pending:Promise<void>|null=null;
 submit(work:()=>Promise<unknown>,report:(error:unknown)=>void):boolean {
  if(this.pending)return false;
  this.pending=Promise.resolve().then(work).then(()=>{},report).finally(()=>{this.pending=null;});
  return true;
 }
 async drain():Promise<void>{await this.pending;}
}

/** Faster discovery after an empty listing or an unpublished exact strike at rollover. No successful
 * strategy evaluation is accelerated. At most three retries per 15m clock window;
 * other feed errors retain normal backoff and no requests overlap.
 */
export class BoundaryDiscoveryRecovery {
 private window:number|null=null;
 private attempts=0;
 private firstFailureAt:number|null=null;
 periodMs(error:string|null,nowMs=Date.now()):number {
  if(!Number.isFinite(nowMs)||nowMs<0)return 5000;
  const window=Math.floor(nowMs/900000);
  if(this.window===null||window>this.window){this.window=window;this.attempts=0;this.firstFailureAt=null;}
  // A wall-clock regression must not reset the provider request budget.
  if(window!==this.window)return 5000;
  const missingRolloverStrike=error==="Kalshi exact market strike is missing or invalid" && nowMs%900000<30000;
  if(error==="Kalshi returned no current market" || missingRolloverStrike){
   if(this.attempts<3){
    if(this.attempts===0)this.firstFailureAt=nowMs;
    this.attempts++;return 1000;
   }
   // Fast retries are inserted BEFORE the original next regular poll.
   // Do not shift that poll from t+5s to t+8s after retries at +1,+2,+3.
   const remaining=(this.firstFailureAt??nowMs)+5000-nowMs;
   return remaining>0?Math.max(250,remaining):5000;
  }
  return 5000;
 }
}
