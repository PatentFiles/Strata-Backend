import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from "@workspace/v13-strategy";
import {
  computeV13LiveMoneyPolicyHash,
  type V13ApprovedLiveMoneyPolicy,
} from "../v13LiveMoneyRisk";
import { REVIEWED_FUNDING_MICROS } from "./commissioning";
import type { AccountCommissioningPorts, StoredCredentialRef } from "./accountCommissioningContext";
import type { CredentialClient, CredentialDatabase } from "./accountCredentialStore";
import {
  accountRiskAllowsEntry,
  duplicateClientOrder,
  executionBoundaryAllowsDispatch,
  operateAccountWorker,
  renewAccountWorkerLease,
  scopedObservationMatches,
  SCOPED_ORDERS_SQL,
  SCOPED_STAKE_SQL,
  type OwnedExecutionAccount,
} from "./accountScopedExecution";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const FINANCIAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FINANCIAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECRET_A = "12121212-1212-4121-8121-121212121212";
const SECRET_B = "34343434-3434-4343-8343-343434343434";
const ACCOUNT_A = "user-a-execution";
const ACCOUNT_B = "user-b-execution";
const FINGERPRINT_A = "ab".repeat(32);
const FINGERPRINT_B = "cd".repeat(32);

interface LeaseRow {
  executionAccountId: string;
  ownerUserId: string;
  financialAccountId: string;
  providerConnectionId: string;
  holderId: string;
  fencingToken: number;
  state: string;
  heartbeatAt: string;
  releasedAt: string | null;
  accountKill: boolean;
  armRequested: boolean;
  credentialFingerprint: string;
  vaultSecretId: string;
}

function policyFor(
  id: string,
  executionAccountId: string,
  maxEntryStakeCents: number,
  maxDailyLossCents: number,
  maxTotalLossCents: number,
): V13ApprovedLiveMoneyPolicy & { executionAccountId: string } {
  const policy: V13ApprovedLiveMoneyPolicy & { executionAccountId: string } = {
    id,
    version: 1,
    supersedesPolicyId: null,
    state: "APPROVED",
    strategyVersion: "V1.3",
    strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
    championSelectionReviewId: null,
    championSelectionEvidenceHash: null,
    championSelectedBy: null,
    championSelectedAt: null,
    capitalLimitCents: 2500,
    maxEntryStakeCents,
    maxEntryAllInCents: maxEntryStakeCents,
    maxOpenPositions: 1,
    maxDailyLossCents,
    maxTotalLossCents,
    maxQuoteAgeMs: 1_000,
    maxFeeEvidenceAgeMs: 1_000,
    feePolicyVersion: null,
    feeSourceUrl: null,
    feeFormulaVersion: null,
    requireFullDepth: true,
    entryTimeInForce: "IOC",
    entryLimitSource: "reviewed-ask",
    policyHash: null,
    createdBy: "phase3-test",
    approvedBy: "phase3-test",
    approvedAt: new Date("2026-10-12T00:00:00.000Z"),
    executionAccountId,
  };
  policy.policyHash = computeV13LiveMoneyPolicyHash(policy);
  return policy;
}

function accountFor(userId: string): OwnedExecutionAccount {
  const mine = userId === USER_A;
  return {
    executionAccountId: mine ? ACCOUNT_A : ACCOUNT_B,
    ownerUserId: userId,
    financialAccountId: mine ? FINANCIAL_A : FINANCIAL_B,
    providerConnectionId: mine ? CONNECTION_A : CONNECTION_B,
    subaccount: 1,
    exchangeIndex: 2,
    keyFingerprint: mine ? FINGERPRINT_A : FINGERPRINT_B,
    commissioned: true,
    executionEnabled: false,
    killSwitch: false,
    configuredStakeCents: mine ? 100 : 500,
    cashMicros: mine ? 1_000_000n : 5_000_000n,
    policy: policyFor(mine ? "policy-a" : "policy-b", mine ? ACCOUNT_A : ACCOUNT_B, mine ? 100 : 500, mine ? 100 : 400, mine ? 200 : 800),
    positions: mine ? [] : [{ market: "KXBTC15M-B", quantityHundredths: 100 }],
    orders: mine ? [{ clientOrderId: "order-a", state: "TERMINAL" }] : [{ clientOrderId: "order-b", state: "DISPATCHED" }],
    fillIds: mine ? ["fill-a"] : ["fill-b"],
    settlementIds: mine ? ["settlement-a"] : [],
    realizedPnlMicros: mine ? 0n : -50_000n,
    realizedDailyLossCents: mine ? 0 : 50,
    realizedTotalLossCents: mine ? 0 : 50,
  };
}

function ports(opened: { count: number }, fingerprint = FINGERPRINT_A, missingCredential = false): AccountCommissioningPorts {
  const ref = (userId: string): StoredCredentialRef => ({
    role: "restricted_execution",
    providerConnectionId: userId === USER_A ? CONNECTION_A : CONNECTION_B,
    vaultSecretId: userId === USER_A ? SECRET_A : SECRET_B,
    keyFingerprint: userId === USER_A ? fingerprint : FINGERPRINT_B,
    source: "vault_connection",
  });
  return {
    async listOwnedConnections(userId) {
      if (userId !== USER_A && userId !== USER_B) return [];
      return [{
        authenticatedUserId: userId,
        financialAccountId: userId === USER_A ? FINANCIAL_A : FINANCIAL_B,
        providerConnectionId: userId === USER_A ? CONNECTION_A : CONNECTION_B,
      }];
    },
    async listCredentialRefs(userId, providerConnectionId) {
      if (missingCredential) return [];
      const credential = ref(userId);
      return credential.providerConnectionId === providerConnectionId ? [credential] : [];
    },
    async readExecutionTarget(userId, providerConnectionId) {
      const account = accountFor(userId);
      if (account.providerConnectionId !== providerConnectionId) return null;
      return {
        ownerUserId: userId,
        providerConnectionId,
        executionAccountId: account.executionAccountId,
        subaccount: account.subaccount,
        exchangeIndex: account.exchangeIndex,
      };
    },
    async readSnapshot() {
      throw new Error("snapshot_not_used");
    },
    async openCredential() {
      opened.count += 1;
      throw new Error("vault_opened");
    },
  };
}

function memoryLeases(failAcquire = false): CredentialDatabase & { rows: LeaseRow[] } {
  const rows: LeaseRow[] = [];
  let turn = Promise.resolve();
  let fail = failAcquire;
  const query: CredentialClient["query"] = async (text, params = []) => {
    const tag = text.match(/account-worker:([a-z-]+)/)?.[1] ?? "";
    if (tag === "lock-owner") {
      return { rows: rows.filter((item) => item.ownerUserId === params[0]).map(view) };
    }
    if (tag === "lock") {
      const row = rows.find((item) => item.executionAccountId === params[0]);
      return { rows: row ? [view(row)] : [] };
    }
    if (tag === "insert") {
      rows.push({
        executionAccountId: String(params[0]),
        ownerUserId: String(params[1]),
        financialAccountId: String(params[2]),
        providerConnectionId: String(params[3]),
        holderId: String(params[4]),
        fencingToken: Number(params[5]),
        state: String(params[6]),
        heartbeatAt: String(params[7]),
        releasedAt: params[8] == null ? null : String(params[8]),
        accountKill: params[9] === true,
        armRequested: params[10] === true,
        credentialFingerprint: String(params[11]),
        vaultSecretId: String(params[12]),
      });
      return { rows: [{ fencing_token: "1" }] };
    }
    const row = rows.find((item) => item.executionAccountId === params[0]);
    if (!row) return { rows: [] };
    if (tag === "arm") {
      if (row.ownerUserId !== params[1] || row.state !== "released" || row.accountKill) return { rows: [] };
      row.armRequested = true;
      row.credentialFingerprint = String(params[2]);
      row.vaultSecretId = String(params[3]);
      row.heartbeatAt = String(params[4]);
      row.providerConnectionId = String(params[5]);
      row.financialAccountId = String(params[6]);
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }
    if (tag === "acquire") {
      const stale = row.heartbeatAt < String(params[8]);
      const allowed = row.ownerUserId === params[7] && !row.accountKill && row.state !== "killed" && row.armRequested &&
        (row.state !== "owned" || row.holderId === params[1] || stale);
      if (!allowed) return { rows: [] };
      if (fail) {
        fail = false;
        row.state = "owned";
        throw Object.assign(new Error("forced_acquire_failure"), { code: "23514" });
      }
      row.holderId = String(params[1]);
      row.fencingToken += 1;
      row.state = "owned";
      row.heartbeatAt = String(params[2]);
      row.releasedAt = null;
      row.armRequested = true;
      row.accountKill = false;
      row.credentialFingerprint = String(params[3]);
      row.vaultSecretId = String(params[4]);
      row.providerConnectionId = String(params[5]);
      row.financialAccountId = String(params[6]);
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }
    if (tag === "release") {
      if (row.ownerUserId !== params[1] || row.state !== "owned" || row.accountKill) return { rows: [] };
      row.state = "released";
      row.releasedAt = String(params[2]);
      row.heartbeatAt = String(params[2]);
      row.armRequested = false;
      row.fencingToken += 1;
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }
    if (tag === "kill") {
      if (row.ownerUserId !== params[1]) return { rows: [] };
      row.state = "killed";
      row.accountKill = true;
      row.armRequested = false;
      row.releasedAt = String(params[2]);
      row.heartbeatAt = String(params[2]);
      row.fencingToken += 1;
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }
    if (tag === "hold") {
      if (row.ownerUserId !== params[1] || row.state !== "owned" || row.accountKill) return { rows: [] };
      row.armRequested = false;
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }
    if (tag === "disarm") {
      if (row.ownerUserId !== params[1] || row.accountKill) return { rows: [] };
      row.armRequested = false;
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }
    if (tag === "heartbeat") {
      const matches = row.ownerUserId === params[1] && row.holderId === params[3] &&
        row.fencingToken === Number(params[4]) && row.state === "owned" && !row.accountKill &&
        row.credentialFingerprint === params[5];
      if (!matches) return { rows: [] };
      row.heartbeatAt = String(params[2]);
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }
    return { rows: [] };
  };
  return {
    rows,
    query,
    async transaction(work) {
      const previous = turn;
      let release = () => {};
      turn = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const saved = structuredClone(rows);
      try {
        return await work({ query });
      } catch (error) {
        rows.splice(0, rows.length, ...saved);
        throw error;
      } finally {
        release();
      }
    },
  };
}

function view(row: LeaseRow): Record<string, unknown> {
  return {
    execution_account_id: row.executionAccountId,
    owner_user_id: row.ownerUserId,
    holder_id: row.holderId,
    fencing_token: String(row.fencingToken),
    state: row.state,
    heartbeat_at: row.heartbeatAt,
    account_kill: row.accountKill,
    arm_requested: row.armRequested,
    credential_fingerprint: row.credentialFingerprint,
    vault_secret_id: row.vaultSecretId,
  };
}

function deps(options?: {
  now?: () => number;
  globalKill?: boolean;
  fingerprint?: string;
  killSwitch?: boolean;
  failAcquire?: boolean;
  accounts?: Map<string, OwnedExecutionAccount>;
  missingCredential?: boolean;
  safety?: {
    listAccounts(userId: string): Promise<Array<{
      executionAccountId: string;
      ownerUserId: string;
      financialAccountId: string;
      providerConnectionId: string;
      keyFingerprint: string | null;
      vaultSecretId: string | null;
      openPositionCount: number;
      unresolvedIntentCount: number;
    }>>;
    markKilled(userId: string, executionAccountId: string): Promise<void>;
  };
}) {
  const opened = { count: 0 };
  const accounts = options?.accounts ?? new Map<string, OwnedExecutionAccount>([
    [ACCOUNT_A, accountFor(USER_A)],
    [ACCOUNT_B, accountFor(USER_B)],
  ]);
  if (options?.killSwitch) accounts.get(ACCOUNT_A)!.killSwitch = true;
  const leases = memoryLeases(options?.failAcquire);
  return {
    opened,
    leases,
    deps: {
      commissioning: ports(opened, options?.fingerprint, options?.missingCredential),
      safety: options?.safety,
      activity: {
        async readOwnedAccount(userId: string, executionAccountId: string) {
          const account = accounts.get(executionAccountId);
          return account?.ownerUserId === userId ? account : null;
        },
      },
      leases,
      globalKill: async () => options?.globalKill === true,
      now: options?.now ?? (() => Date.parse("2026-10-12T21:00:00.000Z")),
    },
  };
}

test("two users keep separate balances, positions, stake, and risk budgets", () => {
  const first = accountFor(USER_A);
  const second = accountFor(USER_B);
  assert.equal(accountRiskAllowsEntry(first, 100, 0, 0), true);
  assert.equal(accountRiskAllowsEntry(first, 101, 0, 0), false);
  assert.equal(accountRiskAllowsEntry(second, 200, 0, 0), true);
  assert.equal(accountRiskAllowsEntry(second, 200, 400, 0), false);
  assert.equal(duplicateClientOrder(first, "order-a"), true);
  assert.equal(duplicateClientOrder(second, "order-a"), false);
  assert.equal(duplicateClientOrder(second, "order-b"), true);
  assert.equal(scopedObservationMatches(first, {
    executionAccountId: ACCOUNT_B,
    ownerUserId: USER_B,
    subaccount: 1,
    exchangeIndex: 2,
    keyFingerprint: FINGERPRINT_B,
  }).ok, false);
  assert.equal(first.executionEnabled, false);
  assert.equal(first.cashMicros === second.cashMicros, false);
  assert.equal(REVIEWED_FUNDING_MICROS, "25000000");
});

test("arm and start acquire one lease and never open Vault or enable execution", async () => {
  const harness = deps();
  const armed = await operateAccountWorker(harness.deps, {
    authenticatedUserId: USER_A,
    holderId: "process-a",
    action: "ARM",
    clientRequest: { owner_user_id: USER_B },
  });
  const started = await operateAccountWorker(harness.deps, {
    authenticatedUserId: USER_A,
    holderId: "process-a",
    action: "START",
  });
  assert.equal(armed.ok, true);
  assert.equal(started.ok, true);
  assert.equal(started.executable, false);
  assert.equal(started.workerStarted, false);
  assert.equal(started.reason, "operation_not_enabled");
  assert.equal(started.state, "owned");
  assert.equal(started.fencingToken, 2);
  assert.equal(harness.opened.count, 0);
  assert.equal(harness.leases.rows[0]?.state, "owned");
  assert.equal(harness.leases.rows[0]?.credentialFingerprint, FINGERPRINT_A);
});

test("a second holder cannot own a fresh lease, and a crashed lease can be recovered", async () => {
  let now = Date.parse("2026-10-12T21:00:00.000Z");
  const harness = deps({ now: () => now });
  await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "ARM" });
  const first = await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "START" });
  const duplicate = await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-b", action: "START" });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "worker_already_owned");
  now += 31_000;
  const recovered = await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-b", action: "START" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.fencingToken, 3);
  const stale = await renewAccountWorkerLease(harness.deps, {
    authenticatedUserId: USER_A,
    executionAccountId: ACCOUNT_A,
    holderId: "process-a",
    fencingToken: first.fencingToken ?? 0,
    credentialFingerprint: FINGERPRINT_A,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale_worker_fence");
});

test("concurrent starts serialize to one owned lease", async () => {
  const harness = deps();
  await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "ARM" });
  const [left, right] = await Promise.all([
    operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "START" }),
    operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-b", action: "START" }),
  ]);
  const owned = [left, right].filter((result) => result.ok);
  assert.equal(owned.length, 1);
  assert.equal(harness.leases.rows.filter((row) => row.state === "owned").length, 1);
});

test("failed acquisition rolls the lease back", async () => {
  const harness = deps({ failAcquire: true });
  await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "ARM" });
  await assert.rejects(() => operateAccountWorker(harness.deps, {
    authenticatedUserId: USER_A,
    holderId: "process-a",
    action: "START",
  }));
  assert.equal(harness.leases.rows[0]?.state, "released");
  const started = await operateAccountWorker(harness.deps, {
    authenticatedUserId: USER_A,
    holderId: "process-a",
    action: "START",
  });
  assert.equal(started.ok, true);
  assert.equal(started.state, "owned");
});

test("wrong user, credential mismatch, exposure, and kill switches stay isolated", async () => {
  const harness = deps();
  await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "ARM" });
  await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "START" });
  await operateAccountWorker(harness.deps, { authenticatedUserId: USER_B, holderId: "process-b", action: "ARM" });
  const other = await operateAccountWorker(harness.deps, { authenticatedUserId: USER_B, holderId: "process-b", action: "START" });
  assert.equal(other.ok, true);
  assert.equal(other.executable, false);
  assert.equal(harness.leases.rows.filter((row) => row.state === "owned").length, 2);
  const exposed = await operateAccountWorker(harness.deps, { authenticatedUserId: USER_B, holderId: "process-b", action: "STOP" });
  assert.equal(exposed.ok, true);
  assert.equal(exposed.reason, "entries_stopped");
  assert.equal(exposed.executionActive, false);
  assert.equal(exposed.armRequested, false);
  assert.equal(harness.leases.rows.find((row) => row.executionAccountId === ACCOUNT_B)?.state, "owned");
  const stranger = await operateAccountWorker(harness.deps, {
    authenticatedUserId: "33333333-3333-4333-8333-333333333333",
    holderId: "process-c",
    action: "START",
  });
  assert.equal(stranger.reason, "owned_connection_missing");
  const mismatch = deps({ fingerprint: "ef".repeat(32) });
  const refused = await operateAccountWorker(mismatch.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "ARM" });
  assert.equal(refused.reason, "credential_fingerprint_mismatch");
  const killed = await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "KILL" });
  assert.equal(killed.accountKill, true);
  assert.equal(killed.executable, false);
  const blocked = await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-c", action: "START" });
  assert.equal(blocked.reason, "account_kill_switch");
  const global = deps({ globalKill: true });
  const globalRefusal = await operateAccountWorker(global.deps, { authenticatedUserId: USER_B, holderId: "process-b", action: "START" });
  assert.equal(globalRefusal.reason, "global_kill_switch");
  const released = await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "STOP" });
  assert.equal(released.ok, true);
  assert.equal(released.reason, "account_killed");
  assert.equal(released.executionActive, false);
});

test("stop and kill do not require a working signer", async () => {
  const harness = deps();
  await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "ARM" });
  await operateAccountWorker(harness.deps, { authenticatedUserId: USER_A, holderId: "process-a", action: "START" });
  let killedAccount = false;
  const blinded = deps({
    missingCredential: true,
    safety: {
      async listAccounts(userId) {
        if (userId !== USER_A) return [];
        return [{
          executionAccountId: ACCOUNT_A,
          ownerUserId: USER_A,
          financialAccountId: FINANCIAL_A,
          providerConnectionId: CONNECTION_A,
          keyFingerprint: null,
          vaultSecretId: null,
          openPositionCount: 1,
          unresolvedIntentCount: 1,
        }];
      },
      async markKilled() { killedAccount = true; },
    },
  });
  blinded.deps.leases = harness.leases;
  const stopped = await operateAccountWorker(blinded.deps, {
    authenticatedUserId: USER_A,
    holderId: "process-a",
    action: "STOP",
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.reason, "entries_stopped");
  assert.equal(stopped.executionActive, false);
  assert.equal(stopped.workerStarted, false);
  assert.equal(harness.leases.rows[0]?.state, "owned");
  assert.equal(harness.leases.rows[0]?.armRequested, false);
  const killed = await operateAccountWorker(blinded.deps, {
    authenticatedUserId: USER_A,
    holderId: "safety",
    action: "KILL",
  });
  assert.equal(killed.ok, true);
  assert.equal(killed.accountKill, true);
  assert.equal(killed.executionActive, false);
  assert.equal(killedAccount, true);
  assert.equal(executionBoundaryAllowsDispatch({
    leaseState: "owned",
    armRequested: true,
    accountKill: false,
    globalKill: false,
    fencingToken: 2,
    presentedToken: 2,
    workerActuallyScheduled: true,
  }).reason, "operation_not_enabled");
  assert.equal(executionBoundaryAllowsDispatch({
    leaseState: "owned",
    armRequested: true,
    accountKill: true,
    globalKill: false,
    fencingToken: 2,
    presentedToken: 2,
    workerActuallyScheduled: true,
  }).reason, "account_kill_switch");
});

test("the user execution route and legacy stake path stay unchanged", () => {
  const engine = readFileSync("src/lib/strata/accountScopedExecution.ts", "utf8");
  const legacyControl = readFileSync("src/lib/strata/userScopeDatabase.ts", "utf8");
  const legacyExecutor = readFileSync("src/lib/v13-production/executor.ts", "utf8");
  const migration = readFileSync("../../lib/db/drizzle/0013_kalshi_account_worker_lease.sql", "utf8");
  assert.equal(engine.includes("process.env"), false);
  assert.equal(engine.includes("ProductionWorker"), false);
  assert.equal(engine.includes("KALSHI_INDEX2"), false);
  assert.equal(engine.includes("decrypted_secret"), false);
  assert.equal(SCOPED_STAKE_SQL.includes("id = 'production'"), false);
  assert.equal(SCOPED_ORDERS_SQL.includes("owner_user_id"), true);
  assert.match(legacyControl, /user_execution_signer_not_provisioned/);
  assert.match(legacyExecutor, /id='production'/);
  assert.match(migration, /REVIEW ONLY/);
  assert.match(migration, /DROP TABLE IF EXISTS private\.kalshi_account_worker_lease/);
  assert.equal(migration.includes("decrypted_secret"), false);
});
