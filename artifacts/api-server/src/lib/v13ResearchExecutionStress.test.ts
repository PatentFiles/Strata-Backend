import assert from "node:assert/strict";
import test from "node:test";
import {
  illustrativeQuadraticFeeCents, stressV13ResearchQuotes,
  type ResearchQuoteRoundTrip,
} from "./v13ResearchExecutionStress";

const row = (overrides: Partial<ResearchQuoteRoundTrip> = {}): ResearchQuoteRoundTrip => ({
  id: "one", marketTicker: "KXBTC15M-EXAMPLE",
  entryOfferTicks: 4000, exitBidTicks: 6000,
  entryDepthContracts: null, exitDepthContracts: null,
  ...overrides,
});
const assumptions = {
  stakeCents: 150, adverseEntryTicks: 0, adverseExitTicks: 0,
  assumedQuadraticCoefficientBps: 700,
};

test("illustrative fee rounds UP per order and rejects invalid units", () => {
  assert.equal(illustrativeQuadraticFeeCents(3, 4000), 6n);
  assert.equal(illustrativeQuadraticFeeCents(3, 6000), 6n);
  assert.equal(illustrativeQuadraticFeeCents(0, 4000), 0n);
  assert.throws(() => illustrativeQuadraticFeeCents(-1, 4000), /invalid_research_fee_input/);
  assert.throws(() => illustrativeQuadraticFeeCents(1, 10001), /invalid_research_fee_input/);
});
test("research quote P&L remains hypothetical without recorded executable depth", () => {
  const report = stressV13ResearchQuotes([row()], assumptions);
  // $1.50 / $0.40 = 3 whole contracts: $0.60 spread less $0.12 assumed fees.
  assert.equal(report.mode, "SHADOW_ONLY");
  assert.equal(report.executionAuthority, false);
  assert.equal(report.pnlProvenByExchangeFills, false);
  assert.equal(report.feeScheduleProviderVerified, false);
  assert.equal(report.modeledNetMicros, "480000");
  assert.equal(report.modeledNetExLargestWinnerMicros, "0");
  assert.equal(report.incompleteDepthTrades, 1);
  assert.equal(report.observedDepthCoverage, 0);
  assert.ok(report.warnings.some(w => w.includes("Absent entry/exit depth")));
});
test("constrained depth limits entry and missing exit liquidity cannot be booked as a fill", () => {
  const report = stressV13ResearchQuotes([
    row({ entryDepthContracts: 2, exitDepthContracts: 1 }),
  ], assumptions);
  assert.equal(report.modeledContracts, 2);
  assert.equal(report.knownResidualContracts, 1);
  // 1*$0.60 proceeds - 2*$0.40 entries = -$0.20, fees 4c + 2c.
  assert.equal(report.modeledNetMicros, "-260000");
  assert.equal(report.incompleteDepthTrades, 0);
  assert.equal(report.observedDepthCoverage, 1);
  assert.ok(report.warnings.some(w => w.includes("residual positions")));
});
test("fee stress and price shocks cannot generate a manufactured favorable fill", () => {
  const baseline = stressV13ResearchQuotes([row()], assumptions);
  const stressed = stressV13ResearchQuotes([row()], {
    ...assumptions, adverseEntryTicks: 100, adverseExitTicks: 100,
  });
  assert.ok(BigInt(stressed.modeledNetMicros) < BigInt(baseline.modeledNetMicros));
  const noEntry = stressV13ResearchQuotes([row({ entryOfferTicks: 9900 })],
    { ...assumptions, adverseEntryTicks: 100 });
  assert.equal(noEntry.modeledTrades, 0);
  assert.equal(noEntry.modeledNetMicros, "0");
});
test("largest winning trade cannot masquerade as diversified expectancy", () => {
  const result = stressV13ResearchQuotes([
    row({ id: "regular", entryOfferTicks: 4000, exitBidTicks: 3900 }),
    row({ id: "one-off", entryOfferTicks: 150, exitBidTicks: 9700 }),
  ], assumptions);
  const gross = BigInt(result.modeledNetMicros);
  const withoutOutlier = BigInt(result.modeledNetExLargestWinnerMicros);
  assert.ok(gross > 0n);
  assert.ok(withoutOutlier < 0n);
  assert.ok(BigInt(result.largestSinglePositiveNetMicros) > 0n);
});
test("duplicate IDs, noninteger prices, invalid depth and negative stress fail closed", () => {
  assert.throws(() => stressV13ResearchQuotes([row(),row()], assumptions),
    /invalid_or_duplicate_research_quote/);
  assert.throws(() => stressV13ResearchQuotes([row({entryOfferTicks:0})], assumptions),
    /invalid_or_duplicate_research_quote/);
  assert.throws(() => stressV13ResearchQuotes([row({entryDepthContracts:-1})], assumptions),
    /invalid_or_duplicate_research_quote/);
  assert.throws(() => stressV13ResearchQuotes([row()], {...assumptions,stakeCents:-150}),
    /invalid_research_stress_assumptions/);
  assert.throws(() => stressV13ResearchQuotes([row()], {...assumptions,adverseExitTicks:NaN}),
    /invalid_research_stress_assumptions/);
});
test("no observations never reports evidence of trades or verified execution", () => {
  const result = stressV13ResearchQuotes([], assumptions);
  assert.equal(result.modeledNetMicros,"0");
  assert.equal(result.modeledTrades,0);
  assert.equal(result.observedDepthCoverage,0);
  assert.equal(result.executionAuthority,false);
});
