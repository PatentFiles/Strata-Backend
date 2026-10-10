import { V13_ENTRY_POLICY_VERSION, V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from "@workspace/v13-strategy";

export const ENTRY_POLICY_REVIEW_BLOCKER = "entry_policy_revision_requires_separate_review";

export interface EntryPolicyRuntimeState {
  championId: string;
  parameterHash: string;
  entryPolicyVersion: string;
  entryPolicyRuntimeApproved: boolean;
  entryPolicyLiveBlocked: boolean;
  entryPolicyBlockReason: string | null;
}

/** Read-only. This never sets V13_ENTRY_POLICY_RUNTIME_APPROVED. */
export function entryPolicyRuntimeState(env: NodeJS.ProcessEnv = process.env): EntryPolicyRuntimeState {
  const approved = env.V13_ENTRY_POLICY_RUNTIME_APPROVED === V13_ENTRY_POLICY_VERSION;
  return {
    championId: V13_CHAMPION_PARAMETER_SET.id,
    parameterHash: V13_CHAMPION_PARAMETER_HASH,
    entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
    entryPolicyRuntimeApproved: approved,
    entryPolicyLiveBlocked: !approved,
    entryPolicyBlockReason: approved ? null : ENTRY_POLICY_REVIEW_BLOCKER,
  };
}

export interface StakeFacts {
  configuredStakeCents: number | null;
  revision: number | null;
  approvedMaxEntryStakeCents: number | null;
  availableCashCents: number | null;
  workerRunning: boolean;
  openPositionCount: number;
  preparedIntentCount: number;
  dispatchedIntentCount: number;
  unknownIntentCount: number;
  unresolvedOrderCount: number;
}

export interface ConfiguredStakeStatus {
  configuredStakeCents: number | null;
  approvedMaxEntryStakeCents: number | null;
  availableCashCents: number | null;
  workerRunning: boolean;
  revision: number | null;
  editable: boolean;
  blockers: string[];
}

export function stakeEditBlockers(facts: StakeFacts): string[] {
  const blockers: string[] = [];
  if (facts.workerRunning) blockers.push("worker_running");
  if (facts.openPositionCount > 0) blockers.push("open_production_position");
  if (facts.preparedIntentCount > 0) blockers.push("prepared_intent");
  if (facts.dispatchedIntentCount > 0) blockers.push("dispatched_intent");
  if (facts.unknownIntentCount > 0) blockers.push("unknown_intent");
  if (facts.unresolvedOrderCount > 0) blockers.push("unresolved_production_order");
  return blockers;
}

export function stakeStatus(facts: StakeFacts): ConfiguredStakeStatus {
  const blockers = stakeEditBlockers(facts);
  return {
    configuredStakeCents: facts.configuredStakeCents,
    approvedMaxEntryStakeCents: facts.approvedMaxEntryStakeCents,
    availableCashCents: facts.availableCashCents,
    workerRunning: facts.workerRunning,
    revision: facts.revision,
    editable: blockers.length === 0 && facts.approvedMaxEntryStakeCents !== null,
    blockers,
  };
}

export function parseConfiguredStakeCents(value: unknown):
  | { ok: true; cents: number }
  | { ok: false; reason: string } {
  if (typeof value === "boolean" || value === null || value === undefined) {
    return { ok: false, reason: "stake_cents_not_integer" };
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return { ok: false, reason: "stake_cents_not_integer" };
    if (value < 1) return { ok: false, reason: "stake_cents_not_positive" };
    return { ok: true, cents: value };
  }
  if (typeof value === "string") {
    if (!/^[1-9]\d*$/.test(value)) return { ok: false, reason: "stake_cents_not_integer" };
    const cents = Number(value);
    if (!Number.isSafeInteger(cents)) return { ok: false, reason: "stake_cents_overflow" };
    return { ok: true, cents };
  }
  return { ok: false, reason: "stake_cents_not_integer" };
}

export function validateConfiguredStake(facts: StakeFacts, cents: number):
  | { ok: true }
  | { ok: false; status: 400 | 409; reason: string; blockers: string[] } {
  if (!Number.isSafeInteger(cents) || cents < 1) {
    return { ok: false, status: 400, reason: "stake_cents_not_positive", blockers: [] };
  }
  const blockers = stakeEditBlockers(facts);
  if (facts.approvedMaxEntryStakeCents === null) {
    blockers.push("approved_max_entry_stake_unknown");
  } else if (cents > facts.approvedMaxEntryStakeCents) {
    blockers.push("above_approved_max_entry_stake");
  }
  if (blockers.length > 0) {
    return { ok: false, status: 409, reason: blockers[0]!, blockers };
  }
  return { ok: true };
}
