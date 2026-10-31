import test from "node:test";
import assert from "node:assert/strict";
import {captureEntryPriceDiagnostics} from "./entryPriceDiagnostics";
import {beginExecutionStage,type StageTiming} from "./stageTiming";
import {planV13IocEntry} from "../v13ExecutionPlanner";
const source={signal:"SCOUT",direction:"DOWN",entry_offer:0.48,evaluated_at:"2026-10-31T04:47:52.373Z",btc_provider_age_ms:793,btc_receive_age_ms:0,market_age_ms:0};
const book={bestAskDollars:"0.4900",bestBidDollars:"0.4800",observedAtMs:12345,asks:[{priceDollars:"0.4900",availableContracts:"10"}]};
test("48-to-49 rejection is unchanged for both DOWN/NO and UP/YES",()=>{
 for(const direction of ["DOWN","UP"] as const){
  const before=planV13IocEntry({signal:"SCOUT",direction,referenceOffer:.48,maxStakeCents:500,bestAskDollars:book.bestAskDollars,askLevels:book.asks});
  const d=captureEntryPriceDiagnostics({...source,direction},book)!;
  assert.equal(d.side,direction==="DOWN"?"NO":"YES");
  assert.equal(d.referenceOffer,.48);assert.equal(d.championCap,.52);
  assert.equal(d.plannerCap,.60);assert.equal(d.effectiveCeiling,.48);assert.equal(d.bestAskDollars,.49);
  assert.equal(d.sampledContractsAtOrBelowCeiling,0);
  assert.deepEqual(before,{ok:false,reason:"best_ask_above_signal_ceiling"});
  assert.deepEqual(planV13IocEntry({signal:"SCOUT",direction,referenceOffer:.48,maxStakeCents:500,bestAskDollars:book.bestAskDollars,askLevels:book.asks}),before);
 }
});
test("decimal-cent depth remains precise, bounded and immutable; unmeasured times are null",()=>{
 const asks=Array.from({length:10000},()=>({priceDollars:"0.4799",availableContracts:"2.50",token:"SECRET"}));
 const d=captureEntryPriceDiagnostics(source,{...book,bestAskDollars:"0.4799",asks})!;
 assert.equal(d.bestAskDollars,.4799);assert.equal(d.sampledAskLevels.length,3);
 assert.equal(d.sampledContractsAtOrBelowCeiling,7.5);assert.equal(d.depthTruncated,true);
 assert.equal(d.bookObservationStartAtMs,12345);assert.equal(d.bookReceiptAtMs,null);
 assert.equal(d.bookProviderTimestampMs,null);assert.equal(d.bookProviderRttMs,null);
 assert.equal(d.feeVerificationDurationMs,null);assert.equal(d.sourceBtcProviderAgeMs,793);
 asks[0]!.priceDollars="0.9999";assert.equal(d.sampledAskLevels[0]!.priceDollars,.4799);
 assert.ok(Object.isFrozen(d));assert.ok(Object.isFrozen(d.sampledAskLevels));
 assert.ok(Object.isFrozen(d.sampledAskLevels[0]));assert.ok(!JSON.stringify(d).includes("SECRET"));
});
test("malformed values and hostile getters cannot throw or leak payloads",()=>{
 const d=captureEntryPriceDiagnostics({...source,entry_offer:NaN,authorization:"SECRET"},
  {...book,bestAskDollars:"Bearer SECRET",asks:[{priceDollars:"49",availableContracts:"SECRET"}],rawBody:"SECRET"})!;
 assert.equal(d.referenceOffer,null);assert.equal(d.bestAskDollars,null);assert.equal(d.sampledContractsAtOrBelowCeiling,null);
 assert.ok(!JSON.stringify(d).includes("SECRET"));
 assert.equal(captureEntryPriceDiagnostics(source,new Proxy({}, {get(){throw Error("SECRET")}})),undefined);
 assert.equal(captureEntryPriceDiagnostics(null,book),undefined);
});
test("prepare event includes only genuine whitelisted diagnostics; observer failures are detached",async()=>{
 const events:StageTiming[]=[];const d=captureEntryPriceDiagnostics(source,book)!;
 const context={accountId:"test-account",mode:"LIVE" as const,evaluationId:"test-evaluation"};
 beginExecutionStage(e=>{events.push(e)},"prepare_entry",context)("rejected",{entryPrice:d,error:Error("live_money_best_ask_above_signal_ceiling")});
 beginExecutionStage(e=>{events.push(e)},"prepare_entry",context)("rejected",{entryPrice:{rawBody:"SECRET"} as never});
 beginExecutionStage(e=>{events.push(e)},"reconciliation",context)("completed",{entryPrice:d});
 beginExecutionStage(()=>{throw Error("logger")},"prepare_entry",context)("rejected",{entryPrice:d});
 beginExecutionStage(()=>Promise.reject(Error("logger")),"prepare_entry",context)("rejected",{entryPrice:d});
 await Promise.resolve();assert.equal(events[0]!.entryPrice,d);
 assert.equal(events[1]!.entryPrice,undefined);assert.equal(events[2]!.entryPrice,undefined);
 assert.ok(!JSON.stringify(events).includes("SECRET"));
});

import {attachMarketEvidenceReadTiming,createMarketEvidenceReadTiming} from '../strata/marketEvidenceReadTiming';
test('only genuine attached full-read timings survive; provider RTT stays unmeasured',async()=>{
 let clock=10;
 const timing=createMarketEvidenceReadTiming(()=>clock);
 await timing.read('book',async()=>{clock=12.125;return undefined;});
 await timing.read('fee',async()=>{clock=15;return undefined;});
 const timedBook=attachMarketEvidenceReadTiming({...book},timing.snapshot());
 const d=captureEntryPriceDiagnostics(source,timedBook)!;
 assert.equal(d.evidenceReads?.semantics,'full_read_elapsed_including_local_work');
 assert.equal(d.evidenceReads?.reads.book?.elapsedMs,2.125);
 assert.equal(d.evidenceReads?.reads.fee?.elapsedMs,2.875);
 assert.equal(d.evidenceReads?.reads.fee?.startOffsetMs,2.125);
 assert.equal(d.bookProviderRttMs,null);assert.equal(d.bookReceiptAtMs,null);
 assert.equal(d.feeVerificationDurationMs,null,'full call duration is labeled in evidenceReads instead');
 assert.ok(Object.isFrozen(d.evidenceReads));assert.ok(Object.isFrozen(d.evidenceReads!.reads));
 assert.equal(captureEntryPriceDiagnostics(source,book)?.evidenceReads,undefined);
 const fake={...book,evidenceReads:{authorization:'SECRET'},rawBody:'SECRET'};
 Object.defineProperty(fake,'readTiming',{get(){throw Error('SECRET');}});
 const sanitized=captureEntryPriceDiagnostics(source,fake)!;
 assert.equal(sanitized.evidenceReads,undefined);assert.ok(!JSON.stringify(sanitized).includes('SECRET'));
 assert.equal(captureEntryPriceDiagnostics(source,{...timedBook})?.evidenceReads,undefined,
  'timing belongs to exact evidence object; copying does not manufacture provenance');
});
