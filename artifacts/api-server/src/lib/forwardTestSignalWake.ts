// Process-local latency hint only. Listeners must re-read committed source,
// reconcile and pass every ordinary gate. Polling remains the recovery path.
const listeners=new Set<()=>void>();
export function onCommittedForwardSignal(listener:()=>void):()=>void {
 listeners.add(listener);return ()=>{listeners.delete(listener);};
}
export function notifyCommittedForwardSignal():void {
 for(const listener of listeners){try{listener();}catch{/* Hints never alter producer commits. */}}
}
