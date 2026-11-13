import assert from "node:assert/strict";
import test from "node:test";
import {auditHistoricalPaperExecution,type HistoricalPaperQuote} from "./forwardTestExecutionAudit";
import {stressV13ResearchQuotes} from "./v13ResearchExecutionStress";

const base=(id:string,opts:Partial<HistoricalPaperQuote>={}):HistoricalPaperQuote=>({
 id,marketTicker:"KXBTC15M-26OCT210445-45",status:"CLOSED",
 entryOffer:0.015,exitPrice:0.9700,stake:4.995,contracts:333,pnl:318.02,...opts,
});
test("dominant $5 quote outlier is not treated as proven executable depth or net P&L",()=>{
 const audit=auditHistoricalPaperExecution([
  base("winner"),base("small",{entryOffer:0.50,exitPrice:0.51,stake:5,contracts:10,pnl:0.10}),
 ]);
 assert.equal(audit.mode,"PAPER_RESEARCH_ONLY");
 assert.equal(audit.tradingAuthority,false);
 assert.equal(audit.netPnlVerified,null);
 assert.equal(audit.quoteGrossUsd,318.12);
 assert.equal(audit.quoteGrossExLargestWinnerUsd,0.10);
 assert.equal(audit.largestQuoteWinnerUsd,318.02);
 assert.equal(audit.assessedQuotes,2);
 assert.equal(audit.depthEvidenceAvailable,false);
 assert.deepEqual(audit.hypotheticalScenarios.map(s=>s.assumedMaxContracts),[1,5,20]);
 for(const scenario of audit.hypotheticalScenarios){
  assert.equal(scenario.netIsExecutable,false);
  assert.equal(scenario.depthCoverage,0);
 }
 const [one,five,twenty]=audit.hypotheticalScenarios;
 assert.ok(one!.assumedNetUsd<five!.assumedNetUsd);
 assert.ok(five!.assumedNetUsd<twenty!.assumedNetUsd);
 assert.ok(twenty!.assumedNetUsd<318.12);
});
test("settled, missing, malformed and duplicate paper observations are excluded conservatively",()=>{
 const rows=[
  base("settled",{status:"SETTLED",pnl:5}),
  base("missing",{exitPrice:null,pnl:4}),
  base("invalid",{entryOffer:1.75,pnl:3}),
  base("first",{entryOffer:0.4,exitPrice:0.6,stake:4.8,contracts:12,pnl:2.4}),
  base("first",{entryOffer:0.4,exitPrice:0.6,stake:4.8,contracts:12,pnl:2.4}),
  base("open",{status:"OPEN",pnl:null}),
 ];
 const x=auditHistoricalPaperExecution(rows);
 assert.equal(x.completed,5);
 assert.equal(x.assessedQuotes,1);
 assert.equal(x.excludedQuotes,4);
 assert.equal(x.netPnlVerified,null);
 assert.equal(x.quoteGrossUsd,16.8);
 assert.equal(x.quoteGrossExLargestWinnerUsd,11.8);
});
test("unorderable 1-dollar close quote is excluded rather than breaking the entire history",()=>{
 const x=auditHistoricalPaperExecution([
  base("unorderable",{entrySpread:0.01,exitPrice:1,pnl:4}),
  base("valid",{entrySpread:0.01,entryOffer:0.5,exitPrice:0.6,pnl:1}),
 ]);
 assert.equal(x.assessedQuotes,1);
 assert.equal(x.excludedQuotes,1);
 assert.equal(x.calibratedScenarios[0]?.modeledTrades,1);
 assert.equal(x.netPnlVerified,null);
});
test("empty paper history gives no false profit",()=>{
 const x=auditHistoricalPaperExecution([]);
 assert.equal(x.completed,0);
 assert.equal(x.quoteGrossUsd,0);
 assert.equal(x.hypotheticalScenarios[0]?.modeledTrades,0);
 assert.equal(x.netPnlVerified,null);
});

test("fee-inclusive paper stress never spends $5 on price alone and ignores liquidity assumptions as proof",()=>{
 const trade={id:"one",marketTicker:"KXBTC15M-26OCT211500-00",
  entryOfferTicks:5000,exitBidTicks:6000,
  entryDepthContracts:null,exitDepthContracts:null};
 const priceOnly=stressV13ResearchQuotes([trade],{
  stakeCents:500,adverseEntryTicks:0,adverseExitTicks:0,
  maxContractsPerTrade:20,assumedQuadraticCoefficientBps:700,
 });
 const feeInclusive=stressV13ResearchQuotes([trade],{
  stakeCents:500,adverseEntryTicks:0,adverseExitTicks:0,
  maxContractsPerTrade:20,assumedQuadraticCoefficientBps:700,
  feeInclusiveEntryBudget:true,
 });
 assert.equal(priceOnly.modeledContracts,10);
 assert.equal(feeInclusive.modeledContracts,9);
 assert.equal(feeInclusive.observedDepthCoverage,0);
 assert.equal(feeInclusive.feeScheduleProviderVerified,false);
});

test("spread-calibrated P&L uses each recorded spread, not an arbitrary 1-cent add-on",()=>{
 const d=new Date("2026-10-22T13:45:00.000Z");
 const rows=[
  base("large",{entryOffer:0.015,exitPrice:0.97,entrySpread:0.001,
     closedAt:d,pnl:318.02}),
  base("small",{entryOffer:0.5,exitPrice:0.65,entrySpread:0.02,
     stake:5,contracts:10,pnl:1.5,closedAt:new Date(d.getTime()-60000)}),
  base("missing",{entryOffer:0.4,exitPrice:0.5,entrySpread:null,
     stake:4.8,contracts:12,pnl:1.2}),
 ];
 const a=auditHistoricalPaperExecution(rows);
 assert.equal(a.observedSpreadTrades,2);
 assert.equal(a.unverifiedLiquidityTrades,3);
 assert.equal(a.asOfClosedAt,d.toISOString());
 assert.equal(a.calibratedScenarios.length,4);
 assert.equal(a.calibratedScenarios[0]?.code,"BEST_QUOTES");
 assert.equal(a.calibratedScenarios[0]?.entryCashCapUsd,5);
 assert.equal(a.calibratedScenarios[0]?.observedSpreadTrades,2);
 assert.ok(a.calibratedScenarios[0]!.netConditionalUsd>
   a.calibratedScenarios[1]!.netConditionalUsd);
 assert.ok(a.calibratedScenarios[1]!.netConditionalUsd>
   a.calibratedScenarios[2]!.netConditionalUsd);
 assert.ok(a.calibratedScenarios[1]!.netConditionalUsd>
   a.calibratedScenarios[3]!.netConditionalUsd);
 for(const x of a.calibratedScenarios){
  assert.equal(x.executable,false);
  assert.equal(x.depthVerified,false);
 }
 assert.equal(a.netPnlVerified,null);
});
test("invalid and missing spread are never silently replaced with fixed slippage",()=>{
 const a=auditHistoricalPaperExecution([
   base("a",{entrySpread:null}),
   base("b",{entrySpread:1.2}),
 ]);
 assert.equal(a.assessedQuotes,2);
 assert.equal(a.observedSpreadTrades,0);
 assert.equal(a.calibratedScenarios[0]!.modeledTrades,0);
 assert.equal(a.calibratedScenarios[0]!.netConditionalUsd,0);
 assert.equal(a.netPnlVerified,null);
});
