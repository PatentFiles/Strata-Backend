/** Diagnostic durations only. No authority clocks, proof fields or I/O. */
export type FeeVerificationTiming=Readonly<{version:1;semantics:'verification_elapsed_including_local_work';totalMs:number|null;publicProbeMs:number|null;verificationRemainderMs:number|null;probeCalls:number;probeCallsCapped:boolean}>;
const branded=new WeakSet<object>();
export const isFeeVerificationTiming=(value:unknown):value is FeeVerificationTiming=>typeof value==='object'&&value!==null&&branded.has(value);
export function createFeeVerificationTiming(clock:()=>number=()=>performance.now()){
 const now=()=>{try{const n=clock();return Number.isFinite(n)&&n>=0?n:null;}catch{return null;}};
 const elapsed=(a:number|null,b:number|null)=>a!==null&&b!==null&&b>=a&&b-a<=3_600_000?b-a:null;
 const start=now();let calls=0,capped=false,active=0,overlap=false,probeMs:number|null=0;
 return {
  async probe<T>(operation:()=>Promise<T>):Promise<T>{
   if(calls<20)calls++;else capped=true;
   if(active++)overlap=true;const before=now();
   try{return await operation();}finally{const ms=elapsed(before,now());active--;probeMs=ms===null||probeMs===null?null:probeMs+ms;}
  },
  snapshot():FeeVerificationTiming|undefined{try{
   const total=elapsed(start,now());const probe=overlap||active||probeMs===null||probeMs>3_600_000?null:probeMs;
   const round=(n:number|null)=>n===null?null:Math.round(n*1000)/1000;
   const result=Object.freeze({version:1 as const,semantics:'verification_elapsed_including_local_work' as const,totalMs:round(total),publicProbeMs:round(probe),verificationRemainderMs:round(total!==null&&probe!==null&&total>=probe?total-probe:null),probeCalls:calls,probeCallsCapped:capped});branded.add(result);return result;
  }catch{return undefined;}}
 };
}
