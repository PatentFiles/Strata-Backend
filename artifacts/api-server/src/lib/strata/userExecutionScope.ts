import { V13_MAX_ENTRY_STAKE_CENTS, evaluateV13LiveMoneyRisk, type V13LiveMoneyRiskInput } from "../v13LiveMoneyRisk";
import { BOT_EXCHANGE_INDEX, BOT_SUBACCOUNT } from "./kalshiUserRead";
import { applyPresetToDraft, type PolicyDraft, type SharedPreset } from "./sharedPresets";

export interface ScopedAccount {
  id: string;
  ownerUserId: string | null;
  connectionId: string | null;
  subaccount: number;
  exchangeIndex: number;
  commissioned: boolean;
  executionEnabled: boolean;
  workerArmRequested?: boolean | null;
  workerLeaseState?: string | null;
  killSwitch: boolean;
  cashCents: number | null;
  reservedCents: number | null;
  capitalRemainingCents: number | null;
  configuredStakeCents: number | null;
  stakeRevision: number | null;
  riskPresetId?: string | null;
  riskPresetRevision?: number | null;
  riskCapitalCents?: number | null;
  approvedMaxEntryStakeCents: number | null;
  policyApproved: boolean;
  policyVersion: number | null;
  workerRunning: boolean;
  openPositionCount: number;
  preparedIntentCount: number;
  dispatchedIntentCount: number;
  unknownIntentCount: number;
  unresolvedOrderCount: number;
  realizedDailyLossCents: number;
  realizedTotalLossCents: number;
  realizedPnlCents: number | null;
  minimumExitApproved: boolean;
  primaryCashCents: number | null;
  primaryPortfolioValueCents: number | null;
  portfolioValueCents: number | null;
  positions: unknown[];
  orders: unknown[];
  fills: unknown[];
  settlements: unknown[];
  reconciledAt: string | null;
  commissioningState: string | null;
}

export interface UserExecutionView {
  executionAccountExists: boolean;
  ownerUserId: string;
  legacyUnassigned: false;
  botCashCents: number | null;
  reservedBotCashCents: number | null;
  capitalRemainingCents: number | null;
  configuredStakeCents: number | null;
  stakeRevision: number | null;
  riskPresetId?: string | null;
  riskPresetRevision?: number | null;
  riskCapitalCents?: number | null;
  approvedMaxEntryStakeCents: number | null;
  policyApproved: boolean;
  policyVersion: number | null;
  workerRunning: boolean;
  armed: boolean;
  workerArmRequested?: boolean | null;
  workerLeaseState?: string | null;
  killSwitch: boolean | null;
  commissioningState: string | null;
  reconciledAt: string | null;
  primaryCashCents: number | null;
  primaryPortfolioValueCents: number | null;
  botPortfolioValueCents: number | null;
  realizedPnlCents: number | null;
  realizedDailyLossCents: number | null;
  realizedTotalLossCents: number | null;
  minimumExitApproved: boolean;
  maxOpenPositions: 1;
  positions: unknown[];
  orders: unknown[];
  fills: unknown[];
  settlements: unknown[];
  editableSettings: string[];
  readOnlyTelemetry: string[];
}

export const EDITABLE_SETTINGS = [
  "capitalLimitCents",
  "maxEntryStakeCents",
  "maxEntryAllInCents",
  "maxDailyLossCents",
  "maxTotalLossCents",
  "configuredStakeCents",
  "maxQuoteAgeMs",
  "maxFeeEvidenceAgeMs",
  "minimumExitMicros",
] as const;

export const READ_ONLY_TELEMETRY = [
  "primaryCashCents",
  "primaryPortfolioValueCents",
  "botCashCents",
  "botPortfolioValueCents",
  "reservedBotCashCents",
  "capitalRemainingCents",
  "positions",
  "orders",
  "fills",
  "settlements",
  "realizedPnlCents",
  "realizedDailyLossCents",
  "realizedTotalLossCents",
  "workerRunning",
  "armed",
  "killSwitch",
  "commissioningState",
  "reconciledAt",
  "policyVersion",
  "stakeRevision",
  "maxOpenPositions",
] as const;

export function emptyUserExecutionView(ownerUserId: string): UserExecutionView {
  return {
    executionAccountExists: false,
    ownerUserId,
    legacyUnassigned: false,
    botCashCents: null,
    reservedBotCashCents: null,
    capitalRemainingCents: null,
    configuredStakeCents: null,
    stakeRevision: null,
    riskPresetId: null,
    riskPresetRevision: null,
    riskCapitalCents: null,
    approvedMaxEntryStakeCents: null,
    policyApproved: false,
    policyVersion: null,
    workerRunning: false,
    armed: false,
    workerArmRequested:null,
    workerLeaseState:null,
    killSwitch: null,
    commissioningState: null,
    reconciledAt: null,
    primaryCashCents: null,
    primaryPortfolioValueCents: null,
    botPortfolioValueCents: null,
    realizedPnlCents: null,
    realizedDailyLossCents: null,
    realizedTotalLossCents: null,
    minimumExitApproved: false,
    maxOpenPositions: 1,
    positions: [],
    orders: [],
    fills: [],
    settlements: [],
    editableSettings: [...EDITABLE_SETTINGS],
    readOnlyTelemetry: [...READ_ONLY_TELEMETRY],
  };
}

export function accountBelongsTo(callerUserId: string, account: ScopedAccount): boolean {
  return account.ownerUserId === callerUserId &&
    account.subaccount === BOT_SUBACCOUNT &&
    account.exchangeIndex === BOT_EXCHANGE_INDEX;
}

export function viewForCaller(callerUserId: string, account: ScopedAccount | null): UserExecutionView {
  if (!account || !accountBelongsTo(callerUserId, account)) return emptyUserExecutionView(callerUserId);
  return {
    ...emptyUserExecutionView(callerUserId),
    executionAccountExists: true,
    botCashCents: account.cashCents,
    reservedBotCashCents: account.reservedCents,
    capitalRemainingCents: account.capitalRemainingCents,
    configuredStakeCents: account.configuredStakeCents,
    stakeRevision: account.stakeRevision,
    riskPresetId: account.riskPresetId ?? null,
    riskPresetRevision: account.riskPresetRevision ?? null,
    riskCapitalCents: account.riskCapitalCents ?? null,
    approvedMaxEntryStakeCents: account.approvedMaxEntryStakeCents,
    policyApproved: account.policyApproved,
    policyVersion: account.policyVersion,
    workerRunning: account.workerRunning,
    armed: account.workerArmRequested===undefined
      ?account.executionEnabled === true && account.killSwitch === false
      :account.workerArmRequested===true && account.executionEnabled===true &&
       account.killSwitch===false,
    workerArmRequested:account.workerArmRequested??null,
    workerLeaseState:account.workerLeaseState??null,
    killSwitch: account.killSwitch,
    commissioningState: account.commissioningState,
    reconciledAt: account.reconciledAt,
    primaryCashCents: account.primaryCashCents,
    primaryPortfolioValueCents: account.primaryPortfolioValueCents,
    botPortfolioValueCents: account.portfolioValueCents,
    realizedPnlCents: account.realizedPnlCents,
    realizedDailyLossCents: account.realizedDailyLossCents,
    realizedTotalLossCents: account.realizedTotalLossCents,
    minimumExitApproved: account.minimumExitApproved,
    positions: account.positions,
    orders: account.orders,
    fills: account.fills,
    settlements: account.settlements,
  };
}

export type ControlAction = "ARM" | "DISARM" | "START" | "STOP" | "KILL" | "STAKE" | "POLICY" | "READ";

export function controlAccount(callerUserId: string, account: ScopedAccount | null, action: ControlAction):
  | { ok: true; account: ScopedAccount }
  | { ok: false; reason: string } {
  if (!account) return { ok: false, reason: "execution_account_missing" };
  if (account.ownerUserId === null) {
    return { ok: false, reason: action === "START" ? "legacy_unassigned_not_startable" : "legacy_unassigned_not_controllable" };
  }
  if (!accountBelongsTo(callerUserId, account)) return { ok: false, reason: "foreign_execution_account" };
  return { ok: true, account };
}

export function stakeEditBlockers(account: ScopedAccount): string[] {
  const blockers: string[] = [];
  if (account.workerRunning) blockers.push("worker_running");
  if (account.openPositionCount > 0) blockers.push("open_production_position");
  if (account.preparedIntentCount > 0) blockers.push("prepared_intent");
  if (account.dispatchedIntentCount > 0) blockers.push("dispatched_intent");
  if (account.unknownIntentCount > 0) blockers.push("unknown_intent");
  if (account.unresolvedOrderCount > 0) blockers.push("unresolved_production_order");
  return blockers;
}

export function changeConfiguredStake(callerUserId: string, account: ScopedAccount, cents: number):
  | { ok: true; cents: number; requiresPolicyApproval: false }
  | { ok: false; reason: string } {
  const control = controlAccount(callerUserId, account, "STAKE");
  if (!control.ok) return control;
  if (!Number.isSafeInteger(cents) || cents < 1) return { ok: false, reason: "stake_cents_not_positive" };
  if (cents > V13_MAX_ENTRY_STAKE_CENTS) return { ok: false, reason: "above_hard_stake_ceiling" };
  if (account.approvedMaxEntryStakeCents === null) return { ok: false, reason: "approved_max_entry_stake_unknown" };
  if (cents > account.approvedMaxEntryStakeCents) return { ok: false, reason: "above_approved_max_entry_stake" };
  const blockers = stakeEditBlockers(account);
  if (blockers.length > 0) return { ok: false, reason: blockers[0]! };
  return { ok: true, cents, requiresPolicyApproval: false };
}

export function policyAuthorityChange(callerUserId: string, account: ScopedAccount, preset: SharedPreset):
  | { ok: true; draft: PolicyDraft; approved: false; armed: false; started: false }
  | { ok: false; reason: string } {
  const control = controlAccount(callerUserId, account, "POLICY");
  if (!control.ok) return control;
  const draft = applyPresetToDraft(callerUserId, preset, account.id);
  return { ok: true, draft, approved: false, armed: false, started: false };
}

export function legacyClaimPreconditions(account: ScopedAccount): { executable: false; reason: "legacy_claim_not_executed"; ready: boolean } {
  const ready = account.ownerUserId === null &&
    account.executionEnabled === false &&
    account.killSwitch === true &&
    account.openPositionCount === 0 &&
    account.preparedIntentCount === 0 &&
    account.dispatchedIntentCount === 0 &&
    account.unknownIntentCount === 0;
  return { executable: false, reason: "legacy_claim_not_executed", ready };
}

export function independentRiskDecisions(inputs: V13LiveMoneyRiskInput[]) {
  return inputs.map((input) => evaluateV13LiveMoneyRisk(input));
}

export function grossSpendWithinConfiguredStake(configuredStakeCents: number, plannedGrossCents: number): boolean {
  return Number.isSafeInteger(configuredStakeCents) &&
    Number.isSafeInteger(plannedGrossCents) &&
    plannedGrossCents >= 1 &&
    plannedGrossCents <= configuredStakeCents &&
    configuredStakeCents <= V13_MAX_ENTRY_STAKE_CENTS;
}
