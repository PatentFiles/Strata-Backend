import {PoolCheckoutTimingCapture,withoutPoolCheckoutTiming,type PoolCheckoutTiming} from "@workspace/db/pool-checkout-timing";
import {AsyncLocalStorage} from 'node:async_hooks';

/** Diagnostics only: client elapsed includes transport, queuing and locks.
 * It is neither database CPU time nor an authority/source clock. */
export type FeeAuthorityPurpose='FINAL_MARKET'|'WIRE_FEE';
export type FeeAuthorityOperation='standing_history_query'|'standing_eligibility_query'|'final_account_fence_query'|'fee_public_probe'|'fee_review_query'|'fee_standing_renewal_query';
export type FeeAuthorityTiming=Readonly<{
 version:1;
 semantics:'client_elapsed_not_database_cpu_or_exclusive_wall_time';
 stages:readonly Readonly<{purpose:FeeAuthorityPurpose;operation:FeeAuthorityOperation;attempted:number;completed:number;rejected:number;active:number;elapsedMs:number|null;capped:boolean;poolCheckout?:PoolCheckoutTiming}>[];
}>;
const PURPOSES=Object.freeze(['FINAL_MARKET','WIRE_FEE'] as const);
const OPERATIONS=Object.freeze(['standing_history_query','standing_eligibility_query','final_account_fence_query','fee_public_probe','fee_review_query','fee_standing_renewal_query'] as const);
const validPurpose=new Set<string>(PURPOSES),validOperation=new Set<string>(OPERATIONS);
const MAX_COUNT=20,MAX_ELAPSED=3_600_000,MAX_SERIALIZED_BYTES=4096;
type MutableStage={purpose:FeeAuthorityPurpose;operation:FeeAuthorityOperation;attempted:number;completed:number;rejected:number;active:number;elapsedMs:number|null;capped:boolean};
const context=new AsyncLocalStorage<{capture:FeeAuthorityTimingCapture;purpose?:FeeAuthorityPurpose}>();
const branded=new WeakSet<object>();
const noop=(_outcome:'fulfilled'|'rejected'):void=>{};
export function isFeeAuthorityTiming(value:unknown):value is FeeAuthorityTiming{return typeof value==='object'&&value!==null&&branded.has(value);}

export class FeeAuthorityTimingCapture {
 private readonly checkouts=new Map<FeeAuthorityOperation,PoolCheckoutTimingCapture>();
 private readonly stages:MutableStage[]=PURPOSES.flatMap(purpose=>OPERATIONS.map(operation=>({purpose,operation,attempted:0,completed:0,rejected:0,active:0,elapsedMs:0,capped:false})));
 constructor(private readonly clock:()=>number=()=>performance.now()){}
 /** Synchronous scope entry: returns the caller's EXACT value/promise. */
 run<T>(operation:()=>T):T{return context.run({capture:this,purpose:'FINAL_MARKET'},operation);}
 private now():number|null{try{const value=this.clock();return Number.isFinite(value)&&value>=0?value:null;}catch{return null;}}
 begin(purpose:FeeAuthorityPurpose,operation:FeeAuthorityOperation):(outcome:'fulfilled'|'rejected')=>void{
  try{
   if(typeof purpose!=='string'||typeof operation!=='string'||!validPurpose.has(purpose)||!validOperation.has(operation))return noop;
   const stage=this.stages.find(row=>row.purpose===purpose&&row.operation===operation)!;
   if(stage.attempted>=MAX_COUNT){stage.capped=true;return noop;}
   stage.attempted++;stage.active++;const start=this.now();let finished=false;
   return outcome=>{try{
    if(finished)return;finished=true;stage.active--;stage.completed++;
    if(outcome==='rejected')stage.rejected++;
    else if(outcome!=='fulfilled'){stage.capped=true;stage.elapsedMs=null;return;}
    const end=this.now();
    if(start===null||end===null||end<start||end-start>MAX_ELAPSED||stage.elapsedMs===null||stage.elapsedMs+end-start>MAX_ELAPSED)stage.elapsedMs=null;
    else stage.elapsedMs+=end-start;
   }catch{/* Diagnostic completion cannot replace an operation's result/error. */}};
  }catch{return noop;}
 }
 checkout<T>(operation:FeeAuthorityOperation,dispatch:()=>T):T{
  if(operation!=='fee_review_query'&&operation!=='fee_standing_renewal_query')return withoutPoolCheckoutTiming(dispatch);
  let capture:PoolCheckoutTimingCapture;
  try{
   const existing=this.checkouts.get(operation);
   capture=existing??new PoolCheckoutTimingCapture(this.clock);
   if(!existing)this.checkouts.set(operation,capture);
  }catch{return dispatch();}
  return capture.run(dispatch);
 }
 snapshot():FeeAuthorityTiming|undefined{try{
  const stages=Object.freeze(this.stages.map(row=>Object.freeze({...row,...(row.purpose==='FINAL_MARKET'&&this.checkouts.has(row.operation)?{poolCheckout:this.checkouts.get(row.operation)!.snapshot()}:{}),elapsedMs:row.elapsedMs===null?null:Math.round(row.elapsedMs*1000)/1000})));
  const result=Object.freeze({version:1 as const,semantics:'client_elapsed_not_database_cpu_or_exclusive_wall_time' as const,stages});
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_SERIALIZED_BYTES)return undefined;
  branded.add(result);return result;
 }catch{return undefined;}}
}
/** No active dispatch/purpose means no clock sample, allocation or async hop. */
export function beginFeeAuthorityTiming(operation:FeeAuthorityOperation):(outcome:'fulfilled'|'rejected')=>void{
 try{const current=context.getStore();return current?.purpose?current.capture.begin(current.purpose,operation):noop;}catch{return noop;}
}
/** No observer API: arbitrary callback/thenable code is never invoked. */
export function withFeeAuthorityTimingPurpose<T>(purpose:FeeAuthorityPurpose,operation:()=>T):T{
 const current=context.getStore();
 if(!current)return withoutPoolCheckoutTiming(operation);
 if(typeof purpose!=='string'||!validPurpose.has(purpose))return withoutPoolCheckoutTiming(()=>context.run({capture:current.capture},operation));
 return purpose==='WIRE_FEE'?withoutPoolCheckoutTiming(()=>context.run({capture:current.capture,purpose},operation)):context.run({capture:current.capture,purpose},operation);
}

export const runFeeAuthorityPurpose=withFeeAuthorityTimingPurpose;

/** Explicit inactive/EXIT scopes must not inherit a surrounding ENTRY capture.
 * context.exit is synchronous and preserves the exact result/promise identity. */
export function withoutFeeAuthorityTiming<T>(operation:()=>T):T{
 return withoutPoolCheckoutTiming(()=>context.getStore()?context.exit(operation):operation());
}

/** FINAL pooled fee dispatch only; borrowed WIRE and inactive scopes are untouched. */
export function withFinalFeePoolCheckout<T>(operation:'fee_review_query'|'fee_standing_renewal_query',dispatch:()=>T):T{
 const current=context.getStore();
 return current?.purpose==='FINAL_MARKET'?current.capture.checkout(operation,dispatch):withoutPoolCheckoutTiming(dispatch);
}
