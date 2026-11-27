import {FORWARD_FEED_DEADLINE_MS} from "./forwardFeedReadScope";
import type {PublicFeedReadEvidence} from "./publicFeedJson";
export type BtcFeedDiagnostic={event:"btc_feed_read_failure"|"btc_feed_read_recovered";
 provider:"coinbase";endpoint:"btc_ticker";attempt:number;consecutiveFailures:number;
 freshnessVerified:false;deadlineMs:number;elapsedMs:number|null;abortCause:PublicFeedReadEvidence["abortCause"];
 phase:"fetch"|"headers"|"body"|"validation"|"cooldown";status:number|null;at:string|null};
/** Bounded per-process state, not database history. Failures emit at most once
 * per30s; first failure and first validated recovery are always observable. */
export class BtcFeedDiagnostics {
 private failures=0;private attempt=0;private lastFailureAt=-Infinity;
 constructor(private readonly emit?:(event:BtcFeedDiagnostic)=>void,
  private readonly monotonicNow:()=>number=()=>performance.now()){}
 begin():number {this.attempt=this.attempt>=Number.MAX_SAFE_INTEGER?1:this.attempt+1;return this.attempt;}
 finish(attempt:number,ok:boolean,evidence:PublicFeedReadEvidence|null):void {
  try {
   const prior=this.failures;
   this.failures=ok?0:Math.min(1_000_000,this.failures+1);
   if(ok&&!prior)return;
   const now=this.monotonicNow();
   if(!ok&&prior&&Number.isFinite(now)&&now>=this.lastFailureAt&&now-this.lastFailureAt<30_000)return;
   if(!ok&&Number.isFinite(now))this.lastFailureAt=now;
   const phase=evidence?.outcome==="request_failed"?"fetch":evidence?.outcome==="body_failed"?"body":
    evidence?.outcome==="cooldown"?"cooldown":evidence?.outcome==="response"?"headers":"validation";
   this.emit?.({event:ok?"btc_feed_read_recovered":"btc_feed_read_failure",provider:"coinbase",endpoint:"btc_ticker",
    attempt,consecutiveFailures:ok?prior:this.failures,freshnessVerified:false,deadlineMs:FORWARD_FEED_DEADLINE_MS,
    elapsedMs:evidence?.roundTripMs??null,abortCause:evidence?.abortCause??"none",phase,
    status:evidence?.status??null,at:evidence?.receivedAt??null});
  }catch{/* Diagnostics never affect data eligibility or recovery. */}
 }
}

/** One serial per direct feed reader in this process. No account identifiers are logged. */
export type BtcReadTiming = {
 event:"direct_btc_read_timing"; scope:"owned_direct_reader"; provider:"coinbase"; endpoint:"btc_ticker";
 reader:number; attempt:number; requestStartMs:number; receiptMs:number; ageAtRequestMs:number; ageAtReceiptMs:number;
 headersMs:number; bodyMs:number; requestToBodyMs:number; httpAgeSeconds:number|null; cacheMaxAgeSeconds:number|null;
};
let readerSequence=0;

export class DirectBtcReadTimings {
 private readonly reader=++readerSequence;
 private pending=false;
 constructor(private readonly emit:(event:BtcReadTiming)=>void) {}

 sample(attempt:number):boolean {
  return !this.pending && (attempt-1)%64===0;
 }

 record(attempt:number, requestStartMs:number, providerMs:number, receiptMs:number,
   headersMs:number|null, body:PublicFeedReadEvidence|null):void {
  const total=body?.roundTripMs;
  const ageAtRequestMs=requestStartMs-providerMs;
  const ageAtReceiptMs=receiptMs-providerMs;
  if(this.pending || body?.outcome!=="complete" || headersMs===null || total==null || total<headersMs ||
    ![requestStartMs,receiptMs,ageAtRequestMs,ageAtReceiptMs].every(Number.isSafeInteger))return;

  const event:BtcReadTiming={
   event:"direct_btc_read_timing",scope:"owned_direct_reader",provider:"coinbase",endpoint:"btc_ticker",
   reader:this.reader,attempt,requestStartMs,receiptMs,ageAtRequestMs,ageAtReceiptMs,
   headersMs,bodyMs:Math.round((total-headersMs)*1000)/1000,requestToBodyMs:total,
   httpAgeSeconds:body.ageSeconds,cacheMaxAgeSeconds:body.cacheMaxAgeSeconds,
  };
  this.pending=true;
  try {
   setImmediate(()=>{
    try{this.emit(event);}catch{/* Diagnostic output is best effort. */}
    finally{this.pending=false;}
   }).unref();
  }catch{this.pending=false;}
 }
}
