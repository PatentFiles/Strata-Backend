import {V13_CHAMPION_PARAMETER_SET,type V13Decision} from '@workspace/v13-strategy';
import {requireProof} from '../v13-production/types';
import {WARREN_BOT,WARREN_BOT_HASH} from './warrenBotIdentity';
type R=Record<string,unknown>;
const number=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
const time=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
/** Only the same-process sealed independent producer may supply this receipt.
 * Historical crossing context never lengthens the five-second CURRENT quote
 * or feed limits enforced by the shared executor and final wire.
 */
export function assertWarrenSourceReference(raw:unknown):V13Decision{
 requireProof(!!raw&&typeof raw==='object'&&!Array.isArray(raw),'warren_source_invalid');
 const s=raw as R,w=s.warren_crossing;
 requireProof(s.bot_strategy_id===WARREN_BOT&&s.bot_spec_hash===WARREN_BOT_HASH&&
  w&&typeof w==='object'&&!Array.isArray(w),'warren_strategy_identity_invalid');
 const c=w as R, now=Date.parse(String(s.evaluated_at??'')),target=s.target,btc=s.btc_price,velocity=s.velocity;
 requireProof(time(now)&&number(target)&&target>0&&number(btc)&&btc>0&&number(velocity)&&
  time(c.crossedAtMs)&&time(c.expiresAtMs)&&
  c.expiresAtMs===Math.min(Number(s.market_close_ms),Number(c.crossedAtMs)+15000)&&
  now>=Number(c.crossedAtMs)&&now<Number(c.expiresAtMs)&&
  c.market===s.market_ticker&&c.target===target&&c.direction===s.direction&&
  number(c.previousBuffer)&&number(c.crossingBuffer),'warren_crossing_evidence_invalid');
 const direction=s.direction as 'UP'|'DOWN',buffer=btc-target;
 const crossed=direction==='UP'?c.previousBuffer<=0&&c.crossingBuffer>0&&buffer>0:
  c.previousBuffer>=0&&c.crossingBuffer<0&&buffer<0;
 const velocityValid=direction==='UP'?velocity>0:velocity<0;
 const prior=String(s.previous_side);
 const currentlyCrossed=direction==='UP'?(prior==='DOWN'||prior==='AT'):(prior==='UP'||prior==='AT');
 requireProof(crossed&&velocityValid&&s.fresh_cross===currentlyCrossed&&
  s.position_was_open===false&&s.qualifying_trigger===true&&s.crossing_consumed===true&&
  s.feed_freshness==='current'&&Math.abs(Number(s.signed_buffer)-buffer)<0.00001,
  'warren_crossing_classification_invalid');
 const p=V13_CHAMPION_PARAMETER_SET.parameters,sep=Math.abs(buffer),signal=s.signal;
 const wanted=sep>=p.confirmMinSeparation?'CONFIRM':sep>=p.scoutMinSeparation&&sep<=p.scoutMaxSeparation?'SCOUT':null;
 const cap=wanted==='CONFIRM'?p.confirmMaxOffer:p.scoutMaxOffer;
 const reference=direction==='UP'?s.up_offer:s.down_offer;
 requireProof(wanted!==null&&signal===wanted&&number(reference)&&reference>0&&reference<=cap&&
   reference===s.entry_offer&&number(s.up_offer)&&number(s.down_offer),
  'warren_entry_reference_mismatch');
 return {
  signal:wanted,direction,reason:'Warren delayed-cross source verified',
  qualifyingTrigger:true,entrySideOffer:reference,candidateOffer:reference,
  buffer,separation:sep,freshCross:currentlyCrossed,crossedDirection:currentlyCrossed?(direction==='UP'?'up':'down'):null,
  advanceCrossId:currentlyCrossed,positionExitReason:null,
 };
}
