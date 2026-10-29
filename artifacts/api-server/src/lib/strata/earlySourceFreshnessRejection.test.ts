import test from "node:test";
import assert from "node:assert/strict";
import {earlySourceFreshnessRejection as precheck} from "./earlySourceFreshnessRejection";

const base={
 evaluatedAtMs:10_000,observedAtMs:12_500,maxQuoteAgeMs:5_000,
 btcProviderAgeMs:950,btcReceiveAgeMs:0,marketAgeMs:0,
};
test("fresh source stays eligible for full independent transactional checks",()=>{
 assert.equal(precheck(base),null);
 assert.equal(precheck({...base,observedAtMs:14_050}),null);
});
test("stale effective feed is refused even before market fee and book GET",()=>{
 assert.equal(precheck({...base,observedAtMs:14_632}),
   "production_source_feed_stale_or_changed");
 assert.equal(precheck({...base,observedAtMs:15_001}),
   "production_evaluation_stale");
 assert.equal(precheck({...base,btcProviderAgeMs:4_000}),
   "production_source_feed_stale_or_changed");
});
test("future sources, missing feed leg and missing policy fail closed",()=>{
 assert.equal(precheck({...base,observedAtMs:9_999}),"production_evaluation_stale");
 assert.equal(precheck({...base,maxQuoteAgeMs:NaN}),"production_evaluation_stale");
 assert.equal(precheck({...base,btcReceiveAgeMs:null}),"production_source_feed_stale_or_changed");
 assert.equal(precheck({...base,marketAgeMs:-1}),"production_source_feed_stale_or_changed");
});
test("does not extend five-second cap or mutate inputs",()=>{
 const source=Object.freeze({...base});
 assert.equal(precheck(source),null);
 assert.equal(precheck({...source,observedAtMs:15_000,btcProviderAgeMs:0}),null);
 assert.equal(precheck({...source,observedAtMs:15_000,btcProviderAgeMs:0.1}),
  "production_source_feed_stale_or_changed");
 assert.equal(source.observedAtMs,12_500);
});
