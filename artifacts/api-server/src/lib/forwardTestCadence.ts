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

/** Error-only recovery while a new quarter-hour market is being published.
 * At most ten one-second retry schedules share one budget per 15m window.
 * The first success or any unrelated failure (including HTTP429) permanently
 * closes that window's fast lane. Valid evaluations retain five-second cadence;
 * the worker still awaits each cycle and enforces its overrun pause.
 */
export class BoundaryDiscoveryRecovery {
 private window:number|null=null;
 private attempts=0;
 private closed=false;
 private lastClock:number|null=null;
 periodMs(error:string|null,nowMs=Date.now()):number {
  if(!Number.isSafeInteger(nowMs)||nowMs<0){this.closed=true;return 5000;}
  // Untrusted/regressed clocks close the fast lane, even if the coincident
  // outcome was a throttle or success. Never resume it later in this window.
  if(this.lastClock!==null&&nowMs<this.lastClock){this.closed=true;return 5000;}
  this.lastClock=nowMs;
  const window=Math.floor(nowMs/900000);
  if(this.window===null||window>this.window){
   this.window=window;this.attempts=0;this.closed=false;
  }
  if(window!==this.window)return 5000;
  const discoveryError=error==="Kalshi returned no current market" ||
    error==="Kalshi exact market strike is missing or invalid";
  if(!discoveryError||nowMs%900000>=30000){this.closed=true;return 5000;}
  if(this.closed||this.attempts>=10)return 5000;
  this.attempts++;return 1000;
 }
}
