import type {ForwardTestFeeds} from "./forwardTestFeeds";
export const FORWARD_FEED_DEADLINE_MS=8_000;
export type FeedAbortCause="none"|"timeout"|"shutdown"|"sibling_failure"|"external_abort";
export function feedAbortCause(signal?:AbortSignal):FeedAbortCause {
 if(!signal?.aborted)return "none";
 try {
  const name=signal.reason?.name;
  return name==="TimeoutError"?"timeout":name==="ForwardFeedShutdown"?"shutdown":
   name==="ForwardFeedSiblingFailure"?"sibling_failure":"external_abort";
 }catch{return "external_abort";}
}
/** One unchanged deadline across parallel BTC and exact/current-market reads. On failure,
 * abort and settle sibling requests BEFORE another serialized cycle can start.
 * All production readers honor AbortSignal; never reuse observations on error.
 * Optional deadline injection is for deterministic offline tests only. */
export async function readForwardCycleFeeds(feeds:ForwardTestFeeds,priorTicker:string|undefined,
 parent?:AbortSignal,deadline:AbortSignal=AbortSignal.timeout(FORWARD_FEED_DEADLINE_MS)) {
 const scope=new AbortController();
 const shutdown=()=>scope.abort(new DOMException("Producer stopped","ForwardFeedShutdown"));
 const timedOut=()=>scope.abort(deadline.reason);
 parent?.addEventListener("abort",shutdown,{once:true});
 deadline.addEventListener("abort",timedOut,{once:true});
 if(parent?.aborted)shutdown();else if(deadline.aborted)timedOut();
 const pending:Promise<unknown>[]=[];
 try {
  scope.signal.throwIfAborted();
  // Promise callbacks also capture a synchronous throw without losing the
  // sibling handle; every started task participates in settlement below.
  const btcRead=Promise.resolve().then(()=>{scope.signal.throwIfAborted();return feeds.btc(scope.signal);});
  // A held position already identifies its contract. New-window discovery is
  // unrelated to its exit/settlement and can be unavailable during rollover.
  // Read that exact ticker directly; never substitute the new market on failure.
  const marketRead=Promise.resolve().then(()=>{scope.signal.throwIfAborted();return feeds.market(priorTicker,scope.signal);});
  pending.push(btcRead,marketRead);
  const [btc,market]=await Promise.all([btcRead,marketRead]);
  scope.signal.throwIfAborted();
  return {btc,market};
 }catch(error){
  if(!scope.signal.aborted)scope.abort(new DOMException("Peer feed failed","ForwardFeedSiblingFailure"));
  await Promise.allSettled(pending);
  throw error;
 }finally{
  parent?.removeEventListener("abort",shutdown);
  deadline.removeEventListener("abort",timedOut);
 }
}
