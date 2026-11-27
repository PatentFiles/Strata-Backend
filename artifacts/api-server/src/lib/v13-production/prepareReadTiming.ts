import {performance} from 'node:perf_hooks';

const phases = ['pool_checkout','duplicate_lookup','authority_gate','initial_authority',
 'receipt_rows','canonical_receipt','remaining_ids','rechecked_authority'] as const;
type Phase = typeof phases[number];
type Row = Readonly<{phase:Phase; count:number; totalMs:number; maxMs:number; failed:boolean;firstReceiptMs?:readonly number[]}>;
export type PrepareReadTiming = readonly Row[];
const issued = new WeakSet<object>();
const allowed = new Set<string>(phases);
let sampleCounter = 0;
function sampleFastPrepare():boolean {
 sampleCounter=(sampleCounter+1)%64;
 return sampleCounter===0;
}

export function isPrepareReadTiming(value:unknown):value is PrepareReadTiming {
 return typeof value==='object' && value!==null && issued.has(value);
}

// All DB spans are elapsed time as observed by the client. The enclosing gate
// contains its SQL spans; its duration must not be added to them.
export class PrepareReadCapture {
 private readonly rows = new Map<Phase,{count:number;totalMs:number;maxMs:number;failed:boolean;firstReceiptMs?:number[]}>();
 constructor(private readonly clock:()=>number=()=>performance.now(),
  private readonly sample:boolean=sampleFastPrepare()){}
 begin(phase:Phase):((failed:boolean)=>void)|undefined {
  if(!allowed.has(phase))return;
  try {
   const start=this.clock();
   return failed=>{
    try{
     const ms=this.clock()-start;
     if(!Number.isFinite(ms)||ms<0)return;
     const row=this.rows.get(phase)??{count:0,totalMs:0,maxMs:0,failed:false};
     row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);row.failed||=failed===true;
     if(phase==='canonical_receipt'){
      const first=row.firstReceiptMs??=[];
      if(first.length<4)first.push(ms);
     }
     this.rows.set(phase,row);
    }catch{/* A broken telemetry clock cannot alter the operation. */}
   };
  }catch{return;}
 }
 snapshot(retain:boolean):PrepareReadTiming|undefined {
  if(!this.rows.size)return;
  if(!retain&&!this.sample&&![...this.rows.values()].some(r=>r.failed||r.totalMs>=100))return;
  const rows=Object.freeze([...this.rows].map(([phase,row])=>Object.freeze({phase,...row,
   ...(row.firstReceiptMs?{firstReceiptMs:Object.freeze([...row.firstReceiptMs])}:{})})));
  issued.add(rows);return rows;
 }
}

export function observePrepareRead<T>(capture:PrepareReadCapture|undefined,phase:Phase,operation:()=>Promise<T>):Promise<T> {
 const finish=capture?.begin(phase);
 if(!finish)return operation();
 try{
  const pending=operation();
  void pending.then(()=>finish(false),()=>finish(true));
  return pending;
 }catch(error){finish(true);throw error;}
}
