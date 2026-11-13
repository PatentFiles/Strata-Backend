// Process-local latency hints only. No hint grants authority or replaces SQL.
export type CommittedForwardSourceHint=Readonly<{
 evaluationId:string;marketTicker:string;evaluatedAtMs:number;committedAtMs:number;
 btcProviderAgeMs:number;btcReceiveAgeMs:number;marketAgeMs:number;qualifyingTrigger:true;
}>;
const listeners=new Set<(hint?:CommittedForwardSourceHint)=>void>();
export function onCommittedForwardSignal(listener:(hint?:CommittedForwardSourceHint)=>void):()=>void {
 listeners.add(listener);return ()=>{listeners.delete(listener);};
}
export function notifyCommittedForwardSignal(hint?:CommittedForwardSourceHint):void {
 const committed=hint?Object.freeze({...hint}):undefined;
 for(const listener of listeners){try{listener(committed);}catch{/* Hints never alter producer commits. */}}
}
