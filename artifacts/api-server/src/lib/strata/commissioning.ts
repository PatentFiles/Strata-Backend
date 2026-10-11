import { createHash, createPrivateKey } from "node:crypto";
import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
  V13_ENTRY_POLICY_VERSION,
} from "@workspace/v13-strategy";
import { ENTRY_POLICY_REVIEW_BLOCKER, entryPolicyRuntimeState } from "./configuredStake";
import { V13_MAX_ENTRY_STAKE_CENTS } from "../v13LiveMoneyRisk";
import {
  canonicalInventory,
  pairKey,
  predictionsApiTier,
  scopedPairBalanceProven,
} from "../kalshiSubaccountInventory";
import type { ProvisioningDiagnostic, ProvisioningSignerDiagnostic } from "../microLiveSubaccountCreation";

/** Reviewed dedicated pair. Production rows cannot name any other pair. */
export const PRODUCTION_SUBACCOUNT = 1;
export const PRODUCTION_EXCHANGE_INDEX = 2;
/** The already-identified legs of the intentional pre-boundary $25 round trip. */
export const PRE_BOUNDARY_INBOUND_TRANSFER_ID = "0991273c-2a60-462a-be81-b10e08d1c76c";
export const PRE_BOUNDARY_OUTBOUND_TRANSFER_ID = "391a20ac-5332-41d6-b015-9b8720e4e5c1";
export const PRE_BOUNDARY_ROUND_TRIP_CENTS = 2500;
export const PRE_BOUNDARY_ROUND_TRIP_CONFIRMATION = "ACKNOWLEDGE_INTENTIONAL_PRE_BOUNDARY_25_ROUND_TRIP";
/** Reviewed one-shot transfer. Not a default the server may invent. */
export const REVIEWED_FUNDING_CENTS = 2500;
export const REVIEWED_FUNDING_MICROS = "25000000";
/** Restricted trading key created once for the Railway pair. */
export const STRATA_INDEX2_KEY_NAME = "Strata INDEX2";
export const STRATA_INDEX2_KEY_CONFIRMATION = "GENERATE_RESTRICTED_INDEX2_KEY";
export const STRATA_INDEX2_REPLACEMENT_CONFIRMATION = "REPLACE_INDEX2_FOR_CURRENT_KALSHI_ACCOUNT";
export const STRATA_INDEX2_KEY_SCOPES = ["read", "write::trade"] as const;

export const OPERATOR_POLICY_FIELDS = [
  "championSelectionReviewId",
  "championSelectionEvidenceHash",
  "championSelectedBy",
  "championSelectedAt",
  "capitalLimitCents",
  "maxEntryStakeCents",
  "maxEntryAllInCents",
  "maxDailyLossCents",
  "maxTotalLossCents",
  "maxQuoteAgeMs",
  "maxFeeEvidenceAgeMs",
  "feePolicyVersion",
  "feeSourceUrl",
  "feeFormulaVersion",
  "approvedBy",
  "approvedAt",
  "policyHash",
] as const;

export interface CommissioningSnapshot {
  asOf: string;
  signer: {
    configured: boolean;
    syntacticallyUsable: boolean;
    fingerprint: string | null;
    signedGetSucceeded: boolean;
    restrictedToPair: boolean;
    historyComplete: boolean;
    keyIdMasked: string | null;
  };
  boundary: {
    exists: boolean;
    subaccount: number | null;
    exchangeIndex: number | null;
    state: string | null;
    cleanZero: boolean;
    verified: boolean;
    fingerprintMatches: boolean;
    historyComplete: boolean;
    ambiguous: boolean;
  };
  funding: {
    anchorExists: boolean;
    amountCents: number | null;
    balanceMicros: string | null;
    verified: boolean;
    uncertain: boolean;
  };
  fee: {
    digest: string | null;
    verified: boolean;
    cashPrecisionVerified: boolean;
  };
  cash: {
    precisionVerified: boolean;
    micros: string | null;
    source: "authenticated_kalshi_micros" | null;
  };
  minimumExit: {
    approved: boolean;
    micros: number | null;
    source: "operator_approved" | null;
  };
  openPositionCount: number;
  unresolvedIntentCount: number;
  transportReady: boolean;
  policy: {
    exists: boolean;
    id: string | null;
    approved: boolean;
    strategyParameterSetId: string | null;
    strategyParameterHash: string | null;
    entryPolicyVersion: string | null;
    hashMatches: boolean;
    missingFields: string[];
  };
  account: {
    count: number;
    id: string | null;
    subaccount: number | null;
    exchangeIndex: number | null;
    fingerprint: string | null;
    commissioned: boolean | null;
    executionEnabled: boolean | null;
    killSwitch: boolean | null;
  };
  /** Persisted operator approval only. Never taken from the request body. */
  approvedMinimumExitMicros: number | null;
  workerRunning: boolean;
  preBoundaryRoundTripAcknowledged: boolean;
  preBoundaryRoundTripEligibleForAcknowledgment: boolean;
}

export interface AccountPlan {
  id: string;
  policyId: string;
  subaccount: 1;
  exchangeIndex: 2;
  keyFingerprint: string;
  commissioningDigest: string;
  minimumExitMicros: number;
  feeArtifactDigest: string;
  cashPrecisionVerified: true;
  cashMicros: typeof REVIEWED_FUNDING_MICROS;
  initialCashMicros: typeof REVIEWED_FUNDING_MICROS;
  commissioned: true;
  executionEnabled: false;
  killSwitch: true;
}

export interface CommissioningStatus {
  productionAccountExists: boolean;
  productionAccountId: string | null;
  policyExists: boolean;
  policyApproved: boolean;
  subaccount: 1;
  exchangeIndex: 2;
  dedicatedSignerConfigured: boolean;
  dedicatedSignerVerified: boolean;
  keyFingerprintVerified: boolean;
  cleanBoundaryExists: boolean;
  cleanBoundaryVerified: boolean;
  fundingAnchorExists: boolean;
  fundingVerified: boolean;
  feeArtifactVerified: boolean;
  cashPrecisionVerified: boolean;
  minimumExitApproved: boolean;
  minimumExitMicros: number | null;
  minimumExitSource: "operator_approved" | "not_approved";
  commissioned: boolean | null;
  executionEnabled: boolean | null;
  killSwitch: boolean | null;
  readyForCommissioning: boolean;
  readyForArming: boolean;
  championId: string;
  parameterHash: string;
  entryPolicyVersion: string;
  entryPolicyRuntimeApproved: boolean;
  entryPolicyLiveBlocked: boolean;
  entryPolicyBlockReason: string | null;
  blockers: string[];
  requiredOperatorEvidence: string[];
  kalshiConnectionStatus: KalshiConnectionStatus;
  asOf: string;
  workerRunning: boolean;
  preBoundaryRoundTripAcknowledged: boolean;
  preBoundaryRoundTripEligibleForAcknowledgment: boolean;
}

export type KalshiConnectionStatus =
  | "NOT_CONFIGURED"
  | "VERIFYING"
  | "BLOCKED"
  | "READY_TO_COMMISSION"
  | "COMMISSIONED_DISARMED"
  | "READY_TO_START"
  | "RUNNING";

const FINGERPRINT = /^[0-9a-f]{64}$/;

export function emptySnapshot(asOf = new Date(0).toISOString()): CommissioningSnapshot {
  return {
    asOf,
    signer: {
      configured: false, syntacticallyUsable: false, fingerprint: null,
      signedGetSucceeded: false, restrictedToPair: false, historyComplete: false,
      keyIdMasked: null,
    },
    boundary: {
      exists: false, subaccount: null, exchangeIndex: null, state: null,
      cleanZero: false, verified: false, fingerprintMatches: false,
      historyComplete: false, ambiguous: false,
    },
    funding: {
      anchorExists: false, amountCents: null, balanceMicros: null,
      verified: false, uncertain: false,
    },
    fee: { digest: null, verified: false, cashPrecisionVerified: false },
    cash: { precisionVerified: false, micros: null, source: null },
    minimumExit: { approved: false, micros: null, source: null },
    openPositionCount: 0,
    unresolvedIntentCount: 0,
    transportReady: false,
    policy: {
      exists: false, id: null, approved: false, strategyParameterSetId: null,
      strategyParameterHash: null, entryPolicyVersion: null, hashMatches: false, missingFields: [...OPERATOR_POLICY_FIELDS],
    },
    account: {
      count: 0, id: null, subaccount: null, exchangeIndex: null, fingerprint: null,
      commissioned: null, executionEnabled: null, killSwitch: null,
    },
    approvedMinimumExitMicros: null,
    workerRunning: false,
    preBoundaryRoundTripAcknowledged: false,
    preBoundaryRoundTripEligibleForAcknowledgment: false,
  };
}

/** Same fingerprint ProductionExchange recomputes from the Railway secrets. */
export function dedicatedSignerFingerprint(keyId: string, privateKey: string): string | null {
  const id = keyId.trim();
  const pem = privateKey.trim().replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  if (!id || !pem) return null;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") return null;
  } catch {
    return null;
  }
  return createHash("sha256").update(`${id}\u001f${pem}`).digest("hex");
}

const DURABLE_KEY_BOUND_STATES = new Set([
  "KEY_BOUND_VERIFIED",
  "funded",
  "initialized",
  "frozen",
]);

export interface DurableSignerBinding {
  currentApiKeyId: string | null;
  rowCount: number;
  restrictedApiKeyId: string | null;
  restrictedKeyFingerprint: string | null;
  keyBoundAt: unknown;
  keyBindingEvidenceDigest: string | null;
}

function keyBoundAtPresent(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

/**
 * Reconstruct dedicated-signer verification from the persisted key binding.
 * A credential change fails closed because the current key id and fingerprint
 * must match. This does not store a boolean and does not call Kalshi.
 */
export function applyDurableDedicatedSigner(
  snapshot: CommissioningSnapshot,
  binding: DurableSignerBinding,
): boolean {
  const fingerprint = snapshot.signer.fingerprint;
  const durable = snapshot.signer.configured &&
    snapshot.signer.syntacticallyUsable &&
    typeof fingerprint === "string" && FINGERPRINT.test(fingerprint) &&
    typeof binding.currentApiKeyId === "string" && binding.currentApiKeyId.trim() !== "" &&
    binding.rowCount === 1 &&
    snapshot.boundary.subaccount === PRODUCTION_SUBACCOUNT &&
    snapshot.boundary.exchangeIndex === PRODUCTION_EXCHANGE_INDEX &&
    typeof snapshot.boundary.state === "string" &&
    DURABLE_KEY_BOUND_STATES.has(snapshot.boundary.state) &&
    binding.restrictedKeyFingerprint === fingerprint &&
    binding.restrictedApiKeyId === binding.currentApiKeyId &&
    keyBoundAtPresent(binding.keyBoundAt) &&
    typeof binding.keyBindingEvidenceDigest === "string" &&
    FINGERPRINT.test(binding.keyBindingEvidenceDigest) &&
    snapshot.boundary.verified &&
    snapshot.boundary.historyComplete;
  if (!durable) return false;
  snapshot.signer.signedGetSucceeded = true;
  snapshot.signer.restrictedToPair = true;
  snapshot.signer.historyComplete = true;
  return true;
}

export function maskKeyId(keyId: string | null | undefined): string | null {
  const trimmed = keyId?.trim();
  if (!trimmed) return null;
  return `****${trimmed.slice(-4)}`;
}

export function commissioningBlockers(snapshot: CommissioningSnapshot): string[] {
  const blockers: string[] = [];
  if (!snapshot.signer.configured) blockers.push("dedicated_signer_missing");
  else if (!snapshot.signer.syntacticallyUsable || !snapshot.signer.fingerprint ||
      !FINGERPRINT.test(snapshot.signer.fingerprint)) blockers.push("dedicated_signer_unusable");
  else if (!snapshot.signer.signedGetSucceeded) blockers.push("dedicated_signer_unverified");
  else if (!snapshot.signer.restrictedToPair) blockers.push("dedicated_signer_wrong_pair");
  else if (!snapshot.signer.historyComplete) blockers.push("dedicated_signer_history_incomplete");

  if (!snapshot.boundary.exists) blockers.push("clean_boundary_missing");
  else if (snapshot.boundary.ambiguous) blockers.push("clean_boundary_ambiguous");
  else if (snapshot.boundary.subaccount !== PRODUCTION_SUBACCOUNT ||
      snapshot.boundary.exchangeIndex !== PRODUCTION_EXCHANGE_INDEX) blockers.push("clean_boundary_wrong_pair");
  else if (!snapshot.boundary.cleanZero) blockers.push("clean_boundary_not_zero");
  else if (!snapshot.boundary.historyComplete) blockers.push("clean_boundary_history_incomplete");
  else if (!snapshot.boundary.verified || !snapshot.boundary.fingerprintMatches) {
    blockers.push("clean_boundary_unverified");
  }

  if (snapshot.funding.uncertain) blockers.push("funding_uncertain_no_retry");
  else if (!snapshot.funding.anchorExists) blockers.push("funding_anchor_missing");
  else if (snapshot.funding.amountCents !== REVIEWED_FUNDING_CENTS ||
      snapshot.funding.balanceMicros !== REVIEWED_FUNDING_MICROS) blockers.push("funding_amount_not_reviewed");
  else if (!snapshot.funding.verified) blockers.push("funding_unverified");

  if (!snapshot.fee.digest || !FINGERPRINT.test(snapshot.fee.digest)) blockers.push("fee_artifact_digest_absent");
  else if (!snapshot.fee.verified) blockers.push("fee_artifact_unverified");

  if (!snapshot.policy.exists) blockers.push("live_money_policy_missing");
  else if (!snapshot.policy.approved) blockers.push("live_money_policy_not_approved");
  else if (snapshot.policy.strategyParameterSetId !== V13_CHAMPION_PARAMETER_SET.id ||
      snapshot.policy.strategyParameterHash !== V13_CHAMPION_PARAMETER_HASH) {
    blockers.push("live_money_policy_strategy_mismatch");
  } else if (!snapshot.policy.hashMatches) blockers.push("live_money_policy_hash_mismatch");
  else if (snapshot.policy.missingFields.length > 0) blockers.push("live_money_policy_operator_values_required");
  const entryPolicy = entryPolicyRuntimeState();
  if (!entryPolicy.entryPolicyRuntimeApproved ||
      snapshot.policy.entryPolicyVersion !== V13_ENTRY_POLICY_VERSION) {
    blockers.push(ENTRY_POLICY_REVIEW_BLOCKER);
  }

  if (!snapshot.cash.precisionVerified) blockers.push("cash_precision_unverified");
  if (!snapshot.minimumExit.approved || snapshot.minimumExit.source !== "operator_approved" ||
      !approvedExitFloor(snapshot.minimumExit.micros)) {
    blockers.push("minimum_exit_floor_unapproved");
  }

  if (snapshot.account.count > 1) blockers.push("production_account_ambiguous");
  else if (snapshot.account.count === 1) {
    if (snapshot.account.subaccount !== PRODUCTION_SUBACCOUNT ||
        snapshot.account.exchangeIndex !== PRODUCTION_EXCHANGE_INDEX) {
      blockers.push("production_account_wrong_pair");
    } else if (snapshot.signer.fingerprint &&
        snapshot.account.fingerprint !== snapshot.signer.fingerprint) {
      blockers.push("production_account_fingerprint_mismatch");
    }
    if (snapshot.account.executionEnabled === true || snapshot.account.killSwitch === false) {
      blockers.push("production_account_already_armed");
    }
  }
  if (snapshot.workerRunning) blockers.push("production_worker_already_running");
  return blockers;
}

export function approvedExitFloor(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 1 && value <= 999999;
}

export function transportGatesReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" &&
    env.LIVE_EXECUTION_ENABLED === "true" &&
    env.V13_PRODUCTION_EXECUTION_ENABLED === "true" &&
    env.KALSHI_API_ENVIRONMENT === "production" &&
    env.MICRO_LIVE_ACCOUNT_MODE === "exclusive" &&
    env.KALSHI_BOT_SUBACCOUNT === "1";
}

export function commissioningStatus(snapshot: CommissioningSnapshot): CommissioningStatus {
  const blockers = commissioningBlockers(snapshot);
  const prerequisite = blockers.filter((item) =>
    item !== "live_arming_not_part_of_commissioning" && item !== ENTRY_POLICY_REVIEW_BLOCKER);
  const accountReady = snapshot.account.count === 0 || (
    snapshot.account.count === 1 &&
    snapshot.account.commissioned !== true &&
    snapshot.account.executionEnabled !== true &&
    snapshot.account.killSwitch !== false &&
    snapshot.account.fingerprint === snapshot.signer.fingerprint
  );
  return {
    productionAccountExists: snapshot.account.count === 1,
    productionAccountId: snapshot.account.count === 1 ? snapshot.account.id : null,
    policyExists: snapshot.policy.exists,
    policyApproved: snapshot.policy.approved && snapshot.policy.hashMatches,
    subaccount: PRODUCTION_SUBACCOUNT,
    exchangeIndex: PRODUCTION_EXCHANGE_INDEX,
    dedicatedSignerConfigured: snapshot.signer.configured && snapshot.signer.syntacticallyUsable,
    dedicatedSignerVerified: snapshot.signer.signedGetSucceeded && snapshot.signer.restrictedToPair &&
      snapshot.signer.historyComplete,
    keyFingerprintVerified: !!snapshot.signer.fingerprint &&
      /^[0-9a-f]{64}$/.test(snapshot.signer.fingerprint) && snapshot.signer.syntacticallyUsable,
    cleanBoundaryExists: snapshot.boundary.exists,
    cleanBoundaryVerified: snapshot.boundary.verified && snapshot.boundary.cleanZero &&
      !snapshot.boundary.ambiguous && snapshot.boundary.historyComplete,
    fundingAnchorExists: snapshot.funding.anchorExists,
    fundingVerified: snapshot.funding.verified && !snapshot.funding.uncertain,
    feeArtifactVerified: snapshot.fee.verified,
    cashPrecisionVerified: snapshot.cash.precisionVerified,
    minimumExitApproved: snapshot.minimumExit.approved,
    minimumExitMicros: snapshot.minimumExit.approved ? snapshot.minimumExit.micros : null,
    minimumExitSource: snapshot.minimumExit.source ?? "not_approved",
    commissioned: snapshot.account.commissioned,
    executionEnabled: snapshot.account.executionEnabled,
    killSwitch: snapshot.account.killSwitch,
    readyForCommissioning: prerequisite.length === 0 && accountReady,
    readyForArming: snapshot.account.commissioned === true &&
      snapshot.account.executionEnabled === false &&
      snapshot.account.killSwitch === true &&
      prerequisite.filter((item) => item !== "production_account_already_armed").length === 0 &&
      !snapshot.workerRunning,
    blockers,
    requiredOperatorEvidence: [
      ...snapshot.policy.missingFields,
      ...(snapshot.minimumExit.approved ? [] : ["minimumExitMicros"]),
      "official fee artifact digest matching the Kalshi fee schedule",
      "authenticated exact-micro cash evidence",
      `operator-approved capitalLimitCents, maxEntryStakeCents (<= ${V13_MAX_ENTRY_STAKE_CENTS}), maxEntryAllInCents, maxDailyLossCents, and maxTotalLossCents`,
    ],
    kalshiConnectionStatus: deriveKalshiConnectionStatus(snapshot, prerequisite.length === 0 && accountReady),
    asOf: snapshot.asOf,
    workerRunning: snapshot.workerRunning,
    preBoundaryRoundTripAcknowledged: snapshot.preBoundaryRoundTripAcknowledged,
    preBoundaryRoundTripEligibleForAcknowledgment: snapshot.preBoundaryRoundTripEligibleForAcknowledgment,
    ...entryPolicyRuntimeState(),
  };
}

export function deriveKalshiConnectionStatus(
  snapshot: CommissioningSnapshot,
  readyToCommission: boolean,
): KalshiConnectionStatus {
  if (snapshot.workerRunning) return "RUNNING";
  const armed = snapshot.account.commissioned === true &&
    snapshot.account.executionEnabled === true &&
    snapshot.account.killSwitch === false &&
    snapshot.transportReady &&
    !snapshot.workerRunning;
  const entryPolicy = entryPolicyRuntimeState();
  if (armed && entryPolicy.entryPolicyRuntimeApproved &&
      snapshot.policy.entryPolicyVersion === V13_ENTRY_POLICY_VERSION) return "READY_TO_START";
  if (armed) return "BLOCKED";
  if (snapshot.account.commissioned === true &&
      snapshot.account.executionEnabled === false &&
      snapshot.account.killSwitch === true) return "COMMISSIONED_DISARMED";
  if (readyToCommission) return "READY_TO_COMMISSION";
  if (!snapshot.signer.configured) return "NOT_CONFIGURED";
  if (snapshot.signer.configured && !snapshot.signer.signedGetSucceeded) return "VERIFYING";
  return "BLOCKED";
}

export function planCommission(snapshot: CommissioningSnapshot): {
  blockers: string[];
  plan: AccountPlan | null;
} {
  const status = commissioningStatus(snapshot);
  if (!status.readyForCommissioning || !snapshot.policy.id || !snapshot.signer.fingerprint ||
      !snapshot.fee.digest || !snapshot.cash.precisionVerified ||
      !approvedExitFloor(snapshot.minimumExit.micros)) {
    return { blockers: status.blockers, plan: null };
  }
  const commissioningDigest = createHash("sha256").update(JSON.stringify({
    policyId: snapshot.policy.id,
    fingerprint: snapshot.signer.fingerprint,
    fee: snapshot.fee.digest,
    fundingMicros: REVIEWED_FUNDING_MICROS,
    minimumExitMicros: snapshot.minimumExit.micros,
    asOf: snapshot.asOf,
  })).digest("hex");
  return {
    blockers: status.blockers,
    plan: {
      id: snapshot.account.id ?? "v13-production-1-2",
      policyId: snapshot.policy.id,
      subaccount: 1,
      exchangeIndex: 2,
      keyFingerprint: snapshot.signer.fingerprint,
      commissioningDigest,
      minimumExitMicros: snapshot.minimumExit.micros,
      feeArtifactDigest: snapshot.fee.digest,
      cashPrecisionVerified: true,
      cashMicros: REVIEWED_FUNDING_MICROS,
      initialCashMicros: REVIEWED_FUNDING_MICROS,
      commissioned: true,
      executionEnabled: false,
      killSwitch: true,
    },
  };
}

export const FUNDING_CONFIRMATION = "AUTHORIZE_ONE_SHOT_25_USD_TRANSFER";

export interface FeeVerificationReport {
  ok: boolean;
  reason: string | null;
  digestStored: boolean;
  httpStatus: number | null;
  contentType: string | null;
  finalOrigin: string | null;
  finalPathname: string | null;
}

const PUBLIC_FEE_REASON = /^[a-z0-9_]{1,80}$/;

/** Keep only the existing machine reason. URLs, bytes, and secrets do not pass. */
export function publicFeeVerificationReason(reason: string): string {
  return PUBLIC_FEE_REASON.test(reason) ? reason : "official_fee_schedule_not_verified";
}

/** Kalshi can stamp a transfer slightly before the local attempt row. */
export const FUNDING_TRANSFER_WINDOW_BEFORE_MS = 1_000;
/** Bound clock skew after the POST response. Later history stays outside the attempt. */
export const FUNDING_TRANSFER_WINDOW_AFTER_MS = 5_000;

export interface FundingTransferCandidate {
  transferId: string;
  fromSubaccount: number;
  toSubaccount: number;
  exchangeIndex: number;
  amountCents: number;
  occurredAt: string | null;
}

function fundingInstant(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Choose the one new $25 inbound inside the current attempt window.
 * The acknowledged pre-boundary round trip is never current funding.
 */
export function selectCurrentFundingTransfer(input: {
  attemptedAt: string | Date | null;
  responseReceivedAt: string | Date | null;
  acknowledgedInboundTransferId: string | null;
  acknowledgedOutboundTransferId: string | null;
  transfers: readonly FundingTransferCandidate[];
}): { status: "selected"; transfer: FundingTransferCandidate & { occurredAt: string } }
  | { status: "pending" }
  | { status: "ambiguous" }
  | { status: "window_unproven" } {
  const attemptedAt = fundingInstant(input.attemptedAt);
  const responseReceivedAt = fundingInstant(input.responseReceivedAt);
  if (attemptedAt === null || responseReceivedAt === null || responseReceivedAt < attemptedAt) {
    return { status: "window_unproven" };
  }
  const excluded = new Set([
    PRE_BOUNDARY_INBOUND_TRANSFER_ID,
    PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
    input.acknowledgedInboundTransferId,
    input.acknowledgedOutboundTransferId,
  ].filter((id): id is string => typeof id === "string" && id !== ""));
  const earliest = attemptedAt - FUNDING_TRANSFER_WINDOW_BEFORE_MS;
  const latest = responseReceivedAt + FUNDING_TRANSFER_WINDOW_AFTER_MS;
  const candidates = input.transfers.filter((transfer) => {
    if (excluded.has(transfer.transferId)) return false;
    if (transfer.fromSubaccount !== 0 || transfer.toSubaccount !== PRODUCTION_SUBACCOUNT) return false;
    if (transfer.exchangeIndex !== PRODUCTION_EXCHANGE_INDEX) return false;
    if (transfer.amountCents !== PRE_BOUNDARY_ROUND_TRIP_CENTS) return false;
    const occurredAt = fundingInstant(transfer.occurredAt);
    return occurredAt !== null && occurredAt >= earliest && occurredAt <= latest;
  });
  if (candidates.length === 0) return { status: "pending" };
  if (candidates.length !== 1) return { status: "ambiguous" };
  const transfer = candidates[0]!;
  return { status: "selected", transfer: { ...transfer, occurredAt: transfer.occurredAt! } };
}

function exactMicros(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Destination must be exactly $25, and the source must have decreased by exactly $25. */
export function fundingCashProvesExact25(input: {
  sourceScopedBeforeMicros: string;
  sourceInventoryBeforeMicros: string;
  sourceScopedMicros: string;
  sourceInventoryMicros: string;
  destinationScopedMicros: string;
  destinationInventoryMicros: string;
}): boolean {
  const beforeScoped = exactMicros(input.sourceScopedBeforeMicros);
  const beforeInventory = exactMicros(input.sourceInventoryBeforeMicros);
  const sourceScoped = exactMicros(input.sourceScopedMicros);
  const sourceInventory = exactMicros(input.sourceInventoryMicros);
  const destinationScoped = exactMicros(input.destinationScopedMicros);
  const destinationInventory = exactMicros(input.destinationInventoryMicros);
  if (beforeScoped === null || beforeInventory === null || sourceScoped === null ||
      sourceInventory === null || destinationScoped === null || destinationInventory === null) {
    return false;
  }
  const amount = BigInt(REVIEWED_FUNDING_MICROS);
  return destinationScoped === amount &&
    destinationInventory === amount &&
    beforeScoped - sourceScoped === amount &&
    beforeInventory - sourceInventory === amount;
}

export const ARM_CONFIRMATION = "ARM_V13_PRODUCTION";
export const DISARM_CONFIRMATION = "DISARM_V13_PRODUCTION";
export const EXIT_FLOOR_CONFIRMATION = "APPROVE_MINIMUM_EXIT_FLOOR";

/**
 * Explicit confirmation is required. Live-execution flags must still be off.
 * The reviewed transfer body is unchanged; this only authorizes calling it.
 */
export function fundingAuthorizationDecision(input: {
  confirmation: unknown;
  liveExecutionEnabled?: string;
  v13ProductionExecutionEnabled?: string;
  attemptState?: "none" | "attempted" | "uncertain" | "reconciled";
}): { proceed: boolean; reason: string } {
  if (input.confirmation !== FUNDING_CONFIRMATION) {
    return { proceed: false, reason: "explicit_authorization_required" };
  }
  if (input.liveExecutionEnabled === "true" || input.v13ProductionExecutionEnabled === "true") {
    return { proceed: false, reason: "funding_refused_while_execution_enabled" };
  }
  if (input.attemptState === "uncertain") {
    return { proceed: false, reason: "funding_uncertain_no_retry" };
  }
  if (input.attemptState === "attempted" || input.attemptState === "reconciled") {
    return { proceed: false, reason: "funding_attempt_already_exists" };
  }
  return { proceed: true, reason: "authorized_one_shot" };
}

export type Index2AttemptState = "none" | "attempted" | "uncertain" | "response_received";

export interface Index2GenerationFacts {
  confirmation: unknown;
  nodeEnv: string | undefined;
  provisioningKeyIdPresent: boolean;
  provisioningPrivateKeyPresent: boolean;
  verifierKeyIdPresent: boolean;
  verifierPrivateKeyPresent: boolean;
  kalshiEnvironment: string | undefined;
  provisioningCredentialValid: boolean;
  provisioningUnrestricted: boolean;
  provisioningScopesExact: boolean;
  verifierCredentialValid: boolean;
  existingIndex2Name: boolean;
  priorAttempt: Index2AttemptState;
  workerRunning: boolean;
  productionAccountExists: boolean;
  liveExecutionEnabled: string | undefined;
  v13ProductionExecutionEnabled: string | undefined;
}

/** Fail closed. A false result means no Kalshi key POST. */
export function index2GenerationDecision(facts: Index2GenerationFacts): { proceed: boolean; reason: string } {
  if (facts.confirmation !== STRATA_INDEX2_KEY_CONFIRMATION) {
    return { proceed: false, reason: "explicit_index2_generation_confirmation_required" };
  }
  if (!facts.provisioningKeyIdPresent) return { proceed: false, reason: "provisioning_key_id_missing" };
  if (!facts.provisioningPrivateKeyPresent) return { proceed: false, reason: "provisioning_private_key_missing" };
  if (!facts.verifierKeyIdPresent) return { proceed: false, reason: "verifier_key_id_missing" };
  if (!facts.verifierPrivateKeyPresent) return { proceed: false, reason: "verifier_private_key_missing" };
  if (facts.kalshiEnvironment !== "production") return { proceed: false, reason: "kalshi_environment_not_production" };
  if (facts.nodeEnv !== "production") return { proceed: false, reason: "node_environment_not_production" };
  if (!facts.provisioningCredentialValid) return { proceed: false, reason: "provisioning_credential_invalid" };
  if (!facts.provisioningUnrestricted) return { proceed: false, reason: "provisioning_key_not_unrestricted" };
  if (!facts.provisioningScopesExact) return { proceed: false, reason: "provisioning_scopes_not_exact" };
  if (!facts.verifierCredentialValid) return { proceed: false, reason: "verifier_credential_invalid" };
  if (facts.existingIndex2Name) return { proceed: false, reason: "index2_key_name_already_exists" };
  if (facts.priorAttempt === "uncertain") return { proceed: false, reason: "index2_generation_uncertain_no_retry" };
  if (facts.priorAttempt !== "none") return { proceed: false, reason: "index2_generation_attempt_exists" };
  if (facts.workerRunning) return { proceed: false, reason: "production_worker_running" };
  if (facts.productionAccountExists) return { proceed: false, reason: "production_account_exists" };
  if (facts.liveExecutionEnabled === "true") return { proceed: false, reason: "live_execution_enabled" };
  if (facts.v13ProductionExecutionEnabled === "true") return { proceed: false, reason: "v13_production_execution_enabled" };
  return { proceed: true, reason: "preflight_passed" };
}

export interface Index2ReplacementFacts extends Index2GenerationFacts {
  sameAccountProven: boolean;
  tierEligible: boolean;
  pairProven: boolean;
  replacementAlreadyUsed: boolean;
}

/** One replacement for the current account. The original generation phrase cannot authorize it. */
export function index2ReplacementDecision(facts: Index2ReplacementFacts): { proceed: boolean; reason: string } {
  if (facts.confirmation !== STRATA_INDEX2_REPLACEMENT_CONFIRMATION) {
    return { proceed: false, reason: "explicit_index2_replacement_confirmation_required" };
  }
  if (!facts.provisioningKeyIdPresent) return { proceed: false, reason: "provisioning_key_id_missing" };
  if (!facts.provisioningPrivateKeyPresent) return { proceed: false, reason: "provisioning_private_key_missing" };
  if (!facts.verifierKeyIdPresent) return { proceed: false, reason: "verifier_key_id_missing" };
  if (!facts.verifierPrivateKeyPresent) return { proceed: false, reason: "verifier_private_key_missing" };
  if (facts.kalshiEnvironment !== "production") return { proceed: false, reason: "kalshi_environment_not_production" };
  if (facts.nodeEnv !== "production") return { proceed: false, reason: "node_environment_not_production" };
  if (!facts.provisioningCredentialValid) return { proceed: false, reason: "provisioning_credential_invalid" };
  if (!facts.provisioningUnrestricted) return { proceed: false, reason: "provisioning_key_not_unrestricted" };
  if (!facts.provisioningScopesExact) return { proceed: false, reason: "provisioning_scopes_not_exact" };
  if (!facts.verifierCredentialValid) return { proceed: false, reason: "verifier_credential_invalid" };
  if (!facts.sameAccountProven) return { proceed: false, reason: "index2_credentials_not_same_account" };
  if (!facts.tierEligible) return { proceed: false, reason: "index2_api_tier_below_advanced" };
  if (!facts.pairProven) return { proceed: false, reason: "index2_pair_not_proven" };
  if (facts.existingIndex2Name) return { proceed: false, reason: "index2_key_name_already_exists" };
  if (facts.workerRunning) return { proceed: false, reason: "production_worker_running" };
  if (facts.productionAccountExists) return { proceed: false, reason: "production_account_exists" };
  if (facts.liveExecutionEnabled === "true") return { proceed: false, reason: "live_execution_enabled" };
  if (facts.v13ProductionExecutionEnabled === "true") return { proceed: false, reason: "v13_production_execution_enabled" };
  if (facts.replacementAlreadyUsed && facts.priorAttempt === "uncertain") {
    return { proceed: false, reason: "index2_generation_uncertain_no_retry" };
  }
  if (facts.replacementAlreadyUsed) return { proceed: false, reason: "index2_replacement_already_used" };
  if (facts.priorAttempt === "attempted") return { proceed: false, reason: "index2_generation_attempt_in_progress" };
  if (facts.priorAttempt !== "uncertain" && facts.priorAttempt !== "response_received") {
    return { proceed: false, reason: "index2_replacement_requires_historical_attempt" };
  }
  return { proceed: true, reason: "preflight_passed" };
}

export const SUBACCOUNT_CREATE_CONFIRMATION = "CREATE_KALSHI_SUBACCOUNT_1_EXCHANGE_2";

export type CleanPairInventoryReason =
  | "clean_pair_inventory_missing"
  | "clean_pair_inventory_duplicated"
  | "clean_pair_exchange_index_2_missing";

export interface SubaccountIdentity {
  subaccount: number | null;
  exchangeIndex: number | null;
}

export interface SubaccountStatus {
  subaccount1Exists: boolean;
  subaccount1Exchange2Exists: boolean;
  matchingRows: number;
  numberedSubaccounts: number[];
  exchangeIndexesForSubaccount1: number[];
  readyForCleanBoundary: boolean;
  reason: string;
  apiTier: string | null;
  subaccountCreationTierEligible: boolean;
  nettingSubaccount1Exists: boolean;
  balanceInventorySubaccount1Exists: boolean;
  provisioningAuthenticated?: boolean;
  diagnostics?: ProvisioningDiagnostic[];
  credentialIdPresent?: boolean;
  privateKeyPresent?: boolean;
  privateKeyParsed?: boolean;
  privateKeyType?: ProvisioningSignerDiagnostic["privateKeyType"];
  signatureGenerated?: boolean;
  fetchAttempted?: boolean;
  localFailureStage?: ProvisioningSignerDiagnostic["localFailureStage"];
  localErrorName?: string | null;
}

export type SubaccountAttemptState =
  | "none" | "attempted" | "uncertain" | "response_received" | "rejected";

function identityInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Keeps only account identity. Balance fields are discarded. */
export function subaccountIdentitiesFromBalancePayload(payload: unknown): SubaccountIdentity[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("subaccount_inventory_incomplete");
  }
  const body = payload as Record<string, unknown>;
  if ("cursor" in body && body.cursor) throw new Error("subaccount_inventory_incomplete");
  if (!Array.isArray(body.subaccount_balances)) throw new Error("subaccount_inventory_incomplete");
  return body.subaccount_balances.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("subaccount_inventory_incomplete");
    }
    const record = row as Record<string, unknown>;
    return {
      subaccount: identityInteger(record.subaccount_number ?? record.subaccount),
      exchangeIndex: identityInteger(record.exchange_index),
    };
  });
}

/** Exactly one (subaccount, exchange index) row passes. Every other shape stays blocked. */
export function cleanPairInventoryDiagnosis(
  identities: readonly SubaccountIdentity[],
  subaccountNumber = PRODUCTION_SUBACCOUNT,
  exchangeIndex = PRODUCTION_EXCHANGE_INDEX,
): CleanPairInventoryReason | null {
  const pairRows = identities.filter((row) =>
    row.subaccount === subaccountNumber && row.exchangeIndex === exchangeIndex);
  if (pairRows.length > 1) return "clean_pair_inventory_duplicated";
  if (pairRows.length === 1) return null;
  if (identities.some((row) => row.subaccount === subaccountNumber)) {
    return "clean_pair_exchange_index_2_missing";
  }
  return "clean_pair_inventory_missing";
}

export function summarizeSubaccountInventory(identities: readonly SubaccountIdentity[]): SubaccountStatus {
  const numberedSubaccounts = [...new Set(identities.flatMap((row) =>
    row.subaccount === null ? [] : [row.subaccount]))].sort((left, right) => left - right);
  const exchangeIndexesForSubaccount1 = [...new Set(identities.flatMap((row) =>
    row.subaccount === PRODUCTION_SUBACCOUNT && row.exchangeIndex !== null ? [row.exchangeIndex] : []))].sort((left, right) => left - right);
  const matchingRows = identities.filter((row) =>
    row.subaccount === PRODUCTION_SUBACCOUNT && row.exchangeIndex === PRODUCTION_EXCHANGE_INDEX).length;
  const subaccount1Exists = identities.some((row) => row.subaccount === PRODUCTION_SUBACCOUNT);
  const diagnosis = cleanPairInventoryDiagnosis(identities);
  let reason = "subaccount_1_missing";
  if (diagnosis === null) reason = "ready_for_clean_boundary";
  else if (diagnosis === "clean_pair_inventory_duplicated") reason = "clean_pair_inventory_duplicated";
  else if (diagnosis === "clean_pair_exchange_index_2_missing") reason = "subaccount_1_exists_exchange_2_missing";
  else if (numberedSubaccounts.some((number) => number >= 1)) reason = "next_subaccount_would_not_be_1";
  return {
    subaccount1Exists,
    subaccount1Exchange2Exists: matchingRows > 0,
    matchingRows,
    numberedSubaccounts,
    exchangeIndexesForSubaccount1,
    readyForCleanBoundary: diagnosis === null,
    reason,
    apiTier: null,
    subaccountCreationTierEligible: false,
    nettingSubaccount1Exists: subaccount1Exists,
    balanceInventorySubaccount1Exists: subaccount1Exists,
  };
}

function statusShell(
  reason: string,
  tier: { apiTier: string | null; subaccountCreationTierEligible: boolean },
  patch: Partial<SubaccountStatus> = {},
): SubaccountStatus {
  return {
    subaccount1Exists: false,
    subaccount1Exchange2Exists: false,
    matchingRows: 0,
    numberedSubaccounts: [],
    exchangeIndexesForSubaccount1: [],
    readyForCleanBoundary: false,
    reason,
    apiTier: tier.apiTier,
    subaccountCreationTierEligible: tier.subaccountCreationTierEligible,
    nettingSubaccount1Exists: false,
    balanceInventorySubaccount1Exists: false,
    ...patch,
  };
}

/** Reviewed netting + balances views. A netting-only new account is pending, not missing. */
export function assembleSubaccountStatus(input: {
  nettingPayload: unknown;
  balancePayload: unknown;
  scopedPayload: unknown;
  limitsPayload: unknown;
  attemptState: SubaccountAttemptState;
}): SubaccountStatus {
  const tier = predictionsApiTier(input.limitsPayload);
  let inventory: ReturnType<typeof canonicalInventory>;
  try {
    inventory = canonicalInventory(input.nettingPayload, input.balancePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return statusShell(
      message.includes("duplicate") ? "subaccount_inventory_duplicated" : "subaccount_inventory_contradictory",
      tier,
    );
  }
  const nettingKeys = new Set(inventory.nettingConfigs.map(pairKey));
  const balanceKeys = new Set(inventory.balances.map(pairKey));
  const onlyBalance = [...balanceKeys].filter((key) => !nettingKeys.has(key));
  const onlyNetting = [...nettingKeys].filter((key) => !balanceKeys.has(key));
  const nettingSubaccount1 = inventory.nettingConfigs.filter((row) => row.subaccountNumber === PRODUCTION_SUBACCOUNT);
  const balanceSubaccount1 = inventory.balances.filter((row) => row.subaccountNumber === PRODUCTION_SUBACCOUNT);
  const nettingPair = nettingSubaccount1.filter((row) => row.exchangeIndex === PRODUCTION_EXCHANGE_INDEX);
  const balancePair = balanceSubaccount1.filter((row) => row.exchangeIndex === PRODUCTION_EXCHANGE_INDEX);
  const numberedSubaccounts = [...new Set([
    ...inventory.nettingConfigs.map((row) => row.subaccountNumber),
    ...inventory.balances.map((row) => row.subaccountNumber),
  ])].sort((left, right) => left - right);
  const exchangeIndexesForSubaccount1 = [...new Set(nettingSubaccount1.map((row) => row.exchangeIndex))]
    .sort((left, right) => left - right);
  const shared = {
    numberedSubaccounts,
    exchangeIndexesForSubaccount1,
    nettingSubaccount1Exists: nettingSubaccount1.length > 0,
    balanceInventorySubaccount1Exists: balanceSubaccount1.length > 0,
  };
  if (onlyBalance.length > 0 || nettingPair.length > 1 || balancePair.length > 1) {
    return statusShell(
      nettingPair.length > 1 || balancePair.length > 1
        ? "subaccount_inventory_duplicated"
        : "subaccount_inventory_contradictory",
      tier,
      shared,
    );
  }
  if (nettingSubaccount1.length > 0 && balanceSubaccount1.length === 0) {
    return statusShell("subaccount_1_pending_balance_visibility", tier, {
      ...shared,
      subaccount1Exists: true,
    });
  }
  if (nettingPair.length === 1 && balancePair.length === 1) {
    if (onlyNetting.length > 0) {
      return statusShell("subaccount_inventory_contradictory", tier, shared);
    }
    const scoped = scopedPairBalanceProven(input.scopedPayload, PRODUCTION_SUBACCOUNT, PRODUCTION_EXCHANGE_INDEX);
    return statusShell(scoped ? "ready_for_clean_boundary" : "scoped_balance_identity_unproven", tier, {
      ...shared,
      subaccount1Exists: true,
      subaccount1Exchange2Exists: scoped,
      matchingRows: 1,
      readyForCleanBoundary: scoped,
    });
  }
  if (nettingSubaccount1.length > 0 && balanceSubaccount1.length > 0) {
    return statusShell("subaccount_1_exists_exchange_2_missing", tier, {
      ...shared,
      subaccount1Exists: true,
    });
  }
  return statusShell(
    input.attemptState === "uncertain"
      ? "subaccount_1_not_visible_after_uncertain_attempt"
      : "subaccount_1_missing",
    tier,
    shared,
  );
}

export function unprovenSubaccountStatus(diagnostics?: {
  provisioningAuthenticated: boolean;
  diagnostics: ProvisioningDiagnostic[];
} & Partial<ProvisioningSignerDiagnostic>): SubaccountStatus {
  return {
    subaccount1Exists: false,
    subaccount1Exchange2Exists: false,
    matchingRows: 0,
    numberedSubaccounts: [],
    exchangeIndexesForSubaccount1: [],
    readyForCleanBoundary: false,
    reason: "subaccount_inventory_unproven",
    apiTier: null,
    subaccountCreationTierEligible: false,
    nettingSubaccount1Exists: false,
    balanceInventorySubaccount1Exists: false,
    ...(diagnostics ? {
      provisioningAuthenticated: diagnostics.provisioningAuthenticated,
      diagnostics: diagnostics.diagnostics,
      credentialIdPresent: diagnostics.credentialIdPresent,
      privateKeyPresent: diagnostics.privateKeyPresent,
      privateKeyParsed: diagnostics.privateKeyParsed,
      privateKeyType: diagnostics.privateKeyType,
      signatureGenerated: diagnostics.signatureGenerated,
      fetchAttempted: diagnostics.fetchAttempted,
      localFailureStage: diagnostics.localFailureStage,
      localErrorName: diagnostics.localErrorName,
    } : {}),
  };
}

export function subaccountCreationDecision(input: {
  confirmation: unknown;
  status: SubaccountStatus;
  inventoryProven: boolean;
  priorAttempt: SubaccountAttemptState;
  workerRunning: boolean;
  productionAccountExists: boolean;
  nodeEnv: string | undefined;
  kalshiEnvironment: string | undefined;
  provisioningConfigured: boolean;
  liveExecutionEnabled?: string;
  v13ProductionExecutionEnabled?: string;
}): { proceed: boolean; reason: string } {
  if (input.confirmation !== SUBACCOUNT_CREATE_CONFIRMATION) {
    return { proceed: false, reason: "explicit_subaccount_confirmation_required" };
  }
  if (!input.provisioningConfigured) return { proceed: false, reason: "provisioning_credential_missing" };
  if (input.kalshiEnvironment !== "production") return { proceed: false, reason: "kalshi_environment_not_production" };
  if (input.nodeEnv !== "production") return { proceed: false, reason: "node_environment_not_production" };
  if (input.liveExecutionEnabled === "true" || input.v13ProductionExecutionEnabled === "true") {
    return { proceed: false, reason: "subaccount_creation_refused_while_execution_enabled" };
  }
  if (input.workerRunning) return { proceed: false, reason: "production_worker_running" };
  if (input.productionAccountExists) return { proceed: false, reason: "production_account_exists" };
  if (input.priorAttempt === "uncertain") return { proceed: false, reason: "subaccount_creation_uncertain_no_retry" };
  if (input.priorAttempt !== "none") return { proceed: false, reason: "subaccount_creation_attempt_exists" };
  if (!input.inventoryProven) return { proceed: false, reason: "subaccount_inventory_unproven" };
  if (input.status.reason === "subaccount_1_pending_balance_visibility" ||
      input.status.reason === "subaccount_inventory_contradictory" ||
      input.status.reason === "subaccount_inventory_duplicated" ||
      input.status.reason === "subaccount_1_not_visible_after_uncertain_attempt" ||
      input.status.reason === "scoped_balance_identity_unproven") {
    return { proceed: false, reason: input.status.reason };
  }
  if (input.status.subaccount1Exists && !input.status.subaccount1Exchange2Exists) {
    return { proceed: false, reason: "subaccount_1_exists_exchange_2_missing" };
  }
  if (input.status.subaccount1Exists || input.status.matchingRows > 0) {
    return { proceed: false, reason: "subaccount_1_already_exists" };
  }
  if (input.status.numberedSubaccounts.some((number) => number >= 1)) {
    return { proceed: false, reason: "next_subaccount_would_not_be_1" };
  }
  return { proceed: true, reason: "subaccount_1_absent" };
}

export interface PolicyLimits {
  capitalLimitCents: number;
  maxEntryStakeCents: number;
  maxEntryAllInCents: number;
  maxDailyLossCents: number;
  maxTotalLossCents: number;
  maxQuoteAgeMs: number;
  maxFeeEvidenceAgeMs: number;
}

export interface PolicyRead {
  draft: PolicyLimits | null;
  approved: boolean;
}

function policyInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Operator limits and approval only. Raw policy rows are not returned. */
export function policyReadFromRows(input: {
  draft: Record<string, unknown> | null;
  approvedCount: number;
}): PolicyRead {
  const row = input.draft;
  const limits = row ? {
    capitalLimitCents: policyInteger(row.capital_limit_cents),
    maxEntryStakeCents: policyInteger(row.max_entry_stake_cents),
    maxEntryAllInCents: policyInteger(row.max_entry_all_in_cents),
    maxDailyLossCents: policyInteger(row.max_daily_loss_cents),
    maxTotalLossCents: policyInteger(row.max_total_loss_cents),
    maxQuoteAgeMs: policyInteger(row.max_quote_age_ms),
    maxFeeEvidenceAgeMs: policyInteger(row.max_fee_evidence_age_ms),
  } : null;
  const draft = limits && Object.values(limits).every((value) => value !== null)
    ? limits as PolicyLimits
    : null;
  return { draft, approved: input.approvedCount === 1 };
}

export function validatePolicyLimits(input: Partial<PolicyLimits> | null): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input) return { ok: false, errors: ["policy_values_required"] };
  const keys = Object.keys(input);
  const allowed = new Set([
    "capitalLimitCents", "maxEntryStakeCents", "maxEntryAllInCents",
    "maxDailyLossCents", "maxTotalLossCents", "maxQuoteAgeMs", "maxFeeEvidenceAgeMs",
  ]);
  if (keys.some((key) => !allowed.has(key)) || keys.length !== allowed.size) {
    errors.push("policy_fields_must_be_exactly_the_operator_limits");
  }
  const n = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  const capital = n(input.capitalLimitCents);
  const stake = n(input.maxEntryStakeCents);
  const allIn = n(input.maxEntryAllInCents);
  const daily = n(input.maxDailyLossCents);
  const total = n(input.maxTotalLossCents);
  const quote = n(input.maxQuoteAgeMs);
  const feeAge = n(input.maxFeeEvidenceAgeMs);
  if (capital === null || capital <= 0 || capital > 2_000_000_000) errors.push("capitalLimitCents");
  if (stake === null || stake <= 0 || stake > V13_MAX_ENTRY_STAKE_CENTS) errors.push("maxEntryStakeCents");
  if (allIn === null || stake === null || capital === null || allIn < stake || allIn > capital) errors.push("maxEntryAllInCents");
  if (daily === null || capital === null || daily <= 0 || daily > capital) errors.push("maxDailyLossCents");
  if (total === null || capital === null || total <= 0 || total > capital) errors.push("maxTotalLossCents");
  if (quote === null || quote <= 0 || quote > 15_000) errors.push("maxQuoteAgeMs");
  if (feeAge === null || feeAge <= 0 || feeAge > 15_000) errors.push("maxFeeEvidenceAgeMs");
  return { ok: errors.length === 0, errors };
}

export function planArm(snapshot: CommissioningSnapshot, confirmation: unknown): { ok: boolean; reason: string } {
  if (confirmation !== ARM_CONFIRMATION) return { ok: false, reason: "explicit_arm_confirmation_required" };
  if (snapshot.account.commissioned !== true) return { ok: false, reason: "arm_cannot_commission" };
  if (snapshot.workerRunning) return { ok: false, reason: "worker_already_running" };
  const blockers = commissioningBlockers({
    ...snapshot,
    account: { ...snapshot.account, executionEnabled: false, killSwitch: true, commissioned: true },
    workerRunning: false,
  }).filter((item) => item !== "production_account_already_armed" && item !== ENTRY_POLICY_REVIEW_BLOCKER);
  if (blockers.length > 0) return { ok: false, reason: blockers[0] ?? "stale_evidence" };
  if (snapshot.account.executionEnabled === true && snapshot.account.killSwitch === false) {
    return { ok: false, reason: "already_armed" };
  }
  return { ok: true, reason: "arm_database_flags_only" };
}

export function planDisarm(snapshot: CommissioningSnapshot, confirmation: unknown): { ok: boolean; reason: string } {
  if (confirmation !== DISARM_CONFIRMATION) return { ok: false, reason: "explicit_disarm_confirmation_required" };
  if (snapshot.openPositionCount > 0 || snapshot.unresolvedIntentCount > 0) {
    return { ok: false, reason: "disarm_refused_while_position_or_intent_open" };
  }
  return { ok: true, reason: "disarm_database_flags_only" };
}

export interface BlockingSubaccountTransfer {
  transferId: string;
  fromSubaccount: number | null;
  toSubaccount: number | null;
  exchangeIndex: number | null;
  amountCents: number | null;
  amountDollars: string | null;
  status: string | null;
  createdAt: string | null;
  missingFields: string[];
}

const BLOCKING_TRANSFER_REASON = /^clean_prior_subaccount_transfer:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SAFE_DOLLARS = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const SAFE_STATUS = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/;
const SECRETISH = /private|secret|password|credential|pem|authorization|api[-_]?key|token|signature|bearer/i;

function blockingInteger(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function blockingDollars(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !SAFE_DOLLARS.test(value) || SECRETISH.test(value)) return null;
  return value;
}

function blockingStatus(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !SAFE_STATUS.test(value) || SECRETISH.test(value)) return null;
  return value;
}

function blockingTime(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "" || SECRETISH.test(value)) return null;
  if (/^(?:0|[1-9]\d*)$/.test(value)) {
    const raw = Number(value);
    if (!Number.isSafeInteger(raw)) return null;
    const millis = raw < 100_000_000_000 ? raw * 1000 : raw;
    const parsed = new Date(millis);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

/** Sanitized fields for the one transfer named by a clean-pair block. Missing fields stay null. */
export function blockingSubaccountTransferDetail(
  reason: string,
  records: Array<{
    feed: string;
    id: string;
    classification: string;
    occurredAt: string | null;
    details: Record<string, string | null>;
  }>,
): BlockingSubaccountTransfer | null {
  const match = BLOCKING_TRANSFER_REASON.exec(reason);
  if (!match) return null;
  const transferId = match[1]!;
  const matches = records.filter((record) =>
    record.feed === "subaccount_transfer" &&
    record.id === transferId &&
    record.classification === "pair");
  if (matches.length !== 1) return null;
  const details = matches[0]!.details;
  const fromSubaccount = blockingInteger(details.from_subaccount);
  const toSubaccount = blockingInteger(details.to_subaccount);
  const exchangeIndex = blockingInteger(details.exchange_index);
  const amountCents = blockingInteger(details.amount_cents);
  const amountDollars = blockingDollars(details.amount_dollars) ?? blockingDollars(details.amount);
  const status = blockingStatus(details.status);
  const createdAt = blockingTime(details.created_ts)
    ?? blockingTime(details.created_time)
    ?? blockingTime(details.created_at);
  const values = {
    fromSubaccount, toSubaccount, exchangeIndex, amountCents, amountDollars, status, createdAt,
  };
  const missingFields = (Object.keys(values) as Array<keyof typeof values>)
    .filter((key) => values[key] === null);
  return { transferId, ...values, missingFields };
}

export interface PreBoundaryTransferView {
  feed: string;
  id: string;
  classification: string;
  occurredAt: string | null;
  details: Record<string, string | null>;
  exchangeIndex?: number | null;
  sourceExchangeIndex?: number | null;
  destinationExchangeIndex?: number | null;
  subaccountNumber?: number | null;
}

export interface RoundTripTransferDiagnostic {
  feed: "subaccount_transfer" | "cross_exchange_transfer";
  transferId: string;
  classification: string;
  fromSubaccount: number | null;
  toSubaccount: number | null;
  exchangeIndex: number | null;
  sourceSubaccount: number | null;
  destinationSubaccount: number | null;
  sourceExchangeIndex: number | null;
  destinationExchangeIndex: number | null;
  amountCents: number | null;
  amountDollars: string | null;
  createdAt: string | null;
}

export interface PreBoundaryAcknowledgmentResult {
  status: "ACKNOWLEDGED" | "BLOCKED";
  reason: string;
  acknowledged: boolean;
  eligible: boolean;
  inboundTransferId: string | null;
  outboundTransferId: string | null;
  amountCents: number | null;
  inboundCreatedAt: string | null;
  outboundCreatedAt: string | null;
  evidenceDigest: string | null;
  calls: Array<{ method: "GET" | "POST" | "DELETE"; path: string }>;
  funded: false;
  commissioned: false;
  armed: false;
  workerStarted: false;
  executionFlagsChanged: false;
  unrecognizedTransfers?: RoundTripTransferDiagnostic[];
  roundTripCandidates?: {
    inbound: RoundTripTransferDiagnostic[];
    outbound: RoundTripTransferDiagnostic[];
  };
}

export interface PreBoundaryRoundTripProof {
  inboundTransferId: string;
  outboundTransferId: string;
  amountCents: number;
  inboundCreatedAt: string;
  outboundCreatedAt: string;
  evidenceDigest: string;
}

const TRANSFER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roundTripInteger(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function roundTripCreatedAt(record: PreBoundaryTransferView): string | null {
  const raw = record.details.created_ts ?? record.details.created_time ?? record.details.created_at;
  if (typeof raw === "string" && /^(?:0|[1-9]\d*)$/.test(raw)) {
    const numeric = Number(raw);
    const millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    const parsed = new Date(millis);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const candidate = typeof raw === "string" && raw.trim() !== "" ? raw : record.occurredAt;
  if (typeof candidate !== "string") return null;
  const millis = Date.parse(candidate);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function roundTripDollars(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) return null;
  return value;
}

function roundTripIndex(value: string | null | undefined, fallback: number | null | undefined): number | null {
  return roundTripInteger(value) ?? (typeof fallback === "number" && Number.isSafeInteger(fallback) ? fallback : null);
}

const CROSS_EXCHANGE_BLOCKING_PREFIXES = [
  "clean_prior_cross_exchange_transfer:",
  "clean_ambiguous_cross_exchange_transfer:",
  "clean_cross_exchange_transfer_timestamp_missing:",
  "clean_cross_exchange_transfer_during_snapshot_scan:",
] as const;

function optionalIndex(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function numberedSubaccount(record: PreBoundaryTransferView): number | null {
  return roundTripInteger(record.details.source_subaccount)
    ?? roundTripInteger(record.details.destination_subaccount)
    ?? roundTripInteger(record.details.from_subaccount)
    ?? roundTripInteger(record.details.to_subaccount)
    ?? roundTripInteger(record.details.subaccount_number)
    ?? roundTripInteger(record.details.subaccount)
    ?? optionalIndex(record.subaccountNumber);
}

function crossExchangeTiedToProductionSubaccount(record: PreBoundaryTransferView): boolean {
  if (record.classification === "pair" || record.subaccountNumber === PRODUCTION_SUBACCOUNT) return true;
  return [
    record.details.source_subaccount,
    record.details.destination_subaccount,
    record.details.from_subaccount,
    record.details.to_subaccount,
    record.details.subaccount_number,
    record.details.subaccount,
  ].some((value) => roundTripInteger(value) === PRODUCTION_SUBACCOUNT);
}

function touchesProductionExchange(record: PreBoundaryTransferView): boolean {
  return roundTripInteger(record.details.source_exchange_shard) === PRODUCTION_EXCHANGE_INDEX ||
    roundTripInteger(record.details.destination_exchange_shard) === PRODUCTION_EXCHANGE_INDEX ||
    roundTripInteger(record.details.exchange_index) === PRODUCTION_EXCHANGE_INDEX ||
    optionalIndex(record.sourceExchangeIndex) === PRODUCTION_EXCHANGE_INDEX ||
    optionalIndex(record.destinationExchangeIndex) === PRODUCTION_EXCHANGE_INDEX ||
    optionalIndex(record.exchangeIndex) === PRODUCTION_EXCHANGE_INDEX;
}

/**
 * Account-wide cross-exchange history has shard identity and no numbered
 * subaccount. Capture already retains that pre-scan evidence as ambiguous.
 * This predicate does not reclassify it and does not remove it from evidence.
 */
function retainedAccountWideCrossExchange(
  record: PreBoundaryTransferView,
  reasons: string[],
  scanStartedAt: string | null | undefined,
): boolean {
  if (record.feed !== "cross_exchange_transfer" || record.classification !== "ambiguous") return false;
  if (crossExchangeTiedToProductionSubaccount(record) || numberedSubaccount(record) !== null) return false;
  if (!touchesProductionExchange(record)) return false;
  if (reasons.some((reason) => CROSS_EXCHANGE_BLOCKING_PREFIXES.some((prefix) => reason === `${prefix}${record.id}`))) {
    return false;
  }
  const createdAt = roundTripCreatedAt(record);
  const scanMs = typeof scanStartedAt === "string" ? Date.parse(scanStartedAt) : NaN;
  const occurredMs = createdAt === null ? NaN : Date.parse(createdAt);
  return Number.isFinite(scanMs) && Number.isFinite(occurredMs) && occurredMs < scanMs;
}

function isInboundCandidate(record: PreBoundaryTransferView): boolean {
  return record.feed === "subaccount_transfer" &&
    record.classification === "pair" &&
    roundTripInteger(record.details.from_subaccount) === 0 &&
    roundTripInteger(record.details.to_subaccount) === PRODUCTION_SUBACCOUNT &&
    roundTripInteger(record.details.exchange_index) === PRODUCTION_EXCHANGE_INDEX &&
    roundTripInteger(record.details.amount_cents) === PRE_BOUNDARY_ROUND_TRIP_CENTS &&
    record.id === PRE_BOUNDARY_INBOUND_TRANSFER_ID;
}

function isOutboundCandidate(record: PreBoundaryTransferView): boolean {
  return record.feed === "subaccount_transfer" &&
    record.classification === "pair" &&
    roundTripInteger(record.details.from_subaccount) === PRODUCTION_SUBACCOUNT &&
    roundTripInteger(record.details.to_subaccount) === 0 &&
    roundTripInteger(record.details.exchange_index) === PRODUCTION_EXCHANGE_INDEX &&
    roundTripInteger(record.details.amount_cents) === PRE_BOUNDARY_ROUND_TRIP_CENTS &&
    record.id === PRE_BOUNDARY_OUTBOUND_TRANSFER_ID;
}

function sanitizeRoundTripTransfer(record: PreBoundaryTransferView): RoundTripTransferDiagnostic | null {
  if (record.feed !== "subaccount_transfer" && record.feed !== "cross_exchange_transfer") return null;
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(record.id)) return null;
  const classification = /^(?:pair|elsewhere|ambiguous)$/.test(record.classification)
    ? record.classification
    : "unrecognized";
  return {
    feed: record.feed,
    transferId: record.id,
    classification,
    fromSubaccount: roundTripInteger(record.details.from_subaccount),
    toSubaccount: roundTripInteger(record.details.to_subaccount),
    exchangeIndex: roundTripIndex(record.details.exchange_index, record.exchangeIndex),
    sourceSubaccount: roundTripInteger(record.details.source_subaccount),
    destinationSubaccount: roundTripInteger(record.details.destination_subaccount),
    sourceExchangeIndex: roundTripIndex(record.details.source_exchange_shard, record.sourceExchangeIndex),
    destinationExchangeIndex: roundTripIndex(record.details.destination_exchange_shard, record.destinationExchangeIndex),
    amountCents: roundTripInteger(record.details.amount_cents),
    amountDollars: roundTripDollars(record.details.amount_dollars) ?? roundTripDollars(record.details.amount),
    createdAt: roundTripCreatedAt(record),
  };
}

function roundTripFailureDiagnostic(
  records: PreBoundaryTransferView[],
  reasons: string[],
  scanStartedAt: string | null | undefined,
): {
  unrecognizedTransfers: RoundTripTransferDiagnostic[];
  roundTripCandidates: { inbound: RoundTripTransferDiagnostic[]; outbound: RoundTripTransferDiagnostic[] };
} {
  const inbound: RoundTripTransferDiagnostic[] = [];
  const outbound: RoundTripTransferDiagnostic[] = [];
  const unrecognized: RoundTripTransferDiagnostic[] = [];
  for (const record of records) {
    if (record.feed === "cross_exchange_transfer") {
      if (retainedAccountWideCrossExchange(record, reasons, scanStartedAt)) continue;
      if (record.classification === "elsewhere" && !crossExchangeTiedToProductionSubaccount(record)) continue;
      const view = sanitizeRoundTripTransfer(record);
      if (view) unrecognized.push(view);
      continue;
    }
    if (record.feed !== "subaccount_transfer" || record.classification === "elsewhere") continue;
    const view = sanitizeRoundTripTransfer(record);
    if (!view) continue;
    if (isInboundCandidate(record)) inbound.push(view);
    else if (isOutboundCandidate(record)) outbound.push(view);
    else unrecognized.push(view);
  }
  const causedByCandidateShape = [...inbound, ...outbound].filter((view) =>
    view.createdAt === null || !TRANSFER_UUID.test(view.transferId));
  return {
    unrecognizedTransfers: [...unrecognized, ...causedByCandidateShape],
    roundTripCandidates: { inbound, outbound },
  };
}

function unrecognizedRoundTrip(
  records: PreBoundaryTransferView[],
  reasons: string[],
  scanStartedAt: string | null | undefined,
) {
  return {
    ok: false as const,
    reason: "pre_boundary_unrecognized_transfer" as const,
    ...roundTripFailureDiagnostic(records, reasons, scanStartedAt),
  };
}

function roundTripDigest(proof: Omit<PreBoundaryRoundTripProof, "evidenceDigest">): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    subaccount: PRODUCTION_SUBACCOUNT,
    exchangeIndex: PRODUCTION_EXCHANGE_INDEX,
    amountCents: PRE_BOUNDARY_ROUND_TRIP_CENTS,
    inboundTransferId: proof.inboundTransferId,
    outboundTransferId: proof.outboundTransferId,
    inboundCreatedAt: proof.inboundCreatedAt,
    outboundCreatedAt: proof.outboundCreatedAt,
  })).digest("hex");
}

/** Prove the one intentional $25 round trip. Any other pair activity fails closed. */
export function provePreBoundaryRoundTrip(input: {
  availableCashMicros: string | null;
  inventoryCashMicros: string | null;
  portfolioValueMicros: string | null;
  zeroPositions: boolean;
  zeroOrders: boolean;
  zeroFills: boolean;
  zeroSettlements: boolean;
  reasons: string[];
  records: PreBoundaryTransferView[];
  /** Start of the boundary scan that retained account-wide cross-exchange evidence. */
  scanStartedAt?: string | null;
}): { ok: true; roundTrip: PreBoundaryRoundTripProof } | {
  ok: false;
  reason: string;
  unrecognizedTransfers?: RoundTripTransferDiagnostic[];
  roundTripCandidates?: { inbound: RoundTripTransferDiagnostic[]; outbound: RoundTripTransferDiagnostic[] };
} {
  if (input.availableCashMicros !== "0") return { ok: false, reason: "pre_boundary_available_cash_not_zero" };
  if (input.inventoryCashMicros !== "0") return { ok: false, reason: "pre_boundary_inventory_cash_not_zero" };
  if (input.portfolioValueMicros !== "0") return { ok: false, reason: "pre_boundary_portfolio_value_not_zero" };
  if (!input.zeroPositions) return { ok: false, reason: "pre_boundary_position_present" };
  if (!input.zeroOrders) return { ok: false, reason: "pre_boundary_order_present" };
  if (!input.zeroFills) return { ok: false, reason: "pre_boundary_fill_present" };
  if (!input.zeroSettlements) return { ok: false, reason: "pre_boundary_settlement_present" };
  const blockingCrossExchange = input.reasons.find((reason) =>
    CROSS_EXCHANGE_BLOCKING_PREFIXES.some((prefix) => reason.startsWith(prefix)));
  if (blockingCrossExchange) return { ok: false, reason: blockingCrossExchange };
  const otherReason = input.reasons.find((reason) => !reason.startsWith("clean_prior_subaccount_transfer:"));
  if (otherReason) return { ok: false, reason: otherReason };
  const unexplainedCrossExchange = input.records.some((record) =>
    record.feed === "cross_exchange_transfer" &&
    !retainedAccountWideCrossExchange(record, input.reasons, input.scanStartedAt) &&
    (crossExchangeTiedToProductionSubaccount(record) || record.classification !== "elsewhere"));
  if (unexplainedCrossExchange) return unrecognizedRoundTrip(input.records, input.reasons, input.scanStartedAt);
  const touching = input.records.filter((record) =>
    record.feed === "subaccount_transfer" && record.classification !== "elsewhere");
  if (touching.some((record) => record.classification !== "pair")) {
    return unrecognizedRoundTrip(input.records, input.reasons, input.scanStartedAt);
  }
  const parsed = touching.map((record) => ({
    id: record.id,
    from: roundTripInteger(record.details.from_subaccount),
    to: roundTripInteger(record.details.to_subaccount),
    exchange: roundTripInteger(record.details.exchange_index),
    cents: roundTripInteger(record.details.amount_cents),
    createdAt: roundTripCreatedAt(record),
  }));
  if (parsed.some((row) => row.createdAt === null || !TRANSFER_UUID.test(row.id))) {
    return unrecognizedRoundTrip(input.records, input.reasons, input.scanStartedAt);
  }
  const inbound = parsed.filter((row) =>
    row.from === 0 && row.to === PRODUCTION_SUBACCOUNT &&
    row.exchange === PRODUCTION_EXCHANGE_INDEX &&
    row.cents === PRE_BOUNDARY_ROUND_TRIP_CENTS &&
    row.id === PRE_BOUNDARY_INBOUND_TRANSFER_ID);
  const outbound = parsed.filter((row) =>
    row.from === PRODUCTION_SUBACCOUNT && row.to === 0 &&
    row.exchange === PRODUCTION_EXCHANGE_INDEX &&
    row.cents === PRE_BOUNDARY_ROUND_TRIP_CENTS &&
    row.id === PRE_BOUNDARY_OUTBOUND_TRANSFER_ID);
  const recognized = new Set([...inbound, ...outbound].map((row) => row.id));
  if (parsed.some((row) => !recognized.has(row.id))) {
    return unrecognizedRoundTrip(input.records, input.reasons, input.scanStartedAt);
  }
  if (inbound.length !== 1) return { ok: false, reason: "pre_boundary_inbound_transfer_not_proven" };
  if (outbound.length !== 1) return { ok: false, reason: "pre_boundary_outbound_transfer_mismatch" };
  const inboundRow = inbound[0]!;
  const outboundRow = outbound[0]!;
  const roundTrip = {
    inboundTransferId: inboundRow.id,
    outboundTransferId: outboundRow.id,
    amountCents: PRE_BOUNDARY_ROUND_TRIP_CENTS,
    inboundCreatedAt: inboundRow.createdAt!,
    outboundCreatedAt: outboundRow.createdAt!,
  };
  return { ok: true, roundTrip: { ...roundTrip, evidenceDigest: roundTripDigest(roundTrip) } };
}

/** Drop only the two persisted transfer ids. Every other historical reason still blocks. */
export function selectBlockingCleanReasons(
  reasons: string[],
  acknowledged: { inboundTransferId: string; outboundTransferId: string } | null,
): string[] {
  if (!acknowledged) return [...reasons];
  const waived = new Set([
    `clean_prior_subaccount_transfer:${acknowledged.inboundTransferId}`,
    `clean_prior_subaccount_transfer:${acknowledged.outboundTransferId}`,
  ]);
  return reasons.filter((reason) => !waived.has(reason));
}
