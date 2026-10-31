import {getFeeFailureDiagnostics,type FeeFailureDiagnostics} from "../strata/feeFailureDiagnostics";
import {isEntryPriceDiagnostics, type EntryPriceDiagnostics} from "./entryPriceDiagnostics";
import {AsyncLocalStorage} from "node:async_hooks";
import {performance} from "node:perf_hooks";
import {deployedGitSha} from "../strata/deployedGitSha";

export type ExecutionStage = "reconciliation" | "signed_snapshot" | "ledger_reconcile_commit" |
 "after_reconcile" | "signal_discovery" | "prepare_entry" | "evaluation_age_admission" |
 "final_preparation" | "final_signed_snapshot" | "dispatch" | "fee_verification" |
 "final_fee_and_authorization" | "http_ack" | "wire_source_admission";
export type StageOutcome = "completed" | "rejected" | "eligible" | "proven_not_posted" |
 "post_uncertain" | "reconciliation_required" | "http_response" | "network_error";
export type StageContext = {accountId:string;mode:"LIVE"|"SIMULATION";evaluationId?:string|null;intentId?:string|null};
export type StageTiming = StageContext & {stage:ExecutionStage;durationMs:number;outcome:StageOutcome;
 releaseCommitSha:string;feeFailure?:FeeFailureDiagnostics;entryPrice?:EntryPriceDiagnostics;sourceAgeMs?:number;sourceToDecisionAgeMs?:number;reason?:string;httpStatus?:number};
export type TimingObserver = (event:Readonly<StageTiming>)=>void|Promise<void>;
const safeId=(value:unknown)=>typeof value==="string"&&/^[a-zA-Z0-9:_-]{1,128}$/.test(value)?value:undefined;
const reasonCode=(error:unknown)=>{
 const message=error instanceof Error?error.message:typeof error==="string"?error:"";
 return /^[a-z][a-z0-9_]{0,127}$/.test(message)?message:"execution_error_details_redacted";
};
/** Best-effort metadata only. No DB, no awaited observer, no trading authority.
 * Durations use a monotonic clock; source age is separately sampled wall time.
 * Completion does not assert a fill or authorize the next stage.
 */
export function beginExecutionStage(observer:TimingObserver|null,stage:ExecutionStage,context:StageContext,
 clock:()=>number=()=>performance.now()) {
 let started=0;
 try{started=clock();}catch{/* Optional clock instrumentation is not authority. */}
 let ended=false;
 return (outcome:StageOutcome,extra:{entryPrice?:EntryPriceDiagnostics;error?:unknown;sourceAgeMs?:number;sourceToDecisionAgeMs?:number;httpStatus?:number}={})=>{
  if(ended)return;ended=true;
  if(!observer)return;
  try {
   const elapsed=clock()-started;
   const event:StageTiming={accountId:safeId(context.accountId)??"redacted",mode:context.mode,
    stage,outcome,durationMs:Number.isFinite(elapsed)?Math.max(0,elapsed):0,releaseCommitSha:deployedGitSha()};
   const evaluationId=safeId(context.evaluationId),intentId=safeId(context.intentId);
   if(evaluationId)event.evaluationId=evaluationId;
   if(intentId)event.intentId=intentId;
   if(Number.isFinite(extra.sourceAgeMs))event.sourceAgeMs=extra.sourceAgeMs;
   if(Number.isFinite(extra.sourceToDecisionAgeMs))event.sourceToDecisionAgeMs=extra.sourceToDecisionAgeMs;
   if(extra.error!==undefined){event.reason=reasonCode(extra.error);
    const feeFailure=getFeeFailureDiagnostics(extra.error);if(feeFailure)event.feeFailure=feeFailure;}
   if(Number.isInteger(extra.httpStatus)&&extra.httpStatus!>=100&&extra.httpStatus!<=599)event.httpStatus=extra.httpStatus;
   if(stage==="prepare_entry" && isEntryPriceDiagnostics(extra.entryPrice))event.entryPrice=extra.entryPrice;
   const captured=Object.freeze(event);
   // In particular, never invoke user/logger code between the last freshness
   // check and synchronous raw HTTP. No observer promise is awaited.
   queueMicrotask(()=>{
    try{const pending=observer(captured);if(pending)void Promise.resolve(pending).catch(()=>{});}
    catch{/* Observers have no execution authority. */}
   });
  }catch{/* Observability can never change admission, recovery or transport. */}
 };
}

/** Wrap the final guards and raw HTTP separately. The factory must place raw
 * AFTER all fee/quota/clock guards. No new await occurs before raw transport.
 * http_ack is time to response headers, NOT body completion or fill evidence.
 */
export function timedFinalFetch(factory:(raw:typeof fetch)=>typeof fetch,raw:typeof fetch,
 observer:TimingObserver|null,context:StageContext):typeof fetch {
 const attempts=new AsyncLocalStorage<{done:ReturnType<typeof beginExecutionStage>;context:StageContext}>();
 // Construct/validate guards once, at the same startup boundary as before.
 const guarded=factory((request,init)=>{
   const attempt=attempts.getStore();
   attempt?.done("completed");
   const ack=beginExecutionStage(observer,"http_ack",attempt?.context??context);
   try{
    return raw(request,init).then(response=>{
     ack("http_response",{httpStatus:response.status});return response;
    },error=>{ack("network_error",{error});throw error;});
   }catch(error){ack("network_error",{error});throw error;}
 });
 return (request,init)=>{
  let intentId: string|undefined;
  try{
   if(typeof init?.body==="string"){
    const id=JSON.parse(init.body)?.client_order_id;
    if(typeof id==="string"&&/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))intentId=id.slice(5);
   }
  }catch{/* Body validation remains the guard's responsibility. */}
  const attemptContext={...context,...(intentId?{intentId}:{})};
  const done=beginExecutionStage(observer,"final_fee_and_authorization",attemptContext);
  return attempts.run({done,context:attemptContext},()=>{
   try{return guarded(request,init).catch(error=>{done("rejected",{error});throw error;});}
   catch(error){done("rejected",{error});throw error;}
  });
 };
}
