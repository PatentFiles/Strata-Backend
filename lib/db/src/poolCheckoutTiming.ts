import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool} from 'pg';

/** Acquisition includes queueing and connection setup, never database CPU time. */
export type PoolCheckoutTiming=Readonly<{attempted:number;completed:number;rejected:number;active:number;elapsedMs:number|null;capped:boolean}>;
const scope=new AsyncLocalStorage<{capture:PoolCheckoutTimingCapture;open:boolean}>();
const installed=new WeakSet<object>();
const LIMIT=20,MAX_MS=3_600_000;
export class PoolCheckoutTimingCapture {
 private attempted=0;private completed=0;private rejected=0;private active=0;private elapsedMs:number|null=0;private capped=false;
 constructor(private readonly clock:()=>number=()=>performance.now()){}
 /** Only synchronous dispatch is scoped. Async descendants cannot label unrelated work. */
 run<T>(dispatch:()=>T):T{
  const current={capture:this,open:true};
  let invoked=false;
  try{return scope.run(current,()=>{invoked=true;try{return dispatch();}finally{current.open=false;}});}
  catch(error){current.open=false;if(invoked)throw error;return dispatch();}
 }
 private now():number|null{try{const n=this.clock();return Number.isFinite(n)&&n>=0?n:null;}catch{return null;}}
 begin():(failed:boolean)=>void{
  if(this.attempted>=LIMIT){this.capped=true;return ()=>{};}
  this.attempted++;this.active++;const start=this.now();let done=false;
  return failed=>{try{
   if(done)return;done=true;this.active--;this.completed++;if(failed)this.rejected++;
   const end=this.now();
   if(start===null||end===null||end<start||end-start>MAX_MS||this.elapsedMs===null||this.elapsedMs+end-start>MAX_MS)this.elapsedMs=null;
   else this.elapsedMs+=end-start;
  }catch{/* Diagnostics cannot replace the original callback/error. */}};
 }
 snapshot():PoolCheckoutTiming{return Object.freeze({attempted:this.attempted,completed:this.completed,rejected:this.rejected,active:this.active,elapsedMs:this.elapsedMs===null?null:Math.round(this.elapsedMs*1000)/1000,capped:this.capped});}
}
/** Installed pg-pool.query calls connect(callback). Promise connect is untouched.
 * No query wrapper, extra Promise/SQL, release wrapper, or cancellation behavior. */
export function installPoolCheckoutTiming(pool:Pool):void{
 if(installed.has(pool))return;
 const original=pool.connect;
 pool.connect=function(this:Pool,...args:unknown[]){
  const current=scope.getStore();
  if(!current?.open||typeof args[0]!=='function')return Reflect.apply(original,this,args);
  const callback=args[0] as (...values:unknown[])=>unknown;
  let done:(failed:boolean)=>void;
  try{done=current.capture.begin();}catch{return Reflect.apply(original,this,args);}
  const wrapped=function(this:unknown,...values:unknown[]){
   done(Boolean(values[0]));
   return Reflect.apply(callback,this,values);
  };
  const forwarded=[wrapped,...args.slice(1)];
  try{return Reflect.apply(original,this,forwarded);}catch(error){done(true);throw error;}
 } as Pool['connect'];
 installed.add(pool);
}

/** Explicit borrowed/inactive scopes cannot inherit an outer synchronous checkout scope. */
export function withoutPoolCheckoutTiming<T>(dispatch:()=>T):T{
 return scope.getStore()?scope.exit(dispatch):dispatch();
}
