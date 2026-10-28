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

/** Faster discovery only after an empty current-market listing. No successful
 * strategy evaluation is accelerated. At most three retries per 15m clock window;
 * other feed errors retain normal backoff and no requests overlap.
 */
export class BoundaryDiscoveryRecovery {
 private window:number|null=null;
 private attempts=0;
 periodMs(error:string|null,nowMs=Date.now()):number {
  if(!Number.isFinite(nowMs)||nowMs<0)return 5000;
  const window=Math.floor(nowMs/900000);
  if(this.window===null||window>this.window){this.window=window;this.attempts=0;}
  // A wall-clock regression must not reset the provider request budget.
  if(window!==this.window)return 5000;
  if(error==="Kalshi returned no current market"&&this.attempts<3){
   this.attempts++;return 1000;
  }
  return 5000;
 }
}
