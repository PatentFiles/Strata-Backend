import test from 'node:test';import assert from 'node:assert/strict';
import {captureFinalComparison,isFinalComparisonDiagnostics} from './finalComparisonDiagnostics';
import {entryCashRiskFeeFixture} from './entryCashRisk.fixture';
import {cashRiskModelFingerprint,cashRiskFeeFingerprint,samePinnedCashModel} from '../v13EntryCashRisk';
import {beginExecutionStage,type StageTiming} from './stageTiming';import type {MarketEvidence} from './types';
const fee=(price:number)=>entryCashRiskFeeFixture({now:10000,market:'KXBTC15M-TEST',side:'NO',price,contracts:13,policyHash:'a'.repeat(64)});
const book=(price:number):MarketEvidence=>({observedAtMs:10000,bestAskDollars:price.toFixed(4),bestBidDollars:(price-.01).toFixed(4),asks:[],bids:[],fee:fee(price)});
const input=()=>({cashEntry:true,stored:book(.38),fresh:book(.40),pinnedFingerprint:fee(.38).fingerprint,requestContracts:3,pinnedLimitMicros:380000,
 source:{entry_offer:.44,evaluated_at:new Date(9000),btc_provider_age_ms:1225,btc_receive_age_ms:0,market_age_ms:0},maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:15000,sampledAtMs:11000});
test('38 to40 bounce below44 source is categorized against pinned38, not preliminary13 versus requested3',()=>{
 const i=input(),d=captureFinalComparison(i)!;assert.equal(samePinnedCashModel(i.stored.fee,i.fresh.fee),false);
 assert.ok(d.categories.includes('fresh_fee_limit_above_pinned'));assert.equal(d.pinnedLimitMicros,380000);assert.equal(d.sourceReferenceOffer,.44);
 assert.equal(d.requestContracts,3);assert.equal(d.storedFeeContracts,13);assert.equal(d.freshBestAsk,.40);assert.equal(d.flags.modelEqual,true);assert.equal(d.originalBtcProviderAgeMs,1225);
});
test('semantic model change and malformed evidence have separate categories',()=>{
 const i=input();i.fresh=book(.38);i.fresh.fee.cashRisk!.gridDigest='f'.repeat(64);i.fresh.fee.cashRisk!.modelFingerprint=cashRiskModelFingerprint(i.fresh.fee.cashRisk!);i.fresh.fee.fingerprint=cashRiskFeeFingerprint(i.fresh.fee);
 assert.ok(captureFinalComparison(i)!.categories.includes('semantic_model_or_scope_changed'));i.fresh.fee.cashRisk!.entryCashDebitPerContractMicros=1;assert.ok(captureFinalComparison(i)!.categories.includes('cash_evidence_invalid'));
});
test('age sample is not guard clock; stale/future/unknown never zero',()=>{
 const i=input();i.fresh=book(.38);i.sampledAtMs=30001;let d=captureFinalComparison(i)!;assert.ok(d.categories.includes('quote_age_outside_limit_at_sample'));assert.ok(d.categories.includes('fee_age_outside_limit_at_sample'));
 assert.equal(d.semantics,'post_failure_diagnostic_sample_not_guard_clock');assert.equal(d.bookAgeAtSampleMs,20001);i.sampledAtMs=9000;assert.equal(captureFinalComparison(i)!.bookAgeAtSampleMs,-1000);i.sampledAtMs=NaN;assert.equal(captureFinalComparison(i)!.bookAgeAtSampleMs,null);
});
test('immutable allowlist excludes payloads and copied/fake objects',()=>{
 const i=input();Object.assign(i.fresh,{credentials:'secret-password',providerBody:'secret-body'});const d=captureFinalComparison(i)!;
 assert.doesNotMatch(JSON.stringify(d),/secret|https:|[a-f0-9]{64}|KXBTC/i);assert.ok(Object.isFrozen(d)&&Object.isFrozen(d.flags)&&Object.isFrozen(d.categories));assert.equal(isFinalComparisonDiagnostics({...d}),false);assert.equal(isFinalComparisonDiagnostics(d),true);
 Object.defineProperty(i.fresh,'fee',{get(){throw Error('poison');}});assert.equal(captureFinalComparison(i),undefined);
});
test('only branded rejected final diagnostics emit; failing observer never becomes ACK',async()=>{
 const events:StageTiming[]=[],d=captureFinalComparison(input())!;const observer=(e:StageTiming)=>{events.push(e);throw Error('observer');};
 for(const [outcome,value] of [['rejected',d],['completed',d],['rejected',{...d}]] as const)beginExecutionStage(observer,'final_preparation',{accountId:'test',mode:'LIVE'})(outcome,{finalComparison:value});
 await Promise.resolve();assert.equal(events[0]!.finalComparison,d);assert.equal(events[1]!.finalComparison,undefined);assert.equal(events[2]!.finalComparison,undefined);assert.ok(events.every(e=>e.stage!=='http_ack'));
});

test('semantic component flags distinguish policy/artifact/fee/series changes without emitting digests',()=>{
 for(const field of ['policyHash','artifactDigest','feeMetadataDigest','seriesDigest','gridDigest'] as const){
  const i=input();i.fresh=book(.38);i.fresh.fee.cashRisk![field]='f'.repeat(64);
  i.fresh.fee.cashRisk!.modelFingerprint=cashRiskModelFingerprint(i.fresh.fee.cashRisk!);i.fresh.fee.fingerprint=cashRiskFeeFingerprint(i.fresh.fee);
  const d=captureFinalComparison(i)!;assert.equal(d.flags.modelEqual,false);
  const key=field==='gridDigest'?'gridEqual':field+'Equal';assert.equal(d.flags[key],false);
  assert.ok(d.categories.includes('semantic_model_or_scope_changed'));assert.doesNotMatch(JSON.stringify(d),/[a-f0-9]{64}/);
 }
});
