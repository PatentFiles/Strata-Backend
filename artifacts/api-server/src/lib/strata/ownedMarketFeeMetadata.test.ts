import assert from "node:assert/strict";
import test from "node:test";
import { verifyOwnedFeeMetadata, type OwnedFeeMetadataInput } from "./ownedMarketFeeMetadata";

const at = Date.parse("2026-10-15T21:00:00.000Z");
const market="KXBTC15M-26OCT152115-15";
const event="KXBTC15M-26OCT152115";
function fixture(): OwnedFeeMetadataInput {
  return {
    marketTicker:market,observedAtMs:at,nowMs:at+100,
    marketPayload:{market:{
      ticker:market,event_ticker:event,status:"active",exchange_index:2,
      close_time:"2026-10-15T21:15:00Z",expiration_time:"2026-10-15T21:16:00Z",
      latest_expiration_time:"2026-10-15T21:16:00Z",expected_expiration_time:"2026-10-15T21:16:00Z",
    }},
    seriesPayload:{series:{ticker:"KXBTC15M",fee_type:"quadratic",fee_multiplier:1}},
    eventPayload:{event:{event_ticker:event,series_ticker:"KXBTC15M",
      fee_type_override:null,fee_multiplier_override:null}},
    seriesChangesPayload:{series_fee_change_arr:[],cursor:""},
    eventChangesPayload:{event_fee_changes:[],cursor:""},
  };
}
const verify = (patch: (p: OwnedFeeMetadataInput)=>void) => {
  const p=fixture();patch(p);return verifyOwnedFeeMetadata(p);
};
test("accepts exact market when series, event and scheduled changes all clear",()=>{
  const ok=verifyOwnedFeeMetadata(fixture());
  assert.equal(ok.ok,true);
  if (ok.ok) assert.match(ok.fingerprint,/^[0-9a-f]{64}$/);
});
test("rejects wrong multiplier, fee type, series or event identity",()=>{
  for(const bad of [
    (p:OwnedFeeMetadataInput)=>{(p.seriesPayload as any).series.fee_multiplier=0.5;},
    (p:OwnedFeeMetadataInput)=>{(p.seriesPayload as any).series.fee_type="flat";},
    (p:OwnedFeeMetadataInput)=>{(p.seriesPayload as any).series.ticker="OTHER";},
    (p:OwnedFeeMetadataInput)=>{(p.eventPayload as any).event.event_ticker="OTHER";},
    (p:OwnedFeeMetadataInput)=>{(p.eventPayload as any).event.series_ticker="OTHER";},
  ]) assert.equal(verify(bad).ok,false);
});
test("rejects event overrides and market-specific fee fields",()=>{
  for (const bad of [
    (p:OwnedFeeMetadataInput)=>{(p.eventPayload as any).event.fee_multiplier_override=2;},
    (p:OwnedFeeMetadataInput)=>{(p.eventPayload as any).event.fee_type_override="flat";},
    (p:OwnedFeeMetadataInput)=>{(p.marketPayload as any).market.custom_fee=0.02;},
  ]) assert.equal(verify(bad).ok,false);
});
test("rejects unverified scheduled changes overlapping lifecycle",()=>{
  for (const key of ["seriesChangesPayload","eventChangesPayload"] as const) {
    const p=fixture();
    const field=key==="seriesChangesPayload"?"series_fee_change_arr":"event_fee_changes";
    (p[key] as any)[field]=[{id:"change1",scheduled_ts:"2026-10-15T21:15:30Z"}];
    assert.equal(verifyOwnedFeeMetadata(p).ok,false);
    (p[key] as any)[field]=[{id:"change1",scheduled_ts:"2026-10-15T22:00:00Z"}];
    assert.equal(verifyOwnedFeeMetadata(p).ok,true);
    (p[key] as any).cursor="more";
    assert.equal(verifyOwnedFeeMetadata(p).ok,false);
  }
});
test("rejects missing lists, timestamps, stale snapshot, and ambiguous market fees",()=>{
  for (const bad of [
    (p:OwnedFeeMetadataInput)=>{(p.seriesChangesPayload as any).series_fee_change_arr=undefined;},
    (p:OwnedFeeMetadataInput)=>{(p.eventChangesPayload as any).event_fee_changes=undefined;},
    (p:OwnedFeeMetadataInput)=>{(p.marketPayload as any).market.close_time="invalid";},
    (p:OwnedFeeMetadataInput)=>{(p.marketPayload as any).market.expiration_time=undefined;},
    (p:OwnedFeeMetadataInput)=>{p.nowMs=at+15_001;},
    (p:OwnedFeeMetadataInput)=>{p.nowMs=at-1;},
    (p:OwnedFeeMetadataInput)=>{(p.seriesChangesPayload as any).series_fee_change_arr=Array(101).fill({id:"i",scheduled_ts:"2026-10-15T22:00:00Z"});},
  ]) assert.equal(verify(bad).ok,false);
});
test("fingerprint binds current fee-change schedule; changed metadata is not equal",()=>{
  const initial=verifyOwnedFeeMetadata(fixture());
  const changed=verify(p=>{(p.seriesChangesPayload as any).series_fee_change_arr=[{id:"future1",scheduled_ts:"2026-10-15T22:00:00Z"}];});
  assert.equal(initial.ok,true);
  assert.equal(changed.ok,true);
  if(initial.ok && changed.ok) assert.notEqual(initial.fingerprint,changed.fingerprint);
});
