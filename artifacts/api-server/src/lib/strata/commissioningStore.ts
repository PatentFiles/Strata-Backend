import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { computeV13LiveMoneyPolicyHash, type V13ApprovedLiveMoneyPolicy } from "../v13LiveMoneyRisk";
import { captureCleanPairSnapshot, verifyKalshiRestrictedTradingKeyForSubaccount } from "../kalshiAccountClient";
import {
  createStrataSubaccount,
  generateStrataIndex2Key,
  inspectStrataIndex2Credentials,
  inspectStrataIndex2Replacement,
} from "../generatePairRestrictedKalshiKey";
import { readProvisioningInventory, readReviewedSubaccountEvidence } from "../microLiveSubaccountCreation";
import { configuredKey } from "../microLivePairBoundary";
import { postOneShotPairFunding, readPairTransferHistory, readPrimaryIndex2Balance } from "../kalshiPairFundingClient";
import {
  CANONICAL_FEE_SCHEDULE_URL,
  STANDING_FEE_POLICY_VERSION,
  STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  establishOfficialFeeDigest,
  verifyOfficialFeePdfBytes,
} from "../microLiveFeeArtifact";
import { REVIEWED_RELEASE } from "./reviewedRelease";
import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
} from "@workspace/v13-strategy";
import {
  PRODUCTION_EXCHANGE_INDEX,
  PRODUCTION_SUBACCOUNT,
  REVIEWED_FUNDING_CENTS,
  REVIEWED_FUNDING_MICROS,
  OPERATOR_POLICY_FIELDS,
  PRE_BOUNDARY_INBOUND_TRANSFER_ID,
  PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
  PRE_BOUNDARY_ROUND_TRIP_CENTS,
  PRE_BOUNDARY_ROUND_TRIP_CONFIRMATION,
  blockingSubaccountTransferDetail,
  applyDurableDedicatedSigner,
  dedicatedSignerFingerprint,
  fundingCashProvesExact25,
  provePreBoundaryRoundTrip,
  selectCurrentFundingTransfer,
  EXIT_FLOOR_CONFIRMATION,
  approvedExitFloor,
  emptySnapshot,
  fundingAuthorizationDecision,
  publicFeeVerificationReason,
  index2GenerationDecision,
  index2ReplacementDecision,
  policyReadFromRows,
  maskKeyId,
  assembleSubaccountStatus,
  subaccountCreationDecision,
  unprovenSubaccountStatus,
  type Index2AttemptState,
  type SubaccountAttemptState,
  type SubaccountStatus,
  planArm,
  planCommission,
  planDisarm,
  transportGatesReady,
  validatePolicyLimits,
  type CommissioningSnapshot,
  type PolicyLimits,
} from "./commissioning";
import type {
  CommissioningPort, ExchangeCall, Index2GenerationResult, SubaccountCreateResult,
} from "../../routes/strataCommissioning";

type QueryRows = { rows: Array<Record<string, unknown>> };

async function query(sql: string, values: unknown[] = []): Promise<QueryRows> {
  return pool.query(sql, values);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function missingPolicyFields(row: Record<string, unknown> | null): string[] {
  if (!row) return [...OPERATOR_POLICY_FIELDS];
  const missing: string[] = [];
  for (const field of OPERATOR_POLICY_FIELDS) {
    const column = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const value = row[column];
    if (value === null || value === undefined || value === "" || value === 0) missing.push(field);
  }
  return missing;
}

function policyFromRow(row: Record<string, unknown>): V13ApprovedLiveMoneyPolicy {
  return {
    id: String(row.id),
    version: Number(row.version),
    supersedesPolicyId: text(row.supersedes_policy_id),
    state: row.state as V13ApprovedLiveMoneyPolicy["state"],
    strategyVersion: String(row.strategy_version),
    strategyParameterSetId: String(row.strategy_parameter_set_id),
    strategyParameterHash: String(row.strategy_parameter_hash),
    championSelectionReviewId: text(row.champion_selection_review_id),
    championSelectionEvidenceHash: text(row.champion_selection_evidence_hash),
    championSelectedBy: text(row.champion_selected_by),
    championSelectedAt: row.champion_selected_at ? new Date(String(row.champion_selected_at)) : null,
    capitalLimitCents: Number(row.capital_limit_cents),
    maxEntryStakeCents: Number(row.max_entry_stake_cents),
    maxEntryAllInCents: Number(row.max_entry_all_in_cents),
    maxOpenPositions: Number(row.max_open_positions),
    maxDailyLossCents: Number(row.max_daily_loss_cents),
    maxTotalLossCents: Number(row.max_total_loss_cents),
    maxQuoteAgeMs: Number(row.max_quote_age_ms),
    maxFeeEvidenceAgeMs: Number(row.max_fee_evidence_age_ms),
    feePolicyVersion: text(row.fee_policy_version),
    feeSourceUrl: text(row.fee_source_url),
    feeFormulaVersion: text(row.fee_formula_version),
    requireFullDepth: row.require_full_depth === true,
    entryTimeInForce: String(row.entry_time_in_force),
    entryLimitSource: String(row.entry_limit_source),
    policyHash: text(row.policy_hash),
    createdBy: String(row.created_by),
    approvedBy: text(row.approved_by),
    approvedAt: row.approved_at ? new Date(String(row.approved_at)) : null,
  };
}

export async function readCommissioningSnapshot(
  workerRunning = false,
  signerPatch: Partial<CommissioningSnapshot["signer"]> = {},
): Promise<CommissioningSnapshot> {
  const snapshot = emptySnapshot(new Date().toISOString());
  snapshot.workerRunning = workerRunning;
  const key = configuredKey("index2");
  if (key) {
    const fingerprint = dedicatedSignerFingerprint(
      key.apiKeyId,
      process.env.KALSHI_INDEX2_PRIVATE_KEY ?? "",
    );
    snapshot.signer = {
      configured: true,
      syntacticallyUsable: fingerprint === key.fingerprint && fingerprint !== null,
      signedGetSucceeded: false,
      restrictedToPair: false,
      historyComplete: false,
      ...signerPatch,
      fingerprint: signerPatch.fingerprint ?? fingerprint,
      keyIdMasked: maskKeyId(key.apiKeyId),
    };
  }
  const [accounts, policies, approvedPolicies, boundary, funding] = await Promise.all([
    query("SELECT * FROM v13_production_account"),
    query("SELECT count(*)::int AS count FROM v13_live_money_policy"),
    query("SELECT * FROM v13_live_money_policy WHERE state = 'APPROVED' LIMIT 2"),
    query("SELECT * FROM micro_live_pair_boundary WHERE subaccount_number = $1", [PRODUCTION_SUBACCOUNT]),
    query(`SELECT state, amount_cents, transfer_id FROM micro_live_pair_funding_attempts
      WHERE destination_subaccount = $1 AND exchange_index = $2 LIMIT 2`,
    [PRODUCTION_SUBACCOUNT, PRODUCTION_EXCHANGE_INDEX]),
  ]);
  const pairAccounts = accounts.rows.filter((row) =>
    Number(row.subaccount) === PRODUCTION_SUBACCOUNT && Number(row.exchange_index) === PRODUCTION_EXCHANGE_INDEX);
  snapshot.account.count = pairAccounts.length;
  const account = pairAccounts.length === 1 ? pairAccounts[0] : null;
  if (account) {
    snapshot.account = {
      count: 1,
      id: text(account.id),
      subaccount: Number(account.subaccount),
      exchangeIndex: Number(account.exchange_index),
      fingerprint: text(account.key_fingerprint),
      commissioned: account.commissioned === true,
      executionEnabled: account.execution_enabled === true,
      killSwitch: account.kill_switch !== false,
    };
    snapshot.fee.digest = text(account.fee_artifact_digest);
    snapshot.fee.cashPrecisionVerified = account.cash_precision_verified === true;
    snapshot.approvedMinimumExitMicros = Number.isSafeInteger(Number(account.minimum_exit_micros))
      ? Number(account.minimum_exit_micros) : null;
  }
  snapshot.policy.exists = Number(policies.rows[0]?.count ?? 0) > 0;
  const approved = approvedPolicies.rows.length === 1 ? approvedPolicies.rows[0]! : null;
  if (approved) {
    const decoded = policyFromRow(approved);
    const hash = computeV13LiveMoneyPolicyHash(decoded);
    snapshot.policy = {
      exists: true,
      id: decoded.id,
      approved: decoded.state === "APPROVED",
      strategyParameterSetId: decoded.strategyParameterSetId,
      strategyParameterHash: decoded.strategyParameterHash,
      entryPolicyVersion: decoded.entryPolicyVersion ?? null,
      hashMatches: decoded.policyHash === hash &&
        decoded.strategyParameterSetId === V13_CHAMPION_PARAMETER_SET.id &&
        decoded.strategyParameterHash === V13_CHAMPION_PARAMETER_HASH,
      missingFields: missingPolicyFields(approved),
    };
  } else if (snapshot.policy.exists) {
    snapshot.policy.missingFields = [...OPERATOR_POLICY_FIELDS];
  }
  const row = boundary.rows.length === 1 ? boundary.rows[0]! : null;
  if (row) {
    const cleanZero = row.clean_balance_micros === "0" &&
      Number(row.clean_order_count) === 0 && Number(row.clean_fill_count) === 0 &&
      Number(row.clean_position_count) === 0 && Number(row.clean_settlement_count) === 0;
    snapshot.boundary = {
      exists: true,
      subaccount: Number(row.subaccount_number),
      exchangeIndex: Number(row.exchange_index),
      state: text(row.state),
      cleanZero,
      verified: row.clean_snapshot_authenticated === true && cleanZero &&
        row.ambiguity_frozen_at == null &&
        typeof row.clean_boundary_evidence_digest === "string",
      fingerprintMatches: !!snapshot.signer.fingerprint &&
        row.restricted_key_fingerprint === snapshot.signer.fingerprint,
      historyComplete: false,
      ambiguous: boundary.rows.length !== 1 || row.ambiguity_frozen_at != null,
    };
    snapshot.funding = {
      anchorExists: text(row.funding_transfer_id) !== null,
      amountCents: row.funding_amount_cents === null ? null : Number(row.funding_amount_cents),
      balanceMicros: text(row.post_funding_balance_micros),
      verified: row.state === "funded" &&
        Number(row.funding_amount_cents) === REVIEWED_FUNDING_CENTS &&
        row.post_funding_balance_micros === REVIEWED_FUNDING_MICROS &&
        row.ambiguity_frozen_at == null,
      uncertain: funding.rows.some((attempt) => attempt.state === "uncertain"),
    };
  }
  if (funding.rows.some((attempt) => attempt.state === "uncertain")) snapshot.funding.uncertain = true;
  snapshot.transportReady = transportGatesReady();
  try {
    const evidence = await query("SELECT * FROM v13_commissioning_evidence WHERE singleton_id = 'singleton'");
    const row = evidence.rows[0];
    if (row?.boundary_history_complete === true && snapshot.boundary.cleanZero && snapshot.boundary.exists) {
      snapshot.boundary.historyComplete = true;
      snapshot.signer.historyComplete = snapshot.signer.configured;
    }
    if (row?.fee_artifact_verified === true && typeof row.fee_artifact_digest === "string") {
      snapshot.fee.digest = row.fee_artifact_digest;
      snapshot.fee.verified = true;
    }
    if (row?.cash_precision_verified === true &&
        typeof row.cash_micros === "string" && /^[0-9]+$/.test(row.cash_micros) &&
        row.cash_source === "authenticated_kalshi_micros") {
      snapshot.cash = {
        precisionVerified: true,
        micros: row.cash_micros,
        source: "authenticated_kalshi_micros",
      };
    }
    const exitMicros = Number(row?.minimum_exit_micros);
    if (row?.minimum_exit_source === "operator_approved" && approvedExitFloor(exitMicros)) {
      snapshot.minimumExit = { approved: true, micros: exitMicros, source: "operator_approved" };
      snapshot.approvedMinimumExitMicros = exitMicros;
    }
  } catch {
    snapshot.boundary.historyComplete = false;
  }
  if (!Object.prototype.hasOwnProperty.call(signerPatch, "signedGetSucceeded")) {
    const boundaryRow = boundary.rows.length === 1 ? boundary.rows[0]! : null;
    applyDurableDedicatedSigner(snapshot, {
      currentApiKeyId: key?.apiKeyId ?? null,
      rowCount: boundary.rows.length,
      restrictedApiKeyId: text(boundaryRow?.restricted_api_key_id),
      restrictedKeyFingerprint: text(boundaryRow?.restricted_key_fingerprint),
      keyBoundAt: boundaryRow?.key_bound_at ?? null,
      keyBindingEvidenceDigest: text(boundaryRow?.key_binding_evidence_digest),
    });
  }
  try {
    const positions = await query(
      "SELECT count(*)::int AS count FROM v13_production_position WHERE quantity_hundredths > 0",
    );
    const intents = await query(
      "SELECT count(*)::int AS count FROM v13_production_intent WHERE terminal = false AND state NOT IN ('TERMINAL','BLOCKED')",
    );
    snapshot.openPositionCount = Number(positions.rows[0]?.count ?? 0);
    snapshot.unresolvedIntentCount = Number(intents.rows[0]?.count ?? 0);
  } catch {
    snapshot.openPositionCount = 0;
    snapshot.unresolvedIntentCount = 0;
  }
  snapshot.preBoundaryRoundTripAcknowledged = (await readStoredRoundTrip()) !== null;
  snapshot.preBoundaryRoundTripEligibleForAcknowledgment = false;
  return snapshot;
}

/**
 * Signed GET only, and only when the verifier secret is already present.
 * A successful GET does not prove history or commissioning.
 */
export async function probeDedicatedSigner(): Promise<{
  signedGetSucceeded: boolean;
  calls: ExchangeCall[];
}> {
  if (!configuredKey("index2") || !process.env.KALSHI_VERIFIER_API_KEY_ID?.trim() ||
      !process.env.KALSHI_VERIFIER_API_PRIVATE_KEY?.trim()) {
    return { signedGetSucceeded: false, calls: [] };
  }
  const signedGetSucceeded = await verifyKalshiRestrictedTradingKeyForSubaccount(
    PRODUCTION_SUBACCOUNT, "index2");
  return {
    signedGetSucceeded,
    calls: [{ method: "GET", path: "/trade-api/v2/api_keys" }],
  };
}

const BOUNDARY_GETS: ExchangeCall[] = [
  { method: "GET", path: "/trade-api/v2/markets" },
  { method: "GET", path: "/trade-api/v2/portfolio/balance" },
  { method: "GET", path: "/trade-api/v2/portfolio/positions" },
  { method: "GET", path: "/trade-api/v2/portfolio/orders" },
  { method: "GET", path: "/trade-api/v2/historical/orders" },
  { method: "GET", path: "/trade-api/v2/portfolio/fills" },
  { method: "GET", path: "/trade-api/v2/historical/fills" },
  { method: "GET", path: "/trade-api/v2/portfolio/settlements" },
  { method: "GET", path: "/trade-api/v2/portfolio/subaccounts/transfers" },
  { method: "GET", path: "/trade-api/v2/portfolio/intra_exchange_instance_transfers" },
];

async function currentIndex2Ticker(): Promise<string> {
  const response = await fetch("https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=200", {
    method: "GET", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) throw new Error("current_market_unavailable");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !("markets" in body) || !Array.isArray(body.markets) ||
      ("cursor" in body && body.cursor)) throw new Error("current_market_incomplete");
  const now = Date.now();
  const current = body.markets.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item) &&
    typeof item.ticker === "string" && /^KXBTC15M-[A-Za-z0-9-]+$/.test(item.ticker) &&
    item.exchange_index === 2 && item.status === "active" &&
    typeof item.open_time === "string" && Date.parse(item.open_time) <= now &&
    typeof item.close_time === "string" && Date.parse(item.close_time) > now);
  if (current.length !== 1) throw new Error("current_market_ambiguous");
  return String(current[0]!.ticker);
}

async function readStoredRoundTrip(): Promise<{
  id: string;
  inboundTransferId: string;
  outboundTransferId: string;
  evidenceDigest: string;
} | null> {
  try {
    const rows = await query(`SELECT id, inbound_transfer_id, outbound_transfer_id, evidence_digest
      FROM strata_pre_boundary_transfer_acknowledgment
      WHERE state = 'ACKNOWLEDGED' LIMIT 2`);
    if (rows.rows.length !== 1) return null;
    const row = rows.rows[0]!;
    if (row.outbound_transfer_id !== PRE_BOUNDARY_OUTBOUND_TRANSFER_ID) return null;
    if (row.inbound_transfer_id !== PRE_BOUNDARY_INBOUND_TRANSFER_ID) return null;
    if (typeof row.id !== "string") return null;
    if (typeof row.evidence_digest !== "string" || !/^[0-9a-f]{64}$/.test(row.evidence_digest)) return null;
    return {
      id: row.id,
      inboundTransferId: row.inbound_transfer_id,
      outboundTransferId: PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
      evidenceDigest: row.evidence_digest,
    };
  } catch {
    return null;
  }
}

async function captureRailwayBoundary(workerRunning: () => boolean) {
  try {
    const ticker = await currentIndex2Ticker();
    const acknowledgedRoundTrip = await readStoredRoundTrip();
    const snapshot = await captureCleanPairSnapshot(PRODUCTION_SUBACCOUNT, ticker, {
      creationBoundary: true,
      acknowledgedRoundTrip,
    });
    const historyClear = snapshot.zeroPriorPairTransfers || snapshot.preBoundaryRoundTripSatisfied === true;
    const clean = snapshot.status === "clean" && snapshot.reasons.length === 0 &&
      snapshot.availableCashMicros === "0" && snapshot.inventoryCashMicros === "0" &&
      snapshot.zeroOrders && snapshot.zeroPositions && snapshot.zeroFills &&
      snapshot.zeroSettlements && historyClear && snapshot.portfolioValueMicros === "0" &&
      snapshot.pair.subaccountNumber === 1 && snapshot.pair.exchangeIndex === 2 &&
      typeof snapshot.evidenceDigest === "string" && /^[0-9a-f]{64}$/.test(snapshot.evidenceDigest);
    if (!clean || !snapshot.evidenceDigest) {
      const reason = snapshot.reasons[0] ?? "clean_boundary_not_proven";
      const proof = provePreBoundaryRoundTrip({
        availableCashMicros: snapshot.availableCashMicros,
        inventoryCashMicros: snapshot.inventoryCashMicros,
        portfolioValueMicros: snapshot.portfolioValueMicros ?? null,
        zeroPositions: snapshot.zeroPositions,
        zeroOrders: snapshot.zeroOrders,
        zeroFills: snapshot.zeroFills,
        zeroSettlements: snapshot.zeroSettlements,
        reasons: snapshot.reasons,
        records: snapshot.records,
        scanStartedAt: snapshot.scanStartedAt,
      });
      const published = await readCommissioningSnapshot(workerRunning());
      published.preBoundaryRoundTripAcknowledged = acknowledgedRoundTrip !== null;
      published.preBoundaryRoundTripEligibleForAcknowledgment = acknowledgedRoundTrip === null && proof.ok;
      return {
        snapshot: published,
        calls: BOUNDARY_GETS,
        blocked: true,
        reason,
        blockingTransfer: snapshot.blockingTransfer !== undefined
          ? snapshot.blockingTransfer
          : blockingSubaccountTransferDetail(reason, snapshot.records),
      };
    }
    const existing = await query("SELECT state FROM micro_live_pair_boundary WHERE subaccount_number = 1");
    if (existing.rows.length > 0) {
      return {
        snapshot: await readCommissioningSnapshot(workerRunning()),
        calls: BOUNDARY_GETS, blocked: true, reason: "boundary_already_recorded",
      };
    }
    const key = configuredKey("index2");
    const keyOk = key ? await verifyKalshiRestrictedTradingKeyForSubaccount(1, "index2") : false;
    await query(`INSERT INTO micro_live_pair_boundary (
      subaccount_number, exchange_index, clean_balance_micros, clean_balance_semantics,
      clean_snapshot_authenticated, clean_order_count, clean_fill_count, clean_position_count,
      clean_settlement_count, clean_boundary_at, clean_boundary_evidence_digest,
      creation_attempt_id, creation_inventory_digest, state)
      VALUES (1, 2, '0', 'available_cash', true, 0, 0, 0, 0, now(), $1, $2, $1, 'CREATED_CLEAN')`,
    [snapshot.evidenceDigest, randomUUID()]);
    await query(`INSERT INTO v13_commissioning_evidence
      (singleton_id, boundary_history_complete, cash_precision_verified, cash_micros, cash_source, updated_at)
      VALUES ('singleton', true, true, '0', 'authenticated_kalshi_micros', now())
      ON CONFLICT (singleton_id) DO UPDATE SET
        boundary_history_complete = true,
        cash_precision_verified = true, cash_micros = '0',
        cash_source = 'authenticated_kalshi_micros', updated_at = now()`);
    if (keyOk && key) {
      const boundAt = new Date().toISOString();
      const bindingDigest = createHash("sha256").update(JSON.stringify({
        subaccountNumber: 1, exchangeIndex: 2, apiKeyId: key.apiKeyId,
        fingerprint: key.fingerprint, verifiedAt: boundAt, scopes: ["read", "write::trade"],
      })).digest("hex");
      await query(`UPDATE micro_live_pair_boundary SET
        state = 'KEY_BOUND_VERIFIED', restricted_api_key_id = $1, restricted_key_fingerprint = $2,
        key_bound_at = $3, key_binding_evidence_digest = $4, updated_at = $3
        WHERE subaccount_number = 1 AND state = 'CREATED_CLEAN'`,
      [key.apiKeyId, key.fingerprint, boundAt, bindingDigest]);
    }
    return {
      snapshot: await readCommissioningSnapshot(workerRunning()),
      calls: BOUNDARY_GETS, blocked: false, reason: keyOk ? "clean_boundary_captured" : "clean_boundary_captured_key_unverified",
    };
  } catch {
    return {
      snapshot: await readCommissioningSnapshot(workerRunning()),
      calls: BOUNDARY_GETS, blocked: true, reason: "boundary_read_failed",
    };
  }
}

async function acknowledgePreBoundaryRoundTrip(confirmation: unknown, actor: string) {
  const closed = {
    acknowledged: false,
    eligible: false,
    inboundTransferId: null,
    outboundTransferId: null,
    amountCents: null,
    inboundCreatedAt: null,
    outboundCreatedAt: null,
    evidenceDigest: null,
    calls: BOUNDARY_GETS,
    funded: false as const,
    commissioned: false as const,
    armed: false as const,
    workerStarted: false as const,
    executionFlagsChanged: false as const,
  };
  if (confirmation !== PRE_BOUNDARY_ROUND_TRIP_CONFIRMATION) {
    return { status: "BLOCKED" as const, reason: "explicit_pre_boundary_round_trip_confirmation_required", ...closed, calls: [] };
  }
  if (actor.trim() === "") {
    return { status: "BLOCKED" as const, reason: "pre_boundary_actor_required", ...closed, calls: [] };
  }
  const existing = await readStoredRoundTrip();
  if (existing) {
    return {
      status: "BLOCKED" as const,
      reason: "pre_boundary_round_trip_already_acknowledged",
      ...closed,
      acknowledged: true,
      calls: [],
      outboundTransferId: existing.outboundTransferId,
      inboundTransferId: existing.inboundTransferId,
      evidenceDigest: existing.evidenceDigest,
      amountCents: PRE_BOUNDARY_ROUND_TRIP_CENTS,
    };
  }
  const ticker = await currentIndex2Ticker();
  const snapshot = await captureCleanPairSnapshot(PRODUCTION_SUBACCOUNT, ticker, { creationBoundary: true });
  const proof = provePreBoundaryRoundTrip({
    availableCashMicros: snapshot.availableCashMicros,
    inventoryCashMicros: snapshot.inventoryCashMicros,
    portfolioValueMicros: snapshot.portfolioValueMicros ?? null,
    zeroPositions: snapshot.zeroPositions,
    zeroOrders: snapshot.zeroOrders,
    zeroFills: snapshot.zeroFills,
    zeroSettlements: snapshot.zeroSettlements,
    reasons: snapshot.reasons,
    records: snapshot.records,
    scanStartedAt: snapshot.scanStartedAt,
  });
  if (!proof.ok) {
    return {
      status: "BLOCKED" as const,
      reason: proof.reason,
      ...closed,
      eligible: false,
      ...(proof.reason === "pre_boundary_unrecognized_transfer" ? {
        unrecognizedTransfers: proof.unrecognizedTransfers ?? [],
        roundTripCandidates: proof.roundTripCandidates ?? { inbound: [], outbound: [] },
      } : {}),
    };
  }
  const id = randomUUID();
  await query(`INSERT INTO strata_pre_boundary_transfer_acknowledgment (
      id, subaccount, exchange_index, inbound_transfer_id, outbound_transfer_id, amount_cents,
      inbound_created_at, outbound_created_at, acknowledged_by, evidence_digest, state)
    VALUES ($1, 1, 2, $2, $3, $4, $5, $6, $7, $8, 'ACKNOWLEDGED')`, [
    id,
    proof.roundTrip.inboundTransferId,
    proof.roundTrip.outboundTransferId,
    proof.roundTrip.amountCents,
    proof.roundTrip.inboundCreatedAt,
    proof.roundTrip.outboundCreatedAt,
    actor,
    proof.roundTrip.evidenceDigest,
  ]);
  return {
    status: "ACKNOWLEDGED" as const,
    reason: "pre_boundary_round_trip_acknowledged",
    ...closed,
    acknowledged: true,
    eligible: false,
    inboundTransferId: proof.roundTrip.inboundTransferId,
    outboundTransferId: proof.roundTrip.outboundTransferId,
    amountCents: proof.roundTrip.amountCents,
    inboundCreatedAt: proof.roundTrip.inboundCreatedAt,
    outboundCreatedAt: proof.roundTrip.outboundCreatedAt,
    evidenceDigest: proof.roundTrip.evidenceDigest,
  };
}

async function fundRailwayPair(confirmation: unknown, workerRunning: () => boolean) {
  const existing = await query(
    "SELECT attempt_uuid, state FROM micro_live_pair_funding_attempts WHERE destination_subaccount = 1 AND exchange_index = 2",
  );
  const row = existing.rows[0];
  const attemptState = !row ? "none"
    : row.state === "uncertain" ? "uncertain"
    : row.state === "reconciled" ? "reconciled"
    : "attempted";
  const decision = fundingAuthorizationDecision({
    confirmation,
    liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
    v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
    attemptState,
  });
  if (!decision.proceed) {
    return { state: "blocked", reason: decision.reason, transferAttempted: false, attempts: existing.rows.length };
  }
  const boundary = await query("SELECT state, clean_boundary_evidence_digest, restricted_key_fingerprint FROM micro_live_pair_boundary WHERE subaccount_number = 1");
  const bound = boundary.rows[0];
  if (!bound || bound.state !== "KEY_BOUND_VERIFIED" || typeof bound.clean_boundary_evidence_digest !== "string") {
    return { state: "blocked", reason: "fresh_preflight_failed", transferAttempted: false, attempts: 0 };
  }
  let ticker = "";
  let primary: { scopedMicros: string; inventoryMicros: string };
  try {
    ticker = await currentIndex2Ticker();
    const clean = await captureCleanPairSnapshot(1, ticker, {
      creationBoundary: true,
      acknowledgedRoundTrip: await readStoredRoundTrip(),
    });
    if (clean.status !== "clean" || clean.reasons.length > 0 || !clean.evidenceDigest) {
      return { state: "blocked", reason: "fresh_preflight_failed", transferAttempted: false, attempts: 0 };
    }
    primary = await readPrimaryIndex2Balance(0);
    const keyOk = await verifyKalshiRestrictedTradingKeyForSubaccount(1, "index2");
    if (!keyOk || BigInt(primary.scopedMicros) < 25_000_000n ||
        BigInt(primary.inventoryMicros) < 25_000_000n ||
        !/^[0-9]+$/.test(primary.scopedMicros) || !/^[0-9]+$/.test(primary.inventoryMicros)) {
      return { state: "blocked", reason: "fresh_preflight_failed", transferAttempted: false, attempts: 0 };
    }
  } catch {
    return { state: "blocked", reason: "fresh_preflight_failed", transferAttempted: false, attempts: 0 };
  }
  const attemptId = randomUUID();
  try {
    await query(`INSERT INTO micro_live_pair_funding_attempts (
      attempt_uuid, source_subaccount, destination_subaccount, exchange_index, amount_cents,
      market_ticker, state, source_scoped_before_micros, source_inventory_before_micros,
      clean_boundary_digest, attempted_at)
      VALUES ($1, 0, 1, 2, 2500, $2, 'attempted', $3, $4, $5, now())`, [
      attemptId, ticker, primary.scopedMicros, primary.inventoryMicros, bound.clean_boundary_evidence_digest,
    ]);
  } catch {
    return { state: "blocked", reason: "durable_attempt_unavailable", transferAttempted: false, attempts: 0 };
  }
  try {
    await postOneShotPairFunding(attemptId, "strata-production");
    await query("UPDATE micro_live_pair_funding_attempts SET state = 'response_received', response_received_at = now() WHERE attempt_uuid = $1 AND state = 'attempted'", [attemptId]);
    return { state: "response_received", reason: "one_transfer_submitted", transferAttempted: true, attempts: 1 };
  } catch {
    await query("UPDATE micro_live_pair_funding_attempts SET state = 'uncertain' WHERE attempt_uuid = $1 AND state = 'attempted'", [attemptId]);
    return { state: "uncertain", reason: "funding_uncertain_no_retry", transferAttempted: true, attempts: 1 };
  }
}

async function reconcileRailwayFunding(workerRunning: () => boolean) {
  void workerRunning;
  const attempts = await query("SELECT * FROM micro_live_pair_funding_attempts WHERE destination_subaccount = 1 AND exchange_index = 2");
  if (attempts.rows.length === 0) {
    return { state: "blocked", reason: "funding_anchor_missing", transferAttempted: false as const };
  }
  if (attempts.rows.length !== 1) {
    return { state: "blocked", reason: "funding_attempt_ambiguous", transferAttempted: false as const };
  }
  const attempt = attempts.rows[0]!;
  if (attempt.state === "uncertain") {
    return { state: "uncertain", reason: "funding_uncertain_no_retry", transferAttempted: false as const };
  }
  if (attempt.state === "reconciled") {
    const storedId = typeof attempt.transfer_id === "string" ? attempt.transfer_id : "";
    if (storedId !== "" &&
        storedId !== PRE_BOUNDARY_INBOUND_TRANSFER_ID &&
        storedId !== PRE_BOUNDARY_OUTBOUND_TRANSFER_ID) {
      return { state: "funded", reason: "recorded_funding_anchor_present", transferAttempted: false as const };
    }
    return { state: "blocked", reason: "reconciled_funding_transfer_unproven", transferAttempted: false as const };
  }
  if (attempt.state !== "response_received") {
    return { state: "blocked", reason: "funding_attempt_not_response_received", transferAttempted: false as const };
  }
  const acknowledged = await readStoredRoundTrip();
  if (!acknowledged) {
    return {
      state: "response_received",
      reason: "funding_reconcile_acknowledgment_required",
      transferAttempted: false as const,
    };
  }
  try {
    const [history, primary, destination] = await Promise.all([
      readPairTransferHistory(), readPrimaryIndex2Balance(0), readPrimaryIndex2Balance(1),
    ]);
    const selected = selectCurrentFundingTransfer({
      attemptedAt: attempt.attempted_at instanceof Date || typeof attempt.attempted_at === "string"
        ? attempt.attempted_at : null,
      responseReceivedAt: attempt.response_received_at instanceof Date || typeof attempt.response_received_at === "string"
        ? attempt.response_received_at : null,
      acknowledgedInboundTransferId: acknowledged.inboundTransferId,
      acknowledgedOutboundTransferId: acknowledged.outboundTransferId,
      transfers: history,
    });
    if (selected.status === "pending") {
      return {
        state: "response_received",
        reason: "funding_transfer_pending_visibility",
        transferAttempted: false as const,
      };
    }
    if (selected.status !== "selected") {
      return {
        state: "blocked",
        reason: selected.status === "ambiguous" ? "funding_transfer_ambiguous" : "funding_attempt_window_unproven",
        transferAttempted: false as const,
      };
    }
    const proved = fundingCashProvesExact25({
      sourceScopedBeforeMicros: String(attempt.source_scoped_before_micros),
      sourceInventoryBeforeMicros: String(attempt.source_inventory_before_micros),
      sourceScopedMicros: primary.scopedMicros,
      sourceInventoryMicros: primary.inventoryMicros,
      destinationScopedMicros: destination.scopedMicros,
      destinationInventoryMicros: destination.inventoryMicros,
    });
    if (!proved) {
      return { state: "blocked", reason: "funding_balance_not_proven", transferAttempted: false as const };
    }
    const transfer = selected.transfer;
    const digest = createHash("sha256").update(transfer.transferId).digest("hex");
    const fundedBoundary = await query(`UPDATE micro_live_pair_boundary SET
      state = 'funded', funding_transfer_id = $1, funding_amount_cents = 2500,
      funding_transferred_at = $2, post_funding_balance_micros = '25000000',
      post_funding_balance_semantics = 'available_cash', post_funding_snapshot_authenticated = true,
      post_funding_snapshot_at = now(), post_funding_evidence_digest = $3, updated_at = now()
      WHERE subaccount_number = 1 AND state = 'KEY_BOUND_VERIFIED'
      RETURNING subaccount_number`, [transfer.transferId, transfer.occurredAt, digest]);
    if (fundedBoundary.rows.length !== 1) {
      return {
        state: "response_received",
        reason: "funding_boundary_not_updated",
        transferAttempted: false as const,
      };
    }
    await query(`UPDATE micro_live_pair_funding_attempts
      SET state = 'reconciled', transfer_id = $2, reconciled_at = now()
      WHERE attempt_uuid = $1 AND state = 'response_received'`, [attempt.attempt_uuid, transfer.transferId]);
    await query(`INSERT INTO v13_commissioning_evidence
      (singleton_id, cash_precision_verified, cash_micros, cash_source, updated_at)
      VALUES ('singleton', true, '25000000', 'authenticated_kalshi_micros', now())
      ON CONFLICT (singleton_id) DO UPDATE SET
        cash_precision_verified = true, cash_micros = '25000000',
        cash_source = 'authenticated_kalshi_micros', updated_at = now()`);
    return { state: "funded", reason: "recorded_funding_anchor_present", transferAttempted: false as const };
  } catch {
    return { state: "response_received", reason: "funding_reconcile_get_failed", transferAttempted: false as const };
  }
}

function index2Closed(reason: string, posts = 0): Index2GenerationResult {
  return {
    state: "blocked",
    reason,
    posts,
    privateKeyPersisted: false,
    verified: false,
    workerStarted: false,
    environmentChanged: false,
  };
}

function index2Facts(
  confirmation: unknown,
  workerRunning: boolean,
  accountExists: boolean,
  priorAttempt: Index2AttemptState,
  remote: {
    provisioningCredentialValid: boolean;
    provisioningUnrestricted: boolean;
    provisioningScopesExact: boolean;
    verifierCredentialValid: boolean;
    existingIndex2Name: boolean;
  },
) {
  const present = (name: string) => Boolean(process.env[name]?.trim());
  return index2GenerationDecision({
    confirmation,
    nodeEnv: process.env.NODE_ENV,
    provisioningKeyIdPresent: present("KALSHI_PROVISIONING_API_KEY_ID"),
    provisioningPrivateKeyPresent: present("KALSHI_PROVISIONING_PRIVATE_KEY"),
    verifierKeyIdPresent: present("KALSHI_VERIFIER_API_KEY_ID"),
    verifierPrivateKeyPresent: present("KALSHI_VERIFIER_API_PRIVATE_KEY"),
    kalshiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
    ...remote,
    priorAttempt,
    workerRunning,
    productionAccountExists: accountExists,
    liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
    v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
  });
}

/** Commits one attempt row, then allows one key POST. The private key is not written. */
export async function generateRailwayIndex2Key(
  confirmation: unknown,
  workerRunning: boolean,
): Promise<Index2GenerationResult> {
  let priorAttempt: Index2AttemptState = "none";
  let accountExists = false;
  try {
    const [attempt, account, micro] = await Promise.all([
      query("SELECT state FROM strata_index2_key_attempt WHERE singleton_id = 'singleton'"),
      query("SELECT 1 FROM v13_production_account LIMIT 1"),
      query("SELECT 1 FROM micro_live_pair_key_provisioning_attempts LIMIT 1"),
    ]);
    accountExists = account.rows.length > 0;
    if (micro.rows.length > 0) priorAttempt = "attempted";
    else if (attempt.rows[0]) {
      const state = attempt.rows[0].state;
      priorAttempt = state === "uncertain" || state === "response_received" || state === "attempted"
        ? state
        : "attempted";
    }
  } catch {
    return index2Closed("index2_preflight_unproven");
  }
  const local = index2Facts(confirmation, workerRunning, accountExists, priorAttempt, {
    provisioningCredentialValid: true,
    provisioningUnrestricted: true,
    provisioningScopesExact: true,
    verifierCredentialValid: true,
    existingIndex2Name: false,
  });
  if (!local.proceed) return index2Closed(local.reason);
  let remote;
  try {
    remote = await inspectStrataIndex2Credentials();
  } catch {
    return index2Closed("provisioning_credential_invalid");
  }
  const inspected = index2Facts(confirmation, workerRunning, accountExists, priorAttempt, remote);
  if (!inspected.proceed) return index2Closed(inspected.reason);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT state FROM strata_index2_key_attempt WHERE singleton_id = 'singleton' FOR UPDATE",
    );
    if (locked.rows.length > 0) {
      await client.query("ROLLBACK");
      return index2Closed("index2_generation_attempt_exists");
    }
    await client.query(`INSERT INTO strata_index2_key_attempt
      (singleton_id, key_name, subaccount, key_type, scopes, state)
      VALUES ('singleton', 'Strata INDEX2', 1, 'rsa', ARRAY['read', 'write::trade']::text[], 'attempted')`);
    await client.query("COMMIT");
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* the insert did not commit */ }
    return index2Closed("index2_attempt_not_durable");
  } finally {
    client.release();
  }

  try {
    const generated = await generateStrataIndex2Key();
    const apiKeyId = generated.id.toString("utf8");
    const privateKey = generated.pem.toString("utf8");
    generated.id.fill(0);
    generated.pem.fill(0);
    const saved = await pool.query(`UPDATE strata_index2_key_attempt
      SET state = 'response_received', api_key_id = $1, response_received_at = now()
      WHERE singleton_id = 'singleton' AND state = 'attempted' AND api_key_id IS NULL
      RETURNING singleton_id`, [apiKeyId]);
    if (saved.rowCount !== 1) {
      await pool.query(`UPDATE strata_index2_key_attempt
        SET state = 'uncertain'
        WHERE singleton_id = 'singleton' AND state = 'attempted'`);
      return {
        state: "uncertain",
        reason: "index2_generation_uncertain_no_retry",
        posts: 1,
        privateKeyPersisted: false,
        verified: false,
        workerStarted: false,
        environmentChanged: false,
      };
    }
    return {
      state: "generated",
      reason: "handed_off_once",
      apiKeyId,
      privateKey,
      posts: 1,
      privateKeyPersisted: false,
      verified: false,
      workerStarted: false,
      environmentChanged: false,
    };
  } catch {
    try {
      await pool.query(`UPDATE strata_index2_key_attempt
        SET state = 'uncertain'
        WHERE singleton_id = 'singleton' AND state = 'attempted'`);
    } catch { /* an attempted row still refuses a second POST */ }
    return {
      state: "uncertain",
      reason: "index2_generation_uncertain_no_retry",
      posts: 1,
      privateKeyPersisted: false,
      verified: false,
      workerStarted: false,
      environmentChanged: false,
    };
  }
}

function subaccountClosed(reason: string, posts = 0, returnedSubaccount: number | null = null): SubaccountCreateResult {
  return {
    state: "blocked",
    reason,
    posts,
    returnedSubaccount,
    workerStarted: false,
    environmentChanged: false,
    funded: false,
    commissioned: false,
  };
}

export async function readRailwaySubaccountStatus(): Promise<SubaccountStatus> {
  let attemptState: SubaccountAttemptState = "none";
  try {
    const attempt = await query(
      "SELECT state FROM strata_subaccount_creation_attempt WHERE singleton_id = 'singleton'",
    );
    const state = attempt.rows[0]?.state;
    if (state === "uncertain" || state === "attempted" || state === "response_received" || state === "rejected") {
      attemptState = state;
    } else if (attempt.rows[0]) {
      attemptState = "attempted";
    }
  } catch {
    return unprovenSubaccountStatus();
  }
  try {
    const evidence = await readProvisioningInventory();
    if (!evidence.complete || evidence.calls.some((call) => call.method !== "GET")) {
      return unprovenSubaccountStatus({
        provisioningAuthenticated: evidence.provisioningAuthenticated,
        diagnostics: evidence.diagnostics,
        credentialIdPresent: evidence.credentialIdPresent,
        privateKeyPresent: evidence.privateKeyPresent,
        privateKeyParsed: evidence.privateKeyParsed,
        privateKeyType: evidence.privateKeyType,
        signatureGenerated: evidence.signatureGenerated,
        fetchAttempted: evidence.fetchAttempted,
        localFailureStage: evidence.localFailureStage,
        localErrorName: evidence.localErrorName,
      });
    }
    return assembleSubaccountStatus({ ...evidence, attemptState });
  } catch {
    return unprovenSubaccountStatus();
  }
}

/** Commits one attempt, then allows one subaccount POST. No funding or orders. */
export async function createRailwaySubaccount(
  confirmation: unknown,
  workerRunning: boolean,
): Promise<SubaccountCreateResult> {
  let priorAttempt: SubaccountAttemptState = "none";
  let accountExists = false;
  try {
    const [attempt, account, micro] = await Promise.all([
      query("SELECT state FROM strata_subaccount_creation_attempt WHERE singleton_id = 'singleton'"),
      query("SELECT 1 FROM v13_production_account LIMIT 1"),
      query("SELECT 1 FROM micro_live_subaccount_creation_attempts LIMIT 1"),
    ]);
    accountExists = account.rows.length > 0;
    if (micro.rows.length > 0) priorAttempt = "attempted";
    else if (attempt.rows[0]) {
      const state = attempt.rows[0].state;
      priorAttempt = state === "uncertain" || state === "response_received" ||
        state === "rejected" || state === "attempted"
        ? state
        : "attempted";
    }
  } catch {
    return subaccountClosed("subaccount_preflight_unproven");
  }
  const present = Boolean(process.env.KALSHI_PROVISIONING_API_KEY_ID?.trim() &&
    process.env.KALSHI_PROVISIONING_PRIVATE_KEY?.trim());
  const local = subaccountCreationDecision({
    confirmation,
    status: unprovenSubaccountStatus(),
    inventoryProven: false,
    priorAttempt,
    workerRunning,
    productionAccountExists: accountExists,
    nodeEnv: process.env.NODE_ENV,
    kalshiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
    provisioningConfigured: present,
    liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
    v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
  });
  if (!local.proceed && local.reason !== "subaccount_inventory_unproven") return subaccountClosed(local.reason);
  let status: SubaccountStatus;
  try {
    const evidence = await readReviewedSubaccountEvidence();
    if (evidence.calls.some((call) => call.method !== "GET")) return subaccountClosed("subaccount_inventory_unproven");
    status = assembleSubaccountStatus({ ...evidence, attemptState: priorAttempt });
  } catch {
    return subaccountClosed("subaccount_inventory_unproven");
  }
  const decision = subaccountCreationDecision({
    confirmation,
    status,
    inventoryProven: true,
    priorAttempt,
    workerRunning,
    productionAccountExists: accountExists,
    nodeEnv: process.env.NODE_ENV,
    kalshiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
    provisioningConfigured: present,
    liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
    v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
  });
  if (!decision.proceed) return subaccountClosed(decision.reason);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT state FROM strata_subaccount_creation_attempt WHERE singleton_id = 'singleton' FOR UPDATE",
    );
    if (locked.rows.length > 0) {
      await client.query("ROLLBACK");
      return subaccountClosed("subaccount_creation_attempt_exists");
    }
    await client.query(`INSERT INTO strata_subaccount_creation_attempt
      (singleton_id, exchange_index, state)
      VALUES ('singleton', 2, 'attempted')`);
    await client.query("COMMIT");
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* the insert did not commit */ }
    return subaccountClosed("subaccount_attempt_not_durable");
  } finally {
    client.release();
  }

  try {
    const created = await createStrataSubaccount();
    if (created.outcome === "created") {
      const saved = await pool.query(`UPDATE strata_subaccount_creation_attempt
        SET state = 'response_received', returned_subaccount = 1, response_received_at = now()
        WHERE singleton_id = 'singleton' AND state = 'attempted' AND returned_subaccount IS NULL
        RETURNING singleton_id`);
      if (saved.rowCount !== 1) {
        await pool.query(`UPDATE strata_subaccount_creation_attempt
          SET state = 'uncertain' WHERE singleton_id = 'singleton' AND state = 'attempted'`);
        return {
          state: "uncertain", reason: "subaccount_creation_uncertain_no_retry", posts: 1,
          returnedSubaccount: null, workerStarted: false, environmentChanged: false,
          funded: false, commissioned: false,
        };
      }
      return {
        state: "created", reason: "subaccount_1_created", posts: 1, returnedSubaccount: 1,
        workerStarted: false, environmentChanged: false, funded: false, commissioned: false,
      };
    }
    if (created.outcome === "wrong_number") {
      await pool.query(`UPDATE strata_subaccount_creation_attempt
        SET state = 'rejected', returned_subaccount = $1, response_received_at = now()
        WHERE singleton_id = 'singleton' AND state = 'attempted'`, [created.subaccountNumber]);
      return subaccountClosed("returned_subaccount_not_1", 1, created.subaccountNumber);
    }
    await pool.query(`UPDATE strata_subaccount_creation_attempt
      SET state = 'uncertain' WHERE singleton_id = 'singleton' AND state = 'attempted'`);
    return {
      state: "uncertain", reason: "subaccount_creation_uncertain_no_retry", posts: 1,
      returnedSubaccount: null, workerStarted: false, environmentChanged: false,
      funded: false, commissioned: false,
    };
  } catch {
    try {
      await pool.query(`UPDATE strata_subaccount_creation_attempt
        SET state = 'uncertain' WHERE singleton_id = 'singleton' AND state = 'attempted'`);
    } catch { /* an attempted row still refuses a second POST */ }
    return {
      state: "uncertain", reason: "subaccount_creation_uncertain_no_retry", posts: 1,
      returnedSubaccount: null, workerStarted: false, environmentChanged: false,
      funded: false, commissioned: false,
    };
  }
}

/** Archives the old attempt in place, then allows one replacement POST. The private key is not written. */
export async function replaceRailwayIndex2Key(
  confirmation: unknown,
  workerRunning: boolean,
): Promise<Index2GenerationResult> {
  let priorAttempt: Index2AttemptState = "none";
  let accountExists = false;
  let replacementAlreadyUsed = false;
  try {
    const [attempt, account, replaced] = await Promise.all([
      query("SELECT state FROM strata_index2_key_attempt WHERE singleton_id = 'singleton'"),
      query("SELECT 1 FROM v13_production_account LIMIT 1"),
      query(`SELECT 1 FROM strata_index2_key_attempt
        WHERE supersession_reason = 'replaced_for_current_kalshi_account' LIMIT 1`),
    ]);
    accountExists = account.rows.length > 0;
    replacementAlreadyUsed = replaced.rows.length > 0;
    if (attempt.rows[0]) {
      const state = attempt.rows[0].state;
      priorAttempt = state === "uncertain" || state === "response_received" || state === "attempted"
        ? state
        : "attempted";
    }
  } catch {
    return index2Closed("index2_replacement_preflight_unproven");
  }
  const present = (name: string) => Boolean(process.env[name]?.trim());
  const base = {
    confirmation,
    nodeEnv: process.env.NODE_ENV,
    provisioningKeyIdPresent: present("KALSHI_PROVISIONING_API_KEY_ID"),
    provisioningPrivateKeyPresent: present("KALSHI_PROVISIONING_PRIVATE_KEY"),
    verifierKeyIdPresent: present("KALSHI_VERIFIER_API_KEY_ID"),
    verifierPrivateKeyPresent: present("KALSHI_VERIFIER_API_PRIVATE_KEY"),
    kalshiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
    priorAttempt,
    workerRunning,
    productionAccountExists: accountExists,
    liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
    v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
    replacementAlreadyUsed,
  };
  const local = index2ReplacementDecision({
    ...base,
    provisioningCredentialValid: true,
    provisioningUnrestricted: true,
    provisioningScopesExact: true,
    verifierCredentialValid: true,
    sameAccountProven: true,
    tierEligible: true,
    pairProven: true,
    existingIndex2Name: false,
  });
  if (!local.proceed) return index2Closed(local.reason);
  let remote;
  try {
    remote = await inspectStrataIndex2Replacement();
  } catch {
    return index2Closed("index2_replacement_preflight_unproven");
  }
  let pairProven = false;
  try {
    const evidence = await readProvisioningInventory();
    if (evidence.complete && evidence.calls.every((call) => call.method === "GET")) {
      const status = assembleSubaccountStatus({ ...evidence, attemptState: "none" });
      pairProven = status.readyForCleanBoundary &&
        status.subaccount1Exists &&
        status.subaccount1Exchange2Exists &&
        status.matchingRows === 1 &&
        status.exchangeIndexesForSubaccount1.includes(PRODUCTION_EXCHANGE_INDEX);
    }
  } catch {
    pairProven = false;
  }
  const inspected = index2ReplacementDecision({
    ...base,
    ...remote,
    pairProven,
  });
  if (!inspected.proceed) return index2Closed(inspected.reason);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT state FROM strata_index2_key_attempt
       WHERE singleton_id = 'singleton' FOR UPDATE`,
    );
    const state = locked.rows[0]?.state;
    if (state !== "uncertain" && state !== "response_received") {
      await client.query("ROLLBACK");
      return index2Closed(state === "attempted"
        ? "index2_generation_attempt_in_progress"
        : "index2_replacement_requires_historical_attempt");
    }
    const already = await client.query(
      `SELECT 1 FROM strata_index2_key_attempt
       WHERE supersession_reason = 'replaced_for_current_kalshi_account' LIMIT 1`,
    );
    if (already.rows.length > 0) {
      await client.query("ROLLBACK");
      return index2Closed(state === "uncertain"
        ? "index2_generation_uncertain_no_retry"
        : "index2_replacement_already_used");
    }
    const archived = await client.query(
      `UPDATE strata_index2_key_attempt
       SET singleton_id = $1,
           superseded_at = now(),
           supersession_reason = 'replaced_for_current_kalshi_account'
       WHERE singleton_id = 'singleton'
         AND state IN ('uncertain', 'response_received')
         AND superseded_at IS NULL
       RETURNING singleton_id`,
      [randomUUID()],
    );
    if (archived.rowCount !== 1) {
      await client.query("ROLLBACK");
      return index2Closed("index2_replacement_not_durable");
    }
    await client.query(`INSERT INTO strata_index2_key_attempt
      (singleton_id, key_name, subaccount, key_type, scopes, state)
      VALUES ('singleton', 'Strata INDEX2', 1, 'rsa', ARRAY['read', 'write::trade']::text[], 'attempted')`);
    await client.query("COMMIT");
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* the archive did not commit */ }
    return index2Closed("index2_replacement_not_durable");
  } finally {
    client.release();
  }

  try {
    const generated = await generateStrataIndex2Key();
    const apiKeyId = generated.id.toString("utf8");
    const privateKey = generated.pem.toString("utf8");
    generated.id.fill(0);
    generated.pem.fill(0);
    const saved = await pool.query(`UPDATE strata_index2_key_attempt
      SET state = 'response_received', api_key_id = $1, response_received_at = now()
      WHERE singleton_id = 'singleton' AND state = 'attempted' AND api_key_id IS NULL
      RETURNING singleton_id`, [apiKeyId]);
    if (saved.rowCount !== 1) {
      await pool.query(`UPDATE strata_index2_key_attempt
        SET state = 'uncertain'
        WHERE singleton_id = 'singleton' AND state = 'attempted'`);
      return {
        state: "uncertain",
        reason: "index2_generation_uncertain_no_retry",
        posts: 1,
        privateKeyPersisted: false,
        verified: false,
        workerStarted: false,
        environmentChanged: false,
      };
    }
    return {
      state: "generated",
      reason: "handed_off_once",
      apiKeyId,
      privateKey,
      posts: 1,
      privateKeyPersisted: false,
      verified: false,
      workerStarted: false,
      environmentChanged: false,
    };
  } catch {
    try {
      await pool.query(`UPDATE strata_index2_key_attempt
        SET state = 'uncertain'
        WHERE singleton_id = 'singleton' AND state = 'attempted'`);
    } catch { /* an attempted row still refuses a second POST */ }
    return {
      state: "uncertain",
      reason: "index2_generation_uncertain_no_retry",
      posts: 1,
      privateKeyPersisted: false,
      verified: false,
      workerStarted: false,
      environmentChanged: false,
    };
  }
}

export function createDatabaseCommissioningPort(
  workerRunning: () => boolean = () => false,
): CommissioningPort {
  return {
    read: () => readCommissioningSnapshot(workerRunning()),
    readSubaccountStatus: () => readRailwaySubaccountStatus(),
    createSubaccount: (confirmation) => createRailwaySubaccount(confirmation, workerRunning()),
    generateIndex2Key: (confirmation) => generateRailwayIndex2Key(confirmation, workerRunning()),
    replaceIndex2Key: (confirmation) => replaceRailwayIndex2Key(confirmation, workerRunning()),
    async verifySigner() {
      const probe = await probeDedicatedSigner();
      const snapshot = await readCommissioningSnapshot(workerRunning(), {
        signedGetSucceeded: probe.signedGetSucceeded,
        restrictedToPair: probe.signedGetSucceeded,
      });
      return { snapshot, calls: probe.calls };
    },
    verifyBoundary: () => readCommissioningSnapshot(workerRunning()),
    captureBoundary: () => captureRailwayBoundary(workerRunning),
    acknowledgePreBoundaryRoundTrip: (confirmation, actor) => acknowledgePreBoundaryRoundTrip(confirmation, actor),
    reconcileFunding: () => reconcileRailwayFunding(workerRunning),
    fund: (confirmation) => fundRailwayPair(confirmation, workerRunning),
    async verifyFee() {
      const established = await establishOfficialFeeDigest();
      if (established.ok) {
        await query(`INSERT INTO v13_commissioning_evidence
          (singleton_id, fee_artifact_digest, fee_artifact_verified, updated_at)
          VALUES ('singleton', $1, true, now())
          ON CONFLICT (singleton_id) DO UPDATE
          SET fee_artifact_digest = EXCLUDED.fee_artifact_digest,
              fee_artifact_verified = true, updated_at = now()`, [established.digest]);
        return {
          snapshot: await readCommissioningSnapshot(workerRunning()),
          feeVerification: {
            ok: true as const,
            reason: null,
            digestStored: true as const,
            httpStatus: established.diagnostic.httpStatus,
            contentType: established.diagnostic.contentType,
            finalOrigin: established.diagnostic.finalOrigin,
            finalPathname: established.diagnostic.finalPathname,
            retryAfterSeconds: established.diagnostic.retryAfterSeconds,
            networkAttempts: established.diagnostic.networkAttempts,
          },
        };
      }
      return {
        snapshot: await readCommissioningSnapshot(workerRunning()),
        feeVerification: {
          ok: false as const,
          reason: publicFeeVerificationReason(established.reason),
          digestStored: false as const,
          httpStatus: established.diagnostic.httpStatus,
          contentType: established.diagnostic.contentType,
          finalOrigin: established.diagnostic.finalOrigin,
          finalPathname: established.diagnostic.finalPathname,
          retryAfterSeconds: established.diagnostic.retryAfterSeconds,
          networkAttempts: established.diagnostic.networkAttempts,
        },
      };
    },
    async verifyFeeUpload(bytes: Buffer) {
      const verified = await verifyOfficialFeePdfBytes(bytes);
      if (!verified.ok) {
        const reason = verified.reason === "too_large"
          ? "uploaded_fee_pdf_too_large"
          : verified.reason === "formula_unverifiable"
            ? "uploaded_fee_pdf_formula_unverifiable"
            : verified.reason === "unreviewed_schedule"
              ? "uploaded_fee_pdf_unreviewed_schedule"
              : "uploaded_fee_pdf_invalid";
        return {
          feeVerification: {
            ok: false as const,
            reason: publicFeeVerificationReason(reason),
            digestStored: false as const,
            sourceMode: null,
            effectiveDate: null,
            formulaVersion: null,
          },
        };
      }
      await query(`INSERT INTO v13_commissioning_evidence
        (singleton_id, fee_artifact_digest, fee_artifact_verified, updated_at)
        VALUES ('singleton', $1, true, now())
        ON CONFLICT (singleton_id) DO UPDATE
        SET fee_artifact_digest = EXCLUDED.fee_artifact_digest,
            fee_artifact_verified = true, updated_at = now()`, [verified.digest]);
      return {
        feeVerification: {
          ok: true as const,
          reason: null,
          digestStored: true as const,
          sourceMode: "operator_uploaded_reviewed_official_pdf" as const,
          effectiveDate: verified.effectiveDate,
          formulaVersion: verified.formulaVersion,
        },
      };
    },
    async verifyCash() {
      const evidence = await readPrimaryIndex2Balance(PRODUCTION_SUBACCOUNT);
      const exact = /^[0-9]+$/.test(evidence.scopedMicros) &&
        evidence.scopedMicros === evidence.inventoryMicros;
      if (exact) {
        await query(`INSERT INTO v13_commissioning_evidence
          (singleton_id, cash_precision_verified, cash_micros, cash_source, updated_at)
          VALUES ('singleton', true, $1, 'authenticated_kalshi_micros', now())
          ON CONFLICT (singleton_id) DO UPDATE
          SET cash_precision_verified = true, cash_micros = EXCLUDED.cash_micros,
              cash_source = 'authenticated_kalshi_micros', updated_at = now()`,
        [evidence.scopedMicros]);
      }
      return readCommissioningSnapshot(workerRunning());
    },
    async readPolicy() {
      const [drafts, approved] = await Promise.all([
        query(`SELECT capital_limit_cents, max_entry_stake_cents, max_entry_all_in_cents,
          max_daily_loss_cents, max_total_loss_cents, max_quote_age_ms, max_fee_evidence_age_ms
          FROM v13_live_money_policy WHERE state = 'DRAFT' ORDER BY version DESC LIMIT 1`),
        query("SELECT 1 FROM v13_live_money_policy WHERE state = 'APPROVED' LIMIT 2"),
      ]);
      return policyReadFromRows({
        draft: drafts.rows[0] ?? null,
        approvedCount: approved.rows.length,
      });
    },
    async proposePolicy(body, actor) {
      const parsed = body && typeof body === "object" && !Array.isArray(body) ? body as Partial<PolicyLimits> : null;
      const decision = validatePolicyLimits(parsed);
      if (!decision.ok || !parsed) return { status: "BLOCKED", reason: decision.errors.join(",") };
      const limits = parsed as PolicyLimits;
      const versionRows = await query("SELECT COALESCE(MAX(version), 0)::int AS version FROM v13_live_money_policy");
      const version = Number(versionRows.rows[0]?.version ?? 0) + 1;
      await query(`INSERT INTO v13_live_money_policy (
        id, version, state, strategy_version, strategy_parameter_set_id, strategy_parameter_hash,
        capital_limit_cents, max_entry_stake_cents, max_entry_all_in_cents, max_open_positions,
        max_daily_loss_cents, max_total_loss_cents, max_quote_age_ms, max_fee_evidence_age_ms,
        require_full_depth, entry_time_in_force, entry_limit_source, created_by)
        VALUES ($1,$2,'DRAFT','V1.3',$3,$4,$5,$6,$7,1,$8,$9,$10,$11,true,'IOC','SIGNAL_REFERENCE_OFFER',$12)`, [
        `v13-live-money-${version}`, version, V13_CHAMPION_PARAMETER_SET.id, V13_CHAMPION_PARAMETER_HASH,
        limits.capitalLimitCents, limits.maxEntryStakeCents, limits.maxEntryAllInCents,
        limits.maxDailyLossCents, limits.maxTotalLossCents, limits.maxQuoteAgeMs,
        limits.maxFeeEvidenceAgeMs, actor,
      ]);
      return { status: "PROPOSED", reason: "operator_limits_stored_as_draft" };
    },
    async approvePolicy(actor) {
      const snapshot = await readCommissioningSnapshot(workerRunning());
      if (!snapshot.fee.verified || !snapshot.fee.digest) {
        return { status: "BLOCKED", reason: "fee_artifact_unverified" };
      }
      const drafts = await query("SELECT * FROM v13_live_money_policy WHERE state = 'DRAFT' ORDER BY version DESC LIMIT 1");
      const draft = drafts.rows[0];
      if (!draft) return { status: "BLOCKED", reason: "policy_draft_missing" };
      const now = new Date();
      const policy = policyFromRow({
        ...draft,
        state: "APPROVED",
        champion_selection_review_id: REVIEWED_RELEASE.commit,
        champion_selection_evidence_hash: V13_CHAMPION_PARAMETER_HASH,
        champion_selected_by: actor,
        champion_selected_at: now.toISOString(),
        fee_policy_version: STANDING_FEE_POLICY_VERSION,
        fee_source_url: CANONICAL_FEE_SCHEDULE_URL,
        fee_formula_version: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
        approved_by: actor,
        approved_at: now.toISOString(),
        strategy_version: "V1.3",
        strategy_parameter_set_id: V13_CHAMPION_PARAMETER_SET.id,
        strategy_parameter_hash: V13_CHAMPION_PARAMETER_HASH,
      });
      policy.policyHash = null;
      const policyHash = computeV13LiveMoneyPolicyHash(policy);
      await query(`UPDATE v13_live_money_policy SET
        state = 'APPROVED', strategy_version = 'V1.3',
        strategy_parameter_set_id = $2, strategy_parameter_hash = $3,
        champion_selection_review_id = $4, champion_selection_evidence_hash = $3,
        champion_selected_by = $5, champion_selected_at = $6,
        fee_policy_version = $7, fee_source_url = $8, fee_formula_version = $9,
        approved_by = $5, approved_at = $6, policy_hash = $10
        WHERE id = $1 AND state = 'DRAFT'`, [
        policy.id, V13_CHAMPION_PARAMETER_SET.id, V13_CHAMPION_PARAMETER_HASH,
        REVIEWED_RELEASE.commit, actor, now.toISOString(),
        STANDING_FEE_POLICY_VERSION, CANONICAL_FEE_SCHEDULE_URL,
        STANDARD_QUADRATIC_FEE_FORMULA_VERSION, policyHash,
      ]);
      return { status: "APPROVED", reason: "policy_hash_recomputed", policyHash };
    },
    async approveMinimumExit(micros, confirmation, actor) {
      if (confirmation !== EXIT_FLOOR_CONFIRMATION) {
        return { status: "BLOCKED", reason: "explicit_exit_floor_confirmation_required" };
      }
      if (!approvedExitFloor(typeof micros === "number" ? micros : null)) {
        return { status: "BLOCKED", reason: "minimum_exit_micros_outside_reviewed_range" };
      }
      await query(`INSERT INTO v13_commissioning_evidence (
        singleton_id, minimum_exit_micros, minimum_exit_source, minimum_exit_approved_by,
        minimum_exit_approved_at, updated_at)
        VALUES ('singleton', $1, 'operator_approved', $2, now(), now())
        ON CONFLICT (singleton_id) DO UPDATE SET
          minimum_exit_micros = EXCLUDED.minimum_exit_micros,
          minimum_exit_source = 'operator_approved',
          minimum_exit_approved_by = EXCLUDED.minimum_exit_approved_by,
          minimum_exit_approved_at = now(), updated_at = now()`, [micros, actor]);
      return { status: "APPROVED", reason: "operator_approved" };
    },
    async arm(confirmation) {
      const snapshot = await readCommissioningSnapshot(workerRunning());
      const decision = planArm(snapshot, confirmation);
      if (!decision.ok) {
        return { status: "BLOCKED", reason: decision.reason, workerStarted: false, environmentChanged: false };
      }
      await query(`UPDATE v13_production_account
        SET execution_enabled = true, kill_switch = false
        WHERE subaccount = 1 AND exchange_index = 2 AND commissioned = true
          AND execution_enabled = false AND kill_switch = true`);
      return { status: "ARMED", reason: decision.reason, workerStarted: false, environmentChanged: false };
    },
    async disarm(confirmation) {
      const snapshot = await readCommissioningSnapshot(workerRunning());
      const decision = planDisarm(snapshot, confirmation);
      if (!decision.ok) {
        return { status: "BLOCKED", reason: decision.reason, emergencyStop: false };
      }
      await query(`UPDATE v13_production_account
        SET execution_enabled = false, kill_switch = true
        WHERE subaccount = 1 AND exchange_index = 2 AND commissioned = true`);
      return { status: "DISARMED", reason: decision.reason, emergencyStop: false };
    },
    async commission(confirmation) {
      if (confirmation !== "COMMISSION_WITHOUT_EXECUTION") {
        return {
          status: "BLOCKED", blockers: ["explicit_commission_confirmation_required"],
          executionEnabled: null, killSwitch: null, commissioned: null,
          workerStarted: false, environmentChanged: false, accountCount: 0,
        };
      }
      const snapshot = await readCommissioningSnapshot(workerRunning());
      const planned = planCommission(snapshot);
      if (!planned.plan) {
        return {
          status: snapshot.account.commissioned ? "ALREADY_COMMISSIONED" : "BLOCKED",
          blockers: planned.blockers,
          executionEnabled: snapshot.account.executionEnabled === true ? null : snapshot.account.executionEnabled === false ? false : null,
          killSwitch: snapshot.account.killSwitch === true ? true : null,
          commissioned: snapshot.account.commissioned,
          workerStarted: false,
          environmentChanged: false,
          accountCount: snapshot.account.count,
        };
      }
      if (snapshot.account.commissioned === true) {
        return {
          status: "ALREADY_COMMISSIONED", blockers: planned.blockers,
          executionEnabled: false, killSwitch: true, commissioned: true,
          workerStarted: false, environmentChanged: false, accountCount: snapshot.account.count,
        };
      }
      const plan = planned.plan;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          "SELECT id, commissioned FROM v13_production_account WHERE subaccount = 1 AND exchange_index = 2 FOR UPDATE",
        );
        if (existing.rows.length > 1) {
          await client.query("ROLLBACK");
          return {
            status: "BLOCKED", blockers: ["production_account_ambiguous"],
            executionEnabled: null, killSwitch: null, commissioned: null,
            workerStarted: false, environmentChanged: false, accountCount: existing.rows.length,
          };
        }
        if (existing.rows.length === 1) {
          await client.query("ROLLBACK");
          return {
            status: existing.rows[0].commissioned === true ? "ALREADY_COMMISSIONED" : "BLOCKED",
            blockers: existing.rows[0].commissioned === true
              ? planned.blockers
              : ["production_account_exists_before_commission"],
            executionEnabled: false, killSwitch: true,
            commissioned: existing.rows[0].commissioned === true,
            workerStarted: false, environmentChanged: false, accountCount: 1,
          };
        }
        if (existing.rows.length === 0) {
          await client.query(`INSERT INTO v13_production_account(
            id, policy_id, subaccount, exchange_index, key_fingerprint, commissioning_digest,
            minimum_exit_micros, fee_artifact_digest, cash_precision_verified, commissioned,
            kill_switch, execution_enabled, cash_micros, initial_cash_micros)
            VALUES ($1,$2,1,2,$3,$4,$5,$6,true,true,true,false,$7,$7)`, [
            plan.id, plan.policyId, plan.keyFingerprint, plan.commissioningDigest,
            plan.minimumExitMicros, plan.feeArtifactDigest, plan.cashMicros,
          ]);
        }
        await client.query("COMMIT");
        return {
          status: "COMMISSIONED", blockers: planned.blockers,
          executionEnabled: false, killSwitch: true, commissioned: true,
          workerStarted: false, environmentChanged: false, accountCount: 1,
        };
      } catch {
        await client.query("ROLLBACK");
        return {
          status: "BLOCKED", blockers: ["commission_write_refused"],
          executionEnabled: null, killSwitch: null, commissioned: null,
          workerStarted: false, environmentChanged: false, accountCount: snapshot.account.count,
        };
      } finally {
        client.release();
      }
    },
  };
}
