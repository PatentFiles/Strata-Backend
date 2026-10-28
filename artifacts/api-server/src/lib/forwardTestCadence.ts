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
