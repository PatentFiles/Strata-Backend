import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET, V13_ENTRY_POLICY_VERSION, V13_LEGACY_ENTRY_POLICY } from "@workspace/v13-strategy";
import { computeV13LiveMoneyPolicyHash, V13_MAX_ENTRY_STAKE_CENTS } from "../lib/v13LiveMoneyRisk";
import {
  approvedPolicyFromDraft,
  policyApprovalEntryBlock,
  policyFromRow,
} from "../lib/strata/commissioningStore";
import { ENTRY_POLICY_REVIEW_BLOCKER } from "../lib/strata/configuredStake";
import {
  ARM_ACCOUNT_SQL,
  ARM_MASTER_SQL,
  DISARM_ACCOUNT_SQL,
  DISARM_MASTER_SQL,
  armProductionAuthority,
  disarmProductionAuthority,
  masterExecutionAllowed,
} from "../lib/strata/v13MasterGate";
import {
  type Index2ReplacementFacts,
  ARM_CONFIRMATION,
  DISARM_CONFIRMATION,
  EXIT_FLOOR_CONFIRMATION,
  FUNDING_CONFIRMATION,
  approvedExitFloor,
  dedicatedSignerFingerprint,
  applyDurableDedicatedSigner,
  assembleSubaccountStatus,
  cleanPairInventoryDiagnosis,
  commissioningBlockers,
  commissioningStatus,
  emptySnapshot,
  fundingAuthorizationDecision,
  publicFeeVerificationReason,
  fundingCashProvesExact25,
  selectCurrentFundingTransfer,
  index2GenerationDecision,
  index2ReplacementDecision,
  STRATA_INDEX2_REPLACEMENT_CONFIRMATION,
  deriveKalshiConnectionStatus,
  planArm,
  SUBACCOUNT_CREATE_CONFIRMATION,
  subaccountCreationDecision,
  summarizeSubaccountInventory,
  unprovenSubaccountStatus,
  STRATA_INDEX2_KEY_CONFIRMATION,
  STRATA_INDEX2_KEY_NAME,
  type Index2GenerationFacts,
  type SubaccountIdentity,
  planCommission,
  planDisarm,
  PRE_BOUNDARY_INBOUND_TRANSFER_ID,
  PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
  PRE_BOUNDARY_ROUND_TRIP_CENTS,
  REVIEWED_FUNDING_CENTS,
  REVIEWED_FUNDING_MICROS,
  blockingSubaccountTransferDetail,
  policyReadFromRows,
  provePreBoundaryRoundTrip,
  selectBlockingCleanReasons,
  validatePolicyLimits,
  type AccountPlan,
  type CommissioningSnapshot,
  type PolicyLimits,
} from "../lib/strata/commissioning";
import { verifySupabaseAccessToken } from "../lib/strata/supabaseAuth";
import { scopedPairBalanceProven } from "../lib/kalshiSubaccountInventory";
import { readProvisioningInventory, readReviewedSubaccountEvidence } from "../lib/microLiveSubaccountCreation";
import { sanitizePublic } from "../lib/v13-production/sanitize";
import { createStrataRouter } from "./strataRouter";
import type { CommissioningPort, ExchangeCall } from "./strataCommissioning";

const SUPABASE_URL = "https://project.supabase.co";
const DEVELOPER_ID = "11111111-1111-4111-8111-111111111111";
const STANDARD_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const FLAG_NAMES = [
  "LIVE_EXECUTION_ENABLED", "V13_PRODUCTION_EXECUTION_ENABLED", "KALSHI_API_ENVIRONMENT",
  "MICRO_LIVE_ACCOUNT_MODE", "KALSHI_BOT_SUBACCOUNT", "KALSHI_INDEX2_API_KEY_ID",
  "KALSHI_INDEX2_PRIVATE_KEY", "NODE_ENV",
] as const;

function ready(): CommissioningSnapshot {
  const snapshot = emptySnapshot("2026-10-10T00:00:00.000Z");
  snapshot.signer = {
    configured: true, syntacticallyUsable: true, fingerprint: "a".repeat(64),
    signedGetSucceeded: true, restrictedToPair: true, historyComplete: true,
    keyIdMasked: "****abcd",
  };
  snapshot.boundary = {
    exists: true, subaccount: 1, exchangeIndex: 2, state: "funded",
    cleanZero: true, verified: true, fingerprintMatches: true, historyComplete: true,
    ambiguous: false,
  };
  snapshot.funding = {
    anchorExists: true, amountCents: 2500, balanceMicros: "25000000",
    verified: true, uncertain: false,
  };
  snapshot.fee = { digest: "b".repeat(64), verified: true, cashPrecisionVerified: true };
  snapshot.cash = { precisionVerified: true, micros: "25000000", source: "authenticated_kalshi_micros" };
  snapshot.minimumExit = { approved: true, micros: 400000, source: "operator_approved" };
  snapshot.policy = {
    exists: true, id: "policy-1", approved: true,
    strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
    entryPolicyVersion: null,
    hashMatches: true, missingFields: [],
  };
  snapshot.approvedMinimumExitMicros = 400000;
  snapshot.master = {
    count: 1, mode: "SHADOW_LIVE", liveExecutionEnabled: false, manualKillSwitch: true,
  };
  return snapshot;
}

function memoryPort(initial: CommissioningSnapshot) {
  let snapshot = structuredClone(initial);
  const accounts: AccountPlan[] = [];
  const calls: ExchangeCall[] = [];
  let workerStarts = 0;
  let emergencyStops = 0;
  let posts = 0;
  let attemptState: "none" | "attempted" | "uncertain" | "reconciled" = "none";
  let index2Attempt: "none" | "attempted" | "uncertain" | "response_received" = "none";
  let index2Posts = 0;
  let index2Overlay: Partial<Index2GenerationFacts> = {};
  let index2Outcome: "generated" | "uncertain" = "generated";
  let index2ReplacementUsed = false;
  const index2Archive: Array<{ state: string; apiKeyId?: string }> = [];
  let index2ReplacementOverlay: Partial<Index2ReplacementFacts> = {};
  const index2Payloads: unknown[] = [];
  const index2Stored: Array<Record<string, unknown>> = [];
  const index2Pem = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----";
  let subaccountIdentities: SubaccountIdentity[] = [
    { subaccount: 0, exchangeIndex: 0 },
    { subaccount: 0, exchangeIndex: 2 },
  ];
  let subaccountAttempt: "none" | "attempted" | "uncertain" | "response_received" | "rejected" = "none";
  let subaccountPosts = 0;
  let subaccountOutcome: "created" | "uncertain" | "wrong_number" = "created";
  const subaccountPayloads: unknown[] = [];
  let reviewedFeeAccepted = false;
  let feeUploadCalls = 0;
  let feeUploadBytes = 0;
  let reviewedCashMicros: string | null = null;
  let draft: PolicyLimits | null = null;
  const envBefore = () => Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]));
  const port: CommissioningPort = {
    read: async () => structuredClone(snapshot),
    generateIndex2Key: async (confirmation) => {
      const decision = index2GenerationDecision({
        nodeEnv: "production",
        provisioningKeyIdPresent: true,
        provisioningPrivateKeyPresent: true,
        verifierKeyIdPresent: true,
        verifierPrivateKeyPresent: true,
        kalshiEnvironment: "production",
        provisioningCredentialValid: true,
        provisioningUnrestricted: true,
        provisioningScopesExact: true,
        verifierCredentialValid: true,
        existingIndex2Name: false,
        workerRunning: snapshot.workerRunning,
        productionAccountExists: snapshot.account.count > 0,
        liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
        v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
        ...index2Overlay,
        confirmation,
        priorAttempt: index2Attempt === "none" ? (index2Overlay.priorAttempt ?? "none") : index2Attempt,
      });
      if (!decision.proceed) {
        return {
          state: "blocked", reason: decision.reason, posts: index2Posts,
          privateKeyPersisted: false, verified: false, workerStarted: false, environmentChanged: false,
        };
      }
      index2Attempt = "attempted";
      index2Posts += 1;
      index2Payloads.push({
        name: STRATA_INDEX2_KEY_NAME, key_type: "rsa", subaccount: 1, scopes: ["read", "write::trade"],
      });
      calls.push({ method: "POST", path: "/trade-api/v2/api_keys/generate" });
      if (index2Outcome === "uncertain") {
        index2Attempt = "uncertain";
        return {
          state: "uncertain", reason: "index2_generation_uncertain_no_retry", posts: index2Posts,
          privateKeyPersisted: false, verified: false, workerStarted: false, environmentChanged: false,
        };
      }
      index2Attempt = "response_received";
      index2Stored.push({ apiKeyId: "strata-index2-test-key", state: "response_received" });
      return {
        state: "generated", reason: "handed_off_once", apiKeyId: "strata-index2-test-key",
        privateKey: index2Pem, posts: index2Posts, privateKeyPersisted: false, verified: false,
        workerStarted: false, environmentChanged: false,
      };
    },
    replaceIndex2Key: async (confirmation) => {
      const priorAttempt = index2Attempt === "none" ? (index2ReplacementOverlay.priorAttempt ?? "uncertain") : index2Attempt;
      const decision = index2ReplacementDecision({
        nodeEnv: "production",
        provisioningKeyIdPresent: true,
        provisioningPrivateKeyPresent: true,
        verifierKeyIdPresent: true,
        verifierPrivateKeyPresent: true,
        kalshiEnvironment: "production",
        provisioningCredentialValid: true,
        provisioningUnrestricted: true,
        provisioningScopesExact: true,
        verifierCredentialValid: true,
        sameAccountProven: true,
        tierEligible: true,
        pairProven: true,
        existingIndex2Name: false,
        replacementAlreadyUsed: index2ReplacementUsed,
        workerRunning: snapshot.workerRunning,
        productionAccountExists: snapshot.account.count > 0,
        liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
        v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
        ...index2ReplacementOverlay,
        confirmation,
        priorAttempt,
      });
      if (!decision.proceed) {
        return {
          state: "blocked", reason: decision.reason, posts: index2Posts,
          privateKeyPersisted: false, verified: false, workerStarted: false, environmentChanged: false,
        };
      }
      index2Archive.push({
        state: priorAttempt,
        apiKeyId: index2Stored.find((row) => row.state === "response_received")?.apiKeyId as string | undefined,
      });
      index2ReplacementUsed = true;
      index2Attempt = "attempted";
      index2Posts += 1;
      index2Payloads.push({
        name: STRATA_INDEX2_KEY_NAME, key_type: "rsa", subaccount: 1, scopes: ["read", "write::trade"],
      });
      calls.push({ method: "POST", path: "/trade-api/v2/api_keys/generate" });
      if (index2Outcome === "uncertain") {
        index2Attempt = "uncertain";
        return {
          state: "uncertain", reason: "index2_generation_uncertain_no_retry", posts: index2Posts,
          privateKeyPersisted: false, verified: false, workerStarted: false, environmentChanged: false,
        };
      }
      index2Attempt = "response_received";
      index2Stored.push({ apiKeyId: "strata-index2-replacement-key", state: "response_received" });
      return {
        state: "generated", reason: "handed_off_once", apiKeyId: "strata-index2-replacement-key",
        privateKey: index2Pem, posts: index2Posts, privateKeyPersisted: false, verified: false,
        workerStarted: false, environmentChanged: false,
      };
    },
    verifySigner: async () => ({ snapshot: structuredClone(snapshot), calls: [...calls] }),
    verifyBoundary: async () => structuredClone(snapshot),
    captureBoundary: async () => {
      calls.push({ method: "GET", path: "/trade-api/v2/portfolio/positions" });
      if (!snapshot.boundary.cleanZero || snapshot.boundary.historyComplete !== true) {
        return { snapshot: structuredClone(snapshot), calls: [...calls], blocked: true, reason: "clean_boundary_not_proven" };
      }
      snapshot.boundary.exists = true;
      snapshot.boundary.verified = true;
      return { snapshot: structuredClone(snapshot), calls: [...calls], blocked: false, reason: "clean_boundary_captured" };
    },
    reconcileFunding: async () => ({
      state: snapshot.funding.uncertain ? "uncertain" : snapshot.funding.verified ? "funded" : "blocked",
      reason: snapshot.funding.uncertain ? "funding_uncertain_no_retry" : "get_only",
      transferAttempted: false,
    }),
    fund: async (confirmation) => {
      const decision = fundingAuthorizationDecision({
        confirmation,
        liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
        v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
        attemptState,
      });
      if (!decision.proceed) {
        return { state: "blocked", reason: decision.reason, transferAttempted: false, attempts: posts };
      }
      if (!snapshot.boundary.cleanZero || !snapshot.boundary.historyComplete) {
        return { state: "blocked", reason: "fresh_preflight_failed", transferAttempted: false, attempts: posts };
      }
      posts += 1;
      attemptState = "uncertain";
      return { state: "uncertain", reason: "funding_uncertain_no_retry", transferAttempted: true, attempts: posts };
    },
    verifyFee: async () => {
      if (!reviewedFeeAccepted) {
        return {
          snapshot: structuredClone(snapshot),
          feeVerification: {
            ok: false as const,
            reason: "official_fee_schedule_not_verified",
            digestStored: false as const,
            httpStatus: null,
            contentType: null,
            finalOrigin: null,
            finalPathname: null,
            retryAfterSeconds: null,
            networkAttempts: 0,
          },
        };
      }
      snapshot.fee = { ...snapshot.fee, digest: "c".repeat(64), verified: true };
      return {
        snapshot: structuredClone(snapshot),
        feeVerification: {
          ok: true as const,
          reason: null,
          digestStored: true as const,
          httpStatus: 200,
          contentType: "application/pdf",
          finalOrigin: "https://kalshi.com",
          finalPathname: "/docs/kalshi-fee-schedule.pdf",
          retryAfterSeconds: null,
          networkAttempts: 1,
        },
      };
    },
    verifyFeeUpload: async (bytes) => {
      feeUploadCalls += 1;
      feeUploadBytes = Buffer.isBuffer(bytes) ? bytes.length : -1;
      if (!reviewedFeeAccepted || !Buffer.isBuffer(bytes)) {
        return {
          feeVerification: {
            ok: false as const,
            reason: "uploaded_fee_pdf_invalid",
            digestStored: false as const,
            sourceMode: null,
            effectiveDate: null,
            formulaVersion: null,
          },
        };
      }
      return {
        feeVerification: {
          ok: true as const,
          reason: null,
          digestStored: true as const,
          sourceMode: "operator_uploaded_reviewed_official_pdf" as const,
          effectiveDate: "2026-07-07",
          formulaVersion: "standard-quadratic-0.07-v1",
        },
      };
    },
    verifyCash: async () => {
      if (reviewedCashMicros === null || !/^[0-9]+$/.test(reviewedCashMicros)) return structuredClone(snapshot);
      snapshot.cash = { precisionVerified: true, micros: reviewedCashMicros, source: "authenticated_kalshi_micros" };
      return structuredClone(snapshot);
    },
    readPolicy: async () => ({ draft, approved: snapshot.policy.approved }),
    proposePolicy: async (body) => {
      const decision = validatePolicyLimits(body as Partial<PolicyLimits> | null);
      if (!decision.ok) return { status: "BLOCKED", reason: decision.errors.join(",") };
      draft = { ...(body as PolicyLimits) };
      return { status: "PROPOSED", reason: "operator_limits_stored_as_draft" };
    },
    approvePolicy: async (actor) => {
      if (!draft || !snapshot.fee.verified) return { status: "BLOCKED", reason: "policy_not_ready" };
      const entryBlock = policyApprovalEntryBlock();
      if (entryBlock) return { status: "BLOCKED", reason: entryBlock };
      const now = new Date("2026-10-10T00:00:00.000Z");
      const policyHash = computeV13LiveMoneyPolicyHash({
        id: "policy-1", version: 1, supersedesPolicyId: null, state: "APPROVED",
        strategyVersion: "V1.3",
        strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
        strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
        entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
        championSelectionReviewId: "03376f2cc125ed649858f19d9aa910e9ff9a57c8",
        championSelectionEvidenceHash: V13_CHAMPION_PARAMETER_HASH,
        championSelectedBy: actor, championSelectedAt: now,
        ...draft, maxOpenPositions: 1,
        feePolicyVersion: "micro-live-standing-fee-policy-v1",
        feeSourceUrl: "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
        feeFormulaVersion: "standard-quadratic-0.07-v1",
        requireFullDepth: true, entryTimeInForce: "IOC", entryLimitSource: "SIGNAL_REFERENCE_OFFER",
        policyHash: null, createdBy: actor, approvedBy: actor, approvedAt: now,
      });
      snapshot.policy = {
        exists: true, id: "policy-1", approved: true,
        strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
        strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
        entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
        hashMatches: true, missingFields: [],
      };
      return { status: "APPROVED", reason: "policy_hash_recomputed", policyHash };
    },
    approveMinimumExit: async (micros, confirmation) => {
      const floor = typeof micros === "number" ? micros : null;
      if (confirmation !== EXIT_FLOOR_CONFIRMATION || !approvedExitFloor(floor)) {
        return { status: "BLOCKED", reason: "minimum_exit_not_approved" };
      }
      snapshot.minimumExit = { approved: true, micros: floor, source: "operator_approved" };
      snapshot.approvedMinimumExitMicros = floor;
      return { status: "APPROVED", reason: "operator_approved" };
    },
    commission: async (confirmation) => {
      if (snapshot.account.commissioned === true) {
        return {
          status: "ALREADY_COMMISSIONED", blockers: [], executionEnabled: false, killSwitch: true,
          commissioned: true, workerStarted: false, environmentChanged: false, accountCount: accounts.length,
        };
      }
      if (confirmation !== "COMMISSION_WITHOUT_EXECUTION") {
        return {
          status: "BLOCKED", blockers: ["explicit_commission_confirmation_required"],
          executionEnabled: null, killSwitch: null, commissioned: null,
          workerStarted: false, environmentChanged: false, accountCount: accounts.length,
        };
      }
      const planned = planCommission(snapshot);
      if (!planned.plan) {
        return {
          status: "BLOCKED", blockers: planned.blockers, executionEnabled: false,
          killSwitch: true, commissioned: snapshot.account.commissioned,
          workerStarted: false, environmentChanged: false, accountCount: accounts.length,
        };
      }
      if (accounts.length === 0) accounts.push(planned.plan);
      snapshot = {
        ...snapshot,
        account: {
          count: 1, id: accounts[0]!.id, subaccount: 1, exchangeIndex: 2,
          fingerprint: accounts[0]!.keyFingerprint, commissioned: true,
          executionEnabled: false, killSwitch: true,
        },
      };
      return {
        status: accounts.length === 1 ? "COMMISSIONED" : "BLOCKED",
        blockers: planned.blockers, executionEnabled: false, killSwitch: true,
        commissioned: true, workerStarted: false, environmentChanged: false,
        accountCount: accounts.length,
      };
    },
    readSubaccountStatus: async () => {
      for (const path of [
        "/trade-api/v2/account/limits",
        "/trade-api/v2/portfolio/subaccounts/netting",
        "/trade-api/v2/portfolio/subaccounts/balances",
        "/trade-api/v2/portfolio/balance?subaccount=1&exchange_index=2",
      ]) calls.push({ method: "GET", path });
      const row = (identity: SubaccountIdentity) => ({
        subaccount_number: identity.subaccount,
        exchange_index: identity.exchangeIndex,
        enabled: false,
        balance: "0.0000",
        updated_ts: 1790422846,
      });
      return assembleSubaccountStatus({
        nettingPayload: { netting_configs: subaccountIdentities.map(row) },
        balancePayload: { subaccount_balances: subaccountIdentities.map(row) },
        scopedPayload: subaccountIdentities.some((identity) => identity.subaccount === 1 && identity.exchangeIndex === 2)
          ? { balance_dollars: "0.0000", subaccount_number: 1, exchange_index: 2 }
          : { balance_breakdown: [{ balance: "10.00" }] },
        limitsPayload: { usage_tier: "advanced" },
        attemptState: subaccountAttempt,
      });
    },
    createSubaccount: async (confirmation) => {
      const before = envBefore();
      const status = summarizeSubaccountInventory(subaccountIdentities);
      const decision = subaccountCreationDecision({
        confirmation,
        status,
        inventoryProven: true,
        priorAttempt: subaccountAttempt,
        workerRunning: snapshot.workerRunning,
        productionAccountExists: snapshot.account.count > 0,
        nodeEnv: "production",
        kalshiEnvironment: "production",
        provisioningConfigured: true,
        liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
        v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
      });
      const unchanged = () => FLAG_NAMES.every((name) => process.env[name] === before[name]);
      if (!decision.proceed) {
        return {
          state: "blocked" as const, reason: decision.reason, posts: subaccountPosts,
          returnedSubaccount: null, workerStarted: false as const,
          environmentChanged: false as const, funded: false as const, commissioned: false as const,
        };
      }
      subaccountAttempt = "attempted";
      subaccountPosts += 1;
      subaccountPayloads.push({ exchange_index: 2 });
      calls.push({ method: "POST", path: "/trade-api/v2/portfolio/subaccounts" });
      if (!unchanged() || workerStarts !== 0) {
        return {
          state: "blocked" as const, reason: "environment_or_worker_changed", posts: subaccountPosts,
          returnedSubaccount: null, workerStarted: false as const,
          environmentChanged: false as const, funded: false as const, commissioned: false as const,
        };
      }
      if (subaccountOutcome === "uncertain") {
        subaccountAttempt = "uncertain";
        return {
          state: "uncertain" as const, reason: "subaccount_creation_uncertain_no_retry", posts: subaccountPosts,
          returnedSubaccount: null, workerStarted: false as const,
          environmentChanged: false as const, funded: false as const, commissioned: false as const,
        };
      }
      if (subaccountOutcome === "wrong_number") {
        subaccountAttempt = "rejected";
        return {
          state: "blocked" as const, reason: "returned_subaccount_not_1", posts: subaccountPosts,
          returnedSubaccount: 7, workerStarted: false as const,
          environmentChanged: false as const, funded: false as const, commissioned: false as const,
        };
      }
      subaccountAttempt = "response_received";
      subaccountIdentities = [...subaccountIdentities, { subaccount: 1, exchangeIndex: 2 }];
      return {
        state: "created" as const, reason: "subaccount_1_created", posts: subaccountPosts,
        returnedSubaccount: 1, workerStarted: false as const,
        environmentChanged: false as const, funded: false as const, commissioned: false as const,
      };
    },
    arm: async (confirmation) => {
      const before = envBefore();
      const decision = planArm(snapshot, confirmation);
      if (!decision.ok) return { status: "BLOCKED", reason: decision.reason, workerStarted: false, environmentChanged: false };
      snapshot.account.executionEnabled = true;
      snapshot.account.killSwitch = false;
      snapshot.master = {
        count: 1, mode: "V13_PRODUCTION", liveExecutionEnabled: true, manualKillSwitch: false,
      };
      const changed = FLAG_NAMES.some((name) => process.env[name] !== before[name]);
      if (changed) return { status: "BLOCKED", reason: "environment_changed", workerStarted: false, environmentChanged: false };
      return { status: "ARMED", reason: decision.reason, workerStarted: false, environmentChanged: false };
    },
    disarm: async (confirmation) => {
      const decision = planDisarm(snapshot, confirmation);
      if (!decision.ok) return { status: "BLOCKED", reason: decision.reason, emergencyStop: false };
      snapshot.account.executionEnabled = false;
      snapshot.account.killSwitch = true;
      snapshot.master = {
        ...snapshot.master, liveExecutionEnabled: false, manualKillSwitch: true,
      };
      return { status: "DISARMED", reason: decision.reason, emergencyStop: false };
    },
    acknowledgePreBoundaryRoundTrip: async (confirmation: unknown) => ({
      status: "BLOCKED" as const,
      reason: confirmation === "ACKNOWLEDGE_INTENTIONAL_PRE_BOUNDARY_25_ROUND_TRIP"
        ? "pre_boundary_round_trip_unproven"
        : "explicit_pre_boundary_round_trip_confirmation_required",
      acknowledged: false,
      eligible: false,
      inboundTransferId: null,
      outboundTransferId: null,
      amountCents: null,
      inboundCreatedAt: null,
      outboundCreatedAt: null,
      evidenceDigest: null,
      calls: [] as Array<{ method: "GET" | "POST" | "DELETE"; path: string }>,
      funded: false as const,
      commissioned: false as const,
      armed: false as const,
      workerStarted: false as const,
      executionFlagsChanged: false as const,
    }),
  };
  return {
    port,
    accounts: () => accounts,
    set(next: CommissioningSnapshot) { snapshot = structuredClone(next); },
    calls,
    posts: () => posts,
    index2Posts: () => index2Posts,
    index2Payloads: () => index2Payloads,
    index2Stored: () => index2Stored,
    setIndex2(next: Partial<Index2GenerationFacts>, outcome: "generated" | "uncertain" = "generated") {
      index2Overlay = next;
      index2Outcome = outcome;
    },
    setIndex2Replacement(next: Partial<Index2ReplacementFacts>, outcome: "generated" | "uncertain" = "generated") {
      index2ReplacementOverlay = next;
      index2Outcome = outcome;
    },
    index2Archive: () => index2Archive,
    setSubaccounts(next: SubaccountIdentity[], outcome: "created" | "uncertain" | "wrong_number" = "created") {
      subaccountIdentities = next;
      subaccountOutcome = outcome;
    },
    subaccountPosts: () => subaccountPosts,
    subaccountPayloads: () => subaccountPayloads,
    noteGet(path: string) { calls.push({ method: "GET", path }); },
    acceptReviewedFee() { reviewedFeeAccepted = true; },
    feeUploadCalls: () => feeUploadCalls,
    feeUploadBytes: () => feeUploadBytes,
    proveCash(micros: string) { reviewedCashMicros = micros; },
    workerStarts: () => workerStarts,
    emergencyStops: () => emergencyStops,
    startWorker() { workerStarts += 1; },
    current: () => snapshot,
  };
}

async function signingKeys() {
  const pair = await generateKeyPair("RS256");
  const jwk = await exportJWK(pair.publicKey);
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey: pair.privateKey, keys: createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey };
}

async function token(privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"], sub: string, aal = "aal2") {
  return new SignJWT({ aal, role: "authenticated" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(sub)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

function roleOf(subject: string): Promise<string | null> {
  if (subject === DEVELOPER_ID) return Promise.resolve("DEVELOPER");
  if (subject === STANDARD_ID) return Promise.resolve("STANDARD");
  if (subject === ADMIN_ID) return Promise.resolve("ADMIN");
  return Promise.resolve(null);
}

function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => ({
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }));
}

function call(port: number, path: string, method: string, bearer?: string, body?: unknown) {
  return new Promise<{
    status: number;
    body: Record<string, unknown>;
    raw: string;
    headers: import("node:http").IncomingHttpHeaders;
  }>((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest({
      hostname: "127.0.0.1", port, path, method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode ?? 0,
          raw,
          headers: res.headers,
          body: raw.startsWith("{") ? JSON.parse(raw) as Record<string, unknown> : {},
        });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("missing signer, wrong pair, incomplete history, funding, fee, and policy stay blocked", () => {
  const missing = emptySnapshot();
  assert.equal(planCommission(missing).plan, null);
  assert.ok(planCommission(missing).blockers.includes("dedicated_signer_missing"));
  assert.ok(planCommission(missing).blockers.includes("funding_anchor_missing"));
  assert.ok(planCommission(missing).blockers.includes("fee_artifact_digest_absent"));
  assert.ok(planCommission(missing).blockers.includes("live_money_policy_missing"));
  assert.ok(planCommission(missing).blockers.includes("cash_precision_unverified"));

  const wrongSigner = ready();
  wrongSigner.signer.restrictedToPair = false;
  assert.ok(planCommission(wrongSigner).blockers.includes("dedicated_signer_wrong_pair"));
  assert.equal(planCommission(wrongSigner).plan, null);

  const wrongPair = ready();
  wrongPair.boundary.subaccount = 0;
  assert.ok(planCommission(wrongPair).blockers.includes("clean_boundary_wrong_pair"));

  const incomplete = ready();
  incomplete.signer.historyComplete = false;
  incomplete.boundary.historyComplete = false;
  assert.ok(planCommission(incomplete).blockers.includes("dedicated_signer_history_incomplete"));
  assert.ok(planCommission(incomplete).blockers.includes("clean_boundary_history_incomplete"));

  const unfunded = ready();
  unfunded.funding = { anchorExists: false, amountCents: null, balanceMicros: null, verified: false, uncertain: false };
  assert.ok(planCommission(unfunded).blockers.includes("funding_anchor_missing"));

  const fee = ready();
  fee.fee.verified = false;
  assert.ok(planCommission(fee).blockers.includes("fee_artifact_unverified"));

  const policy = ready();
  policy.policy = { ...policy.policy, exists: false, approved: false, hashMatches: false, missingFields: ["capitalLimitCents"] };
  assert.ok(planCommission(policy).blockers.includes("live_money_policy_missing"));
});

test("commission creates one disarmed (1,2) account and does not arm or start a worker", () => {
  const saved = Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]));
  const gate = memoryPort(ready());
  const first = planCommission(ready());
  assert.ok(first.plan);
  assert.equal(first.plan.executionEnabled, false);
  assert.equal(first.plan.killSwitch, true);
  assert.equal(first.plan.subaccount, 1);
  assert.equal(first.plan.exchangeIndex, 2);
  return gate.port.commission("COMMISSION_WITHOUT_EXECUTION", DEVELOPER_ID).then(async (created) => {
    assert.equal(created.status, "COMMISSIONED");
    assert.equal(created.executionEnabled, false);
    assert.equal(created.killSwitch, true);
    assert.equal(created.workerStarted, false);
    assert.equal(created.environmentChanged, false);
    assert.equal(gate.current().master.liveExecutionEnabled, false);
    assert.equal(gate.current().master.manualKillSwitch, true);
    assert.equal(gate.calls.length, 0);
    assert.equal(gate.accounts().length, 1);
    assert.equal(gate.workerStarts(), 0);
    const second = await gate.port.commission("COMMISSION_WITHOUT_EXECUTION", DEVELOPER_ID);
    assert.equal(second.accountCount, 1);
    assert.equal(gate.accounts().length, 1);
    for (const name of FLAG_NAMES) assert.equal(process.env[name], saved[name]);
  });
});

test("one-shot funding requires the exact phrase and never retries an uncertain attempt", async () => {
  assert.equal(fundingAuthorizationDecision({ confirmation: "transfer 25" }).proceed, false);
  assert.equal(fundingAuthorizationDecision({
    confirmation: FUNDING_CONFIRMATION,
    liveExecutionEnabled: "true",
  }).reason, "funding_refused_while_execution_enabled");
  assert.equal(fundingAuthorizationDecision({
    confirmation: FUNDING_CONFIRMATION,
    attemptState: "uncertain",
  }).reason, "funding_uncertain_no_retry");
  const clean = emptySnapshot();
  clean.boundary = {
    exists: true, subaccount: 1, exchangeIndex: 2, state: "KEY_BOUND_VERIFIED",
    cleanZero: true, verified: true, fingerprintMatches: true, historyComplete: true, ambiguous: false,
  };
  const gate = memoryPort(clean);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("live kalshi fetch is not allowed in tests"));
  try {
    const first = await gate.port.fund(FUNDING_CONFIRMATION);
    const second = await gate.port.fund(FUNDING_CONFIRMATION);
    assert.equal(first.transferAttempted, true);
    assert.equal(first.attempts, 1);
    assert.equal(second.transferAttempted, false);
    assert.equal(second.reason, "funding_uncertain_no_retry");
    assert.equal(gate.posts(), 1);
    const reconcile = await gate.port.reconcileFunding();
    assert.equal(reconcile.transferAttempted, false);
    assert.equal(gate.posts(), 1);
    const dirty = memoryPort(emptySnapshot());
    const blocked = await dirty.port.captureBoundary();
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.calls.every((call) => call.method === "GET"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fingerprint is recomputed and a private key is not a caller field", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
  const fingerprint = dedicatedSignerFingerprint("index2-test-key", pem);
  assert.match(fingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.equal(dedicatedSignerFingerprint("index2-test-key", "not-a-key"), null);
  assert.equal(fingerprint, dedicatedSignerFingerprint("index2-test-key", pem));
});

test("commissioning routes require AAL2 developer or admin and stay read-only", async () => {
  const { privateKey, keys } = await signingKeys();
  const gate = memoryPort(emptySnapshot());
  const pem = "-----BEGIN PRIVATE KEY-----\nnot-in-the-response\n-----END PRIVATE KEY-----";
  const app = express();
  app.use(express.json());
  app.use("/api/strata", createStrataRouter({
    verifyToken: (value) => verifySupabaseAccessToken(value, { supabaseUrl: SUPABASE_URL, keys }),
    roleOf,
    control: { start: async () => { gate.startWorker(); }, stop() {}, view: () => ({ runtimeStatus: "STOPPED", workerRunning: false, blockedReason: null, lastProductionError: null, refused: false }), isScheduled: () => false } as never,
    status: async () => ({ runtimeStatus: "STOPPED" }),
    positions: async () => ({ positions: [] }),
    orders: async () => ({ orders: [] }),
    fills: async () => ({ fills: [] }),
    trades: async () => ({ trades: [] }),
    latestTrade: async () => ({ unresolved: false, latestCompleted: null }),
    forwardTestStatus: async () => ({}),
    forwardTestHistory: async () => ({}),
    phase4State: async () => ({}),
    microLiveState: async () => ({}),
    emergencyStop: async () => ({ killSwitch: "ON" }),
    commissioning: gate.port,
  }));
  const server = await listen(app);
  try {
    const developer = await token(privateKey, DEVELOPER_ID);
    const admin = await token(privateKey, ADMIN_ID);
    const standard = await token(privateKey, STANDARD_ID);
    const aal1 = await token(privateKey, DEVELOPER_ID, "aal1");
    assert.equal((await call(server.port, "/api/strata/commissioning/status", "GET")).status, 401);
    assert.equal((await call(server.port, "/api/strata/commissioning/status", "GET", aal1)).status, 401);
    assert.equal((await call(server.port, "/api/strata/commissioning/status", "GET", standard)).status, 403);
    const status = await call(server.port, "/api/strata/commissioning/status", "GET", developer);
    assert.equal(status.status, 200);
    assert.equal(status.body.readyForCommissioning, false);
    assert.equal(status.body.readyForArming, false);
    assert.ok((status.body.blockers as string[]).includes("dedicated_signer_missing"));
    assert.equal(status.raw.includes(pem), false);
    assert.equal(status.raw.includes("BEGIN PRIVATE KEY"), false);
    const adminStatus = await call(server.port, "/api/strata/commissioning/status", "GET", admin);
    assert.equal(adminStatus.status, 200);
    gate.noteGet("/trade-api/v2/api_keys");
    const signer = await call(server.port, "/api/strata/commissioning/verify-signer", "POST", developer, {});
    assert.equal(signer.status, 200);
    assert.deepEqual(signer.body.exchangeCalls, [{ method: "GET", path: "/trade-api/v2/api_keys" }]);
    assert.equal(gate.workerStarts(), 0);
    const early = await call(server.port, "/api/strata/commissioning/commission", "POST", developer, {
      confirm: "COMMISSION_WITHOUT_EXECUTION",
    });
    assert.equal(early.status, 409);
    assert.equal(gate.accounts().length, 0);
    const armed = await call(server.port, "/api/strata/commissioning/commission", "POST", developer, {
      confirm: "COMMISSION_WITHOUT_EXECUTION", executionEnabled: true, killSwitch: false,
    });
    assert.equal(armed.status, 400);
    const fund = await call(server.port, "/api/strata/commissioning/fund", "POST", developer, {
      confirm: "AUTHORIZE_ONE_SHOT_25_USD_TRANSFER",
    });
    assert.equal(fund.status, 409);
    assert.equal(fund.body.transferAttempted, false);
    assert.equal(gate.accounts().length, 0);
    assert.equal(status.body.kalshiConnectionStatus, "NOT_CONFIGURED");
    assert.equal(status.body.minimumExitApproved, false);
    assert.equal(status.body.minimumExitSource, "not_approved");
  } finally {
    await server.close();
  }
});

const OPERATOR_LIMITS = {
  capitalLimitCents: 2500,
  maxEntryStakeCents: 100,
  maxEntryAllInCents: 200,
  maxDailyLossCents: 500,
  maxTotalLossCents: 1000,
  maxQuoteAgeMs: 1000,
  maxFeeEvidenceAgeMs: 2000,
};

test("policy, fee, cash, exit floor, arm, and disarm stay explicit", async () => {
  assert.equal(validatePolicyLimits(null).ok, false);
  assert.equal(validatePolicyLimits({ maxEntryStakeCents: 500000 }).ok, false);
  assert.equal(V13_MAX_ENTRY_STAKE_CENTS, 2_500_000);
  assert.equal(REVIEWED_FUNDING_CENTS, 2500);
  assert.equal(REVIEWED_FUNDING_MICROS, "25000000");
  assert.equal(PRE_BOUNDARY_ROUND_TRIP_CENTS, 2500);
  const ceilingLimits = {
    ...OPERATOR_LIMITS,
    capitalLimitCents: 2_500_000,
    maxEntryStakeCents: 2_500_000,
    maxEntryAllInCents: 2_500_000,
  };
  assert.equal(validatePolicyLimits(ceilingLimits).ok, true);
  assert.equal(validatePolicyLimits({ ...ceilingLimits, maxEntryStakeCents: 2_500_001 }).ok, false);
  const launchPolicy = {
    capitalLimitCents: 15000,
    maxEntryStakeCents: 150,
    maxEntryAllInCents: 200,
    maxDailyLossCents: 500,
    maxTotalLossCents: 1500,
    maxQuoteAgeMs: 1000,
    maxFeeEvidenceAgeMs: 1000,
  };
  assert.equal(validatePolicyLimits(launchPolicy).ok, true);
  assert.equal(validatePolicyLimits({ ...OPERATOR_LIMITS, chosenForYou: 1 } as never).ok, false);
  const gate = memoryPort(emptySnapshot());
  assert.equal((await gate.port.verifyFee()).snapshot.fee.verified, false);
  assert.equal((await gate.port.verifyCash()).cash.precisionVerified, false);
  gate.proveCash("25.00");
  assert.equal((await gate.port.verifyCash()).cash.precisionVerified, false);
  gate.proveCash("25000000");
  assert.equal((await gate.port.verifyCash()).cash.source, "authenticated_kalshi_micros");
  gate.acceptReviewedFee();
  assert.equal((await gate.port.verifyFee()).snapshot.fee.verified, true);
  const proposed = await gate.port.proposePolicy(OPERATOR_LIMITS, DEVELOPER_ID);
  assert.equal(proposed.status, "PROPOSED");
  const savedEntryApproval = process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
  process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED = V13_ENTRY_POLICY_VERSION;
  const approved = await gate.port.approvePolicy(DEVELOPER_ID);
  if (savedEntryApproval === undefined) delete process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
  else process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED = savedEntryApproval;
  assert.equal(approved.status, "APPROVED");
  assert.match(approved.policyHash ?? "", /^[0-9a-f]{64}$/);
  const exit = await gate.port.approveMinimumExit(400000, EXIT_FLOOR_CONFIRMATION, DEVELOPER_ID);
  assert.equal(exit.status, "APPROVED");
  assert.equal(gate.current().minimumExit.source, "operator_approved");
  assert.equal((await gate.port.approveMinimumExit(0, EXIT_FLOOR_CONFIRMATION, DEVELOPER_ID)).status, "BLOCKED");
  const unarmed = await gate.port.arm(ARM_CONFIRMATION);
  assert.equal(unarmed.reason, "arm_cannot_commission");
  assert.equal(gate.accounts().length, 0);
  assert.equal(gate.workerStarts(), 0);
  const owned = ready();
  owned.openPositionCount = 1;
  owned.unresolvedIntentCount = 0;
  assert.equal(planDisarm(owned, DISARM_CONFIRMATION).reason, "disarm_refused_while_position_or_intent_open");
  const unresolved = ready();
  unresolved.openPositionCount = 0;
  unresolved.unresolvedIntentCount = 1;
  assert.equal(planDisarm(unresolved, DISARM_CONFIRMATION).reason, "disarm_refused_while_position_or_intent_open");
  const commissioned = memoryPort(ready());
  await commissioned.port.commission("COMMISSION_WITHOUT_EXECUTION", DEVELOPER_ID);
  const saved = process.env.LIVE_EXECUTION_ENABLED;
  const armed = await commissioned.port.arm(ARM_CONFIRMATION);
  assert.equal(armed.status, "ARMED");
  assert.equal(armed.workerStarted, false);
  assert.equal(armed.environmentChanged, false);
  assert.equal(process.env.LIVE_EXECUTION_ENABLED, saved);
  assert.equal(commissioned.workerStarts(), 0);
  commissioned.current().fee.verified = false;
  commissioned.current().account.executionEnabled = false;
  commissioned.current().account.killSwitch = true;
  const stale = await commissioned.port.arm(ARM_CONFIRMATION);
  assert.equal(stale.status, "BLOCKED");
  assert.equal(commissioned.current().account.executionEnabled, false);
  const disarmed = await commissioned.port.disarm(DISARM_CONFIRMATION);
  assert.equal(disarmed.status, "DISARMED");
  assert.equal(disarmed.emergencyStop, false);
  assert.equal(commissioned.emergencyStops(), 0);
  assert.equal(commissioned.current().account.killSwitch, true);
  assert.equal(commissioned.current().account.executionEnabled, false);
  assert.equal(commissioned.current().master.liveExecutionEnabled, false);
  assert.equal(commissioned.current().master.manualKillSwitch, true);
  assert.equal(commissioned.current().master.mode, "V13_PRODUCTION");
  assert.equal(commissioned.calls.length, 0);
});

test("V2 approval binds the reviewed entry policy and leaves a blocked draft unchanged", () => {
  const draft = {
    id: "v13-live-money-1",
    version: 1,
    supersedes_policy_id: null,
    state: "DRAFT",
    strategy_version: "V1.3",
    strategy_parameter_set_id: V13_CHAMPION_PARAMETER_SET.id,
    strategy_parameter_hash: V13_CHAMPION_PARAMETER_HASH,
    entry_policy_version: null,
    capital_limit_cents: 2500,
    max_entry_stake_cents: 100,
    max_entry_all_in_cents: 200,
    max_open_positions: 1,
    max_daily_loss_cents: 500,
    max_total_loss_cents: 1000,
    max_quote_age_ms: 1000,
    max_fee_evidence_age_ms: 2000,
    require_full_depth: true,
    entry_time_in_force: "IOC",
    entry_limit_source: "SIGNAL_REFERENCE_OFFER",
    created_by: DEVELOPER_ID,
    policy_hash: null,
  };
  assert.equal(policyFromRow(draft).entryPolicyVersion, null);
  assert.equal(policyFromRow({ ...draft, entry_policy_version: V13_ENTRY_POLICY_VERSION }).entryPolicyVersion, V13_ENTRY_POLICY_VERSION);
  assert.equal(policyFromRow({ ...draft, entry_policy_version: V13_LEGACY_ENTRY_POLICY }).entryPolicyVersion, V13_LEGACY_ENTRY_POLICY);
  const before = structuredClone(draft);
  assert.equal(policyApprovalEntryBlock({}), ENTRY_POLICY_REVIEW_BLOCKER);
  assert.equal(policyApprovalEntryBlock({ V13_ENTRY_POLICY_RUNTIME_APPROVED: "not-the-reviewed-v2" }), ENTRY_POLICY_REVIEW_BLOCKER);
  assert.deepEqual(draft, before);
  assert.equal(policyApprovalEntryBlock({ V13_ENTRY_POLICY_RUNTIME_APPROVED: V13_ENTRY_POLICY_VERSION }), null);
  const now = new Date("2026-10-11T14:00:00.000Z");
  const bound = approvedPolicyFromDraft(draft, DEVELOPER_ID, now);
  assert.deepEqual(draft, before);
  assert.equal(bound.policy.entryPolicyVersion, V13_ENTRY_POLICY_VERSION);
  const unbound = computeV13LiveMoneyPolicyHash({ ...bound.policy, entryPolicyVersion: null, policyHash: null });
  assert.notEqual(bound.policyHash, unbound);
  const stored = {
    ...draft,
    state: "APPROVED",
    entry_policy_version: V13_ENTRY_POLICY_VERSION,
    strategy_version: "V1.3",
    strategy_parameter_set_id: V13_CHAMPION_PARAMETER_SET.id,
    strategy_parameter_hash: V13_CHAMPION_PARAMETER_HASH,
    champion_selection_review_id: bound.policy.championSelectionReviewId,
    champion_selection_evidence_hash: bound.policy.championSelectionEvidenceHash,
    champion_selected_by: DEVELOPER_ID,
    champion_selected_at: now.toISOString(),
    fee_policy_version: bound.policy.feePolicyVersion,
    fee_source_url: bound.policy.feeSourceUrl,
    fee_formula_version: bound.policy.feeFormulaVersion,
    approved_by: DEVELOPER_ID,
    approved_at: now.toISOString(),
    policy_hash: bound.policyHash,
  };
  const reread = policyFromRow(stored);
  assert.equal(reread.entryPolicyVersion, V13_ENTRY_POLICY_VERSION);
  assert.equal(reread.policyHash, bound.policyHash);
  assert.equal(computeV13LiveMoneyPolicyHash({ ...reread, policyHash: null }), bound.policyHash);
  const legacy = ready();
  const runtimeApproved = { V13_ENTRY_POLICY_RUNTIME_APPROVED: V13_ENTRY_POLICY_VERSION };
  legacy.policy.entryPolicyVersion = null;
  assert.equal(commissioningBlockers(legacy, runtimeApproved).includes(ENTRY_POLICY_REVIEW_BLOCKER), true);
  legacy.policy.entryPolicyVersion = V13_LEGACY_ENTRY_POLICY;
  assert.equal(commissioningBlockers(legacy, runtimeApproved).includes(ENTRY_POLICY_REVIEW_BLOCKER), true);
  legacy.policy.entryPolicyVersion = V13_ENTRY_POLICY_VERSION;
  assert.equal(commissioningBlockers(legacy, {}).includes(ENTRY_POLICY_REVIEW_BLOCKER), true);
  assert.equal(commissioningBlockers(legacy, runtimeApproved).includes(ENTRY_POLICY_REVIEW_BLOCKER), false);
  const savedRuntime = process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
  delete process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
  try {
    const diagnosed = commissioningStatus(emptySnapshot());
    assert.equal(diagnosed.entryPolicyRuntimeApproved, false);
    assert.equal(diagnosed.entryPolicyBlockReason, ENTRY_POLICY_REVIEW_BLOCKER);
    assert.equal(diagnosed.blockers.includes(ENTRY_POLICY_REVIEW_BLOCKER), true);
    assert.equal(diagnosed.entryPolicyRuntimeConfiguredState, "MISSING");
    assert.equal(diagnosed.entryPolicyRuntimeDiagnosticReason, "runtime_approval_env_missing");
    assert.equal(diagnosed.blockers.includes("runtime_approval_env_missing"), false);
  } finally {
    if (savedRuntime === undefined) delete process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
    else process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED = savedRuntime;
  }
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const approval = store.slice(store.indexOf("async approvePolicy(actor)"), store.indexOf("async approveMinimumExit"));
  assert.ok(approval.indexOf("policyApprovalEntryBlock") < approval.indexOf("UPDATE v13_live_money_policy"));
  assert.match(approval, /entry_policy_version = \$10/);
  assert.match(approval, /state = 'DRAFT'/);
  assert.equal(approval.includes("fetch("), false);
  assert.equal(approval.includes("/trade-api/"), false);
  assert.equal(approval.includes("/portfolio/"), false);
  const executor = readFileSync("src/lib/v13-production/executor.ts", "utf8");
  const prepare = executor.slice(executor.indexOf("async prepareEntry"), executor.indexOf("async dispatch"));
  const dispatch = executor.slice(executor.indexOf("async dispatch"));
  assert.match(prepare, /assertEntryPolicyWindow\(tx, source\)/);
  assert.match(dispatch, /assertEntryPolicyWindow\(tx, source\)/);
  assert.ok(dispatch.indexOf("assertEntryPolicyWindow") < dispatch.indexOf("this.exchange.submit"));
});

test("approved policy hash keeps PostgreSQL date milliseconds", () => {
  const when = new Date("2026-10-11T18:49:20.789Z");
  const draft = {
    id: "v13-live-money-1",
    version: 1,
    supersedes_policy_id: null,
    state: "DRAFT",
    strategy_version: "V1.3",
    strategy_parameter_set_id: V13_CHAMPION_PARAMETER_SET.id,
    strategy_parameter_hash: V13_CHAMPION_PARAMETER_HASH,
    entry_policy_version: null,
    capital_limit_cents: 15000,
    max_entry_stake_cents: 150,
    max_entry_all_in_cents: 200,
    max_open_positions: 1,
    max_daily_loss_cents: 500,
    max_total_loss_cents: 1500,
    max_quote_age_ms: 1000,
    max_fee_evidence_age_ms: 1000,
    require_full_depth: true,
    entry_time_in_force: "IOC",
    entry_limit_source: "SIGNAL_REFERENCE_OFFER",
    created_by: DEVELOPER_ID,
    policy_hash: null,
  };
  const bound = approvedPolicyFromDraft(draft, DEVELOPER_ID, when);
  assert.match(bound.policyHash, /^[0-9a-f]{64}$/);
  assert.equal(bound.policy.entryPolicyVersion, V13_ENTRY_POLICY_VERSION);
  const pgRow = {
    ...draft,
    state: "APPROVED",
    entry_policy_version: bound.policy.entryPolicyVersion,
    champion_selection_review_id: bound.policy.championSelectionReviewId,
    champion_selection_evidence_hash: bound.policy.championSelectionEvidenceHash,
    champion_selected_by: DEVELOPER_ID,
    champion_selected_at: bound.policy.championSelectedAt,
    fee_policy_version: bound.policy.feePolicyVersion,
    fee_source_url: bound.policy.feeSourceUrl,
    fee_formula_version: bound.policy.feeFormulaVersion,
    approved_by: DEVELOPER_ID,
    approved_at: bound.policy.approvedAt,
    strategy_version: "V1.3",
    strategy_parameter_set_id: V13_CHAMPION_PARAMETER_SET.id,
    strategy_parameter_hash: V13_CHAMPION_PARAMETER_HASH,
    policy_hash: bound.policyHash,
  };
  const reread = policyFromRow(pgRow);
  assert.equal(reread.approvedAt?.toISOString(), "2026-10-11T18:49:20.789Z");
  assert.equal(reread.championSelectedAt?.toISOString(), "2026-10-11T18:49:20.789Z");
  assert.equal(computeV13LiveMoneyPolicyHash(reread), bound.policyHash);
  const limitChanges: Array<Partial<typeof reread>> = [
    { capitalLimitCents: 14999 },
    { maxEntryStakeCents: 149 },
    { maxEntryAllInCents: 199 },
    { maxDailyLossCents: 499 },
    { maxTotalLossCents: 1499 },
    { maxQuoteAgeMs: 999 },
    { maxFeeEvidenceAgeMs: 999 },
    { maxOpenPositions: 0 },
  ];
  for (const change of limitChanges) {
    assert.notEqual(computeV13LiveMoneyPolicyHash({ ...reread, ...change }), bound.policyHash);
  }
  assert.notEqual(
    computeV13LiveMoneyPolicyHash({ ...reread, entryPolicyVersion: V13_LEGACY_ENTRY_POLICY }),
    bound.policyHash,
  );
  assert.notEqual(
    computeV13LiveMoneyPolicyHash({ ...reread, approvedAt: new Date(when.getTime() + 1) }),
    bound.policyHash,
  );
  assert.notEqual(
    computeV13LiveMoneyPolicyHash({ ...reread, championSelectedAt: new Date(when.getTime() - 1) }),
    bound.policyHash,
  );
  assert.notEqual(
    computeV13LiveMoneyPolicyHash({ ...reread, entryPolicyVersion: null }),
    bound.policyHash,
  );
});

test("INDEX2 generation is one authenticated POST and never stores or logs the private key", async () => {
  const readyFacts = (): Index2GenerationFacts => ({
    confirmation: STRATA_INDEX2_KEY_CONFIRMATION,
    nodeEnv: "production",
    provisioningKeyIdPresent: true,
    provisioningPrivateKeyPresent: true,
    verifierKeyIdPresent: true,
    verifierPrivateKeyPresent: true,
    kalshiEnvironment: "production",
    provisioningCredentialValid: true,
    provisioningUnrestricted: true,
    provisioningScopesExact: true,
    verifierCredentialValid: true,
    existingIndex2Name: false,
    priorAttempt: "none",
    workerRunning: false,
    productionAccountExists: false,
    liveExecutionEnabled: undefined,
    v13ProductionExecutionEnabled: undefined,
  });
  for (const [reason, patch] of [
    ["provisioning_key_id_missing", { provisioningKeyIdPresent: false }],
    ["provisioning_private_key_missing", { provisioningPrivateKeyPresent: false }],
    ["verifier_key_id_missing", { verifierKeyIdPresent: false }],
    ["verifier_private_key_missing", { verifierPrivateKeyPresent: false }],
    ["kalshi_environment_not_production", { kalshiEnvironment: "demo" }],
    ["provisioning_credential_invalid", { provisioningCredentialValid: false }],
    ["provisioning_key_not_unrestricted", { provisioningUnrestricted: false }],
    ["provisioning_scopes_not_exact", { provisioningScopesExact: false }],
    ["verifier_credential_invalid", { verifierCredentialValid: false }],
    ["index2_key_name_already_exists", { existingIndex2Name: true }],
    ["index2_generation_attempt_exists", { priorAttempt: "attempted" as const }],
    ["index2_generation_uncertain_no_retry", { priorAttempt: "uncertain" as const }],
    ["production_worker_running", { workerRunning: true }],
    ["production_account_exists", { productionAccountExists: true }],
    ["live_execution_enabled", { liveExecutionEnabled: "true" }],
    ["v13_production_execution_enabled", { v13ProductionExecutionEnabled: "true" }],
  ] as const) {
    const decision = index2GenerationDecision({ ...readyFacts(), ...patch });
    assert.equal(decision.proceed, false);
    assert.equal(decision.reason, reason);
  }
  const sql = readFileSync("../../lib/db/drizzle/0002_strata_index2_key_attempt.sql", "utf8");
  assert.equal(/private_key/i.test(sql), false);
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const generator = store.slice(
    store.indexOf("export async function generateRailwayIndex2Key"),
    store.indexOf("export function createDatabaseCommissioningPort"),
  );
  assert.equal(generator.includes("private_key"), false);
  assert.equal(generator.includes("postOneShotPairFunding"), false);
  assert.equal(generator.includes("/portfolio/orders"), false);
  assert.equal(generator.includes("/portfolio/fills"), false);
  assert.equal(generator.includes("LIVE_EXECUTION_ENABLED ="), false);

  const { privateKey, keys } = await signingKeys();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("live kalshi fetch is not allowed in tests"); }) as typeof fetch;
  const logged: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  }
  const gate = memoryPort(emptySnapshot());
  const app = express();
  app.use(express.json());
  app.use("/api/strata", createStrataRouter({
    verifyToken: (value) => verifySupabaseAccessToken(value, { supabaseUrl: SUPABASE_URL, keys }),
    roleOf,
    control: { start: async () => { gate.startWorker(); }, stop() {}, view: () => ({ runtimeStatus: "STOPPED", workerRunning: false, blockedReason: null, lastProductionError: null, refused: false }), isScheduled: () => false } as never,
    status: async () => ({ runtimeStatus: "STOPPED" }),
    positions: async () => ({ positions: [] }),
    orders: async () => ({ orders: [] }),
    fills: async () => ({ fills: [] }),
    trades: async () => ({ trades: [] }),
    latestTrade: async () => ({ unresolved: false, latestCompleted: null }),
    forwardTestStatus: async () => ({}),
    forwardTestHistory: async () => ({}),
    phase4State: async () => ({}),
    microLiveState: async () => ({}),
    emergencyStop: async () => ({ killSwitch: "ON" }),
    commissioning: gate.port,
  }));
  const server = await listen(app);
  const savedLive = process.env.LIVE_EXECUTION_ENABLED;
  const savedV13 = process.env.V13_PRODUCTION_EXECUTION_ENABLED;
  try {
    const developer = await token(privateKey, DEVELOPER_ID);
    const admin = await token(privateKey, ADMIN_ID);
    const standard = await token(privateKey, STANDARD_ID);
    const aal1 = await token(privateKey, DEVELOPER_ID, "aal1");
    const path = "/api/strata/commissioning/generate-index2-key";
    const body = { confirm: STRATA_INDEX2_KEY_CONFIRMATION };
    assert.equal((await call(server.port, path, "POST", undefined, body)).status, 401);
    assert.equal((await call(server.port, path, "POST", aal1, body)).status, 401);
    assert.equal((await call(server.port, path, "POST", standard, body)).status, 403);
    const wrong = await call(server.port, path, "POST", developer, { confirm: "GENERATE" });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.raw.includes("not-a-key"), false);
    for (const [reason, patch] of [
      ["provisioning_key_id_missing", { provisioningKeyIdPresent: false }],
      ["verifier_key_id_missing", { verifierKeyIdPresent: false }],
      ["provisioning_scopes_not_exact", { provisioningScopesExact: false }],
      ["index2_key_name_already_exists", { existingIndex2Name: true }],
      ["index2_generation_attempt_exists", { priorAttempt: "attempted" as const }],
      ["live_execution_enabled", { liveExecutionEnabled: "true" }],
      ["v13_production_execution_enabled", { v13ProductionExecutionEnabled: "true" }],
    ] as const) {
      gate.setIndex2(patch);
      const blocked = await call(server.port, path, "POST", developer, body);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.reason, reason);
      assert.equal(blocked.body.keyMaterialReturned, false);
      assert.equal(blocked.raw.includes("not-a-key"), false);
    }
    assert.equal(gate.index2Posts(), 0);
    gate.setIndex2({}, "uncertain");
    const uncertain = await call(server.port, path, "POST", developer, body);
    assert.equal(uncertain.status, 409);
    assert.equal(uncertain.body.reason, "index2_generation_uncertain_no_retry");
    assert.equal(uncertain.raw.includes("not-a-key"), false);
    const retry = await call(server.port, path, "POST", admin, body);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.reason, "index2_generation_uncertain_no_retry");
    assert.equal(gate.index2Posts(), 1);
    assert.deepEqual(gate.index2Payloads(), [{
      name: "Strata INDEX2", key_type: "rsa", subaccount: 1, scopes: ["read", "write::trade"],
    }]);
    assert.deepEqual(gate.calls.filter((item) => item.method === "POST").map((item) => item.path), [
      "/trade-api/v2/api_keys/generate",
    ]);
    assert.equal(gate.calls.some((item) => item.path.includes("transfer")), false);
    assert.equal(gate.calls.some((item) => item.path.includes("order")), false);

    const fresh = memoryPort(emptySnapshot());
    const freshApp = express();
    freshApp.use(express.json());
    freshApp.use("/api/strata", createStrataRouter({
      verifyToken: (value) => verifySupabaseAccessToken(value, { supabaseUrl: SUPABASE_URL, keys }),
      roleOf,
      control: { start: async () => undefined, stop() {}, view: () => ({ runtimeStatus: "STOPPED", workerRunning: false, blockedReason: null, lastProductionError: null, refused: false }), isScheduled: () => false } as never,
      status: async () => ({ runtimeStatus: "STOPPED" }),
      positions: async () => ({ positions: [] }),
      orders: async () => ({ orders: [] }),
      fills: async () => ({ fills: [] }),
      trades: async () => ({ trades: [] }),
      latestTrade: async () => ({ unresolved: false, latestCompleted: null }),
      forwardTestStatus: async () => ({}),
      forwardTestHistory: async () => ({}),
      phase4State: async () => ({}),
      microLiveState: async () => ({}),
      emergencyStop: async () => ({ killSwitch: "ON" }),
      commissioning: fresh.port,
    }));
    const freshServer = await listen(freshApp);
    try {
      const created = await call(freshServer.port, path, "POST", developer, body);
      assert.equal(created.status, 201);
      assert.equal(created.headers["cache-control"], "no-store");
      assert.equal(created.headers.pragma, "no-cache");
      assert.equal(created.body.apiKeyId, "strata-index2-test-key");
      assert.equal(created.body.privateKey, "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----");
      assert.equal(created.body.keyType, "rsa");
      assert.equal(created.body.subaccount, 1);
      assert.deepEqual(created.body.scopes, ["read", "write::trade"]);
      assert.match(String(created.body.instructions), /KALSHI_INDEX2_API_KEY_ID/);
      assert.match(String(created.body.instructions), /KALSHI_INDEX2_PRIVATE_KEY/);
      assert.equal(created.body.verified, false);
      const adminCreated = await call(freshServer.port, path, "POST", admin, body);
      assert.equal(adminCreated.status, 409);
      assert.equal(adminCreated.raw.includes("not-a-key"), false);
      assert.equal(fresh.index2Posts(), 1);
      assert.equal(JSON.stringify(fresh.index2Stored()).includes("not-a-key"), false);
      const status = await call(freshServer.port, "/api/strata/commissioning/status", "GET", developer);
      assert.equal(status.raw.includes("not-a-key"), false);
      assert.equal(status.raw.includes("BEGIN RSA PRIVATE KEY"), false);
    } finally {
      await freshServer.close();
    }
    assert.equal(logged.some((line) => line.includes("not-a-key") || line.includes("BEGIN RSA PRIVATE KEY")), false);
    assert.equal(process.env.LIVE_EXECUTION_ENABLED, savedLive);
    assert.equal(process.env.V13_PRODUCTION_EXECUTION_ENABLED, savedV13);
  } finally {
    methods.forEach((method, index) => { console[method] = originals[index]!; });
    globalThis.fetch = previousFetch;
    if (savedLive === undefined) delete process.env.LIVE_EXECUTION_ENABLED;
    else process.env.LIVE_EXECUTION_ENABLED = savedLive;
    if (savedV13 === undefined) delete process.env.V13_PRODUCTION_EXECUTION_ENABLED;
    else process.env.V13_PRODUCTION_EXECUTION_ENABLED = savedV13;
    await server.close();
  }
});

test("subaccount inspection is GET-only and creation is one restricted POST", async () => {
  assert.equal(cleanPairInventoryDiagnosis([]), "clean_pair_inventory_missing");
  assert.equal(cleanPairInventoryDiagnosis([{ subaccount: 1, exchangeIndex: 0 }]), "clean_pair_exchange_index_2_missing");
  assert.equal(cleanPairInventoryDiagnosis([
    { subaccount: 1, exchangeIndex: 2 },
    { subaccount: 1, exchangeIndex: 2 },
  ]), "clean_pair_inventory_duplicated");
  assert.equal(cleanPairInventoryDiagnosis([{ subaccount: 1, exchangeIndex: 2 }]), null);
  const missing = summarizeSubaccountInventory([{ subaccount: 0, exchangeIndex: 2 }]);
  assert.equal(missing.subaccount1Exists, false);
  assert.equal(missing.reason, "subaccount_1_missing");
  const exchangeMissing = summarizeSubaccountInventory([{ subaccount: 1, exchangeIndex: 0 }]);
  assert.equal(exchangeMissing.reason, "subaccount_1_exists_exchange_2_missing");
  const duplicated = summarizeSubaccountInventory([
    { subaccount: 1, exchangeIndex: 2 },
    { subaccount: 1, exchangeIndex: 2 },
  ]);
  assert.equal(duplicated.matchingRows, 2);
  assert.equal(duplicated.readyForCleanBoundary, false);

  const saved = Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]));
  const gate = memoryPort(emptySnapshot());
  const status = await gate.port.readSubaccountStatus();
  assert.equal(status.subaccount1Exists, false);
  assert.deepEqual(status.numberedSubaccounts, [0]);
  assert.deepEqual(gate.calls.filter((item) => item.path.includes("balances")).map((item) => item.method), ["GET"]);
  const wrong = await gate.port.createSubaccount("create");
  assert.equal(wrong.reason, "explicit_subaccount_confirmation_required");
  assert.equal(gate.subaccountPosts(), 0);
  gate.setSubaccounts([{ subaccount: 1, exchangeIndex: 2 }]);
  const existing = await gate.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION);
  assert.equal(existing.reason, "subaccount_1_already_exists");
  assert.equal(gate.subaccountPosts(), 0);
  gate.setSubaccounts([{ subaccount: 1, exchangeIndex: 0 }]);
  assert.equal((await gate.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION)).reason, "subaccount_1_exists_exchange_2_missing");
  gate.setSubaccounts([{ subaccount: 0, exchangeIndex: 2 }, { subaccount: 2, exchangeIndex: 2 }]);
  assert.equal((await gate.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION)).reason, "next_subaccount_would_not_be_1");
  assert.equal(gate.subaccountPosts(), 0);
  gate.setSubaccounts([{ subaccount: 0, exchangeIndex: 2 }], "uncertain");
  const uncertain = await gate.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION);
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uncertain.posts, 1);
  const retry = await gate.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION);
  assert.equal(retry.reason, "subaccount_creation_uncertain_no_retry");
  assert.equal(gate.subaccountPosts(), 1);
  assert.deepEqual(gate.subaccountPayloads(), [{ exchange_index: 2 }]);
  assert.equal(gate.calls.some((item) => item.path.includes("transfer") || item.path.includes("order")), false);

  const createdGate = memoryPort(emptySnapshot());
  const created = await createdGate.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION);
  assert.equal(created.state, "created");
  assert.equal(created.returnedSubaccount, 1);
  assert.equal(created.workerStarted, false);
  assert.equal(created.environmentChanged, false);
  assert.equal(created.funded, false);
  assert.equal(created.commissioned, false);
  assert.equal(createdGate.workerStarts(), 0);
  const again = await createdGate.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION);
  assert.equal(again.reason, "subaccount_creation_attempt_exists");
  assert.equal(createdGate.subaccountPosts(), 1);
  const wrongNumber = memoryPort(emptySnapshot());
  wrongNumber.setSubaccounts([{ subaccount: 0, exchangeIndex: 2 }], "wrong_number");
  const rejected = await wrongNumber.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION);
  assert.equal(rejected.reason, "returned_subaccount_not_1");
  assert.equal(rejected.returnedSubaccount, 7);
  assert.equal((await wrongNumber.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION)).reason, "subaccount_creation_attempt_exists");
  assert.equal(wrongNumber.subaccountPosts(), 1);
  const running = memoryPort(emptySnapshot());
  running.current().workerRunning = true;
  assert.equal((await running.port.createSubaccount(SUBACCOUNT_CREATE_CONFIRMATION)).reason, "production_worker_running");
  assert.equal(running.subaccountPosts(), 0);
  for (const name of FLAG_NAMES) assert.equal(process.env[name], saved[name]);
  const source = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const body = source.slice(source.indexOf("export async function createRailwaySubaccount"), source.indexOf("export function createDatabaseCommissioningPort"));
  assert.equal(body.includes("/portfolio/orders"), false);
  assert.equal(body.includes("postOneShotPairFunding"), false);
  assert.equal(body.includes("LIVE_EXECUTION_ENABLED ="), false);
  const sql = readFileSync("../../lib/db/drizzle/0003_strata_subaccount_creation_attempt.sql", "utf8");
  assert.equal(/balance|private_key/i.test(sql), false);
  assert.equal(readFileSync("src/lib/kalshiAccountClient.ts", "utf8").includes("clean_pair_inventory_missing_or_duplicated"), false);

  const limits = { usage_tier: "advanced", read_limit: 9999, write_limit: 9999 };
  const primary = {
    subaccount_number: 0, exchange_index: 2, enabled: false, balance: "10.0000", updated_ts: 1790422846,
  };
  const pair = {
    subaccount_number: 1, exchange_index: 2, enabled: false, balance: "0.0000", updated_ts: 1790422846,
  };
  const pending = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [primary, pair] },
    balancePayload: { subaccount_balances: [primary] },
    scopedPayload: { balance_breakdown: [{ balance: "10.00" }] },
    limitsPayload: { usage_tier: "basic" },
    attemptState: "uncertain",
  });
  assert.equal(pending.reason, "subaccount_1_pending_balance_visibility");
  assert.equal(pending.subaccount1Exists, true);
  assert.equal(pending.subaccount1Exchange2Exists, false);
  assert.equal(pending.readyForCleanBoundary, false);
  assert.equal(pending.nettingSubaccount1Exists, true);
  assert.equal(pending.balanceInventorySubaccount1Exists, false);
  assert.equal(pending.apiTier, "basic");
  assert.equal(pending.subaccountCreationTierEligible, false);
  assert.equal(JSON.stringify(pending).includes("10.0000"), false);
  assert.equal(subaccountCreationDecision({
    confirmation: SUBACCOUNT_CREATE_CONFIRMATION,
    status: pending,
    inventoryProven: true,
    priorAttempt: "uncertain",
    workerRunning: false,
    productionAccountExists: false,
    nodeEnv: "production",
    kalshiEnvironment: "production",
    provisioningConfigured: true,
  }).proceed, false);

  const balanceOnly = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [primary] },
    balancePayload: { subaccount_balances: [primary, pair] },
    scopedPayload: { balance_dollars: "0.0000", subaccount_number: 1, exchange_index: 2 },
    limitsPayload: limits,
    attemptState: "uncertain",
  });
  assert.equal(balanceOnly.reason, "subaccount_inventory_contradictory");
  assert.equal(balanceOnly.readyForCleanBoundary, false);

  const agreed = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [primary, pair] },
    balancePayload: { subaccount_balances: [primary, pair] },
    scopedPayload: { balance_dollars: "0.0000", subaccount_number: 1, exchange_index: 2 },
    limitsPayload: { usage_tier: "premier" },
    attemptState: "uncertain",
  });
  assert.equal(agreed.matchingRows, 1);
  assert.equal(agreed.subaccount1Exists, true);
  assert.equal(agreed.subaccount1Exchange2Exists, true);
  assert.equal(agreed.readyForCleanBoundary, true);
  assert.equal(agreed.subaccountCreationTierEligible, true);
  assert.equal(agreed.apiTier, "premier");
  const wrongScope = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [primary, pair] },
    balancePayload: { subaccount_balances: [primary, pair] },
    scopedPayload: { balance_dollars: "0.0000", subaccount_number: 0, exchange_index: 2 },
    limitsPayload: { usage_tier: "advanced" },
    attemptState: "uncertain",
  });
  assert.equal(wrongScope.reason, "scoped_balance_identity_unproven");
  assert.equal(wrongScope.subaccount1Exchange2Exists, false);
  assert.equal(wrongScope.readyForCleanBoundary, false);

  const duplicatedInventory = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [pair, pair] },
    balancePayload: { subaccount_balances: [pair, pair] },
    scopedPayload: { balance_dollars: "0.0000", subaccount_number: 1, exchange_index: 2 },
    limitsPayload: { usage_tier: "advanced" },
    attemptState: "none",
  });
  assert.equal(duplicatedInventory.reason, "subaccount_inventory_duplicated");
  assert.equal(duplicatedInventory.readyForCleanBoundary, false);

  const absent = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [primary] },
    balancePayload: { subaccount_balances: [primary] },
    scopedPayload: { balance_dollars: "10.0000", subaccount_number: 0, exchange_index: 2 },
    limitsPayload: { usage_tier: "advanced" },
    attemptState: "uncertain",
  });
  assert.equal(absent.reason, "subaccount_1_not_visible_after_uncertain_attempt");
  assert.equal(absent.subaccount1Exists, false);
  assert.equal(absent.subaccountCreationTierEligible, true);
  assert.equal(subaccountCreationDecision({
    confirmation: SUBACCOUNT_CREATE_CONFIRMATION,
    status: absent,
    inventoryProven: true,
    priorAttempt: "uncertain",
    workerRunning: false,
    productionAccountExists: false,
    nodeEnv: "production",
    kalshiEnvironment: "production",
    provisioningConfigured: true,
  }).reason, "subaccount_creation_uncertain_no_retry");
});

test("reviewed subaccount reconciliation is GET-only and does not change execution flags", async () => {
  const saved = Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]));
  const savedProvisioningId = process.env.KALSHI_PROVISIONING_API_KEY_ID;
  const savedProvisioningKey = process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.KALSHI_PROVISIONING_API_KEY_ID = "unit-test-provisioning-id";
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const calls: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    assert.equal(init?.method, "GET");
    if (url.pathname.endsWith("/account/limits")) return Response.json({ usage_tier: "advanced" });
    if (url.pathname.endsWith("/subaccounts/netting")) {
      return Response.json({ netting_configs: [{ subaccount_number: 0, exchange_index: 2, enabled: false }] });
    }
    if (url.pathname.endsWith("/subaccounts/balances")) {
      return Response.json({ subaccount_balances: [{ subaccount_number: 0, exchange_index: 2, balance: "1.0000", updated_ts: 1790422846 }] });
    }
    return Response.json({ balance_dollars: "1.0000", subaccount_number: 0, exchange_index: 2 });
  }) as typeof fetch;
  try {
    const evidence = await readReviewedSubaccountEvidence();
    assert.equal(evidence.calls.every((call) => call.method === "GET"), true);
    assert.equal(calls.some((call) => call.startsWith("POST")), false);
    assert.equal(calls.some((call) => call.includes("/account/limits")), true);
    assert.equal(calls.some((call) => call.includes("/subaccounts/netting")), true);
    assert.equal(calls.some((call) => call.includes("/subaccounts/balances")), true);
    assert.equal(calls.some((call) => call.includes("subaccount=1&exchange_index=2")), true);
    assert.equal(calls.some((call) => call.includes("transfer") || call.includes("order")), false);
    const status = assembleSubaccountStatus({ ...evidence, attemptState: "uncertain" });
    assert.equal(status.reason, "subaccount_1_not_visible_after_uncertain_attempt");
    assert.equal(status.apiTier, "advanced");
    assert.equal(status.subaccountCreationTierEligible, true);
    assert.equal(JSON.stringify(status).includes("1.0000"), false);
    for (const name of FLAG_NAMES) assert.equal(process.env[name], saved[name]);
  } finally {
    globalThis.fetch = previous;
    for (const name of FLAG_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    if (savedProvisioningId === undefined) delete process.env.KALSHI_PROVISIONING_API_KEY_ID;
    else process.env.KALSHI_PROVISIONING_API_KEY_ID = savedProvisioningId;
    if (savedProvisioningKey === undefined) delete process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
    else process.env.KALSHI_PROVISIONING_PRIVATE_KEY = savedProvisioningKey;
  }
});

test("unproven provisioning inventory returns sanitized GET diagnostics and does not retry creation", async () => {
  const savedProvisioningId = process.env.KALSHI_PROVISIONING_API_KEY_ID;
  const savedProvisioningKey = process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = "unit-test-provisioning-id";
  process.env.KALSHI_PROVISIONING_API_KEY_ID = keyId;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const methods: string[] = [];
  const signatures: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    methods.push(init?.method ?? "GET");
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    const signature = headers.get("KALSHI-ACCESS-SIGNATURE") ?? "";
    if (signature) signatures.push(signature);
    const headerDump = JSON.stringify(Object.fromEntries(headers.entries()));
    assert.equal(headerDump.includes(keyId), true);
    if (url.pathname.endsWith("/account/limits")) {
      return Response.json({ usage_tier: "advanced" }, { status: 200, headers: { "KALSHI-ACCESS-SIGNATURE": "must-not-leak" } });
    }
    if (url.pathname.endsWith("/subaccounts/netting")) {
      return Response.json({
        error: { code: "authentication_error", message: `login required ${keyId}` },
      }, { status: 401, headers: { Authorization: "Bearer secret" } });
    }
    if (url.pathname.endsWith("/subaccounts/balances")) {
      return Response.json({
        code: "forbidden",
        message: "not allowed\n-----BEGIN PRIVATE KEY-----\nsecret",
      }, { status: 403 });
    }
    return Response.json({ message: "missing" }, { status: 404 });
  };
  try {
    const evidence = await readProvisioningInventory(fetchImpl);
    assert.equal(methods.every((method) => method === "GET"), true);
    assert.equal(methods.length, 4);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.provisioningAuthenticated, true);
    assert.deepEqual(evidence.diagnostics.map((row) => row.endpoint), [
      "/trade-api/v2/account/limits",
      "/trade-api/v2/portfolio/subaccounts/netting",
      "/trade-api/v2/portfolio/subaccounts/balances",
      "/trade-api/v2/portfolio/balance?subaccount=1&exchange_index=2",
    ]);
    assert.deepEqual(evidence.diagnostics.map((row) => [row.httpStatus, row.ok, row.errorCode, row.errorMessage]), [
      [200, true, null, null],
      [401, false, "authentication_error", null],
      [403, false, "forbidden", null],
      [404, false, null, "missing"],
    ]);
    assert.equal(evidence.credentialIdPresent, true);
    assert.equal(evidence.privateKeyPresent, true);
    assert.equal(evidence.privateKeyParsed, true);
    assert.equal(evidence.privateKeyType, "rsa");
    assert.equal(evidence.signatureGenerated, true);
    assert.equal(evidence.fetchAttempted, true);
    assert.equal(evidence.localFailureStage, null);
    assert.equal(evidence.localErrorName, null);
    const status = sanitizePublic(unprovenSubaccountStatus(evidence));
    assert.equal(status.reason, "subaccount_inventory_unproven");
    assert.equal(status.privateKeyParsed, true);
    assert.equal(status.fetchAttempted, true);
    const published = JSON.stringify(status);
    assert.equal(published.includes(keyId), false);
    assert.equal(published.includes("PRIVATE KEY"), false);
    assert.equal(published.includes("Bearer"), false);
    assert.equal(published.includes("KALSHI-ACCESS"), false);
    assert.equal(published.includes("Authorization"), false);
    assert.equal(signatures.length > 0, true);
    assert.equal(signatures.some((value) => published.includes(value)), false);
    await assert.rejects(readReviewedSubaccountEvidence(fetchImpl), /Reviewed subaccount inventory GET failed/);
    assert.equal(subaccountCreationDecision({
      confirmation: SUBACCOUNT_CREATE_CONFIRMATION,
      status,
      inventoryProven: false,
      priorAttempt: "uncertain",
      workerRunning: false,
      productionAccountExists: false,
      nodeEnv: "production",
      kalshiEnvironment: "production",
      provisioningConfigured: true,
    }).reason, "subaccount_creation_uncertain_no_retry");
  } finally {
    if (savedProvisioningId === undefined) delete process.env.KALSHI_PROVISIONING_API_KEY_ID;
    else process.env.KALSHI_PROVISIONING_API_KEY_ID = savedProvisioningId;
    if (savedProvisioningKey === undefined) delete process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
    else process.env.KALSHI_PROVISIONING_PRIVATE_KEY = savedProvisioningKey;
  }
});

test("local RSA signer diagnostic names the failed stage and does not fetch or expose secrets", async () => {
  const savedProvisioningId = process.env.KALSHI_PROVISIONING_API_KEY_ID;
  const savedProvisioningKey = process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
  const keyId = "unit-test-provisioning-id";
  let fetches = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    fetches += 1;
    assert.equal(init?.method, "GET");
    throw new TypeError("socket closed");
  };
  try {
    process.env.KALSHI_PROVISIONING_API_KEY_ID = keyId;
    delete process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
    const missing = sanitizePublic(unprovenSubaccountStatus(await readProvisioningInventory(fetchImpl)));
    assert.equal(fetches, 0);
    assert.equal(missing.credentialIdPresent, true);
    assert.equal(missing.privateKeyPresent, false);
    assert.equal(missing.privateKeyParsed, false);
    assert.equal(missing.privateKeyType, null);
    assert.equal(missing.signatureGenerated, false);
    assert.equal(missing.fetchAttempted, false);
    assert.equal(missing.localFailureStage, "credential_read");
    assert.equal(missing.localErrorName, null);
    assert.equal(missing.diagnostics?.every((row) => row.method === "GET" && row.httpStatus === null), true);

    const fragment = "not-a-real-key-body";
    process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
      `-----BEGIN RSA PRIVATE KEY-----\n${fragment}\n-----END RSA PRIVATE KEY-----`;
    const unreadable = sanitizePublic(unprovenSubaccountStatus(await readProvisioningInventory(fetchImpl)));
    assert.equal(fetches, 0);
    assert.equal(unreadable.privateKeyPresent, true);
    assert.equal(unreadable.privateKeyParsed, false);
    assert.equal(unreadable.fetchAttempted, false);
    assert.equal(unreadable.signatureGenerated, false);
    assert.equal(unreadable.localFailureStage, "private_key_parse");
    assert.match(unreadable.localErrorName ?? "Error", /^[A-Za-z_][A-Za-z0-9_]{0,31}$/);
    const hidden = JSON.stringify(unreadable);
    assert.equal(hidden.includes(fragment), false);
    assert.equal(hidden.includes(keyId), false);
    assert.equal(hidden.includes("BEGIN"), false);
    assert.equal(hidden.includes("DECODER"), false);

    const { privateKey: ecKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    process.env.KALSHI_PROVISIONING_PRIVATE_KEY = ecKey.export({ type: "pkcs8", format: "pem" }).toString();
    const other = await readProvisioningInventory(fetchImpl);
    assert.equal(fetches, 0);
    assert.equal(other.privateKeyParsed, true);
    assert.equal(other.privateKeyType, "other");
    assert.equal(other.signatureGenerated, false);
    assert.equal(other.fetchAttempted, false);
    assert.equal(other.localFailureStage, "key_type_validation");

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    assert.equal(pkcs1.includes("BEGIN RSA PRIVATE KEY"), true);
    process.env.KALSHI_PROVISIONING_PRIVATE_KEY = pkcs1;
    const fetched = await readProvisioningInventory(fetchImpl);
    assert.equal(fetches, 4);
    assert.equal(fetched.privateKeyParsed, true);
    assert.equal(fetched.privateKeyType, "rsa");
    assert.equal(fetched.signatureGenerated, true);
    assert.equal(fetched.fetchAttempted, true);
    assert.equal(fetched.localFailureStage, "fetch");
    assert.equal(fetched.localErrorName, "TypeError");
    assert.equal(fetched.diagnostics.every((row) => row.method === "GET" && row.httpStatus === null && row.errorCode === "request_failed"), true);
    assert.equal(JSON.stringify(fetched).includes(keyId), false);
    assert.equal(JSON.stringify(fetched).includes("BEGIN RSA PRIVATE KEY"), false);
    assert.equal(subaccountCreationDecision({
      confirmation: SUBACCOUNT_CREATE_CONFIRMATION,
      status: unprovenSubaccountStatus(fetched),
      inventoryProven: false,
      priorAttempt: "uncertain",
      workerRunning: false,
      productionAccountExists: false,
      nodeEnv: "production",
      kalshiEnvironment: "production",
      provisioningConfigured: true,
    }).reason, "subaccount_creation_uncertain_no_retry");
  } finally {
    if (savedProvisioningId === undefined) delete process.env.KALSHI_PROVISIONING_API_KEY_ID;
    else process.env.KALSHI_PROVISIONING_API_KEY_ID = savedProvisioningId;
    if (savedProvisioningKey === undefined) delete process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
    else process.env.KALSHI_PROVISIONING_PRIVATE_KEY = savedProvisioningKey;
  }
});

test("scoped balance scalar proves an already agreed (1,2) pair without an identity echo", () => {
  const limits = { usage_tier: "advanced" };
  const row = (subaccount: number, exchange: number) => ({
    subaccount_number: subaccount,
    exchange_index: exchange,
    enabled: false,
    balance: "0.0000",
    updated_ts: 1790422846,
  });
  const agreedRows = [row(0, 0), row(1, 0), row(1, 2)];
  const views = (rows: ReturnType<typeof row>[]) => ({
    nettingPayload: { netting_configs: rows },
    balancePayload: { subaccount_balances: rows },
  });
  const proven = assembleSubaccountStatus({
    ...views(agreedRows),
    scopedPayload: { balance_dollars: "0.0000" },
    limitsPayload: limits,
    attemptState: "uncertain",
  });
  assert.equal(scopedPairBalanceProven({ balance: 0 }, 1, 2), true);
  assert.equal(scopedPairBalanceProven({ balance_breakdown: [{ balance: "0.0000" }] }, 1, 2), false);
  assert.equal(proven.reason, "ready_for_clean_boundary");
  assert.equal(proven.subaccount1Exists, true);
  assert.equal(proven.subaccount1Exchange2Exists, true);
  assert.equal(proven.matchingRows, 1);
  assert.deepEqual(proven.numberedSubaccounts, [0, 1]);
  assert.deepEqual(proven.exchangeIndexesForSubaccount1, [0, 2]);
  assert.equal(proven.readyForCleanBoundary, true);
  assert.equal(proven.apiTier, "advanced");

  const echoed = assembleSubaccountStatus({
    ...views(agreedRows),
    scopedPayload: { balance: "1.250000" },
    limitsPayload: limits,
    attemptState: "none",
  });
  assert.equal(echoed.reason, "ready_for_clean_boundary");
  assert.equal(echoed.readyForCleanBoundary, true);

  const missingNetting = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [row(0, 0), row(1, 0)] },
    balancePayload: { subaccount_balances: [row(0, 0), row(1, 0)] },
    scopedPayload: { balance_dollars: "0.0000" },
    limitsPayload: limits,
    attemptState: "none",
  });
  assert.equal(missingNetting.readyForCleanBoundary, false);
  assert.equal(missingNetting.subaccount1Exchange2Exists, false);
  assert.notEqual(missingNetting.reason, "ready_for_clean_boundary");

  const missingBalance = assembleSubaccountStatus({
    nettingPayload: { netting_configs: agreedRows },
    balancePayload: { subaccount_balances: [row(0, 0), row(1, 0)] },
    scopedPayload: { balance_dollars: "0.0000" },
    limitsPayload: limits,
    attemptState: "none",
  });
  assert.equal(missingBalance.readyForCleanBoundary, false);
  assert.notEqual(missingBalance.reason, "ready_for_clean_boundary");

  const duplicated = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [row(1, 2), row(1, 2)] },
    balancePayload: { subaccount_balances: [row(1, 2), row(1, 2)] },
    scopedPayload: { balance_dollars: "0.0000" },
    limitsPayload: limits,
    attemptState: "none",
  });
  assert.equal(duplicated.reason, "subaccount_inventory_duplicated");
  assert.equal(duplicated.readyForCleanBoundary, false);

  const contradictory = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [row(1, 2)] },
    balancePayload: { subaccount_balances: [row(1, 2), row(2, 2)] },
    scopedPayload: { balance_dollars: "0.0000" },
    limitsPayload: limits,
    attemptState: "none",
  });
  assert.equal(contradictory.reason, "subaccount_inventory_contradictory");
  assert.equal(contradictory.readyForCleanBoundary, false);

  const malformed = assembleSubaccountStatus({
    ...views(agreedRows),
    scopedPayload: { balance_breakdown: [{ balance: "0.0000", subaccount_number: 1, exchange_index: 2 }] },
    limitsPayload: limits,
    attemptState: "uncertain",
  });
  assert.equal(malformed.reason, "scoped_balance_identity_unproven");
  assert.equal(malformed.subaccount1Exchange2Exists, false);
  assert.equal(malformed.readyForCleanBoundary, false);
  const badScalar = assembleSubaccountStatus({
    ...views(agreedRows),
    scopedPayload: { balance_dollars: "not-a-balance" },
    limitsPayload: limits,
    attemptState: "uncertain",
  });
  assert.equal(badScalar.reason, "scoped_balance_identity_unproven");
  assert.equal(badScalar.readyForCleanBoundary, false);

  const scalarAlone = assembleSubaccountStatus({
    nettingPayload: { netting_configs: [row(0, 0)] },
    balancePayload: { subaccount_balances: [row(0, 0)] },
    scopedPayload: { balance_dollars: "25.0000" },
    limitsPayload: limits,
    attemptState: "none",
  });
  assert.equal(scalarAlone.readyForCleanBoundary, false);
  assert.equal(scalarAlone.subaccount1Exists, false);

  const creation = {
    confirmation: SUBACCOUNT_CREATE_CONFIRMATION,
    status: proven,
    inventoryProven: true,
    workerRunning: false,
    productionAccountExists: false,
    nodeEnv: "production" as const,
    kalshiEnvironment: "production" as const,
    provisioningConfigured: true,
  };
  assert.equal(subaccountCreationDecision({ ...creation, priorAttempt: "none" }).reason, "subaccount_1_already_exists");
  assert.equal(subaccountCreationDecision({ ...creation, priorAttempt: "uncertain" }).reason, "subaccount_creation_uncertain_no_retry");
  assert.equal(subaccountCreationDecision({ ...creation, priorAttempt: "none" }).proceed, false);
});

test("clean-pair block returns only the named subaccount transfer", () => {
  const transferId = "391a20ac-5332-41d6-b015-9b8720e4e5c1";
  const reason = `clean_prior_subaccount_transfer:${transferId}`;
  const detail = blockingSubaccountTransferDetail(reason, [
    {
      feed: "subaccount_transfer",
      id: "11111111-1111-4111-8111-111111111111",
      classification: "pair",
      occurredAt: "2026-10-10T00:00:00.000Z",
      details: {
        from_subaccount: "0",
        to_subaccount: "1",
        exchange_index: "2",
        amount_cents: "1",
        status: "applied",
        created_ts: "2026-10-10T00:00:00.000Z",
        signature: "must-not-leak",
      },
    },
    {
      feed: "subaccount_transfer",
      id: transferId,
      classification: "pair",
      occurredAt: null,
      details: {
        from_subaccount: "0",
        to_subaccount: "1",
        exchange_index: "2",
        amount_cents: "2500",
        amount_dollars: "25.00",
        amount: "9.00",
        status: "applied",
        created_time: "2026-10-10T15:37:52.251Z",
        signature: "must-not-leak",
        authorization: "must-not-leak",
      },
    },
  ]);
  assert.deepEqual(detail, {
    transferId,
    fromSubaccount: 0,
    toSubaccount: 1,
    exchangeIndex: 2,
    amountCents: 2500,
    amountDollars: "25.00",
    status: "applied",
    createdAt: "2026-10-10T15:37:52.251Z",
    missingFields: [],
  });
  const published = JSON.stringify(detail);
  assert.equal(published.includes("must-not-leak"), false);
  assert.equal(published.includes("11111111-1111-4111-8111-111111111111"), false);
  assert.equal(published.includes("9.00"), false);
  assert.equal(blockingSubaccountTransferDetail("clean_pair_inventory_cash_not_zero", []), null);
  assert.equal(blockingSubaccountTransferDetail(reason, [{
    feed: "subaccount_transfer",
    id: transferId,
    classification: "elsewhere",
    occurredAt: "2026-10-10T15:37:52.251Z",
    details: {
      from_subaccount: "0", to_subaccount: "1", exchange_index: "2",
      amount_cents: "2500", status: "applied",
    },
  }]), null);
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const body = store.slice(store.indexOf("async function captureRailwayBoundary"), store.indexOf("async function fundRailwayPair"));
  assert.equal(body.includes("blocked: true"), true);
  assert.equal(body.includes("zeroPriorPairTransfers"), true);
  assert.equal(body.includes('method: "POST"'), false);
  assert.equal(body.includes("/portfolio/orders"), false);
  assert.equal(body.includes("postOneShotPairFunding"), false);
  const account = readFileSync("src/lib/kalshiAccountClient.ts", "utf8");
  const digestAt = account.indexOf("const evidenceDigest = clean ? digestOf({");
  const digest = account.slice(digestAt, account.indexOf("}) : null;", digestAt));
  assert.equal(digest.includes("blockingTransfer"), false);
  assert.equal(digest.includes("zeroPriorPairTransfers"), true);
  assert.equal(account.includes("clean_prior_subaccount_transfer:${item.record.id}"), true);
});

test("partial blocking transfer keeps its identity when amount and status are absent", () => {
  const transferId = "391a20ac-5332-41d6-b015-9b8720e4e5c1";
  const reason = `clean_prior_subaccount_transfer:${transferId}`;
  const detail = blockingSubaccountTransferDetail(reason, [{
    feed: "subaccount_transfer",
    id: transferId,
    classification: "pair",
    occurredAt: null,
    details: {
      from_subaccount: "0",
      to_subaccount: null,
      exchange_index: null,
      amount_cents: null,
      amount: "25.0000",
      status: null,
      created_at: "2026-10-10T15:37:52.251Z",
      signature: "must-not-leak",
    },
  }]);
  assert.deepEqual(detail, {
    transferId,
    fromSubaccount: 0,
    toSubaccount: null,
    exchangeIndex: null,
    amountCents: null,
    amountDollars: "25.0000",
    status: null,
    createdAt: "2026-10-10T15:37:52.251Z",
    missingFields: ["toSubaccount", "exchangeIndex", "amountCents", "status"],
  });
  assert.equal(JSON.stringify(detail).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(detail).includes("11111111"), false);
});

test("intentional pre-boundary $25 round trip is acknowledged only for its two transfers", () => {
  const inboundId = PRE_BOUNDARY_INBOUND_TRANSFER_ID;
  const created = "2026-10-10T16:24:20.000Z";
  const leg = (id: string, from: number, to: number, cents = 2500, exchange = 2) => ({
    feed: "subaccount_transfer",
    id,
    classification: "pair",
    occurredAt: created,
    details: {
      from_subaccount: String(from),
      to_subaccount: String(to),
      exchange_index: String(exchange),
      amount_cents: String(cents),
      created_ts: created,
    },
  });
  const inbound = leg(inboundId, 0, 1);
  const outbound = leg(PRE_BOUNDARY_OUTBOUND_TRANSFER_ID, 1, 0);
  const exact = {
    availableCashMicros: "0" as const,
    inventoryCashMicros: "0" as const,
    portfolioValueMicros: "0" as const,
    zeroPositions: true,
    zeroOrders: true,
    zeroFills: true,
    zeroSettlements: true,
    reasons: [
      `clean_prior_subaccount_transfer:${inboundId}`,
      `clean_prior_subaccount_transfer:${PRE_BOUNDARY_OUTBOUND_TRANSFER_ID}`,
    ],
    records: [inbound, outbound],
  };
  const reasonOf = (result: { ok: true } | { ok: false; reason: string }) => result.ok ? "" : result.reason;
  const proven = provePreBoundaryRoundTrip(exact);
  assert.equal(proven.ok, true);
  if (!proven.ok) return;
  assert.equal(proven.roundTrip.inboundTransferId, inboundId);
  assert.equal(proven.roundTrip.outboundTransferId, PRE_BOUNDARY_OUTBOUND_TRANSFER_ID);
  assert.equal(proven.roundTrip.amountCents, 2500);
  assert.match(proven.roundTrip.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(provePreBoundaryRoundTrip({
    ...exact,
    records: [leg(inboundId, 0, 1), leg("bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, 0)],
  }).ok, false);
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...exact,
    records: [outbound],
  })), "pre_boundary_inbound_transfer_not_proven");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...exact,
    records: [inbound, outbound, leg("cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee", 0, 1)],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...exact,
    records: [leg(inboundId, 0, 1, 2499), outbound],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...exact,
    records: [leg(inboundId, 0, 1, 2500, 0), outbound],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...exact,
    records: [leg(inboundId, 2, 1), outbound],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...exact,
    records: [inbound, outbound, leg("dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, 0, 100)],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...exact, zeroOrders: false })), "pre_boundary_order_present");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...exact, zeroPositions: false })), "pre_boundary_position_present");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...exact, zeroFills: false })), "pre_boundary_fill_present");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...exact, zeroSettlements: false })), "pre_boundary_settlement_present");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...exact, availableCashMicros: "1" })), "pre_boundary_available_cash_not_zero");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...exact, inventoryCashMicros: "1" })), "pre_boundary_inventory_cash_not_zero");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...exact, portfolioValueMicros: "1" })), "pre_boundary_portfolio_value_not_zero");
  const acknowledged = {
    inboundTransferId: proven.roundTrip.inboundTransferId,
    outboundTransferId: proven.roundTrip.outboundTransferId,
  };
  const later = "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const waived = selectBlockingCleanReasons([
    ...exact.reasons,
    `clean_prior_subaccount_transfer:${later}`,
  ], acknowledged);
  assert.deepEqual(waived, [`clean_prior_subaccount_transfer:${later}`]);
  assert.deepEqual(selectBlockingCleanReasons(exact.reasons, null), exact.reasons);
  const changed = provePreBoundaryRoundTrip({
    ...exact,
    records: [leg(inboundId, 0, 1), { ...outbound, occurredAt: "2026-10-10T16:24:21.000Z", details: { ...outbound.details, created_ts: "2026-10-10T16:24:21.000Z" } }],
  });
  assert.equal(changed.ok, true);
  if (changed.ok) assert.notEqual(changed.roundTrip.evidenceDigest, proven.roundTrip.evidenceDigest);
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const body = store.slice(store.indexOf("async function acknowledgePreBoundaryRoundTrip"), store.indexOf("async function fundRailwayPair"));
  assert.equal(body.includes("captureCleanPairSnapshot"), true);
  assert.equal(body.includes("INSERT INTO strata_pre_boundary_transfer_acknowledgment"), true);
  assert.equal(body.includes("pre_boundary_round_trip_already_acknowledged"), true);
  assert.equal(body.includes('method: "POST"'), false);
  assert.equal(body.includes("postOneShotPairFunding"), false);
  assert.equal(body.includes("planCommission"), false);
  assert.equal(body.includes("planArm"), false);
  assert.equal(body.includes("/portfolio/orders"), false);
  assert.equal(body.includes("LIVE_EXECUTION_ENABLED"), false);
  const account = readFileSync("src/lib/kalshiAccountClient.ts", "utf8");
  const digestAt = account.indexOf("const evidenceDigest = clean ? digestOf({");
  const digest = account.slice(digestAt, account.indexOf("}) : null;", digestAt));
  assert.equal(digest.includes("acknowledgedPreBoundaryRoundTrip"), true);
  assert.equal(digest.includes("inboundTransferId"), true);
  assert.equal(digest.includes("outboundTransferId"), true);
  assert.equal(digest.includes("evidenceDigest"), true);
  const migration = readFileSync("../../lib/db/drizzle/0006_strata_pre_boundary_transfer_acknowledgment.sql", "utf8");
  assert.equal(migration.includes("UNIQUE (round_trip_key)"), true);
  assert.equal(migration.includes("DELETE"), false);
  assert.equal(migration.includes("private_key"), false);
});

test("unrecognized round-trip transfers are sanitized and still block acknowledgment", () => {
  const inboundId = PRE_BOUNDARY_INBOUND_TRANSFER_ID;
  const created = "2026-10-10T16:24:20.000Z";
  const leg = (id: string, from: number, to: number, cents = 2500, exchange = 2) => ({
    feed: "subaccount_transfer",
    id,
    classification: "pair",
    occurredAt: created,
    details: {
      from_subaccount: String(from),
      to_subaccount: String(to),
      exchange_index: String(exchange),
      amount_cents: String(cents),
      created_ts: created,
      signature: "must-not-leak",
    },
  });
  const extraId = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const blocked = provePreBoundaryRoundTrip({
    availableCashMicros: "0",
    inventoryCashMicros: "0",
    portfolioValueMicros: "0",
    zeroPositions: true,
    zeroOrders: true,
    zeroFills: true,
    zeroSettlements: true,
    reasons: [
      `clean_prior_subaccount_transfer:${inboundId}`,
      `clean_prior_subaccount_transfer:${PRE_BOUNDARY_OUTBOUND_TRANSFER_ID}`,
      `clean_prior_subaccount_transfer:${extraId}`,
    ],
    records: [
      leg(inboundId, 0, 1),
      leg(PRE_BOUNDARY_OUTBOUND_TRANSFER_ID, 1, 0),
      leg(extraId, 1, 0, 100),
      {
        feed: "subaccount_transfer",
        id: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        classification: "elsewhere",
        occurredAt: created,
        details: {
          from_subaccount: "3",
          to_subaccount: "4",
          exchange_index: "0",
          amount_cents: "5",
          created_ts: created,
          signature: "must-not-leak",
        },
      },
      {
        feed: "position",
        id: "not-a-transfer",
        classification: "pair",
        occurredAt: created,
        details: { signature: "must-not-leak" },
      },
    ],
  });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.reason, "pre_boundary_unrecognized_transfer");
  assert.deepEqual(blocked.unrecognizedTransfers?.map((row) => row.transferId), [extraId]);
  assert.deepEqual(blocked.roundTripCandidates?.inbound.map((row) => row.transferId), [inboundId]);
  assert.deepEqual(blocked.roundTripCandidates?.outbound.map((row) => row.transferId), [PRE_BOUNDARY_OUTBOUND_TRANSFER_ID]);
  const extra = blocked.unrecognizedTransfers?.[0];
  assert.equal(extra?.fromSubaccount, 1);
  assert.equal(extra?.toSubaccount, 0);
  assert.equal(extra?.exchangeIndex, 2);
  assert.equal(extra?.amountCents, 100);
  assert.equal(extra?.amountDollars, null);
  const published = JSON.stringify(blocked);
  assert.equal(published.includes("must-not-leak"), false);
  assert.equal(published.includes("ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee"), false);
  assert.equal(published.includes("not-a-transfer"), false);
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const body = store.slice(store.indexOf("async function acknowledgePreBoundaryRoundTrip"), store.indexOf("async function fundRailwayPair"));
  const blockedReturn = body.indexOf("pre_boundary_unrecognized_transfer");
  const insertAt = body.indexOf("INSERT INTO strata_pre_boundary_transfer_acknowledgment");
  assert.equal(blockedReturn > -1 && insertAt > blockedReturn, true);
  assert.equal(body.includes("unrecognizedTransfers"), true);
  assert.equal(body.includes("roundTripCandidates"), true);
});

test("old account-wide cross-exchange evidence does not block the exact pre-boundary round trip", () => {
  const scanStartedAt = "2026-10-10T22:00:00.000Z";
  const inboundCreated = "2026-09-27T01:08:49.000Z";
  const outboundCreated = "2026-10-10T16:24:20.000Z";
  const leg = (
    id: string,
    from: number,
    to: number,
    cents = 2500,
    exchange = 2,
    created = outboundCreated,
  ) => ({
    feed: "subaccount_transfer" as const,
    id,
    classification: "pair" as const,
    occurredAt: created,
    details: {
      from_subaccount: String(from),
      to_subaccount: String(to),
      exchange_index: String(exchange),
      amount_cents: String(cents),
      created_ts: created,
    },
  });
  const oldCross = (n: number) => {
    const created = new Date(Date.UTC(2026, 0, n, 0, 0, 0)).toISOString();
    const source = n % 2 === 0 ? 0 : 2;
    const destination = source === 0 ? 2 : 0;
    return {
      feed: "cross_exchange_transfer" as const,
      id: `old-account-wide-cross-${n}`,
      classification: "ambiguous" as const,
      occurredAt: created,
      sourceExchangeIndex: source,
      destinationExchangeIndex: destination,
      subaccountNumber: null,
      details: {
        source_subaccount: null,
        destination_subaccount: null,
        source_exchange_shard: String(source),
        destination_exchange_shard: String(destination),
        amount: "25.0000",
        created_ts: created,
      },
    };
  };
  const inbound = leg(PRE_BOUNDARY_INBOUND_TRANSFER_ID, 0, 1, 2500, 2, inboundCreated);
  const outbound = leg(PRE_BOUNDARY_OUTBOUND_TRANSFER_ID, 1, 0);
  const historical = Array.from({ length: 9 }, (_, index) => oldCross(index + 1));
  const elsewhereCross = {
    feed: "cross_exchange_transfer" as const,
    id: "elsewhere-cross",
    classification: "elsewhere" as const,
    occurredAt: "2026-01-01T00:00:00.000Z",
    details: {
      source_subaccount: "3",
      destination_subaccount: "4",
      source_exchange_shard: "0",
      destination_exchange_shard: "1",
      created_ts: "2026-01-01T00:00:00.000Z",
    },
  };
  const records = [inbound, outbound, ...historical, elsewhereCross];
  const base = {
    availableCashMicros: "0" as const,
    inventoryCashMicros: "0" as const,
    portfolioValueMicros: "0" as const,
    zeroPositions: true,
    zeroOrders: true,
    zeroFills: true,
    zeroSettlements: true,
    scanStartedAt,
    reasons: [
      `clean_prior_subaccount_transfer:${PRE_BOUNDARY_INBOUND_TRANSFER_ID}`,
      `clean_prior_subaccount_transfer:${PRE_BOUNDARY_OUTBOUND_TRANSFER_ID}`,
    ],
    records,
  };
  const reasonOf = (result: { ok: true } | { ok: false; reason: string }) => result.ok ? "" : result.reason;
  const proven = provePreBoundaryRoundTrip(base);
  assert.equal(proven.ok, true);
  if (!proven.ok) return;
  assert.equal(proven.roundTrip.inboundTransferId, PRE_BOUNDARY_INBOUND_TRANSFER_ID);
  assert.equal(proven.roundTrip.outboundTransferId, PRE_BOUNDARY_OUTBOUND_TRANSFER_ID);
  assert.equal(proven.roundTrip.inboundCreatedAt, inboundCreated);
  assert.equal(proven.roundTrip.outboundCreatedAt, outboundCreated);
  assert.equal(proven.roundTrip.amountCents, 2500);
  assert.equal(historical.every((row) => row.classification === "ambiguous"), true);
  assert.equal(elsewhereCross.classification, "elsewhere");
  assert.equal(records.filter((row) => row.id.startsWith("old-account-wide-cross-")).length, 9);

  const during = {
    ...oldCross(1),
    id: "during-scan-cross",
    occurredAt: scanStartedAt,
    details: { ...oldCross(1).details, created_ts: scanStartedAt },
  };
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...base,
    records: [inbound, outbound, during],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...base,
    reasons: [...base.reasons, "clean_cross_exchange_transfer_during_snapshot_scan:during-scan-cross"],
    records: [inbound, outbound, during],
  })), "clean_cross_exchange_transfer_during_snapshot_scan:during-scan-cross");

  const tied = {
    ...oldCross(2),
    id: "tied-to-subaccount-1",
    details: { ...oldCross(2).details, source_subaccount: "1" },
  };
  assert.equal(tied.classification, "ambiguous");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...base,
    records: [inbound, outbound, tied],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...base,
    reasons: [...base.reasons, "clean_prior_cross_exchange_transfer:tied-to-subaccount-1"],
    records: [inbound, outbound, tied],
  })), "clean_prior_cross_exchange_transfer:tied-to-subaccount-1");

  const timeless = {
    ...oldCross(3),
    id: "timestampless-cross",
    occurredAt: null,
    details: { ...oldCross(3).details, created_ts: null },
  };
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...base,
    records: [inbound, outbound, timeless],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...base,
    reasons: [...base.reasons, "clean_cross_exchange_transfer_timestamp_missing:timestampless-cross"],
    records: [inbound, outbound, timeless],
  })), "clean_cross_exchange_transfer_timestamp_missing:timestampless-cross");

  const thirdId = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const third = provePreBoundaryRoundTrip({
    ...base,
    reasons: [...base.reasons, `clean_prior_subaccount_transfer:${thirdId}`],
    records: [...records, leg(thirdId, 1, 0, 100)],
  });
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.reason, "pre_boundary_unrecognized_transfer");
  assert.deepEqual(third.unrecognizedTransfers?.map((row) => row.transferId), [thirdId]);
  assert.equal(JSON.stringify(third).includes("old-account-wide-cross-1"), false);

  const wrongInbound = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...base,
    reasons: [
      `clean_prior_subaccount_transfer:${wrongInbound}`,
      `clean_prior_subaccount_transfer:${PRE_BOUNDARY_OUTBOUND_TRANSFER_ID}`,
    ],
    records: [leg(wrongInbound, 0, 1, 2500, 2, inboundCreated), outbound, ...historical],
  })), "pre_boundary_unrecognized_transfer");
  const wrongOutbound = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(reasonOf(provePreBoundaryRoundTrip({
    ...base,
    records: [inbound, leg(wrongOutbound, 1, 0), ...historical],
  })), "pre_boundary_unrecognized_transfer");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, records: [outbound, ...historical] })), "pre_boundary_inbound_transfer_not_proven");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, records: [inbound, ...historical] })), "pre_boundary_outbound_transfer_mismatch");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, availableCashMicros: "1" })), "pre_boundary_available_cash_not_zero");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, inventoryCashMicros: "1" })), "pre_boundary_inventory_cash_not_zero");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, portfolioValueMicros: "1" })), "pre_boundary_portfolio_value_not_zero");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, zeroPositions: false })), "pre_boundary_position_present");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, zeroOrders: false })), "pre_boundary_order_present");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, zeroFills: false })), "pre_boundary_fill_present");
  assert.equal(reasonOf(provePreBoundaryRoundTrip({ ...base, zeroSettlements: false })), "pre_boundary_settlement_present");

  const waived = selectBlockingCleanReasons([
    ...base.reasons,
    `clean_prior_subaccount_transfer:${thirdId}`,
    "clean_prior_cross_exchange_transfer:tied-to-subaccount-1",
    "clean_cross_exchange_transfer_during_snapshot_scan:during-scan-cross",
    "clean_cross_exchange_transfer_timestamp_missing:timestampless-cross",
    "clean_ambiguous_cross_exchange_transfer:other-shard",
  ], {
    inboundTransferId: PRE_BOUNDARY_INBOUND_TRANSFER_ID,
    outboundTransferId: PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
  });
  assert.deepEqual(waived, [
    `clean_prior_subaccount_transfer:${thirdId}`,
    "clean_prior_cross_exchange_transfer:tied-to-subaccount-1",
    "clean_cross_exchange_transfer_during_snapshot_scan:during-scan-cross",
    "clean_cross_exchange_transfer_timestamp_missing:timestampless-cross",
    "clean_ambiguous_cross_exchange_transfer:other-shard",
  ]);
  const account = readFileSync("src/lib/kalshiAccountClient.ts", "utf8");
  assert.equal(account.includes("do not infer that it"), true);
  assert.equal(account.includes("records: canonicalRecords"), true);
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const reader = store.slice(store.indexOf("async function readStoredRoundTrip"), store.indexOf("async function captureRailwayBoundary"));
  assert.equal(reader.includes("PRE_BOUNDARY_INBOUND_TRANSFER_ID"), true);
  assert.equal(reader.includes("PRE_BOUNDARY_OUTBOUND_TRANSFER_ID"), true);
});

test("policy read returns draft limits and approval state without raw policy rows", () => {
  const read = policyReadFromRows({
    draft: {
      capital_limit_cents: 1000,
      max_entry_stake_cents: 500,
      max_entry_all_in_cents: 800,
      max_daily_loss_cents: 200,
      max_total_loss_cents: 400,
      max_quote_age_ms: 1500,
      max_fee_evidence_age_ms: 1500,
      policy_hash: "secret-hash",
      created_by: "secret-actor",
    },
    approvedCount: 1,
  });
  assert.deepEqual(read, {
    draft: {
      capitalLimitCents: 1000,
      maxEntryStakeCents: 500,
      maxEntryAllInCents: 800,
      maxDailyLossCents: 200,
      maxTotalLossCents: 400,
      maxQuoteAgeMs: 1500,
      maxFeeEvidenceAgeMs: 1500,
    },
    approved: true,
  });
  assert.equal(JSON.stringify(read).includes("secret-hash"), false);
  assert.equal(JSON.stringify(read).includes("secret-actor"), false);
  assert.equal(policyReadFromRows({ draft: null, approvedCount: 0 }).approved, false);
  assert.equal(policyReadFromRows({ draft: null, approvedCount: 2 }).approved, false);
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const body = store.slice(store.indexOf("async readPolicy()"), store.indexOf("async proposePolicy"));
  assert.equal(body.includes("policies:"), false);
  assert.equal(body.includes("SELECT *"), false);
});

test("INDEX2 replacement preserves the old attempt and allows one current-account POST", async () => {
  const ready = (): Index2ReplacementFacts => ({
    confirmation: STRATA_INDEX2_REPLACEMENT_CONFIRMATION,
    nodeEnv: "production",
    provisioningKeyIdPresent: true,
    provisioningPrivateKeyPresent: true,
    verifierKeyIdPresent: true,
    verifierPrivateKeyPresent: true,
    kalshiEnvironment: "production",
    provisioningCredentialValid: true,
    provisioningUnrestricted: true,
    provisioningScopesExact: true,
    verifierCredentialValid: true,
    sameAccountProven: true,
    tierEligible: true,
    pairProven: true,
    existingIndex2Name: false,
    priorAttempt: "uncertain",
    replacementAlreadyUsed: false,
    workerRunning: false,
    productionAccountExists: false,
    liveExecutionEnabled: undefined,
    v13ProductionExecutionEnabled: undefined,
  });
  assert.equal(index2ReplacementDecision(ready()).proceed, true);
  assert.equal(index2ReplacementDecision({ ...ready(), confirmation: STRATA_INDEX2_KEY_CONFIRMATION }).reason,
    "explicit_index2_replacement_confirmation_required");
  for (const [reason, patch] of [
    ["index2_credentials_not_same_account", { sameAccountProven: false }],
    ["index2_api_tier_below_advanced", { tierEligible: false }],
    ["index2_pair_not_proven", { pairProven: false }],
    ["index2_key_name_already_exists", { existingIndex2Name: true }],
    ["production_worker_running", { workerRunning: true }],
    ["production_account_exists", { productionAccountExists: true }],
    ["live_execution_enabled", { liveExecutionEnabled: "true" }],
    ["v13_production_execution_enabled", { v13ProductionExecutionEnabled: "true" }],
    ["index2_generation_uncertain_no_retry", { priorAttempt: "uncertain" as const, replacementAlreadyUsed: true }],
    ["index2_replacement_already_used", { priorAttempt: "response_received" as const, replacementAlreadyUsed: true }],
  ] as const) {
    const decision = index2ReplacementDecision({ ...ready(), ...patch });
    assert.equal(decision.proceed, false, reason);
    assert.equal(decision.reason, reason);
  }
  assert.equal(index2GenerationDecision({
    ...ready(),
    confirmation: STRATA_INDEX2_KEY_CONFIRMATION,
    priorAttempt: "uncertain",
  }).reason, "index2_generation_uncertain_no_retry");

  const sql = readFileSync("../../lib/db/drizzle/0005_strata_index2_key_attempt_supersession.sql", "utf8");
  assert.equal(/private_key/i.test(sql), false);
  assert.equal(/\bDELETE\b/i.test(sql), false);
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const replacement = store.slice(
    store.indexOf("export async function replaceRailwayIndex2Key"),
    store.indexOf("export function createDatabaseCommissioningPort"),
  );
  assert.equal(replacement.includes("generateStrataIndex2Key"), true);
  assert.equal(replacement.includes("private_key"), false);
  assert.equal(replacement.includes("DELETE"), false);
  assert.equal(replacement.includes("postOneShotPairFunding"), false);
  assert.equal(replacement.includes("/portfolio/orders"), false);
  assert.equal(replacement.includes("planCommission"), false);
  assert.equal(replacement.includes("planArm"), false);
  assert.equal(replacement.includes("LIVE_EXECUTION_ENABLED ="), false);

  const gate = memoryPort(emptySnapshot());
  gate.setIndex2Replacement({ priorAttempt: "uncertain" }, "uncertain");
  const first = await gate.port.replaceIndex2Key(STRATA_INDEX2_REPLACEMENT_CONFIRMATION);
  assert.equal(first.state, "uncertain");
  assert.equal(first.privateKeyPersisted, false);
  assert.equal(first.privateKey, undefined);
  assert.equal(gate.index2Posts(), 1);
  assert.equal(gate.index2Archive().length, 1);
  assert.equal(gate.index2Archive()[0]?.state, "uncertain");
  assert.equal(JSON.stringify(gate.index2Stored()).includes("not-a-key"), false);
  assert.equal(gate.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(gate.calls.some((call) => call.path.includes("order") || call.path.includes("fund") || call.path.includes("subaccount")), false);
  const retry = await gate.port.replaceIndex2Key(STRATA_INDEX2_REPLACEMENT_CONFIRMATION);
  assert.equal(retry.reason, "index2_generation_uncertain_no_retry");
  assert.equal(gate.index2Posts(), 1);
  assert.equal(gate.index2Archive().length, 1);
  assert.equal(gate.workerStarts(), 0);
});

test("status reconstructs dedicated signer verification from the current key-bound boundary", () => {
  const fingerprint = "ab".repeat(32);
  const digest = "cd".repeat(32);
  const keyId = "index2-current-key";
  const boundAt = new Date("2026-10-10T16:30:00.000Z");
  const ready = () => {
    const snapshot = emptySnapshot("2026-10-10T22:00:00.000Z");
    snapshot.signer = {
      configured: true,
      syntacticallyUsable: true,
      fingerprint,
      signedGetSucceeded: false,
      restrictedToPair: false,
      historyComplete: false,
      keyIdMasked: "****key",
    };
    snapshot.boundary = {
      exists: true,
      subaccount: 1,
      exchangeIndex: 2,
      state: "KEY_BOUND_VERIFIED",
      cleanZero: true,
      verified: true,
      fingerprintMatches: true,
      historyComplete: true,
      ambiguous: false,
    };
    return snapshot;
  };
  const binding = {
    currentApiKeyId: keyId,
    rowCount: 1,
    restrictedApiKeyId: keyId,
    restrictedKeyFingerprint: fingerprint,
    keyBoundAt: boundAt,
    keyBindingEvidenceDigest: digest,
  };
  const fresh = emptySnapshot();
  assert.equal(commissioningStatus(fresh).dedicatedSignerVerified, false);
  assert.equal(applyDurableDedicatedSigner(fresh, { ...binding, rowCount: 0 }), false);
  assert.equal(fresh.signer.signedGetSucceeded, false);

  const transient = ready();
  transient.signer.signedGetSucceeded = true;
  transient.signer.restrictedToPair = true;
  transient.signer.historyComplete = true;
  assert.equal(commissioningStatus(transient).dedicatedSignerVerified, true);
  assert.equal(commissioningStatus(transient).keyFingerprintVerified, true);

  const persisted = ready();
  assert.equal(applyDurableDedicatedSigner(persisted, binding), true);
  assert.equal(commissioningStatus(persisted).dedicatedSignerVerified, true);
  assert.equal(persisted.signer.signedGetSucceeded, true);
  assert.equal(persisted.signer.restrictedToPair, true);
  assert.equal(persisted.signer.historyComplete, true);
  const funded = ready();
  funded.boundary.state = "funded";
  assert.equal(applyDurableDedicatedSigner(funded, binding), true);

  const changedKey = ready();
  assert.equal(applyDurableDedicatedSigner(changedKey, { ...binding, currentApiKeyId: "replacement-key" }), false);
  assert.equal(commissioningStatus(changedKey).dedicatedSignerVerified, false);
  const changedFingerprint = ready();
  changedFingerprint.signer.fingerprint = "ef".repeat(32);
  assert.equal(applyDurableDedicatedSigner(changedFingerprint, binding), false);
  assert.equal(changedFingerprint.signer.signedGetSucceeded, false);
  const unusable = ready();
  unusable.signer.syntacticallyUsable = false;
  assert.equal(applyDurableDedicatedSigner(unusable, binding), false);

  const missingBoundAt = ready();
  assert.equal(applyDurableDedicatedSigner(missingBoundAt, { ...binding, keyBoundAt: null }), false);
  assert.equal(applyDurableDedicatedSigner(ready(), { ...binding, keyBoundAt: "" }), false);
  assert.equal(applyDurableDedicatedSigner(ready(), { ...binding, keyBindingEvidenceDigest: null }), false);
  assert.equal(applyDurableDedicatedSigner(ready(), { ...binding, keyBindingEvidenceDigest: "not-a-digest" }), false);
  assert.equal(applyDurableDedicatedSigner(ready(), { ...binding, keyBindingEvidenceDigest: "A".repeat(64) }), false);

  const wrongSubaccount = ready();
  wrongSubaccount.boundary.subaccount = 2;
  assert.equal(applyDurableDedicatedSigner(wrongSubaccount, binding), false);
  const wrongExchange = ready();
  wrongExchange.boundary.exchangeIndex = 0;
  assert.equal(applyDurableDedicatedSigner(wrongExchange, binding), false);
  const createdClean = ready();
  createdClean.boundary.state = "CREATED_CLEAN";
  assert.equal(applyDurableDedicatedSigner(createdClean, binding), false);
  const unverified = ready();
  unverified.boundary.verified = false;
  assert.equal(applyDurableDedicatedSigner(unverified, binding), false);

  const incomplete = ready();
  incomplete.boundary.historyComplete = false;
  assert.equal(applyDurableDedicatedSigner(incomplete, binding), false);
  assert.equal(commissioningStatus(incomplete).dedicatedSignerVerified, false);

  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const readBody = store.slice(
    store.indexOf("export async function readCommissioningSnapshot"),
    store.indexOf("export async function probeDedicatedSigner"),
  );
  assert.equal(readBody.includes("applyDurableDedicatedSigner"), true);
  assert.equal(readBody.includes('hasOwnProperty.call(signerPatch, "signedGetSucceeded")'), true);
  assert.equal(readBody.includes("fetch("), false);
  assert.equal(readBody.includes("probeDedicatedSigner"), false);
  assert.equal(readBody.includes("postOneShotPairFunding"), false);
  assert.equal(readBody.includes('method: "POST"'), false);
  assert.equal(readBody.includes('method: "DELETE"'), false);
  assert.equal(readBody.includes("/portfolio/orders"), false);
  const port = store.slice(store.indexOf("export function createDatabaseCommissioningPort"));
  const readPort = port.slice(port.indexOf("read:"), port.indexOf("readSubaccountStatus"));
  assert.equal(readPort.includes("readCommissioningSnapshot"), true);
  assert.equal(readPort.includes("probeDedicatedSigner"), false);
  assert.equal(readPort.includes("fundRailwayPair"), false);
  const verify = port.slice(port.indexOf("async verifySigner"), port.indexOf("verifyBoundary"));
  assert.equal(verify.includes("signedGetSucceeded: probe.signedGetSucceeded"), true);
  assert.equal(verify.includes("restrictedToPair: probe.signedGetSucceeded"), true);
  const route = readFileSync("src/routes/strataCommissioning.ts", "utf8");
  const statusRoute = route.slice(route.indexOf('router.get("/status"'), route.indexOf('router.post("/verify-signer"'));
  assert.equal(statusRoute.includes("port.read()"), true);
  assert.equal(statusRoute.includes("verifySigner"), false);
  assert.equal(statusRoute.includes("fund"), false);
  assert.equal(statusRoute.includes("/portfolio/orders"), false);
});

test("funding reconciliation selects only the post-attempt transfer and never retries", () => {
  const attemptedAt = "2026-10-11T04:00:00.000Z";
  const responseReceivedAt = "2026-10-11T04:00:02.000Z";
  const historical = {
    transferId: PRE_BOUNDARY_INBOUND_TRANSFER_ID,
    fromSubaccount: 0,
    toSubaccount: 1,
    exchangeIndex: 2,
    amountCents: 2500,
    occurredAt: "2026-09-27T01:08:49.000Z",
  };
  const outbound = {
    transferId: PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
    fromSubaccount: 1,
    toSubaccount: 0,
    exchangeIndex: 2,
    amountCents: 2500,
    occurredAt: "2026-10-10T16:24:20.000Z",
  };
  const currentId = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const current = {
    transferId: currentId,
    fromSubaccount: 0,
    toSubaccount: 1,
    exchangeIndex: 2,
    amountCents: 2500,
    occurredAt: "2026-10-11T04:00:01.000Z",
  };
  const window = {
    attemptedAt,
    responseReceivedAt,
    acknowledgedInboundTransferId: PRE_BOUNDARY_INBOUND_TRANSFER_ID,
    acknowledgedOutboundTransferId: PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
  };
  const selected = selectCurrentFundingTransfer({ ...window, transfers: [historical, outbound, current] });
  assert.equal(selected.status, "selected");
  if (selected.status === "selected") assert.equal(selected.transfer.transferId, currentId);
  const disguisedHistorical = { ...historical, occurredAt: current.occurredAt };
  const excluded = selectCurrentFundingTransfer({ ...window, transfers: [disguisedHistorical, current] });
  assert.equal(excluded.status, "selected");
  if (excluded.status === "selected") assert.equal(excluded.transfer.transferId, currentId);
  assert.equal(selectCurrentFundingTransfer({ ...window, transfers: [disguisedHistorical] }).status, "pending");
  assert.equal(selectCurrentFundingTransfer({ ...window, transfers: [historical, outbound] }).status, "pending");
  const early = { ...current, transferId: "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee", occurredAt: "2026-10-11T03:59:58.000Z" };
  assert.equal(selectCurrentFundingTransfer({ ...window, transfers: [historical, early] }).status, "pending");
  const late = { ...current, transferId: "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee", occurredAt: "2026-10-11T04:00:08.000Z" };
  assert.equal(selectCurrentFundingTransfer({ ...window, transfers: [historical, late] }).status, "pending");
  const second = { ...current, transferId: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  assert.equal(selectCurrentFundingTransfer({
    ...window,
    transfers: [historical, current, second],
  }).status, "ambiguous");
  assert.equal(selectCurrentFundingTransfer({
    ...window,
    transfers: [historical, { ...current, exchangeIndex: 0 }],
  }).status, "pending");
  assert.equal(selectCurrentFundingTransfer({
    ...window,
    transfers: [historical, { ...current, amountCents: 2501 }],
  }).status, "pending");
  assert.equal(selectCurrentFundingTransfer({
    ...window,
    transfers: [historical, { ...current, occurredAt: null }],
  }).status, "pending");
  assert.equal(selectCurrentFundingTransfer({
    ...window,
    responseReceivedAt: null,
    transfers: [historical, current],
  }).status, "window_unproven");

  const balances = {
    sourceScopedBeforeMicros: "50000000",
    sourceInventoryBeforeMicros: "50000000",
    sourceScopedMicros: "25000000",
    sourceInventoryMicros: "25000000",
    destinationScopedMicros: "25000000",
    destinationInventoryMicros: "25000000",
  };
  assert.equal(fundingCashProvesExact25(balances), true);
  assert.equal(fundingCashProvesExact25({ ...balances, sourceScopedMicros: "25000001" }), false);
  assert.equal(fundingCashProvesExact25({ ...balances, sourceInventoryMicros: "24000000" }), false);
  assert.equal(fundingCashProvesExact25({ ...balances, destinationScopedMicros: "25000001" }), false);
  assert.equal(fundingCashProvesExact25({ ...balances, destinationInventoryMicros: "0" }), false);
  assert.equal(fundingCashProvesExact25({ ...balances, sourceScopedBeforeMicros: "nope" }), false);

  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const body = store.slice(
    store.indexOf("async function reconcileRailwayFunding"),
    store.indexOf("function index2Closed"),
  );
  assert.equal(body.includes("selectCurrentFundingTransfer"), true);
  assert.equal(body.includes("readStoredRoundTrip"), true);
  assert.equal(body.includes("funding_transfer_pending_visibility"), true);
  assert.equal(body.includes("funding_transferred_at = $2"), true);
  assert.equal(body.includes("funding_transferred_at = now()"), false);
  assert.equal(body.includes("clean_boundary_evidence_digest ="), false);
  assert.equal(body.includes("postOneShotPairFunding"), false);
  assert.equal(body.includes('method: "POST"'), false);
  assert.equal(body.includes('method: "DELETE"'), false);
  assert.equal(body.includes("/portfolio/subaccounts/transfers"), false);
  assert.equal(body.includes("SET state = 'uncertain'"), false);
  assert.equal(body.includes("state = 'reconciled'"), true);
  const pendingAt = body.indexOf("funding_transfer_pending_visibility");
  const updateAt = body.indexOf("UPDATE micro_live_pair_boundary");
  assert.equal(pendingAt > -1 && updateAt > pendingAt, true);
  const route = readFileSync("src/routes/strataCommissioning.ts", "utf8");
  const reconcile = route.slice(route.indexOf('router.post("/funding/reconcile"'), route.indexOf('router.post("/fund"'));
  assert.equal(reconcile.includes("transferAttempted: false"), true);
  assert.equal(reconcile.includes("postOneShotPairFunding"), false);
});

test("verify-fee returns the existing safe failure reason and stores a digest only on success", () => {
  for (const reason of [
    "official_fee_schedule_unavailable",
    "official_fee_schedule_http_403",
    "official_fee_schedule_http_404",
    "official_fee_schedule_content_type_invalid",
    "official_fee_schedule_size_or_body_invalid",
    "official_fee_schedule_pdf_unparseable",
    "official_fee_schedule_formula_unverifiable",
    "official_fee_schedule_not_verified",
    "official_fee_schedule_http_429",
    "official_fee_schedule_redirected",
    "uploaded_fee_pdf_invalid",
    "uploaded_fee_pdf_too_large",
    "uploaded_fee_pdf_formula_unverifiable",
    "uploaded_fee_pdf_unreviewed_schedule",
    "uploaded_fee_pdf_confirmation_required",
  ]) {
    assert.equal(publicFeeVerificationReason(reason), reason);
  }
  assert.equal(publicFeeVerificationReason("https://fees.example/token"), "official_fee_schedule_not_verified");
  assert.equal(
    publicFeeVerificationReason("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"),
    "official_fee_schedule_not_verified",
  );
  const store = readFileSync("src/lib/strata/commissioningStore.ts", "utf8");
  const body = store.slice(store.indexOf("async verifyFee()"), store.indexOf("async verifyFeeUpload("));
  const okBranch = body.indexOf("if (established.ok)");
  const insertAt = body.indexOf("INSERT INTO v13_commissioning_evidence");
  const failureReturn = body.indexOf("digestStored: false");
  assert.equal(okBranch > -1 && insertAt > okBranch && failureReturn > insertAt, true);
  assert.equal(body.includes("publicFeeVerificationReason(established.reason)"), true);
  assert.equal(body.includes("digestStored: true"), true);
  assert.equal(body.includes("reason: null"), true);
  assert.equal(body.includes("httpStatus: established.diagnostic.httpStatus"), true);
  assert.equal(body.includes("contentType: established.diagnostic.contentType"), true);
  assert.equal(body.includes("finalOrigin: established.diagnostic.finalOrigin"), true);
  assert.equal(body.includes("finalPathname: established.diagnostic.finalPathname"), true);
  assert.equal(body.includes("retryAfterSeconds: established.diagnostic.retryAfterSeconds"), true);
  assert.equal(body.includes("networkAttempts: established.diagnostic.networkAttempts"), true);
  assert.equal(body.includes("verifyCurrentFeeArtifact"), false);
  const successReturn = body.slice(body.indexOf("ok: true"), body.indexOf("digestStored: false"));
  assert.equal(successReturn.includes("digest: established.digest"), false);
  assert.equal(body.includes("postOneShotPairFunding"), false);
  assert.equal(body.includes("planCommission"), false);
  assert.equal(body.includes("planArm"), false);
  assert.equal(body.includes("/portfolio/orders"), false);
  const route = readFileSync("src/routes/strataCommissioning.ts", "utf8");
  const verifyFee = route.slice(route.indexOf('router.post("/verify-fee"'), route.indexOf('router.post("/verify-cash"'));
  assert.equal(verifyFee.includes("feeVerification: result.feeVerification"), true);
  assert.equal(verifyFee.includes("commissioningStatus(result.snapshot)"), true);
  const upload = store.slice(store.indexOf("async verifyFeeUpload("), store.indexOf("async verifyCash()"));
  const uploadOk = upload.indexOf("if (!verified.ok)");
  const uploadInsert = upload.indexOf("INSERT INTO v13_commissioning_evidence");
  assert.equal(uploadOk > -1 && uploadInsert > uploadOk, true);
  assert.equal(upload.includes("fee_artifact_digest"), true);
  assert.equal(upload.includes("fee_artifact_verified"), true);
  assert.equal(upload.includes("verifyCurrentFeeArtifact"), false);
  assert.equal(upload.includes("establishOfficialFeeDigest"), false);
  assert.equal(upload.includes("/portfolio/"), false);
  assert.equal(upload.includes("/trade-api/"), false);
  assert.equal(upload.includes("fetch("), false);
  const uploadRoute = route.slice(route.indexOf('router.post("/verify-fee-upload"'), route.indexOf('router.post("/verify-cash"'));
  assert.equal(uploadRoute.includes("VERIFY_OFFICIAL_FEE_PDF_UPLOAD_CONFIRMATION"), true);
  assert.equal(route.includes('VERIFY_OFFICIAL_FEE_PDF_UPLOAD_CONFIRMATION = "VERIFY_OFFICIAL_KALSHI_FEE_PDF_UPLOAD"'), true);
  assert.equal(uploadRoute.includes("application/pdf"), true);
  assert.equal(uploadRoute.includes("commissioningStatus"), false);
  assert.equal(uploadRoute.includes("feeVerification: result.feeVerification"), true);
});

test("verify-fee-upload accepts only raw PDF bytes from an AAL2 operator", async () => {
  const { privateKey, keys } = await signingKeys();
  const gate = memoryPort(emptySnapshot());
  const app = express();
  app.use(express.json());
  app.use("/api/strata", createStrataRouter({
    verifyToken: (value) => verifySupabaseAccessToken(value, { supabaseUrl: SUPABASE_URL, keys }),
    roleOf,
    control: { start: async () => { gate.startWorker(); }, stop() {}, view: () => ({ runtimeStatus: "STOPPED", workerRunning: false, blockedReason: null, lastProductionError: null, refused: false }), isScheduled: () => false } as never,
    status: async () => ({ runtimeStatus: "STOPPED" }),
    positions: async () => ({ positions: [] }),
    orders: async () => ({ orders: [] }),
    fills: async () => ({ fills: [] }),
    trades: async () => ({ trades: [] }),
    latestTrade: async () => ({ unresolved: false, latestCompleted: null }),
    forwardTestStatus: async () => ({}),
    forwardTestHistory: async () => ({}),
    phase4State: async () => ({}),
    microLiveState: async () => ({}),
    emergencyStop: async () => ({ killSwitch: "ON" }),
    commissioning: gate.port,
  }));
  const server = await listen(app);
  const claimed = "caller-supplied-digest-marker";
  const pem = "-----BEGIN PRIVATE KEY-----\nnot-in-the-response\n-----END PRIVATE KEY-----";
  function send(path: string, method: string, bearer: string | undefined, payload: Buffer | null, headers: Record<string, string>) {
    return new Promise<{ status: number; raw: string; body: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({
        hostname: "127.0.0.1", port: server.port, path, method,
        headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...headers,
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            raw,
            body: raw.startsWith("{") ? JSON.parse(raw) as Record<string, unknown> : {},
          });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  try {
    const developer = await token(privateKey, DEVELOPER_ID);
    const standard = await token(privateKey, STANDARD_ID);
    const anonymous = await send("/api/strata/commissioning/verify-fee-upload", "POST", undefined, Buffer.from("%PDF-"), {
      "Content-Type": "application/pdf",
    });
    assert.equal(anonymous.status, 401);
    assert.equal(gate.feeUploadCalls(), 0);
    const forbidden = await send("/api/strata/commissioning/verify-fee-upload", "POST", standard, Buffer.from("%PDF-"), {
      "Content-Type": "application/pdf",
      "X-Strata-Confirmation": "VERIFY_OFFICIAL_KALSHI_FEE_PDF_UPLOAD",
    });
    assert.equal(forbidden.status, 403);
    assert.equal(gate.feeUploadCalls(), 0);
    const json = await send("/api/strata/commissioning/verify-fee-upload", "POST", developer, Buffer.from(JSON.stringify({
      digest: claimed,
      note: pem,
      effectiveDate: "2026-07-07",
      formulaVersion: "standard-quadratic-0.07-v1",
    })), {
      "Content-Type": "application/json",
      "X-Strata-Confirmation": "VERIFY_OFFICIAL_KALSHI_FEE_PDF_UPLOAD",
    });
    assert.equal(json.status, 415);
    assert.equal(gate.feeUploadCalls(), 0);
    assert.equal(json.raw.includes(claimed), false);
    assert.equal(json.raw.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(json.raw.includes(developer), false);
    const unconfirmed = await send("/api/strata/commissioning/verify-fee-upload", "POST", developer, Buffer.from("%PDF-1.4\n"), {
      "Content-Type": "application/pdf",
    });
    assert.equal(unconfirmed.status, 400);
    assert.equal(gate.feeUploadCalls(), 0);
    const pdf = Buffer.from("%PDF-1.4\noperator-upload-bytes\n%%EOF");
    const rejected = await send("/api/strata/commissioning/verify-fee-upload", "POST", developer, pdf, {
      "Content-Type": "application/pdf",
      "X-Strata-Confirmation": "VERIFY_OFFICIAL_KALSHI_FEE_PDF_UPLOAD",
    });
    assert.equal(rejected.status, 422);
    assert.equal(gate.feeUploadCalls(), 1);
    assert.equal(gate.feeUploadBytes(), pdf.length);
    assert.equal((rejected.body.feeVerification as { digestStored: boolean }).digestStored, false);
    assert.equal(rejected.raw.includes("%PDF"), false);
    assert.equal(rejected.raw.includes(developer), false);
    gate.acceptReviewedFee();
    const accepted = await send("/api/strata/commissioning/verify-fee-upload", "POST", developer, pdf, {
      "Content-Type": "application/pdf",
      "X-Strata-Confirmation": "VERIFY_OFFICIAL_KALSHI_FEE_PDF_UPLOAD",
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, {
      feeVerification: {
        ok: true,
        reason: null,
        digestStored: true,
        sourceMode: "operator_uploaded_reviewed_official_pdf",
        effectiveDate: "2026-07-07",
        formulaVersion: "standard-quadratic-0.07-v1",
      },
    });
    assert.equal(accepted.raw.includes("%PDF"), false);
    assert.equal(accepted.raw.includes(developer), false);
    assert.equal(gate.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("V13 master gate stays fail closed until an atomic arm and rolls both layers back", async () => {
  const migration = readFileSync("../../lib/db/drizzle/0008_v13_production_master_gate.sql", "utf8");
  assert.match(migration, /DROP CONSTRAINT IF EXISTS live_execution_config_execution_disabled_check/);
  assert.match(migration, /'PAPER_ONLY', 'SHADOW_LIVE', 'V13_PRODUCTION'/);
  assert.match(migration, /live_execution_enabled = false OR manual_kill_switch = false/);
  assert.equal(/live_execution_enabled\s*=\s*true/.test(migration), false);
  assert.equal(migration.includes("UPDATE "), false);
  assert.match(migration, /SELECT 'singleton', 'V13_PRODUCTION', false, true/);
  assert.equal(masterExecutionAllowed("PAPER_ONLY", true, false), false);
  assert.equal(masterExecutionAllowed("SHADOW_LIVE", true, false), false);
  assert.equal(masterExecutionAllowed("V13_PRODUCTION", true, true), false);
  assert.equal(masterExecutionAllowed("V13_PRODUCTION", true, false), true);
  assert.equal(masterExecutionAllowed("V13_PRODUCTION", false, true), true);

  const disarmed = ready();
  disarmed.account = {
    count: 1, id: "acct", subaccount: 1, exchangeIndex: 2, fingerprint: "a".repeat(64),
    commissioned: true, executionEnabled: false, killSwitch: true,
  };
  assert.equal(planArm(disarmed, ARM_CONFIRMATION).ok, true);
  disarmed.master.liveExecutionEnabled = true;
  assert.equal(planArm(disarmed, ARM_CONFIRMATION).reason, "production_master_not_fail_closed");

  function client(failOn: string | null) {
    const seen: string[] = [];
    return {
      seen,
      async query(sql: string) {
        seen.push(sql);
        if (failOn && sql.includes(failOn)) throw new Error("write failed");
        if (sql.includes("FROM v13_production_account") || sql.includes("FROM live_execution_config")) {
          return {
            rows: [{ id: "acct", mode: "SHADOW_LIVE", live_execution_enabled: false, manual_kill_switch: true }],
            rowCount: 1,
          };
        }
        if (sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: null };
      },
    };
  }

  const armed = client(null);
  assert.deepEqual(await armProductionAuthority(armed), { ok: true });
  assert.ok(armed.seen.some((sql) => sql === ARM_ACCOUNT_SQL));
  assert.ok(armed.seen.some((sql) => sql === ARM_MASTER_SQL));
  assert.equal(armed.seen.at(-1), "COMMIT");
  assert.equal(armed.seen.filter((sql) => sql === "ROLLBACK").length, 0);

  const accountFailed = client("SET execution_enabled = true");
  assert.equal((await armProductionAuthority(accountFailed)).ok, false);
  assert.ok(accountFailed.seen.includes("ROLLBACK"));
  assert.equal(accountFailed.seen.includes("COMMIT"), false);
  assert.equal(accountFailed.seen.some((sql) => sql === ARM_MASTER_SQL), false);

  const masterFailed = client("SET mode = 'V13_PRODUCTION'");
  const masterFailure = await armProductionAuthority(masterFailed);
  assert.equal(masterFailure.ok, false);
  if (!masterFailure.ok) assert.equal(masterFailure.reason, "production_arm_rolled_back");
  assert.ok(masterFailed.seen.some((sql) => sql === ARM_ACCOUNT_SQL));
  assert.ok(masterFailed.seen.includes("ROLLBACK"));
  assert.equal(masterFailed.seen.includes("COMMIT"), false);

  const disarmedWrites = client(null);
  assert.deepEqual(await disarmProductionAuthority(disarmedWrites), { ok: true });
  assert.ok(disarmedWrites.seen.some((sql) => sql === DISARM_ACCOUNT_SQL));
  assert.ok(disarmedWrites.seen.some((sql) => sql === DISARM_MASTER_SQL));
  assert.equal(DISARM_MASTER_SQL.includes("mode ="), false);
  assert.match(DISARM_MASTER_SQL, /live_execution_enabled = false/);
  assert.match(DISARM_MASTER_SQL, /manual_kill_switch = true/);
  const masterDisarmFailed = client("SET live_execution_enabled = false, manual_kill_switch = true");
  assert.equal((await disarmProductionAuthority(masterDisarmFailed)).ok, false);
  assert.ok(masterDisarmFailed.seen.includes("ROLLBACK"));
  assert.equal(masterDisarmFailed.seen.includes("COMMIT"), false);

  const saved = process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
  process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED = V13_ENTRY_POLICY_VERSION;
  try {
    const readyToStart = ready();
    readyToStart.account = {
      count: 1, id: "acct", subaccount: 1, exchangeIndex: 2, fingerprint: "a".repeat(64),
      commissioned: true, executionEnabled: true, killSwitch: false,
    };
    readyToStart.transportReady = true;
    readyToStart.policy.entryPolicyVersion = V13_ENTRY_POLICY_VERSION;
    readyToStart.workerRunning = false;
    readyToStart.master = { count: 1, mode: "V13_PRODUCTION", liveExecutionEnabled: true, manualKillSwitch: false };
    assert.equal(deriveKalshiConnectionStatus(readyToStart, false), "READY_TO_START");
    assert.equal(commissioningStatus(readyToStart).productionMasterReady, true);
    readyToStart.master = { count: 1, mode: "V13_PRODUCTION", liveExecutionEnabled: false, manualKillSwitch: true };
    assert.equal(deriveKalshiConnectionStatus(readyToStart, false), "BLOCKED");
    assert.equal(commissioningStatus(readyToStart).productionMasterReady, false);
  } finally {
    if (saved === undefined) delete process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
    else process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED = saved;
  }
});
