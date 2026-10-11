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
