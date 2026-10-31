/** Operational diagnostics only: these durations include local scheduling,
 * signing (book), parsing and validation. They are NOT provider/network RTT.
 * WeakMap attachment avoids changing serialized evidence, fee hashes or gates.
 */
export const MARKET_EVIDENCE_READ_LABELS = Object.freeze([
 "fee", "book", "market", "series", "seriesChanges", "event", "eventChanges",
] as const);
type Label = typeof MARKET_EVIDENCE_READ_LABELS[number];
type ReadTiming = Readonly<{startOffsetMs:number|null;elapsedMs:number|null;outcome:"completed"|"rejected"}>;
export type MarketEvidenceReadTiming = Readonly<{
 version:1; semantics:"full_read_elapsed_including_local_work";
 reads:Readonly<Partial<Record<Label,ReadTiming>>>;
}>;
const captured = new WeakSet<object>();
const attached = new WeakMap<object,MarketEvidenceReadTiming>();
export function getMarketEvidenceReadTiming(value:unknown):MarketEvidenceReadTiming|undefined {
 return typeof value === "object" && value !== null ? attached.get(value) : undefined;
}
export function attachMarketEvidenceReadTiming<T extends object>(value:T,timing:MarketEvidenceReadTiming|undefined):T {
 // Internal diagnostic failures must never change an execution decision.
 try { if(timing && captured.has(timing))attached.set(value,timing); } catch {}
 return value;
}
export function createMarketEvidenceReadTiming(clock:()=>number=()=>performance.now()) {
 const now=()=>{try {const n=clock();return Number.isFinite(n)?n:null;}catch{return null;}};
 const elapsed=(start:number|null,end:number|null)=>start!==null&&end!==null&&end>=start&&end-start<=86_400_000
  ?Math.round((end-start)*1000)/1000:null;
 const origin=now();
 const reads:Partial<Record<Label,ReadTiming>>={};
 const record=(label:Label,start:number|null,outcome:ReadTiming["outcome"])=>{
  try {reads[label]=Object.freeze({startOffsetMs:elapsed(origin,start),elapsedMs:elapsed(start,now()),outcome});}catch{}
 };
 return {
  async read<T>(label:Label,operation:()=>Promise<T>):Promise<T>{
   const start=now();
   try {const value=await operation();record(label,start,"completed");return value;}
   catch(error){record(label,start,"rejected");throw error;}
  },
  snapshot():MarketEvidenceReadTiming|undefined {
   try {const snapshot = Object.freeze({version:1 as const,semantics:"full_read_elapsed_including_local_work" as const,reads:Object.freeze({...reads})});captured.add(snapshot);return snapshot;}
   catch{return undefined;}
  },
 };
}
