import type {RolloverReadShapeEvidence} from './rolloverReadShapeEvidence';
import type {PublicFeedReadEvidence} from './publicFeedJson';
import {BOUNDARY_FAST_RETRY_LIMIT} from './forwardTestCadence';

const FIELDS=['floor_strike','floorStrike','strike','target','threshold'] as const;
type StrikeField=typeof FIELDS[number];
type FieldEvidence={field:StrikeField;type:'missing'|'null'|'number'|'string'|'other';parsed:number|null};
export type StrikeEvidence={selectedField:StrikeField|null;value:number|null;valid:boolean;fields:FieldEvidence[];
 capStrike:{type:FieldEvidence['type'];parsed:number|null};strikeType:string|null;providerUpdatedAt:string|null};
/** Same finite-number selection as the existing reader. Never retain arbitrary
 * strings, titles, response bodies, credentials, or inferred settlement data. */
export function marketStrikeEvidence(market:Record<string,unknown>):StrikeEvidence {
 const fields:FieldEvidence[]=FIELDS.map(field=>{
  const v=market[field];
  const type=!Object.prototype.hasOwnProperty.call(market,field)?'missing':v===null?'null':typeof v==='number'?'number':typeof v==='string'?'string':'other';
  const n=typeof v==='number'?v:typeof v==='string'&&v.trim()?Number(v):NaN;
  return {field,type,parsed:Number.isFinite(n)?n:null};
 });
 const selected=fields.find(f=>f.parsed!==null);
 const value=selected?.parsed??null;
 const cap=market.cap_strike,capN=typeof cap==='number'?cap:typeof cap==='string'&&cap.trim()?Number(cap):NaN;
 const capType:FieldEvidence['type']=!Object.prototype.hasOwnProperty.call(market,'cap_strike')?'missing':cap===null?'null':typeof cap==='number'?'number':typeof cap==='string'?'string':'other';
 const type=market.strike_type;
 const strikeType=typeof type==='string'&&['greater','greater_or_equal','less','less_or_equal','between','functional','custom'].includes(type)?type:null;
 const updated=typeof market.updated_time==='string'&&market.updated_time.length<=128?Date.parse(market.updated_time):NaN;
 return {selectedField:selected?.field??null,value,valid:value!==null&&value>0,fields,
  capStrike:{type:capType,parsed:Number.isFinite(capN)?capN:null},strikeType,
  providerUpdatedAt:Number.isFinite(updated)?new Date(updated).toISOString():null};
}
export type RolloverStrikeEvent={
 event:'kalshi_rollover_strike';phase:'first_unavailable'|'ready'|'unresolved_30s'|'non_strike_fields_ready';
 windowStartedAt:string;observedAt:string;firstObservedOffsetMs:number;observedOffsetMs:number;
 ticker:string|null;detailReadAttempts:number;invalidStrikeReads:number;transportFailures:number;
 configuredFastRetryLimit:number;strike:StrikeEvidence|null;transport:PublicFeedReadEvidence|null;
 detailEvidence?:RolloverReadShapeEvidence|null;
 reason:'invalid_strike'|'transport'|'valid_strike';
};
/** One in-memory window, no database writes, at most four compact events per
 * window: first unavailable, deadline (if unresolved), eventual readiness, and first usable non-strike fields if initially absent.
 * Diagnostic failures cannot alter eligibility, cadence, or the request budget.
 */
export class RolloverStrikeDiagnostics {
 private window=-Infinity;
 private first=0;
 private last=-Infinity;
 private attempts=0;
 private invalid=0;
 private failures=0;
 private unavailable=false;
 private deadline=false;
 private ready=false;
 private shapeSeen=false;
 constructor(private emit:(event:RolloverStrikeEvent)=>void=()=>{}){}
 observe(nowMs:number,ticker:string|null,strike:StrikeEvidence|null,transport:PublicFeedReadEvidence|null,detailEvidence:RolloverReadShapeEvidence|null=null):void {
  if(!Number.isSafeInteger(nowMs)||nowMs<0||nowMs>8640000000000000)return;
  const window=Math.floor(nowMs/900000)*900000;
  if(window<this.window||nowMs<this.last)return;
  this.last=nowMs;
  if(window>this.window){
   this.window=window;this.first=nowMs;this.attempts=0;this.invalid=0;this.failures=0;
   this.unavailable=false;this.deadline=false;this.ready=false;this.shapeSeen=false;
  }
  if(this.ready)return;
  this.attempts++;
  const valid=!!strike?.valid;
  if(strike&&!valid)this.invalid++;
  if(!strike)this.failures++;
  const reason=strike?(valid?'valid_strike':'invalid_strike'):'transport';
  let phase:RolloverStrikeEvent['phase']|null=null;
  if(valid){this.ready=true;phase='ready';}
  else if(!this.unavailable){this.unavailable=true;phase='first_unavailable';}
  else if(!this.deadline&&nowMs-window>=30000){this.deadline=true;phase='unresolved_30s';}
  const firstShape=detailEvidence?.nonStrikeScopeAndOffersPresent===true&&!this.shapeSeen;
  if(firstShape){this.shapeSeen=true;phase??='non_strike_fields_ready';}
  if(!phase)return;
  const safeTicker=ticker&&/^KXBTC15M-[A-Z0-9-]{1,80}$/.test(ticker)?ticker:null;
  try{this.emit({event:'kalshi_rollover_strike',phase,windowStartedAt:new Date(window).toISOString(),
   observedAt:new Date(nowMs).toISOString(),firstObservedOffsetMs:this.first-window,observedOffsetMs:nowMs-window,
   ticker:safeTicker,detailReadAttempts:this.attempts,invalidStrikeReads:this.invalid,transportFailures:this.failures,
   configuredFastRetryLimit:BOUNDARY_FAST_RETRY_LIMIT,strike,transport,detailEvidence,reason});}catch{/* diagnostics are never authority */}
 }
}

// At most one explicit held probe. Observers cannot alter the producer decision.
let heldObserver:((event:RolloverStrikeEvent)=>void)|null=null;
export function subscribeHeldRolloverDiagnostics(observer:(event:RolloverStrikeEvent)=>void):()=>void {
 if(heldObserver)throw Error('held_rollover_observer_already_active');
 heldObserver=observer;return ()=>{if(heldObserver===observer)heldObserver=null;};
}
export function publishHeldRolloverDiagnostics(event:RolloverStrikeEvent):void {
 try{heldObserver?.(event)}catch{/* observation only */}
}
