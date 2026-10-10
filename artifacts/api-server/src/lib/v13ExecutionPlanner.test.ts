import assert from "node:assert/strict";
import test from "node:test";
import { planV13IocEntry, planV13IocExit } from "./v13ExecutionPlanner";

test("$5,000 IOC walks only V13-approved depth and ignores higher asks", () => {
  const result = planV13IocEntry({
    signal: "SCOUT",
    direction: "UP",
    referenceOffer: 0.50,
    maxStakeCents: 500_000,
    bestAskDollars: "0.4800",
    askLevels: [
      { priceDollars: "0.4800", availableContracts: "2000" },
      { priceDollars: "0.4900", availableContracts: "3000" },
      { priceDollars: "0.5000", availableContracts: "5000" },
      { priceDollars: "0.5100", availableContracts: "100000" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.contracts, 10_000);
  assert.equal(result.plan.limitPrice, 0.50);
  assert.equal(result.plan.expectedGrossCents, 493_000);
  assert.equal(result.plan.worstCaseGrossCents, 500_000);
  assert.equal(result.plan.expectedVwap, 0.493);
  assert.equal(result.plan.visibleContractsAtLimit, 10_000);
  assert.equal(result.plan.maximumPrice, 0.50);
});

test("planner sizes down when only part of $5,000 is executable", () => {
  const result = planV13IocEntry({
    signal: "CONFIRM",
    direction: "DOWN",
    referenceOffer: 0.68,
    maxStakeCents: 500_000,
    bestAskDollars: "0.6500",
    askLevels: [
      { priceDollars: "0.6500", availableContracts: "1000" },
      { priceDollars: "0.6700", availableContracts: "1500" },
      { priceDollars: "0.6900", availableContracts: "50000" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.contracts, 2500);
  assert.equal(result.plan.limitPrice, 0.67);
  assert.equal(result.plan.expectedGrossCents, 165_500);
  assert.equal(result.plan.worstCaseGrossCents, 167_500);
});

test("planner refuses to chase beyond the persisted signal offer", () => {
  const result = planV13IocEntry({
    signal: "SCOUT",
    direction: "UP",
    referenceOffer: 0.50,
    maxStakeCents: 500_000,
    bestAskDollars: "0.5100",
    askLevels: [{ priceDollars: "0.5100", availableContracts: "50000" }],
  });
  assert.deepEqual(result, { ok: false, reason: "best_ask_above_signal_ceiling" });
});

test("planner fails closed on missing or inconsistent depth", () => {
  assert.deepEqual(planV13IocEntry({
    signal: "SCOUT",
    direction: "UP",
    referenceOffer: 0.50,
    maxStakeCents: 500_000,
    bestAskDollars: "0.4800",
    askLevels: [],
  }), { ok: false, reason: "depth_unavailable_or_invalid" });
  assert.deepEqual(planV13IocEntry({
    signal: "SCOUT",
    direction: "UP",
    referenceOffer: 0.50,
    maxStakeCents: 500_000,
    bestAskDollars: "0.4800",
    askLevels: [{ priceDollars: "0.4900", availableContracts: "10" }],
  }), { ok: false, reason: "depth_unavailable_or_invalid" });
});


test("large reduce-only exit walks bid depth only to the explicit floor", () => {
  const result = planV13IocExit({
    ownedContracts: 10_000,
    bestBidDollars: "0.4900",
    minimumExitPrice: 0.47,
    bidLevels: [
      { priceDollars: "0.4900", availableContracts: "2000" },
      { priceDollars: "0.4800", availableContracts: "3000" },
      { priceDollars: "0.4700", availableContracts: "5000" },
      { priceDollars: "0.4600", availableContracts: "100000" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.plannedContracts, 10_000);
  assert.equal(result.plan.residualContracts, 0);
  assert.equal(result.plan.limitPrice, 0.47);
  assert.equal(result.plan.expectedGrossProceedsCents, 477_000);
  assert.equal(result.plan.expectedVwap, 0.477);
});

test("exit planner reports residual instead of assuming liquidity below the floor", () => {
  const result = planV13IocExit({
    ownedContracts: 10_000,
    bestBidDollars: "0.4900",
    minimumExitPrice: 0.48,
    bidLevels: [
      { priceDollars: "0.4900", availableContracts: "2000" },
      { priceDollars: "0.4800", availableContracts: "3000" },
      { priceDollars: "0.4700", availableContracts: "50000" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.plannedContracts, 5000);
  assert.equal(result.plan.residualContracts, 5000);
  assert.equal(result.plan.limitPrice, 0.48);
  assert.equal(result.plan.expectedGrossProceedsCents, 242_000);
});


test("entry planner keeps 5000-dollar stake separate from fee-inclusive cash debit", () => {
  const result = planV13IocEntry({
    signal: "SCOUT",
    direction: "UP",
    referenceOffer: 0.50,
    maxStakeCents: 500_000,
    maxAllInCashDebitCents: 505_000,
    cashDebitMicrosPerContractAtLimit: (price) =>
      Math.round((Number(price) + 0.005) * 1_000_000),
    bestAskDollars: "0.4800",
    askLevels: [
      { priceDollars: "0.4800", availableContracts: "2000" },
      { priceDollars: "0.4900", availableContracts: "3000" },
      { priceDollars: "0.5000", availableContracts: "5000" },
      { priceDollars: "0.5100", availableContracts: "100000" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.contracts, 10_000);
  assert.equal(result.plan.worstCaseGrossCents, 500_000);
  assert.equal(result.plan.worstCaseEntryCashDebitCents, 505_000);
});

test("fee-inclusive cash cap can size a 5000-dollar gross plan down", () => {
  const result = planV13IocEntry({
    signal: "SCOUT",
    direction: "UP",
    referenceOffer: 0.50,
    maxStakeCents: 500_000,
    maxAllInCashDebitCents: 500_000,
    cashDebitMicrosPerContractAtLimit: (price) =>
      Math.round((Number(price) + 0.005) * 1_000_000),
    bestAskDollars: "0.4800",
    askLevels: [
      { priceDollars: "0.4800", availableContracts: "2000" },
      { priceDollars: "0.4900", availableContracts: "3000" },
      { priceDollars: "0.5000", availableContracts: "5000" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.plan.contracts < 10_000);
  assert.ok(result.plan.worstCaseEntryCashDebitCents! <= 500_000);
});
