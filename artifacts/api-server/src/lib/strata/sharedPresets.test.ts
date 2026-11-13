import assert from "node:assert/strict";
import test from "node:test";
import {
  STANDARD_PROPORTIONAL_PRESET,
  STANDARD_PROPORTIONAL_PRESET_ID,
  scaleSharedRiskPreset,
} from "./sharedPresets";

test("named standard template is nonexecuting and keeps C52/C53 champion untouched", () => {
  assert.equal(STANDARD_PROPORTIONAL_PRESET.id, STANDARD_PROPORTIONAL_PRESET_ID);
  assert.equal(STANDARD_PROPORTIONAL_PRESET.minimumExitMicros, 0);
  assert.equal(STANDARD_PROPORTIONAL_PRESET.capitalLimitCents, 2500);
  assert.equal(STANDARD_PROPORTIONAL_PRESET.maxEntryStakeCents, 150);
});

test("scale up and down with exact integer cents; quote, fee and exit constraints stay fixed", () => {
  const cases = [
    [500, 30, 40, 100, 300],
    [2500, 150, 200, 500, 1500],
    [25000, 1500, 2000, 5000, 15000],
    [250000, 15000, 20000, 50000, 150000],
    [500000, 30000, 40000, 100000, 300000],
    [2500000, 150000, 200000, 500000, 1500000],
  ] as const;
  for (const [capital, stake, allIn, daily, total] of cases) {
    const result = scaleSharedRiskPreset(STANDARD_PROPORTIONAL_PRESET, capital);
    assert.equal(result.ok, true, String(capital));
    if (!result.ok) continue;
    assert.deepEqual([
      result.limits.capitalLimitCents, result.limits.maxEntryStakeCents,
      result.limits.maxEntryAllInCents, result.limits.maxDailyLossCents,
      result.limits.maxTotalLossCents,
    ], [capital, stake, allIn, daily, total]);
    assert.equal(result.minimumExitMicros, null);
    assert.equal(result.limits.maxQuoteAgeMs, 5000);
    assert.equal(result.limits.maxFeeEvidenceAgeMs, 15000);
  }
});

test("round down, never increase authorization or silently claim 1-contract executability", () => {
  const result = scaleSharedRiskPreset(STANDARD_PROPORTIONAL_PRESET, 133);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.limits.maxEntryStakeCents, 7);
  assert.equal(result.limits.maxEntryAllInCents, 10);
  // 7 cents is only the risk envelope; it does not buy a 52c/53c contract.
});

test("reject malformed amounts and maximum stake outside the installed executor ceiling", () => {
  for (const cap of [-1, 0, 1.4, Number.NaN, Infinity, 2_000_000_001]) {
    assert.equal(scaleSharedRiskPreset(STANDARD_PROPORTIONAL_PRESET, cap).ok, false);
  }
  const huge = { ...STANDARD_PROPORTIONAL_PRESET, maxEntryStakeCents: 2_500_000 };
  assert.equal(scaleSharedRiskPreset(huge, 2_000_000_000).ok, false);
  const tiny = scaleSharedRiskPreset(STANDARD_PROPORTIONAL_PRESET, 1);
  assert.equal(tiny.ok, false); // Floor-to-zero never creates zero-value approved limits.
});

test("separately named templates scale at the saved ratio; no global mutation", () => {
  const alternative = {
    ...STANDARD_PROPORTIONAL_PRESET, id: "unique-template", name: "Experiment",
    maxEntryStakeCents: 100, maxEntryAllInCents: 175, minimumExitMicros: 10_000,
  };
  const result = scaleSharedRiskPreset(alternative, 50_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.limits.maxEntryStakeCents, 2000);
  assert.equal(result.limits.maxEntryAllInCents, 3500);
  assert.equal(result.minimumExitMicros, 10_000);
  assert.equal(STANDARD_PROPORTIONAL_PRESET.maxEntryStakeCents, 150);
});
