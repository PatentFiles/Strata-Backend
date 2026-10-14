import { V13_MAX_ENTRY_STAKE_CENTS } from "../v13LiveMoneyRisk";

export interface SharedPreset {
  id: string;
  name: string;
  description: string;
  creatorUserId: string;
  creatorDisplayName: string | null;
  capitalLimitCents: number;
  maxEntryStakeCents: number;
  maxEntryAllInCents: number;
  maxDailyLossCents: number;
  maxTotalLossCents: number;
  maxQuoteAgeMs: number;
  maxFeeEvidenceAgeMs: number;
  minimumExitMicros: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDraft {
  ownerUserId: string;
  executionAccountId: string | null;
  state: "DRAFT";
  capitalLimitCents: number;
  maxEntryStakeCents: number;
  maxEntryAllInCents: number;
  maxDailyLossCents: number;
  maxTotalLossCents: number;
  maxQuoteAgeMs: number;
  maxFeeEvidenceAgeMs: number;
  minimumExitMicros: number | null;
  maxOpenPositions: 1;
  approved: false;
  armed: false;
  started: false;
}

const FORBIDDEN = [
  "configuredStakeCents", "cash", "positions", "orders", "fills", "settlements",
  "pnl", "realizedPnl", "dailyLoss", "totalLoss", "credential", "privateKey",
  "executionAccountId", "workerRunning", "armed", "killSwitch", "ownerUserId",
];

export function presetFieldError(input: Record<string, unknown>): string | null {
  for (const key of FORBIDDEN) {
    if (key in input) return "preset_contains_account_state";
  }
  const name = input.name;
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 80) return "preset_name_invalid";
  const numbers: Array<[string, number, number]> = [
    ["capitalLimitCents", 1, 2_000_000_000],
    ["maxEntryStakeCents", 1, V13_MAX_ENTRY_STAKE_CENTS],
    ["maxEntryAllInCents", 1, 2_000_000_000],
    ["maxDailyLossCents", 1, 2_000_000_000],
    ["maxTotalLossCents", 1, 2_000_000_000],
    ["maxQuoteAgeMs", 1, 15_000],
    ["maxFeeEvidenceAgeMs", 1, 15_000],
    ["minimumExitMicros", 1, 999_999],
  ];
  const values = new Map<string, number>();
  for (const [key, min, max] of numbers) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return `${key}_invalid`;
    values.set(key, value);
  }
  const capital = values.get("capitalLimitCents")!;
  const stake = values.get("maxEntryStakeCents")!;
  const allIn = values.get("maxEntryAllInCents")!;
  const daily = values.get("maxDailyLossCents")!;
  const total = values.get("maxTotalLossCents")!;
  if (allIn < stake || allIn > capital || daily > capital || total > capital) return "preset_limits_inconsistent";
  if (input.maxOpenPositions !== undefined && input.maxOpenPositions !== 1) return "max_open_positions_fixed";
  return null;
}

export function canEditPreset(preset: SharedPreset, actorUserId: string): boolean {
  return preset.creatorUserId === actorUserId;
}

/** Copies configuration into the caller's draft. It does not approve, arm, start, or change the preset. */
export function applyPresetToDraft(actorUserId: string, preset: SharedPreset, executionAccountId: string | null): PolicyDraft {
  return {
    ownerUserId: actorUserId,
    executionAccountId,
    state: "DRAFT",
    capitalLimitCents: preset.capitalLimitCents,
    maxEntryStakeCents: preset.maxEntryStakeCents,
    maxEntryAllInCents: preset.maxEntryAllInCents,
    maxDailyLossCents: preset.maxDailyLossCents,
    maxTotalLossCents: preset.maxTotalLossCents,
    maxQuoteAgeMs: preset.maxQuoteAgeMs,
    maxFeeEvidenceAgeMs: preset.maxFeeEvidenceAgeMs,
    minimumExitMicros: preset.minimumExitMicros,
    maxOpenPositions: 1,
    approved: false,
    armed: false,
    started: false,
  };
}

/**
 * Immutable, non-authoritative Strata starter template. Dollar values are
 * BASELINE RATIOS only, not funded cash and never an approved policy.
 * A minimum exit floor has to be reviewed separately by every owner.
 */
export const STANDARD_PROPORTIONAL_PRESET_ID = "strata-standard-c52c53-v1";

export const STANDARD_PROPORTIONAL_PRESET: SharedPreset = {
  id: STANDARD_PROPORTIONAL_PRESET_ID,
  name: "Standard C52/C53 — 6% entry",
  description: "Scales $25 reference capital: 6% stake, 8% fee-inclusive, 20% daily and 60% cumulative loss ceilings. Review-only, not an approval.",
  creatorUserId: "SYSTEM",
  creatorDisplayName: "Strata",
  capitalLimitCents: 2500,
  maxEntryStakeCents: 150,
  maxEntryAllInCents: 200,
  maxDailyLossCents: 500,
  maxTotalLossCents: 1500,
  maxQuoteAgeMs: 5000,
  maxFeeEvidenceAgeMs: 15000,
  minimumExitMicros: 0, // NO EXIT FLOOR IS APPROVED BY THIS TEMPLATE.
  revision: 1,
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
};

export interface ScaledPolicyLimits {
  capitalLimitCents: number;
  maxEntryStakeCents: number;
  maxEntryAllInCents: number;
  maxDailyLossCents: number;
  maxTotalLossCents: number;
  maxQuoteAgeMs: number;
  maxFeeEvidenceAgeMs: number;
}

/**
 * Compute a preview using *integer* arithmetic; every monetary bound rounds
 * DOWN to a cent, so rounding can never grant more risk than the named preset.
 * Timing and 1-position limits stay fixed. This does not set the live stake,
 * alter any approved policy, or establish that one Kalshi contract is affordable.
 */
export function scaleSharedRiskPreset(
  preset: SharedPreset,
  selectedCapitalCents: number,
): { ok: true; limits: ScaledPolicyLimits; minimumExitMicros: number | null } |
   { ok: false; reason: string } {
  if (!Number.isSafeInteger(selectedCapitalCents) ||
      selectedCapitalCents < 1 || selectedCapitalCents > 2_000_000_000) {
    return { ok: false, reason: "selected_capital_invalid" };
  }
  if (presetFieldError({
    ...preset,
    minimumExitMicros: preset.minimumExitMicros > 0 ? preset.minimumExitMicros : 1,
  }) !== null) {
    return { ok: false, reason: "preset_limits_invalid" };
  }
  const ratio = (referenceCents: number): number =>
    Number((BigInt(referenceCents) * BigInt(selectedCapitalCents)) /
      BigInt(preset.capitalLimitCents));
  const limits: ScaledPolicyLimits = {
    capitalLimitCents: selectedCapitalCents,
    maxEntryStakeCents: ratio(preset.maxEntryStakeCents),
    maxEntryAllInCents: ratio(preset.maxEntryAllInCents),
    maxDailyLossCents: ratio(preset.maxDailyLossCents),
    maxTotalLossCents: ratio(preset.maxTotalLossCents),
    maxQuoteAgeMs: preset.maxQuoteAgeMs,
    maxFeeEvidenceAgeMs: preset.maxFeeEvidenceAgeMs,
  };
  if (limits.maxEntryStakeCents < 1 || limits.maxEntryAllInCents < 1 ||
      limits.maxDailyLossCents < 1 || limits.maxTotalLossCents < 1 ||
      limits.maxEntryStakeCents > V13_MAX_ENTRY_STAKE_CENTS ||
      limits.maxEntryStakeCents > limits.maxEntryAllInCents ||
      limits.maxEntryAllInCents > selectedCapitalCents) {
    return { ok: false, reason: "scaled_limits_outside_valid_range" };
  }
  return {
    ok: true,
    limits,
    minimumExitMicros: preset.minimumExitMicros > 0 ? preset.minimumExitMicros : null,
  };
}
