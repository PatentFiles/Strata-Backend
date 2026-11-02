import {performance} from 'node:perf_hooks';

export const EXECUTION_SUBSTAGES = [
 'source_read_and_validation','market_evidence','transaction_acquire',
 'duplicate_and_authority','policy_and_window','source_pin_and_classification',
 'exposure_and_stake','reservation_and_conservation',
 'grant_history','technical_lease','continuous_eligibility','flat_entry_evidence',
 'legacy_protective_release',
] as const;
export type ExecutionSubstage = typeof EXECUTION_SUBSTAGES[number];
export type ExecutionSubtiming = Readonly<{stage:ExecutionSubstage;durationMs:number;completed:boolean}>;
const names=new Set<string>(EXECUTION_SUBSTAGES);
/** Optional monotonic diagnostics only. No eligibility clock, async work, SQL,
 * provider access, payloads, or logging. At most eight sequential groups.
 */
export class ExecutionSubtimings {
 private rows:ExecutionSubtiming[]=[];
 private active:{stage:ExecutionSubstage;started:number}|null=null;
 private closed=false;
 constructor(private readonly clock:()=>number=()=>performance.now()){}
 private end(completed:boolean){
  const active=this.active;this.active=null;
  if(!active)return;
  try{const durationMs=this.clock()-active.started;
   if(Number.isFinite(durationMs)&&durationMs>=0&&this.rows.length<8)
    this.rows.push(Object.freeze({stage:active.stage,durationMs,completed}));
  }catch{/* Telemetry cannot alter execution. */}
 }
 mark(stage:ExecutionSubstage):void {
  if(this.closed)return;
  this.end(true);
  try{if(names.has(stage)&&this.rows.length<8){const started=this.clock();
   if(Number.isFinite(started))this.active={stage,started};
  }}catch{/* Telemetry cannot alter execution. */}
 }
 snapshot(completed:boolean):readonly ExecutionSubtiming[]{
  if(!this.closed){this.end(completed);this.closed=true;}
  return Object.freeze([...this.rows]);
 }
}
export function sanitizeExecutionSubtimings(value:unknown):readonly ExecutionSubtiming[]|undefined {
 try{
  if(!Array.isArray(value))return undefined;
  const length=value.length;
  if(!Number.isSafeInteger(length)||length<0||length>8)return undefined;
  const rows:ExecutionSubtiming[]=[];
  for(let index=0;index<length;index++){
   const x=value[index];
   if(!x||typeof x!=='object'||!Object.keys(x).every(k=>['stage','durationMs','completed'].includes(k)))return undefined;
   // Read each potentially hostile accessor exactly once, then validate only
   // these primitive copies. Never spread caller-owned telemetry objects.
   const stage=x.stage,durationMs=x.durationMs,completed=x.completed;
   if(typeof stage!=='string'||!names.has(stage)||typeof durationMs!=='number'||
      !Number.isFinite(durationMs)||durationMs<0||typeof completed!=='boolean')return undefined;
   rows.push(Object.freeze({stage:stage as ExecutionSubstage,durationMs,completed}));
  }
  return Object.freeze(rows);
 }catch{return undefined;}
}
export function validExecutionSubtimings(value:unknown):value is readonly ExecutionSubtiming[]{
 return sanitizeExecutionSubtimings(value)!==undefined;
}
