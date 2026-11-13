import {performance} from 'node:perf_hooks';
import {AsyncLocalStorage} from 'node:async_hooks';
/** Fixed labels only. Never retain credentials, URLs, cursors, rows or proof data. */
const GROUPS={
 '/trade-api/v2/portfolio/balance':'balance',
 '/trade-api/v2/portfolio/orders':'orders',
 '/trade-api/v2/historical/orders':'historical_orders',
 '/trade-api/v2/portfolio/fills':'fills',
 '/trade-api/v2/historical/fills':'historical_fills',
 '/trade-api/v2/portfolio/positions':'positions',
 '/trade-api/v2/portfolio/settlements':'settlements',
} as const;
type Group=typeof GROUPS[keyof typeof GROUPS];
export type OwnedFeedReadTiming={event:'strata_signed_feed_read_timing';version:1;
 semantics:'GET_ELAPSED_INCLUDING_TRANSPORT_LOCAL_WORK';readElapsedMs:number|null;
 groups:ReadonlyArray<{group:Group;calls:number;completed:number;failed:number;elapsedMs:number|null;countCapped:boolean}>};
type Get=(...args:any[])=>Promise<any>;
/** Per invocation only; no authority clock reads, cache, retries or altered error objects. */
export function createOwnedFeedReadTiming<T extends Get>(get:T,
 observer:(event:Readonly<OwnedFeedReadTiming>)=>unknown,
 clock:()=>number=()=>performance.now(),
){
 const sample=()=>{try{const n=clock();return Number.isFinite(n)&&n>=0?n:null;}catch{return null;}};
 const elapsed=(a:number|null,b:number|null)=>a===null||b===null||b<a?null:Math.min(3_600_000,Math.round((b-a)*1000)/1000);
 const started=sample();let finished=false;
 const groups=new Map<Group,{group:Group;calls:number;completed:number;failed:number;elapsedMs:number|null;countCapped:boolean}>();
 const wrapped=(async(...args:Parameters<T>)=>{
  const path=args[1];
  const group=typeof path==='string'&&Object.hasOwn(GROUPS,path)?GROUPS[path as keyof typeof GROUPS]:undefined;
  // Unknown paths pass through untouched and are never logged.
  if(!group)return get(...args);
  let row=groups.get(group);
  if(!row){row={group,calls:0,completed:0,failed:0,elapsedMs:0,countCapped:false};groups.set(group,row);}
  const cap=group==='balance'?1:20;
  if(row.calls<cap)row.calls++;else row.countCapped=true;
  const before=sample();let completed=false;
  try{const value=await get(...args);completed=true;return value;}
  finally{
   const duration=elapsed(before,sample());
   if(duration===null||row.elapsedMs===null)row.elapsedMs=null;else row.elapsedMs=Math.min(3_600_000,Math.round((row.elapsedMs+duration)*1000)/1000);
   if(completed)row.completed=Math.min(cap,row.completed+1);else row.failed=Math.min(cap,row.failed+1);
  }
 }) as T;
 return {get:wrapped,finish:()=>{
  if(finished)return;finished=true;
  try{
   const event:OwnedFeedReadTiming={event:'strata_signed_feed_read_timing',version:1,
    semantics:'GET_ELAPSED_INCLUDING_TRANSPORT_LOCAL_WORK',readElapsedMs:elapsed(started,sample()),
    groups:[...groups.values()].map(row=>({...row}))};
   // Do not await observers or let sync/async failures enter signed-read control flow.
   Object.freeze(event.groups);for(const row of event.groups)Object.freeze(row);Object.freeze(event);
   validSummaries.add(event);
   Promise.resolve(observer(event)).catch(()=>{});
  }catch{/* Diagnostics cannot change the signed account proof or failure path. */}
 }};
}

const validSummaries=new WeakSet<object>();
const readContext=new AsyncLocalStorage<{summary?:OwnedFeedReadTiming}>();
export function recordOwnedFeedReadTiming(summary:OwnedFeedReadTiming):void {
 try{const context=readContext.getStore();if(context&&validSummaries.has(summary))context.summary=summary;}catch{/* diagnostic only */}
}
export function isOwnedFeedReadTiming(value:unknown):value is OwnedFeedReadTiming {
 return typeof value==='object'&&value!==null&&validSummaries.has(value);
}
/** Dedicated side channel; never put this object on a signed snapshot. */
export class OwnedFeedTimingCapture {
 private readonly context:{summary?:OwnedFeedReadTiming}={};
 run<T>(fn:()=>T):T{return readContext.run(this.context,fn);}
 snapshot():OwnedFeedReadTiming|undefined{return this.context.summary;}
}
