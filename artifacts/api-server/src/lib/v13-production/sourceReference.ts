import {evaluateV13Strategy,previousBufferFromSide,type V13Decision} from "@workspace/v13-strategy";
import {requireProof} from "./types";

/** The generic IOC planner supports legacy strategy caps. Production must bind
 * its reference price to the exact current champion classification instead of
 * trusting an independently stored entry_offer field. No rounding or slippage
 * allowance: the canonical producer stores this same classifier value. */
export function assertChampionSourceReference(value:unknown):V13Decision {
  requireProof(value!==null&&typeof value==="object"&&!Array.isArray(value),
    "production_source_reference_mismatch");
  const source=value as Record<string,unknown>;
  const finite=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
  const classified=evaluateV13Strategy({
    marketTicker:typeof source.market_ticker==="string"?source.market_ticker:null,
    btcPrice:finite(source.btc_price),target:finite(source.target),
    previousBuffer:previousBufferFromSide(typeof source.previous_side==="string"?source.previous_side:null),
    velocity:finite(source.velocity),upOffer:finite(source.up_offer),downOffer:finite(source.down_offer),
    freshness:"current",position:null,
  });
  requireProof(classified.signal===source.signal&&classified.direction===source.direction&&
    classified.qualifyingTrigger&&classified.freshCross,"production_source_classification_mismatch");
  requireProof(typeof source.entry_offer==="number"&&Number.isFinite(source.entry_offer)&&
    classified.entrySideOffer!==null&&Number.isFinite(classified.entrySideOffer)&&
    source.entry_offer===classified.entrySideOffer,
    "production_source_reference_mismatch");
  return classified;
}
