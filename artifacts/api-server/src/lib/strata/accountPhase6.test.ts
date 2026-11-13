import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Pool } from "@workspace/db";
import { authorizeFutureAccountOperation, persistAccountFundingEvidence } from "./accountFunding";
import {
  accountDispatchDecision,
  accountOrderTransmission,
  AccountScopedExchange,
  bindAccountProductionWorker,
  type AccountDispatchState,
} from "./accountProductionSession";
import { userCommissioningReadiness } from "./accountCredentialLifecycle";
import type { Identity, Request, Snapshot } from "../v13-production/types";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

test("two users keep separate signers and live orders stay unsent", async () => {
  const firstKey = keyMaterial("user-a");
  const secondKey = keyMaterial("user-b");
  const order = sampleOrder();
  const firstWire = accountOrderTransmission(firstKey, order);
  const secondWire = accountOrderTransmission(secondKey, order);
  assert.equal(firstWire.keyId, "user-a");
  assert.equal(secondWire.keyId, "user-b");
  assert.equal(firstWire.body.includes("\"subaccount\":1"), true);
  assert.equal(firstWire.body.includes("\"exchange_index\":2"), true);
  assert.equal(firstWire.body.includes(firstKey.privateKey), false);
  assert.equal(secondWire.body.includes("BEGIN"), false);
  const closed = new AccountScopedExchange(readyState(USER_A));
  await assert.rejects(() => closed.submit(order, async () => {}), /operation_not_enabled/);
  assert.equal(closed.fetchCalls, 0);
  const opened = new AccountScopedExchange(readyState(USER_A, true), firstKey, null, async () => {
    throw new Error("fetch_must_not_run_without_a_fence");
  });
  await assert.rejects(() => opened.submit(order, async () => {}), /production_opaque_fence_required/);
  assert.equal(opened.fetchCalls, 0);
  const stale = readyState(USER_A, true);
  stale.presentedToken = 1;
  assert.equal(accountDispatchDecision(stale).reason, "stale_worker_fence");
  const killed = readyState(USER_A, true);
  killed.accountKill = true;
  assert.equal(accountDispatchDecision(killed).reason, "account_kill_switch");
  const duplicate = readyState(USER_A, true);
  duplicate.duplicateClientOrder = true;
  assert.equal(accountDispatchDecision(duplicate).reason, "duplicate_client_order");
  const pool = { query: async () => { throw new Error("pool_not_used"); }, connect: async () => { throw new Error("pool_not_used"); } } as unknown as Pool;
  const bound = bindAccountProductionWorker({
    pool,
    ownerUserId: USER_A,
    executionAccountId: "acct-a",
    credentialFingerprint: "ab".repeat(32),
    state: readyState(USER_A, true),
  });
  assert.equal(bound.worker.isScheduled(), false);
  assert.equal(bound.workerStarted, false);
  assert.equal(bound.exchange.state.liveExecutionEnabled, false);
  assert.equal(bound.executor.accountOwnerUserId, USER_A);
  const identity: Identity = { subaccount: 1, exchangeIndex: 2, keyFingerprint: "ab".repeat(32) };
  const reader = new AccountScopedExchange(readyState(USER_A), null, async () => snapshotFor(USER_B));
  await assert.rejects(() => reader.snapshot(identity, 0), /production_account_mismatch/);
  const session = readFileSync("src/lib/strata/accountProductionSession.ts", "utf8");
  const executor = readFileSync("src/lib/v13-production/executor.ts", "utf8");
  assert.equal(session.includes("process.env"), false);
  assert.equal(session.includes("KALSHI_INDEX2"), false);
  assert.equal(session.includes("KalshiProductionExchange"), false);
  assert.equal(executor.includes("id='production'"), true);
  assert.equal(executor.includes("a.owner_user_id = $2::uuid"), true);
});

test("a balance observation is not recorded as a transfer", async () => {
  let writes = 0;
  const refused = await persistAccountFundingEvidence({
    query: async () => { writes += 1; return { rows: [] }; },
    transaction: async (work) => work({ query: async () => ({ rows: [] }) }),
  }, {
    async listOwnedConnections() { throw new Error("connection_not_needed"); },
    async listCredentialRefs() { return []; },
    async readExecutionTarget() { return null; },
    async readSnapshot() { throw new Error("snapshot_not_used"); },
    async openCredential() { throw new Error("vault_not_opened"); },
  }, {
    authenticatedUserId: USER_A,
    confirmation: "RECORD_ACCOUNT_FUNDING_EVIDENCE",
    evidenceMicros: "1000000",
    evidenceSource: "kalshi_transfer",
  });
  assert.equal(refused.reason, "funding_transfer_unproven");
  assert.equal(refused.transferAttempted, false);
  assert.equal(writes, 0);
  const readiness = userCommissioningReadiness({
    roles: [{ role: "restricted_execution", fingerprint: "ab".repeat(32), verified: true, revoked: false, verificationReason: null }],
    authorizedMicros: "1000000",
    evidenceMicros: "1000000",
    evidenceSource: "kalshi_transfer",
    subaccount: 1,
    exchangeIndex: 2,
    policyOwned: true,
  });
  assert.equal(readiness.executable, false);
  assert.equal(readiness.blockers.includes("account_funding_transfer_unproven"), true);
  assert.equal(authorizeFutureAccountOperation({ operation: "transfer_funds", confirmation: "no" }).reason, "explicit_authorization_required");
  const named = authorizeFutureAccountOperation({ operation: "transfer_funds", confirmation: "TRANSFER_ACCOUNT_FUNDS" });
  assert.equal(named.ok, false);
  assert.equal(named.reason, "operation_not_enabled");
  assert.equal(named.attempted, false);
  assert.equal(authorizeFutureAccountOperation({ operation: "qualifying_order", confirmation: "SUBMIT_QUALIFYING_ORDER" }).attempted, false);
});

function keyMaterial(keyId: string): { keyId: string; privateKey: string } {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { keyId, privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
}

function sampleOrder(): Request {
  return {
    market: "KXBTC15M-TEST",
    side: "YES",
    action: "BUY",
    contracts: 1,
    limitMicros: 10_000,
    timeInForce: "IOC",
    reduceOnly: false,
    clientOrderId: "v13p-11111111-1111-4111-8111-111111111111",
  };
}

function readyState(owner: string, live = false): AccountDispatchState {
  return {
    leaseState: "owned",
    armRequested: true,
    accountKill: false,
    globalKill: false,
    fencingToken: 4,
    presentedToken: 4,
    workerActuallyScheduled: true,
    authenticatedUserId: owner,
    ownerUserId: owner,
    credentialFingerprint: "ab".repeat(32),
    presentedFingerprint: "ab".repeat(32),
    uncertainOrderCount: 0,
    duplicateClientOrder: false,
    liveExecutionEnabled: live,
  };
}

function snapshotFor(owner: string): Snapshot {
  const identity: Identity = { subaccount: 1, exchangeIndex: 2, keyFingerprint: owner === USER_A ? "ab".repeat(32) : "cd".repeat(32) };
  return {
    identity,
    observedAtMs: 0,
    complete: true,
    authenticated: true,
    historyFromMs: 0,
    cashMicros: "1000000",
    cashExact: true,
    orders: [],
    fills: [],
    settlements: [],
    positions: [],
    unexplainedCashActivity: false,
  };
}
