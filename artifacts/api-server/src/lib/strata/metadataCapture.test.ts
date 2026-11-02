import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {validateMetadataCapture,type MetadataCaptureManifest} from "./metadataCapture";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";
import {verifyOwnedFeeMetadata} from "./ownedMarketFeeMetadata";
import {ownedMarketEvidence} from "./personalExchangeRead";
import {preparePdfFreeApiFeePolicyReview} from "./apiFeePolicyReviewCandidate";
import {samePinnedCashModel} from "../v13EntryCashRisk";

const at=Date.parse("2026-10-31T04:47:00Z");
const market="KXBTC15M-26OCT310500-00",event="KXBTC15M-26OCT310500";
const mp=`/markets/${market}`,ep=`/events/${event}`;
const sp="/series/KXBTC15M",sc="/series/fee_changes?series_ticker=KXBTC15M&show_historical=false";
const ec=`/events/fee_changes?event_ticker=${event}&limit=100`;
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
function fixture():Record<string,Record<string,unknown>> {return {
  [mp]:{market:{ticker:market,event_ticker:event,exchange_index:2,status:"active",
    open_time:"2026-10-31T04:45:00Z",close_time:"2026-10-31T05:00:00Z",
    expiration_time:"2026-10-31T05:00:00Z",latest_expiration_time:"2026-10-31T05:00:00Z",
    expected_expiration_time:"2026-10-31T05:00:00Z",price_level_structure:"deci_cent"}},
  [ep]:{event:{event_ticker:event,series_ticker:"KXBTC15M",exchange_index:2,
    fee_type_override:null,fee_multiplier_override:null}},
  [sp]:{series:{ticker:"KXBTC15M",exchange_index:2,fee_type:"quadratic",fee_multiplier:1}},
  [sc]:{series_fee_change_arr:[]},[ec]:{event_fee_changes:[],cursor:""},
};}
function captured(pages=fixture(),start=at-1000):MetadataCaptureManifest {
  return {marketTicker:market,eventTicker:event,exchangeIndex:2,
    records:[mp,sp,sc,ep,ec].map((path,i)=>({path,
      requestStartedAtMs:start+(i<3?0:200),capturedAtMs:start+(i<3?200:400),
      rawSha256:sha(JSON.stringify(pages[path],null,2)),normalizedSha256:sha(JSON.stringify(pages[path])),
    }))};
}
function input(pages=fixture(),nowMs=at){return {
  marketTicker:market,eventTicker:event,nowMs,observedAtMs:nowMs,
  marketPayload:pages[mp],eventPayload:pages[ep],seriesPayload:pages[sp],
  seriesChangesPayload:pages[sc],eventChangesPayload:pages[ec],
};}
const neverFetch=(async()=>{throw Error("unexpected_provider_call");}) as typeof fetch;
function owned(pages=fixture(),manifest?:MetadataCaptureManifest,nowMs=at){
  return ownedMarketEvidence({...input(pages,nowMs),market,side:"YES",
    bookPayload:{orderbook_fp:{yes_dollars:[["0.5000","100"]],no_dollars:[["0.5000","100"]]}},
    configuredStakeCents:100,policyVersion:"standing",sourceUrl:"https://kalshi.com/fees",
    formulaVersion:"quadratic",artifactDigest:"ab".repeat(32),policyHash:"cd".repeat(32),verifiedAtMs:nowMs,
    ...(manifest===undefined?{}:{metadataCapture:manifest}),
  });
}

test("capture proof preserves originals, raw/normalized digests and a frozen bounded manifest",()=>{
  const pages=fixture(),manifest=captured(pages);
  const proof=validateMetadataCapture({...input(pages),manifest});assert.ok(proof);
  assert.equal(proof.observedAtMs,at-1000);assert.equal(proof.capturedThroughMs,at-600);
  assert.equal(proof.manifest.records.length,5);assert.deepEqual(proof.manifest,manifest);
  assert.ok(Object.isFrozen(proof));assert.ok(Object.isFrozen(proof.manifest));
  assert.ok(Object.isFrozen(proof.manifest.records));
  for(const record of proof.manifest.records){assert.ok(Object.isFrozen(record));assert.notEqual(record.rawSha256,record.normalizedSha256);}
  (manifest.records[0] as any).requestStartedAtMs=at;
  assert.equal(proof.manifest.records[0]!.requestStartedAtMs,at-1000,"caller mutation cannot restamp validated capture");
});

test("exact five path/digest/time invariants reject malformed, mismatched, missing and stale manifests",()=>{
  const cases:Array<(m:any)=>void>=[
    m=>m.marketTicker="KXBTC15M-OTHER",m=>m.eventTicker="KXBTC15M-OTHER",m=>m.exchangeIndex=1,
    m=>m.records.pop(),m=>m.records.push(m.records[0]),m=>m.records[1]=m.records[0],
    m=>m.records[0].path="/markets?series_ticker=KXBTC15M&status=open&limit=100",
    m=>m.records[0].normalizedSha256="f".repeat(64),m=>m.records[0].rawSha256="not-a-digest",
    m=>m.records[0].requestStartedAtMs=at-15001,m=>m.records[0].requestStartedAtMs=at+1,
    m=>m.records[0].capturedAtMs=at+1,m=>m.records[0].capturedAtMs=at-1001,
    m=>m.records[0].requestStartedAtMs=NaN,m=>m.records[0].capturedAtMs=at+.5,
    m=>m.records[3].requestStartedAtMs=at-1001,
  ];
  for(const mutate of cases){const manifest=captured();mutate(manifest);assert.equal(validateMetadataCapture({...input(),manifest}),null);}
  const pages=fixture(),manifest=captured(pages);(pages[sp]!.series as any).fee_multiplier=2;
  assert.equal(validateMetadataCapture({...input(pages),manifest}),null,"body substitution cannot retain capture proof");
});

test("15000ms inclusive metadata limit is unchanged and original time never advances on consumption",()=>{
  const manifest=captured(fixture(),at-15000);
  assert.equal(validateMetadataCapture({...input(),manifest})?.observedAtMs,at-15000);
  assert.equal(validateMetadataCapture({...input(fixture(),at+1),manifest}),null);
  for(const nowMs of [at-16000,NaN,at+.1])assert.equal(validateMetadataCapture({...input(fixture(),nowMs),manifest}),null);
});

test("fee probe default output and four eligibility clock reads stay identical; capture uses no extra read",async()=>{
  const pages=fixture();
  const run=async(manifest?:MetadataCaptureManifest)=>{
    const clocks:number[]=[],reads:string[]=[];let calls=0;
    const outcome=await probeCurrentKalshiFeeApi(neverFetch,()=>{const sampled=at+calls++;clocks.push(sampled);return sampled;},market,
      async path=>{reads.push(path);assert.ok(pages[path]);return pages[path]!;},manifest?()=>manifest:undefined);
    return {outcome,clocks,reads};
  };
  const ordinary=await run(),prefetched=await run(captured(pages));
  assert.equal(ordinary.outcome.ok,true);assert.equal(prefetched.outcome.ok,true);
  assert.deepEqual(ordinary.clocks,[at,at+1,at+2,at+3]);assert.deepEqual(prefetched.clocks,ordinary.clocks);
  assert.deepEqual(prefetched.reads,ordinary.reads);assert.equal(ordinary.reads.length,5);
  assert.equal(ordinary.outcome.liveVerifiedAt,new Date(at+3).toISOString());
  assert.equal(ordinary.outcome.metadataCapture,undefined);
  const expected=sha(JSON.stringify({series:"KXBTC15M",ticker:market,eventTicker:event,
    seriesFeeType:"quadratic",seriesMultiplier:1,seriesChanges:[],eventChanges:[],observedAt:at+3}));
  assert.equal(ordinary.outcome.metadataDigest,expected,"default digest byte-for-byte legacy formula");
  assert.equal(prefetched.outcome.liveVerifiedAt,new Date(at-1000).toISOString());
  assert.equal(prefetched.outcome.metadataCapture?.observedAtMs,at-1000);
  assert.notEqual(prefetched.outcome.metadataDigest,ordinary.outcome.metadataDigest);
  assert.equal(prefetched.outcome.tradingEnabled,false);
});

test("capture-mode fee probe rejects unavailable/stale proof without network fallback or timestamp renewal",async()=>{
  const pages=fixture();let reads=0;
  const read=async(path:string)=>{reads++;return pages[path]!;};
  for(const manifest of [captured(pages,at-15001),undefined,null] as unknown as MetadataCaptureManifest[]){
    reads=0;const proof=await probeCurrentKalshiFeeApi(neverFetch,()=>at,market,read,()=>manifest);
    assert.equal(proof.ok,false);assert.equal(proof.reason,"market_fee_capture_invalid_or_stale");assert.equal(reads,5);
    assert.equal(proof.liveVerifiedAt,undefined);
  }
  reads=0;const noExact=await probeCurrentKalshiFeeApi(neverFetch,()=>at,undefined,read,()=>captured());
  assert.equal(noExact.ok,false);assert.equal(reads,0,"capture cannot enable inventory discovery");
});

test("owned fee retains semantic model identity while propagating older fee time and capture provenance",()=>{
  const pages=fixture(),manifest=captured(pages);
  const baseline=verifyOwnedFeeMetadata(input(pages));
  const prefetched=verifyOwnedFeeMetadata({...input(pages),metadataCapture:manifest});
  assert.ok(baseline.ok&&prefetched.ok);
  assert.equal(baseline.verifiedAtMs,at);assert.equal(prefetched.verifiedAtMs,at-1000);
  assert.equal(prefetched.fingerprint,baseline.fingerprint,"capture is not the semantic fee model");
  const ordinary=owned(pages),prepared=owned(pages,manifest),finalFresh=owned(pages,undefined,at+200);
  assert.equal(prepared.observedAtMs,at,"signed book clock is not replaced by metadata capture time");
  assert.equal(prepared.fee.verifiedAtMs,at-1000);assert.equal(ordinary.fee.verifiedAtMs,at);
  assert.deepEqual(prepared.fee.cashRisk,ordinary.fee.cashRisk);
  assert.equal(prepared.fee.fingerprint,ordinary.fee.fingerprint);
  assert.equal(samePinnedCashModel(prepared.fee,finalFresh.fee),true);
  assert.equal(prepared.publicMetadataCapture?.observedAtMs,at-1000);
  assert.equal(finalFresh.publicMetadataCapture,undefined,"ordinary final invocation does not inherit preparatory capture");
  assert.equal(finalFresh.fee.verifiedAtMs,at+200);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)).publicMetadataCapture,prepared.publicMetadataCapture,
    "original provenance survives durable decision serialization");
});

test("owned capture fails closed despite freshly sampled signed book/authorization timestamps",()=>{
  const pages=fixture();
  assert.equal(verifyOwnedFeeMetadata({...input(pages),metadataCapture:captured(pages,at-15001)}).ok,false);
  assert.equal(verifyOwnedFeeMetadata({...input(pages),metadataCapture:null as any}).ok,false);
  assert.throws(()=>owned(pages,captured(pages,at-15001)),/production_event_fee_evidence_unverified/);
  const manifest=captured(pages);(pages[sp]!.series as any).fee_multiplier=2;
  assert.throws(()=>owned(pages,manifest),/production_event_fee_evidence_unverified/);
});


test("downstream fee-policy candidate preserves original time and its stricter 10s limit",async()=>{
  const pages=fixture();
  const read=async(path:string)=>pages[path]!;
  for(const age of [1000,10000,10001]){
    const probe=await probeCurrentKalshiFeeApi(neverFetch,()=>at,market,read,()=>captured(pages,at-age));
    assert.equal(probe.ok,true,"body capture itself still uses existing 15s maximum");
    const candidate=preparePdfFreeApiFeePolicyReview(probe,at);
    assert.equal(candidate.ok,age<=10000);
    if(candidate.ok){assert.equal(candidate.verifiedAt,new Date(at-age).toISOString());assert.equal(candidate.tradingAuthorized,false);}
    else assert.equal(candidate.reason,"live_api_fee_observation_stale");
  }
});

test("capture getter failure is held as metadata failure, never silently re-fetched",async()=>{
  const pages=fixture();let reads=0,captures=0;
  const outcome=await probeCurrentKalshiFeeApi(neverFetch,()=>at,market,async path=>{reads++;return pages[path]!;},()=>{
    captures++;throw Error("original_capture_unavailable");
  });
  assert.equal(outcome.ok,false);assert.equal(outcome.reason,"official_api_metadata_unavailable");
  assert.equal(reads,5);assert.equal(captures,1);assert.equal(outcome.liveVerifiedAt,undefined);
});
