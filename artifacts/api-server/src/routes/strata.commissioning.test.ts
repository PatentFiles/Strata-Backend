import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from "@workspace/v13-strategy";
import { computeV13LiveMoneyPolicyHash } from "../lib/v13LiveMoneyRisk";
import {
  ARM_CONFIRMATION,
  DISARM_CONFIRMATION,
  EXIT_FLOOR_CONFIRMATION,
  FUNDING_CONFIRMATION,
  approvedExitFloor,
  dedicatedSignerFingerprint,
  emptySnapshot,
  fundingAuthorizationDecision,
  planArm,
  planCommission,
  planDisarm,
  validatePolicyLimits,
  type AccountPlan,
  type CommissioningSnapshot,
  type PolicyLimits,
} from "../lib/strata/commissioning";
import { verifySupabaseAccessToken } from "../lib/strata/supabaseAuth";
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
    hashMatches: true, missingFields: [],
  };
  snapshot.approvedMinimumExitMicros = 400000;
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
  let reviewedFeeAccepted = false;
  let reviewedCashMicros: string | null = null;
  let draft: PolicyLimits | null = null;
  const envBefore = () => Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]));
  const port: CommissioningPort = {
    read: async () => structuredClone(snapshot),
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
      if (!reviewedFeeAccepted) return structuredClone(snapshot);
      snapshot.fee = { ...snapshot.fee, digest: "c".repeat(64), verified: true };
      return structuredClone(snapshot);
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
      const now = new Date("2026-10-10T00:00:00.000Z");
      const policyHash = computeV13LiveMoneyPolicyHash({
        id: "policy-1", version: 1, supersedesPolicyId: null, state: "APPROVED",
        strategyVersion: "V1.3",
        strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
        strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
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
    arm: async (confirmation) => {
      const before = envBefore();
      const decision = planArm(snapshot, confirmation);
      if (!decision.ok) return { status: "BLOCKED", reason: decision.reason, workerStarted: false, environmentChanged: false };
      snapshot.account.executionEnabled = true;
      snapshot.account.killSwitch = false;
      const changed = FLAG_NAMES.some((name) => process.env[name] !== before[name]);
      if (changed) return { status: "BLOCKED", reason: "environment_changed", workerStarted: false, environmentChanged: false };
      return { status: "ARMED", reason: decision.reason, workerStarted: false, environmentChanged: false };
    },
    disarm: async (confirmation) => {
      emergencyStops += 0;
      const decision = planDisarm(snapshot, confirmation);
      if (!decision.ok) return { status: "BLOCKED", reason: decision.reason, emergencyStop: false };
      snapshot.account.executionEnabled = false;
      snapshot.account.killSwitch = true;
      return { status: "DISARMED", reason: decision.reason, emergencyStop: false };
    },
  };
  return {
    port,
    accounts: () => accounts,
    set(next: CommissioningSnapshot) { snapshot = structuredClone(next); },
    calls,
    posts: () => posts,
    noteGet(path: string) { calls.push({ method: "GET", path }); },
    acceptReviewedFee() { reviewedFeeAccepted = true; },
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
  return new Promise<{ status: number; body: Record<string, unknown>; raw: string }>((resolve, reject) => {
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
  assert.equal(validatePolicyLimits({ ...OPERATOR_LIMITS, chosenForYou: 1 } as never).ok, false);
  const gate = memoryPort(emptySnapshot());
  assert.equal((await gate.port.verifyFee()).fee.verified, false);
  assert.equal((await gate.port.verifyCash()).cash.precisionVerified, false);
  gate.proveCash("25.00");
  assert.equal((await gate.port.verifyCash()).cash.precisionVerified, false);
  gate.proveCash("25000000");
  assert.equal((await gate.port.verifyCash()).cash.source, "authenticated_kalshi_micros");
  gate.acceptReviewedFee();
  assert.equal((await gate.port.verifyFee()).fee.verified, true);
  const proposed = await gate.port.proposePolicy(OPERATOR_LIMITS, DEVELOPER_ID);
  assert.equal(proposed.status, "PROPOSED");
  const approved = await gate.port.approvePolicy(DEVELOPER_ID);
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
  assert.equal(planDisarm(owned, DISARM_CONFIRMATION).reason, "disarm_refused_while_position_or_intent_open");
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
});
