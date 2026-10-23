import assert from "node:assert/strict";
import test from "node:test";
import {
  auditPostActionPaperBooks,simulateFiveDollarPilotFaults,
  type PaperPositionEvidence,type PaperBookEvidence,
} from "./forwardTestBookReplayResearch";

const p=(overrides:Partial<PaperPositionEvidence>={}):PaperPositionEvidence=>({
  id:"huge-paper-winner",status:"CLOSED",contracts:333,entryOffer:0.015,
  exitPrice:0.97,stake:4.995,payout:323.01,pnl:318.02,...overrides,
});
const r=(phase:"ENTRY"|"EXIT",overrides:Partial<PaperBookEvidence>={}):PaperBookEvidence=>({
  paperPositionId:"huge-paper-winner",phase,status:"CAPTURED",
  requestedContracts:333,modeledFilledContracts:0,
  eventAtMs:1_000,receivedAtMs:2_500,timestampAuthority:"LOCAL_RECEIPT_ONLY",...overrides,
});

test("recomputes recorded gross position P&L without claiming live fees or fill evidence",()=>{
 const a=auditPostActionPaperBooks([p()],[]);
 assert.equal(a.positions,1);
 assert.equal(a.grossPaperUsd,318.02);
 assert.equal(a.recalculatedGrossUsd,318.015);
 assert.ok(Math.abs(a.maxAccountingDifferenceUsd-0.005)<0.000001);
 assert.equal(a.accountingDifferencesOverHalfCent,0);
 assert.equal(a.certifiedExecutableNetUsd,null);
 assert.equal(a.liveFeeScheduleVerified,false);
 assert.equal(a.tradingAuthority,false);
 assert.equal(a.fullyModeledPostActionPairs,0);
 assert.deepEqual(a.unverifiedLargeProfitIds,["huge-paper-winner"]);
 assert.ok(a.illustrativeQuoteOnlyNetUsd<a.grossPaperUsd);
});

test("post-action two-sided books with zero entry liquidity never become an executable profit",()=>{
 const a=auditPostActionPaperBooks([p()],[r("ENTRY"),r("EXIT",{modeledFilledContracts:333})]);
 assert.equal(a.bothBooksCaptured,1);
 assert.equal(a.entryPriceLimitedZeroFill,1);
 assert.equal(a.exitPriceLimitedZeroFill,0);
 assert.equal(a.fullyModeledPostActionPairs,0);
 assert.equal(a.postActionOrUnsequencedSnapshots,1);
 assert.equal(a.certifiedExecutableNetUsd,null);
});

test("modeled full REST capacity stays research-only because books arrive after paper transitions",()=>{
 const a=auditPostActionPaperBooks([p()],[
  r("ENTRY",{modeledFilledContracts:333}),
  r("EXIT",{modeledFilledContracts:333}),
 ]);
 assert.equal(a.fullyModeledPostActionPairs,1);
 assert.equal(a.certifiedExecutableNetUsd,null);
 assert.equal(a.tradingAuthority,false);
 assert.deepEqual(a.unverifiedLargeProfitIds,[]);
});

test("missing and UNAVAILABLE book receipts are not treated as zero verified fills",()=>{
 const a=auditPostActionPaperBooks([p()],[
  r("ENTRY",{status:"UNAVAILABLE",modeledFilledContracts:null,receivedAtMs:null}),
 ]);
 assert.equal(a.bothBooksCaptured,0);
 assert.equal(a.entryPriceLimitedZeroFill,0);
 assert.equal(a.missingBookPairs,1);
});

test("duplicate/forged receipts and inconsistent fixed point inputs fail closed",()=>{
 assert.throws(()=>auditPostActionPaperBooks([p()],[r("ENTRY"),r("ENTRY")]),/invalid_research_book/);
 assert.throws(()=>auditPostActionPaperBooks([p({contracts:0})],[]),/invalid_paper_position/);
 assert.throws(()=>auditPostActionPaperBooks([p({entryOffer:0.01501})],[]),/non_fixed_point_paper_price/);
 const changed=auditPostActionPaperBooks([p({stake:5})],[]);
 assert.equal(changed.accountingDifferencesOverHalfCent,1);
});

test("five successive 20%-of-remaining $5-capped losses exhaust most $25 equity",()=>{
 const x=simulateFiveDollarPilotFaults(["LOSS","LOSS","LOSS","LOSS","LOSS"]);
 assert.deepEqual(x.modeledRiskStakesCents,[500,400,320,256,204]);
 assert.equal(x.finalCashCents,820);
 assert.equal(x.researchOnly,true);
 assert.equal(x.tradingAuthority,false);
});

test("one-cent exit can destroy most of the first $5 position, even if the market allows it",()=>{
 const x=simulateFiveDollarPilotFaults(["ONE_CENT_EXIT"]);
 assert.deepEqual(x.modeledRiskStakesCents,[500]);
 assert.equal(x.finalCashCents,2010);
 assert.equal(x.tradingAuthority,false);
});

test("429, UNKNOWN order and worker restart fail closed: restarting never clears their blockers",()=>{
 const x=simulateFiveDollarPilotFaults([
  "KALSHI_429","WORKER_RESTART","LOSS","UNKNOWN_ORDER",
  "WORKER_RESTART","UNSIGNED_RECONCILE","LOSS",
 ]);
 assert.equal(x.finalCashCents,2500);
 assert.equal(x.restarts,2);
 assert.equal(x.blocked,true);
 assert.equal(x.partialOrAbsentFills,2);
 assert.ok(x.blockers.includes("official_fee_source_unavailable"));
 assert.ok(x.blockers.includes("unknown_order_requires_signed_exchange_reconciliation"));
 assert.ok(x.blockers.includes("unsigned_reconciliation_is_not_authority"));
});

test("no depth => no entry; no silent market order and no synthetic P&L",()=>{
 const x=simulateFiveDollarPilotFaults(["LOW_LIQUIDITY","LOW_LIQUIDITY"]);
 assert.equal(x.finalCashCents,2500);
 assert.equal(x.modeledRiskStakesCents.length,0);
 assert.equal(x.partialOrAbsentFills,2);
});
