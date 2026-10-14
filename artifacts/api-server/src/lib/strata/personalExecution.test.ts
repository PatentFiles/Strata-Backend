import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { V13_ENTRY_POLICY_VERSION, V13_LEGACY_ENTRY_POLICY } from "@workspace/v13-strategy";
import { computeV13LiveMoneyPolicyHash } from "../v13LiveMoneyRisk";
import type { Pool } from "@workspace/db";
import {
  AccountScopedExchange,
  accountOrderTransmission,
  openOwnedExecutionSession,
  scheduleOwnedAccountWorker,
  type AccountDispatchState,
} from "./accountProductionSession";
import { dedicatedSignerFingerprint } from "./commissioning";
import { persistOwnedCashReconciliation, RECORD_OWNED_CASH_CONFIRMATION } from "./personalCashReconciliation";
import { marketEvidenceFromBook, parseKalshiOrderBook, readSubaccountSpendableCash } from "./personalMarketAdapter";
import { authorizeOwnedPolicy, createOwnedPolicyDraft, persistOwnedPolicyApproval, APPROVE_OWNED_POLICY_CONFIRMATION } from "./personalPolicyApproval";
import { createOwnedTradingSupervisor, createProductionPersonalSession, productionPersonalSession } from "./personalExecutionSupervisor";
import {
  approveOwnedPolicyForUser,
  readOwnedApprovedFeeEvidence,
  commissionOwnedAccount,
  COMMISSION_OWNED_ACCOUNT_CONFIRMATION,
  enableOwnedAccountExecution,
  ENABLE_OWNED_EXECUTION_CONFIRMATION,
  reconcileOwnedSubaccountCash,
  REQUEST_OWNED_ACTIVATION_CONFIRMATION,
  requestOwnedAccountActivation,
} from "./personalAccountActivation";
import { emptySnapshot, ownedMarketEvidence, personalAccountSnapshot, readOwnedKalshiFeeds } from "./personalExchangeRead";
import type { MarketEvidence, Request } from "../v13-production/types";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-13T18:00:00.000Z");

test("order book evidence fails closed without a fee, depth, or a fresh clock", () => {
  const book = parseKalshiOrderBook({
    orderbook_fp: { yes_dollars: [["0.4500", "12.00"]], no_dollars: [["0.5000", "8.00"]] },
  });
  assert.equal(book.yesBids[0]?.priceDollars, "0.4500");
  assert.throws(() => marketEvidenceFromBook({
    market: "KXBTC15M-TEST", side: "YES", book, observedAtMs: NOW, nowMs: NOW, maxAgeMs: 15_000, fee: null,
  }), /fee_evidence_missing/);
  assert.throws(() => marketEvidenceFromBook({
    market: "KXBTC15M-TEST", side: "YES", book, observedAtMs: NOW - 16_000, nowMs: NOW, maxAgeMs: 15_000, fee: fee(),
  }), /market_evidence_stale/);
  assert.throws(() => parseKalshiOrderBook({ orderbook_fp: { yes_dollars: "bad", no_dollars: [] } }), /market_book_malformed/);
  assert.throws(() => marketEvidenceFromBook({
    market: "NOT-BTC", side: "YES", book, observedAtMs: NOW, nowMs: NOW, maxAgeMs: 15_000, fee: fee(),
  }), /production_market_invalid/);
  const evidence = marketEvidenceFromBook({
    market: "KXBTC15M-TEST", side: "YES", book, observedAtMs: NOW, nowMs: NOW, maxAgeMs: 15_000, fee: fee(),
  });
  assert.equal(evidence.bestAskDollars, "0.5000");
  assert.equal(evidence.bestBidDollars, "0.4500");
  assert.equal(evidence.asks[0]?.availableContracts, "8.00");
});

test("spendable cash is the subaccount balance, not portfolio value or the primary account", () => {
  const read = readSubaccountSpendableCash({
    subaccount: 1,
    exchangeIndex: 2,
    observedAtMs: NOW,
    nowMs: NOW,
    maxAgeMs: 15_000,
    subaccountBalance: { balance_dollars: "1000.00", portfolio_value_dollars: "50.00" },
    primaryBalance: { balance_dollars: "25000.00" },
  });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.cashCents, 100_000);
  assert.equal(read.cashMicros, "1000000000");
  assert.equal(read.portfolioValueCents, 5_000);
  assert.equal(read.primaryCashCents, 2_500_000);
  const wrongPair = readSubaccountSpendableCash({
    subaccount: 0, exchangeIndex: 2, observedAtMs: NOW, nowMs: NOW, maxAgeMs: 15_000,
    subaccountBalance: { balance: 100 }, primaryBalance: { balance: 100 },
  });
  assert.equal(wrongPair.ok, false);
  if (!wrongPair.ok) assert.equal(wrongPair.reason, "account_target_pair_mismatch");
  const stale = readSubaccountSpendableCash({
    subaccount: 1, exchangeIndex: 2, observedAtMs: NOW - 20_000, nowMs: NOW, maxAgeMs: 15_000,
    subaccountBalance: { balance: 100 }, primaryBalance: {},
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "cash_evidence_stale");
  const missing = readSubaccountSpendableCash({
    subaccount: 1, exchangeIndex: 2, observedAtMs: NOW, nowMs: NOW, maxAgeMs: 15_000,
    subaccountBalance: {}, primaryBalance: { balance: 100 },
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "cash_unproven");
});

test("policy approval requires the owner, fee evidence, and explicit limits below the ceiling", async () => {
  const limits = {
    capitalLimitCents: 5_000_000,
    maxEntryStakeCents: 2_500_000,
    maxEntryAllInCents: 5_000_000,
    maxDailyLossCents: 100_000,
    maxTotalLossCents: 250_000,
    maxQuoteAgeMs: 15_000,
    maxFeeEvidenceAgeMs: 15_000,
  };
  const unconfirmed = authorizeOwnedPolicy({ ...policyInput(limits), confirmation: "no" });
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.equal(unconfirmed.reason, "explicit_authorization_required");
  const missingFee = authorizeOwnedPolicy({ ...policyInput(limits), fee: null });
  assert.equal(missingFee.ok, false);
  if (!missingFee.ok) assert.equal(missingFee.reason, "fee_artifact_unverified");
  const aboveCeiling = authorizeOwnedPolicy({ ...policyInput({ ...limits, maxEntryStakeCents: 2_500_001 }) });
  assert.equal(aboveCeiling.ok, false);
  if (!aboveCeiling.ok) assert.equal(aboveCeiling.reason, "policy_limits_invalid");
  const approved = authorizeOwnedPolicy(policyInput(limits));
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.equal(approved.policy.maxEntryStakeCents, 2_500_000);
  assert.equal(approved.policy.state, "APPROVED");
  assert.equal(approved.policy.entryPolicyVersion, V13_ENTRY_POLICY_VERSION);
  assert.match(approved.policy.policyHash ?? "", /^[0-9a-f]{64}$/);
  const tamperedVersion = { ...approved.policy, entryPolicyVersion: V13_LEGACY_ENTRY_POLICY };
  assert.notEqual(computeV13LiveMoneyPolicyHash(tamperedVersion), approved.policy.policyHash);
  const tampered = await persistOwnedPolicyApproval({
    query: async () => { throw new Error("tampered_policy_must_not_write"); },
  }, { ownerUserId: USER, executionAccountId: "acct-a", policy: tamperedVersion });
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.equal(tampered.reason, "policy_hash_mismatch");
  const rehashedLegacy = {
    ...tamperedVersion,
    policyHash: computeV13LiveMoneyPolicyHash(tamperedVersion),
  };
  const legacy = await persistOwnedPolicyApproval({
    query: async () => { throw new Error("legacy_policy_must_not_write"); },
  }, { ownerUserId: USER, executionAccountId: "acct-a", policy: rehashedLegacy });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.equal(legacy.reason, "production_entry_policy_revision_not_approved");
  const calls: string[] = [];
  const stored = await persistOwnedPolicyApproval({
    query: async () => { throw new Error("autocommit_not_allowed"); },
    transaction: async (work) => work(async (text, params) => {
      calls.push(text);
      if (text.includes("owned-policy:approve")) {
        assert.match(text, /entry_policy_version = \$22/);
        assert.match(text, /AND version = \$23/);
        assert.equal(params?.[21], V13_ENTRY_POLICY_VERSION);
        assert.equal(params?.[22], approved.policy.version);
      }
      assert.equal(text.includes("execution_enabled"), false);
      assert.equal(text.includes("kill_switch"), false);
      assert.equal(text.includes("id = 'production'"), false);
      return { rows: [{ id: "policy-a" }], rowCount: 1 };
    }),
  }, { ownerUserId: USER, executionAccountId: "acct-a", policy: approved.policy });
  assert.equal(stored.ok, true);
  assert.equal(calls.length, 2);
  const foreign = await persistOwnedPolicyApproval({
    query: async () => ({ rows: [], rowCount: 0 }),
  }, { ownerUserId: OTHER, executionAccountId: "acct-a", policy: approved.policy });
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.reason, "policy_not_owned");
  const split = await persistOwnedPolicyApproval({
    query: async () => ({ rows: [{ id: "policy-a" }], rowCount: 1 }),
  }, { ownerUserId: USER, executionAccountId: "acct-a", policy: approved.policy });
  assert.equal(split.ok, false);
  if (!split.ok) assert.equal(split.reason, "policy_approval_not_transactional");
  let approvedRows = 0;
  const linked = await persistOwnedPolicyApproval({
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (work) => work(async (text) => {
      if (text.includes("owned-policy:link")) return { rows: [], rowCount: 0 };
      approvedRows += 1;
      return { rows: [{ id: "policy-a" }], rowCount: 1 };
    }),
  }, { ownerUserId: USER, executionAccountId: "acct-a", policy: approved.policy });
  assert.equal(linked.ok, false);
  if (!linked.ok) assert.equal(linked.reason, "policy_not_linked");
  assert.equal(approvedRows, 1);
});

test("approved-policy fee evidence is read-only and rejects foreign or mismatched policy identity", async () => {
  let calls = 0;
  const absent = await readOwnedApprovedFeeEvidence({
    query: async (_sql, params) => {
      calls++;
      assert.deepEqual(params, [USER]);
      return { rows: [] };
    },
  }, USER);
  assert.equal(absent.ok, false);
  assert.equal(absent.reason, "policy_not_approved");

  const outdated = await readOwnedApprovedFeeEvidence({
    query: async (_sql, params) => {
      calls++;
      assert.deepEqual(params, [USER]);
      return { rows: [{
        id: "old-policy", version: 1, state: "APPROVED",
        entry_policy_version: V13_LEGACY_ENTRY_POLICY,
        strategy_parameter_hash: "a".repeat(64),
      }] };
    },
  }, USER);
  assert.equal(outdated.ok, false);
  assert.equal(outdated.reason, "production_entry_policy_revision_not_approved");
  assert.equal(calls, 2);
});

test("cash reconciliation records the subaccount read and does not transfer or enable execution", async () => {
  let sql = "";
  const recorded = await persistOwnedCashReconciliation({
    query: async (text, params = []) => {
      sql = text;
      assert.equal(params[0], "acct-a");
      assert.equal(params[1], USER);
      assert.equal(params[2], "1000000000");
      return { rows: [{ id: "acct-a" }], rowCount: 1 };
    },
  }, {
    ownerUserId: USER,
    executionAccountId: "acct-a",
    confirmation: RECORD_OWNED_CASH_CONFIRMATION,
    subaccount: 1,
    exchangeIndex: 2,
    observedAtMs: NOW,
    nowMs: NOW,
    maxAgeMs: 15_000,
    subaccountBalance: { balance_dollars: "1000.00" },
    primaryBalance: { balance_dollars: "25000.00" },
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.cashCents, 100_000);
  assert.equal(recorded.transferAttempted, false);
  assert.equal(sql.includes("execution_enabled"), false);
  assert.equal(sql.includes("kill_switch"), false);
  const skipped = await persistOwnedCashReconciliation({
    query: async () => { throw new Error("write_not_allowed"); },
  }, {
    ownerUserId: USER, executionAccountId: "acct-a", confirmation: "no",
    subaccount: 1, exchangeIndex: 2, observedAtMs: NOW, nowMs: NOW, maxAgeMs: 15_000,
    subaccountBalance: { balance: 100 }, primaryBalance: {},
  });
  assert.equal(skipped.reason, "explicit_authorization_required");
});

test("the market adapter stays disabled until a reader is bound, and global fetch cannot submit", async () => {
  const closed = new AccountScopedExchange(state(false));
  await assert.rejects(() => closed.market("KXBTC15M-TEST", "YES"), /operation_not_enabled/);
  const opened = new AccountScopedExchange(state(false), null, null, null, null, async () => evidence());
  assert.equal((await opened.market("KXBTC15M-TEST", "YES")).bestAskDollars, "0.5000");
  await assert.rejects(() => opened.market("OTHER", "YES"), /production_market_invalid/);
  await assert.rejects(() => opened.snapshot(
    { subaccount: 0, exchangeIndex: 2, keyFingerprint: "ab".repeat(32) }, 0,
  ), /account_target_pair_mismatch/);
  await assert.rejects(() => opened.snapshot(
    { subaccount: 1, exchangeIndex: 2, keyFingerprint: "cd".repeat(32) }, 0,
  ), /credential_fingerprint_mismatch/);
  const key = keyMaterial();
  const wire = accountOrderTransmission(key, order());
  assert.equal(wire.body.includes("\"subaccount\":1"), true);
  assert.equal(wire.body.includes("\"exchange_index\":2"), true);
  assert.equal(wire.body.includes("immediate_or_cancel"), true);
  assert.equal(wire.body.includes(key.privateKey), false);
  const globalTransport = new AccountScopedExchange(state(true), key, null, fetch);
  const blocked = await scheduleOwnedAccountWorker({ worker: fakeWorker(), exchange: globalTransport }, "entries");
  assert.equal(blocked.reason, "personal_submission_not_authorized");
  assert.equal(blocked.workerStarted, false);
  assert.equal(productionPersonalSession().isScheduled(USER, "acct-a"), false);
  const production = await productionPersonalSession().start({ userId: USER, accountId: "acct-a", action: "START" });
  assert.equal(production.workerStarted, false);
  assert.equal(production.reason, "personal_signer_unavailable");
  const worker = fakeWorker();
  await worker.start();
  const supervisor = createOwnedTradingSupervisor(async () => ({ ok: true, worker }));
  const started = await supervisor.start({ userId: USER, accountId: "acct-a", action: "START" });
  assert.equal(started.reason, "worker_scheduled");
  assert.equal(supervisor.isScheduled(USER, "acct-a"), true);
  assert.equal(supervisor.isScheduled(OTHER, "acct-a"), false);
  const halted = await supervisor.stopOwner(USER);
  assert.equal(halted.workerStopped, true);
  assert.equal(supervisor.isScheduled(USER, "acct-a"), false);
});

test("entry scheduling starts one worker and a second start does not", async () => {
  const calls: string[] = [];
  const worker = fakeWorker();
  const exchange = new AccountScopedExchange(state(true), null, null, async () => new Response("{}", { status: 200 }));
  const first = await scheduleOwnedAccountWorker({ worker, exchange }, "entries");
  calls.push(first.reason);
  const second = await scheduleOwnedAccountWorker({ worker, exchange }, "entries");
  assert.equal(first.workerStarted, true);
  assert.equal(first.executionActive, false);
  assert.equal(second.reason, "worker_already_running");
  assert.equal(worker.starts, 1);
  worker.stop();
  const liveOff = new AccountScopedExchange(state(false), null, null, async () => new Response("{}", { status: 200 }));
  const refused = await scheduleOwnedAccountWorker({ worker: fakeWorker(), exchange: liveOff }, "entries");
  assert.equal(refused.reason, "live_execution_not_enabled");
  assert.equal(calls[0], "worker_scheduled");
  const pool = { query: async () => { throw new Error("pool_not_used"); }, connect: async () => { throw new Error("pool_not_used"); } } as unknown as Pool;
  const bound = openOwnedExecutionSession({
    pool, ownerUserId: USER, executionAccountId: "acct-a", state: state(false), intervalMs: 60_000,
  });
  assert.equal(bound.workerStarted, false);
  assert.equal(bound.executionActive, false);
  assert.equal(bound.worker.isScheduled(), false);
  assert.equal(bound.exchange.state.liveExecutionEnabled, false);
});

function fee() {
  return {
    policyVersion: "test-fees", sourceUrl: "https://invalid.test/fees", formulaVersion: "test-v1",
    fingerprint: "fee-evidence-fingerprint", verifiedAtMs: NOW, contracts: 2, limitPrice: 0.5,
    reservedEntryFeeCents: 1, reservedExitFeeCents: 1,
  };
}

function evidence(): MarketEvidence {
  return {
    observedAtMs: NOW, bestAskDollars: "0.5000", asks: [{ priceDollars: "0.5000", availableContracts: "8" }],
    bestBidDollars: "0.4500", bids: [{ priceDollars: "0.4500", availableContracts: "12" }], fee: fee(),
  };
}

function policyInput(limits: {
  capitalLimitCents: number; maxEntryStakeCents: number; maxEntryAllInCents: number;
  maxDailyLossCents: number; maxTotalLossCents: number; maxQuoteAgeMs: number; maxFeeEvidenceAgeMs: number;
}) {
  return {
    ownerUserId: USER,
    executionAccountId: "acct-a",
    policyId: "policy-a",
    version: 1,
    confirmation: APPROVE_OWNED_POLICY_CONFIRMATION,
    limits,
    fee: { policyVersion: "test-fees", sourceUrl: "https://invalid.test/fees", formulaVersion: "test-v1" },
    champion: {
      reviewId: "review-1",
      evidenceHash: "a".repeat(64),
      selectedBy: USER,
      selectedAt: new Date(NOW - 1_000),
    },
    approvedAt: new Date(NOW),
  };
}

function state(live: boolean): AccountDispatchState {
  return {
    leaseState: "owned", armRequested: true, accountKill: false, globalKill: false,
    fencingToken: 2, presentedToken: 2, workerActuallyScheduled: false,
    authenticatedUserId: USER, ownerUserId: USER,
    credentialFingerprint: "ab".repeat(32), presentedFingerprint: "ab".repeat(32),
    uncertainOrderCount: 0, duplicateClientOrder: false, liveExecutionEnabled: live,
  };
}

function order(): Request {
  return {
    market: "KXBTC15M-TEST", side: "YES", action: "BUY", contracts: 1, limitMicros: 500_000,
    timeInForce: "IOC", reduceOnly: false, clientOrderId: `v13p-${USER}`,
  };
}

test("authenticated reads fail closed on incomplete history and a cash mismatch does not schedule", async () => {
  const queries: string[] = [];
  const paged = await readOwnedKalshiFeeds(keyMaterial(), NOW, async (_creds, path, query = "") => {
    queries.push(`${path}${query}`);
    if (path.includes("balance")) return { balance_dollars: "1.0000", subaccount: 1, exchange_index: 2 };
    if (path.includes("orders")) return { orders: [], cursor: "more" };
    if (path.includes("positions")) return { market_positions: [] };
    if (path.includes("fills")) return { fills: [] };
    return { settlements: [] };
  });
  assert.equal(paged.ok, false);
  if (!paged.ok) assert.equal(paged.reason, "personal_exchange_history_unreconciled");
  assert.equal(queries.some((query) => query.includes("exchange_index=2") && query.includes("balance")), true);
  const followed = await readOwnedKalshiFeeds(keyMaterial(), NOW, async (_creds, path, query = "") => {
    if (!query.includes("exchange_index=2")) throw new Error("missing_exchange_index");
    if (path.includes("balance")) return { balance_dollars: "1.0000", subaccount: 1, exchange_index: 1 };
    if (path.includes("orders")) return { orders: [] };
    if (path.includes("positions")) return { market_positions: [] };
    if (path.includes("fills")) return { fills: [] };
    return { settlements: [] };
  });
  assert.equal(followed.ok, false);
  if (!followed.ok) assert.equal(followed.reason, "account_target_pair_mismatch");
  const material = keyMaterial();
  const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
  let feeChecks = 0;
  const session = createProductionPersonalSession({
    async query(text: string) {
      if (text.includes("personal-session:signer")) {
        return { rows: [{
          key_fingerprint: fingerprint, credential_fingerprint: fingerprint,
          decrypted_secret: JSON.stringify({ api_key_id: material.keyId, private_key: material.privateKey }),
          commissioned: true, execution_enabled: true, kill_switch: false, cash_precision_verified: true,
          cash_micros: "1000000", fee_artifact_digest: "ab".repeat(32), policy_hash: "cd".repeat(32),
          fee_policy_version: "standing", fee_source_url: "https://kalshi.com/fees", fee_formula_version: "quadratic",
          policy_state: "APPROVED", configured_stake_cents: "100", subaccount: 1, exchange_index: 2,
        }] };
      }
      if (text.includes("live_execution_config")) return { rows: [{ live_execution_enabled: true, manual_kill_switch: false }] };
      return { rows: [] };
    },
  }, {
    now: () => NOW,
    verifyFee: async () => {
      feeChecks += 1;
      return {
        status: "verified" as const, valid: true, sourceUrl: "https://kalshi.com/fees",
        digest: "ab".repeat(32), formulaVersion: "quadratic", verifiedAt: NOW, reason: null,
      };
    },
    kalshiGet: async (_creds, path) => {
      if (path.includes("balance")) return { balance_dollars: "50.0000" };
      if (path.includes("orders")) return { orders: [] };
      if (path.includes("positions")) return { market_positions: [] };
      if (path.includes("fills")) return { fills: [] };
      return { settlements: [] };
    },
  });
  const refused = await session.start({ userId: USER, accountId: "acct-a", action: "START" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "cash_evidence_mismatch");
  assert.equal(feeChecks, 0);
  assert.equal(session.isScheduled(USER, "acct-a"), false);
  const open = emptySnapshot(
    { subaccount: 1, exchangeIndex: 2, keyFingerprint: fingerprint ?? "" },
    { ok: true, observedAtMs: NOW, cashMicros: "1", orders: [{ id: "x" }], fills: [], positions: [], settlements: [] },
  );
  assert.equal("reason" in open && open.reason, "personal_exchange_history_unreconciled");
  const request = order();
  const mapped = personalAccountSnapshot(
    { subaccount: 1, exchangeIndex: 2, keyFingerprint: fingerprint ?? "" },
    {
      ok: true, observedAtMs: NOW, cashMicros: "900000",
      orders: [{
        order_id: "ord-1", client_order_id: request.clientOrderId, ticker: request.market,
        status: "executed", side: "bid", price: "0.5000", initial_count_fp: "1.00", fill_count_fp: "1.00",
        subaccount: 1, exchange_index: 2,
      }],
      fills: [{
        trade_id: "fill-1", order_id: "ord-1", ticker: request.market, count_fp: "1.00",
        yes_price_dollars: "0.500000", fee_cost: "0.010000", created_time: new Date(NOW).toISOString(),
        subaccount: 1, exchange_index: 2,
      }],
      positions: [{ ticker: request.market, position_fp: "1.00", subaccount: 1, exchange_index: 2 }],
      settlements: [],
    },
    [request],
  );
  assert.equal("orders" in mapped && mapped.orders.length, 1);
  if ("orders" in mapped) assert.equal(mapped.orders[0]?.request, request);
  const halted = createOwnedTradingSupervisor(async () => ({
    ok: true,
    worker: { isScheduled: () => true, async start() {}, async startRecovery() {}, stop() {} },
    disarm: async () => ({ entriesBlocked: false, managingExposure: false }),
  }));
  assert.equal((await halted.start({ userId: USER, accountId: "acct-a", action: "START" })).workerStarted, true);
  const blocked = await halted.stop({ userId: USER, accountId: "acct-a" });
  assert.equal(blocked.workerStopped, false);
  assert.equal(halted.isScheduled(USER, "acct-a"), true);
});

test("cash and commissioning writes require explicit confirmation", async () => {
  const db = { query: async () => { throw new Error("no_write"); } };
  const cash = await reconcileOwnedSubaccountCash(db, { ownerUserId: USER, confirmation: "no", nowMs: NOW });
  assert.equal(cash.reason, "explicit_authorization_required");
  assert.equal(cash.transferAttempted, false);
  const commission = await commissionOwnedAccount(db, {
    ownerUserId: USER, confirmation: "no", feeArtifactDigest: "ab".repeat(32), minimumExitMicros: 1,
  });
  assert.equal(commission.reason, "explicit_authorization_required");
  assert.equal(COMMISSION_OWNED_ACCOUNT_CONFIRMATION.includes("COMMISSION_OWNED_STRATA_ACCOUNT"), true);
});

test("owned market evidence uses the configured stake and rejects an unproven fee grid", () => {
  const book = { orderbook_fp: { yes_dollars: [["0.4500", "100"]], no_dollars: [["0.5000", "100"]] } };
  const series = { series: { ticker: "KXBTC15M", fee_type: "quadratic", fee_multiplier: "1" } };
  const market = { market: { ticker: "KXBTC15M-TEST", exchange_index: 2, status: "active", price_level_structure: "deci_cent" } };
  const evidence = ownedMarketEvidence({
    market: "KXBTC15M-TEST", side: "YES", bookPayload: book, seriesPayload: series, marketPayload: market,
    observedAtMs: NOW, nowMs: NOW, configuredStakeCents: 100,
    policyVersion: "standing", sourceUrl: "https://kalshi.com/fees", formulaVersion: "quadratic",
    artifactDigest: "ab".repeat(32), policyHash: "cd".repeat(32), verifiedAtMs: NOW,
  });
  assert.equal(evidence.bestAskDollars, "0.5000");
  assert.equal(evidence.fee.contracts >= 1, true);
  const tapered = ownedMarketEvidence({
    market: "KXBTC15M-TEST", side: "YES", bookPayload: book, seriesPayload: series,
    marketPayload: {
      market: {
        ticker: "KXBTC15M-TEST", exchange_index: 2, status: "active",
        price_level_structure: "tapered_deci_cent",
        price_ranges: [
          { start: "0.0000", end: "0.1000", step: "0.0010" },
          { start: "0.1000", end: "0.9000", step: "0.0100" },
          { start: "0.9000", end: "1.0000", step: "0.0010" },
        ],
      },
    },
    observedAtMs: NOW, nowMs: NOW, configuredStakeCents: 100,
    policyVersion: "standing", sourceUrl: "https://kalshi.com/fees", formulaVersion: "quadratic",
    artifactDigest: "ab".repeat(32), policyHash: "cd".repeat(32), verifiedAtMs: NOW,
  });
  assert.equal(tapered.fee.contracts, evidence.fee.contracts);
  assert.throws(() => ownedMarketEvidence({
    market: "KXBTC15M-TEST", side: "YES", bookPayload: book,
    seriesPayload: { series: { ticker: "OTHER", fee_type: "quadratic", fee_multiplier: "1" } },
    marketPayload: market, observedAtMs: NOW, nowMs: NOW, configuredStakeCents: 100,
    policyVersion: "standing", sourceUrl: "https://kalshi.com/fees", formulaVersion: "quadratic",
    artifactDigest: "ab".repeat(32), policyHash: "cd".repeat(32), verifiedAtMs: NOW,
  }), /production_fee_or_market_grid_unproven/);
});

test("commissioning requires an explicit minimum exit and activation does not change flags", async () => {
  const missingExit = await commissionOwnedAccount(
    { query: async () => { throw new Error("no_write"); } },
    {
      ownerUserId: USER,
      confirmation: COMMISSION_OWNED_ACCOUNT_CONFIRMATION,
      feeArtifactDigest: "ab".repeat(32),
      minimumExitMicros: 0,
    },
  );
  assert.equal(missingExit.reason, "minimum_exit_missing");
  const oversized = await createOwnedPolicyDraft(
    { query: async () => { throw new Error("no_write"); } },
    {
      ownerUserId: USER,
      executionAccountId: "acct-a",
      limits: {
        capitalLimitCents: 100,
        maxEntryStakeCents: 2_500_001,
        maxEntryAllInCents: 100,
        maxDailyLossCents: 100,
        maxTotalLossCents: 100,
        maxQuoteAgeMs: 1_000,
        maxFeeEvidenceAgeMs: 1_000,
      },
    },
  );
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.reason, "policy_limits_invalid");
  const mismatch = await approveOwnedPolicyForUser(
    { query: async () => { throw new Error("no_write"); } },
    {
      ownerUserId: USER,
      executionAccountId: "acct-a",
      verifyFee: async () => { throw new Error("fee_called"); },
      body: {
        confirmation: APPROVE_OWNED_POLICY_CONFIRMATION,
        policyId: "policy-1",
        version: 1,
        feeArtifactDigest: "ab".repeat(32),
        limits: {
          capitalLimitCents: 2_500_000, maxEntryStakeCents: 500, maxEntryAllInCents: 500,
          maxDailyLossCents: 100, maxTotalLossCents: 100, maxQuoteAgeMs: 1_000, maxFeeEvidenceAgeMs: 1_000,
        },
        champion: {
          reviewId: "not-the-reviewed-release",
          evidenceHash: "ab".repeat(32),
          selectedBy: USER,
          selectedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    },
  );
  assert.equal(mismatch.reason, "champion_evidence_mismatch");
  const writes: string[] = [];
  const ready = {
    id: "acct-a", subaccount: 1, exchange_index: 2,
    key_fingerprint: "aa".repeat(32), credential_fingerprint: "aa".repeat(32),
    policy_state: "APPROVED", policy_id: "policy-1", configured_stake_cents: 100,
    cash_precision_verified: true, minimum_exit_micros: 1_000,
    fee_artifact_digest: "bb".repeat(32), commissioned: true, execution_enabled: false,
    kill_switch: true, commissioning_digest: "cc".repeat(32), activation_requests: 0,
  };
  const requested = await requestOwnedAccountActivation({
    query: async (sql) => {
      writes.push(sql);
      if (sql.includes("UPDATE")) throw new Error("activation_request_wrote_state");
      if (sql.includes("INSERT INTO v13_production_observation")) return { rows: [], rowCount: 1 };
      return { rows: [ready] };
    },
  }, { ownerUserId: USER, confirmation: REQUEST_OWNED_ACTIVATION_CONFIRMATION });
  assert.equal(requested.ok, true);
  assert.equal(requested.executionEnabled, false);
  assert.equal(requested.killSwitchCleared, false);
  assert.equal(requested.liveEnabled, false);
  assert.equal(writes.some((sql) => sql.includes("UPDATE")), false);
  const legacy = await enableOwnedAccountExecution(
    { query: async () => ({ rows: [] }) },
    { executionAccountId: "legacy-account", confirmation: ENABLE_OWNED_EXECUTION_CONFIRMATION },
  );
  assert.equal(legacy.ok, false);
  assert.equal(legacy.accountsTouched, 0);
  assert.equal(legacy.globalFlagsChanged, false);
});

function keyMaterial() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const material = { keyId: "user-key", privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
  assert.ok(dedicatedSignerFingerprint(material.keyId, material.privateKey));
  return material;
}

function fakeWorker() {
  let scheduled = false;
  return {
    starts: 0,
    isScheduled() { return scheduled; },
    async start() { this.starts += 1; scheduled = true; },
    async startRecovery() { this.starts += 1; scheduled = true; },
    stop() { scheduled = false; },
  };
}
