import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,evaluateV13Strategy,type V13Input,type V13Decision} from '@workspace/v13-strategy';

/** Independently versioned research candidate. No signer, ledger, worker,
 * transport, or execution capability is imported. C52/C53 remains byte-for-byte
 * unchanged. This first ablation changes ONLY post-cross entry confirmation.
 */
export const WARREN_BUFFETT_SPEC=Object.freeze({
 id:'warren-buffett-delayed-cross-v1',name:'Warren Buffett',version:1,
 baseStrategyId:V13_CHAMPION_PARAMETER_SET.id,baseParameterHash:V13_CHAMPION_PARAMETER_HASH,
 confirmationWindowMs:15_000,maximumObservationGapMs:5_000,maximumSourceAgeMs:5_000,velocityWindowMs:30_000,
 entryParameters:V13_CHAMPION_PARAMETER_SET.parameters,exitPolicy:'UNCHANGED_C52_C53',
 trainingStatus:'NOT_TRAINED',executionAuthority:'NONE',liveSelectable:false,
} as const);
export type WarrenObservation=Readonly<{
 market:string;target:number;btc:number;openMs:number;closeMs:number;nowMs:number;
 providerAtMs:number;receivedAtMs:number;marketObservedAtMs:number;
}>;
export type WarrenQuote=Readonly<{
 market:string;requestStartedAtMs:number;receivedAtMs:number;upOffer:number;downOffer:number;
}>;
type Direction='UP'|'DOWN';
type Cross=Readonly<{
 market:string;target:number;direction:Direction;crossedAtMs:number;expiresAtMs:number;
 previousBuffer:number;crossingBuffer:number;
}>;
export type WarrenCandidate=Readonly<{
 id:number;strategyId:typeof WARREN_BUFFETT_SPEC.id;direction:Direction;signal:'SCOUT'|'CONFIRM';
 observation:WarrenObservation;crossing:Cross;velocity:number;freshCrossAtObservation:boolean;executionAuthority:'NONE';
}>;
export type WarrenDecision=Readonly<{
 outcome:'PASS'|'ERROR'|'QUOTE_REQUIRED'|'QUALIFIED';reason:string;executionAuthority:'NONE';
 strategyId:typeof WARREN_BUFFETT_SPEC.id;candidate?:WarrenCandidate;referenceOffer?:number;
}>;
const time=(v:number)=>Number.isSafeInteger(v)&&v>0;
const positive=(v:number)=>Number.isFinite(v)&&v>0;
const offer=(v:number)=>Number.isFinite(v)&&v>0&&v<1;
const side=(buffer:number):Direction|null=>buffer>0?'UP':buffer<0?'DOWN':null;
const answer=(outcome:WarrenDecision['outcome'],reason:string,extra:Partial<WarrenDecision>={}):WarrenDecision=>
 Object.freeze({outcome,reason,...extra,executionAuthority:'NONE',strategyId:WARREN_BUFFETT_SPEC.id});

export class WarrenBuffettResearch {
 private previous:WarrenObservation|null=null;
 private cross:Cross|null=null;
 private points:Array<{price:number;at:number}>=[];
 private candidate:WarrenCandidate|null=null;
 private lastClock=0;
 private serial=0;
 private emittedMarket:string|null=null;
 private resetHistory():void {
  this.previous=null;this.cross=null;this.points=[];this.candidate=null;
  // A feed gap is not permission to emit a second same-market signal.
 }
 observe(raw:WarrenObservation):WarrenDecision {
  this.candidate=null;
  if(!time(raw.nowMs)||raw.nowMs<this.lastClock){this.resetHistory();return answer('ERROR','clock_regression');}
  this.lastClock=raw.nowMs;
  const times=[raw.providerAtMs,raw.receivedAtMs,raw.marketObservedAtMs];
  if(!/^KXBTC15M-[A-Za-z0-9-]+$/.test(raw.market)||!positive(raw.target)||!positive(raw.btc)||
   !time(raw.openMs)||!time(raw.closeMs)||raw.closeMs-raw.openMs!==900_000||raw.openMs>raw.nowMs||raw.closeMs<=raw.nowMs||
   times.some(t=>!time(t)||t>raw.nowMs||raw.nowMs-t>WARREN_BUFFETT_SPEC.maximumSourceAgeMs)||raw.providerAtMs>raw.receivedAtMs){
   this.resetHistory();return answer('ERROR','market_or_feed_invalid');
  }
  const current=Object.freeze({...raw}),prior=this.previous;
  if(prior&&prior.market===current.market&&(prior.target!==current.target||prior.openMs!==current.openMs||prior.closeMs!==current.closeMs)){
   this.resetHistory();return answer('ERROR','market_identity_changed');
  }
  const continuous=prior!==null&&prior.market===current.market&&current.providerAtMs>prior.providerAtMs&&
   current.receivedAtMs>prior.receivedAtMs&&current.providerAtMs-prior.providerAtMs<=WARREN_BUFFETT_SPEC.maximumObservationGapMs&&
   current.receivedAtMs-prior.receivedAtMs<=WARREN_BUFFETT_SPEC.maximumObservationGapMs;
  if(!continuous){this.cross=null;this.points=[];}
  this.previous=current;
  this.points=[...this.points.filter(p=>current.receivedAtMs-p.at<=WARREN_BUFFETT_SPEC.velocityWindowMs),
   {price:current.btc,at:current.receivedAtMs}].slice(-180);
  if(!continuous||!prior)return answer('PASS','continuous_crossing_history_required');
  const buffer=current.btc-current.target,previousBuffer=prior.btc-current.target;
  const direction:Direction|null=previousBuffer<=0&&buffer>0?'UP':previousBuffer>=0&&buffer<0?'DOWN':null;
  if(direction)this.cross=Object.freeze({market:current.market,target:current.target,direction,crossedAtMs:current.nowMs,
   expiresAtMs:Math.min(current.closeMs,current.nowMs+WARREN_BUFFETT_SPEC.confirmationWindowMs),previousBuffer,crossingBuffer:buffer});
  if(this.emittedMarket===current.market)return answer('PASS','market_signal_already_emitted');
  const cross=this.cross;
  if(!cross)return answer('PASS','no_pending_cross');
  if(current.nowMs>=cross.expiresAtMs){this.cross=null;return answer('PASS','confirmation_window_expired');}
  if(side(buffer)!==cross.direction){this.cross=null;return answer('PASS','cross_invalidated');}
  const first=this.points[0]!,last=this.points.at(-1)!;
  const velocity=last.at>first.at?(last.price-first.price)*60000/(last.at-first.at):NaN;
  if(!Number.isFinite(velocity)||(cross.direction==='UP'?velocity<=0:velocity>=0))return answer('PASS','directional_velocity_not_supportive');
  const p=WARREN_BUFFETT_SPEC.entryParameters,separation=Math.abs(buffer);
  const signal=separation>=p.confirmMinSeparation?'CONFIRM':separation>=p.scoutMinSeparation&&separation<=p.scoutMaxSeparation?'SCOUT':null;
  if(!signal)return answer('PASS','awaiting_post_cross_separation');
  this.candidate=Object.freeze({id:++this.serial,strategyId:WARREN_BUFFETT_SPEC.id,direction:cross.direction,signal,
   observation:current,crossing:cross,velocity,freshCrossAtObservation:direction!==null,executionAuthority:'NONE'});
  return answer('QUOTE_REQUIRED','fresh_quote_required',{candidate:this.candidate});
 }
 /** The pending cross is historical context, NOT fresh order evidence. The
  * current snapshot and quote retain the five-second freshness budget. Object
  * custody rejects fabricated, replayed, or superseded candidates. */
 price(candidate:WarrenCandidate,quote:WarrenQuote,nowMs:number):WarrenDecision {
  if(candidate!==this.candidate||!this.cross||candidate.crossing!==this.cross)return answer('ERROR','candidate_custody_unverified');
  const observation=candidate.observation;
  if(!time(nowMs)||nowMs<this.lastClock){this.resetHistory();return answer('ERROR','clock_regression');}
  this.lastClock=nowMs;
  const oldest=Math.min(observation.nowMs,observation.providerAtMs,observation.receivedAtMs,observation.marketObservedAtMs);
  if(nowMs-oldest>WARREN_BUFFETT_SPEC.maximumSourceAgeMs||nowMs>=candidate.crossing.expiresAtMs||nowMs>=observation.closeMs||
   quote.market!==observation.market||!time(quote.requestStartedAtMs)||!time(quote.receivedAtMs)||
   quote.requestStartedAtMs<observation.nowMs||quote.receivedAtMs<quote.requestStartedAtMs||quote.receivedAtMs>nowMs||
   !offer(quote.upOffer)||!offer(quote.downOffer)){
   this.candidate=null;return answer('ERROR','quote_or_source_evidence_invalid');
  }
  const referenceOffer=candidate.direction==='UP'?quote.upOffer:quote.downOffer;
  const ceiling=candidate.signal==='SCOUT'?WARREN_BUFFETT_SPEC.entryParameters.scoutMaxOffer:WARREN_BUFFETT_SPEC.entryParameters.confirmMaxOffer;
  if(referenceOffer>ceiling)return answer('PASS','market_already_repriced');
  this.emittedMarket=observation.market;this.candidate=null;this.cross=null;
  return answer('QUALIFIED','research_signal_only',{candidate,referenceOffer});
 }
}

/** Exit behavior stays unchanged for attribution. Hysteresis, benchmark
 * replacement, sizing and fee changes need separate evaluated experiments. */
export function evaluateWarrenBuffettExit(input:V13Input):V13Decision {
 if(input.position?.status!=='open')throw Error('research_open_position_required');
 return evaluateV13Strategy(input);
}
