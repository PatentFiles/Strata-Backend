import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { emptySnapshot, planCommission, REVIEWED_FUNDING_MICROS } from "./commissioning";
import {
  evaluateAccountCommissioning,
  phase1ExecutionDecision,
  resolveAccountCommissioningContext,
  selectCredentialRef,
  useAccountCredential,
  type AccountCommissioningPorts,
  type AccountCredentialMaterial,
  type ExecutionTarget,
  type OwnedKalshiConnection,
  type StoredCredentialRef,
} from "./accountCommissioningContext";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const CONNECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FINANCIAL_A = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SECRET = "vault-secret-a";
const SENTINEL = "LEGACY-SENTINEL-PRIVATE-KEY";

function connection(): OwnedKalshiConnection {
  return {
    authenticatedUserId: USER_A,
    financialAccountId: FINANCIAL_A,
    providerConnectionId: CONNECTION_A,
  };
}

function ref(role: string, overrides: Partial<StoredCredentialRef> = {}): StoredCredentialRef {
  return {
    role,
    providerConnectionId: CONNECTION_A,
    vaultSecretId: `${SECRET}-${role}`,
    keyFingerprint: "ab".repeat(32),
    source: "vault_connection",
    ...overrides,
  };
}

function target(overrides: Partial<ExecutionTarget> = {}): ExecutionTarget {
  return {
    ownerUserId: USER_A,
    providerConnectionId: CONNECTION_A,
    executionAccountId: null,
    subaccount: 1,
    exchangeIndex: 2,
    ...overrides,
  };
}

function ports(options: {
  connections?: OwnedKalshiConnection[];
  refs?: StoredCredentialRef[];
  target?: ExecutionTarget | null;
  snapshot?: ReturnType<typeof emptySnapshot>;
  open?: AccountCommissioningPorts["openCredential"];
  calls?: string[];
} = {}): AccountCommissioningPorts {
  const calls = options.calls ?? [];
  return {
    async listOwnedConnections(userId) {
      calls.push(`connections:${userId}`);
      return options.connections ?? [connection()];
    },
    async listCredentialRefs(userId, connectionId) {
      calls.push(`refs:${userId}:${connectionId}`);
      return options.refs ?? [ref("provisioning"), ref("verification"), ref("restricted_execution")];
    },
    async readExecutionTarget(userId, connectionId) {
      calls.push(`target:${userId}:${connectionId}`);
      return options.target === undefined ? target() : options.target;
    },
    async readSnapshot(userId, connectionId) {
      calls.push(`snapshot:${userId}:${connectionId}`);
      return options.snapshot ?? emptySnapshot("2026-10-12T00:00:00.000Z");
    },
    async openCredential(userId, credential) {
      calls.push(`open:${userId}:${credential.role}`);
      return options.open ? options.open(userId, credential) : { keyId: "should-not-open", privateKey: SENTINEL };
    },
  };
}

test("resolution uses the authenticated user and ignores a client owner", async () => {
  const calls: string[] = [];
  const resolved = await resolveAccountCommissioningContext(USER_A, ports({ calls }), {
    owner_user_id: USER_B,
    target_user_id: USER_B,
    provider_connection_id: "client-picked",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.context.authenticatedUserId, USER_A);
  assert.equal(resolved.context.providerConnectionId, CONNECTION_A);
  assert.equal(resolved.context.executable, false);
  assert.deepEqual(calls, [
    `connections:${USER_A}`,
    `refs:${USER_A}:${CONNECTION_A}`,
    `target:${USER_A}:${CONNECTION_A}`,
  ]);
  assert.equal(calls.some((call) => call.includes(USER_B)), false);
});

test("a missing or ambiguous owned connection is refused", async () => {
  const missing = await resolveAccountCommissioningContext(USER_A, ports({ connections: [] }));
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.reason, "owned_connection_missing");
  const ambiguous = await resolveAccountCommissioningContext(USER_A, ports({
    connections: [connection(), { ...connection(), providerConnectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
  }));
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok) return;
  assert.equal(ambiguous.reason, "owned_connection_ambiguous");
});

test("another user's connection or execution account is refused", async () => {
  const foreignConnection = await resolveAccountCommissioningContext(USER_A, ports({
    connections: [{ ...connection(), authenticatedUserId: USER_B }],
  }));
  assert.equal(foreignConnection.ok, false);
  if (foreignConnection.ok) return;
  assert.equal(foreignConnection.reason, "foreign_connection");
  const foreignAccount = await resolveAccountCommissioningContext(USER_A, ports({
    target: target({ ownerUserId: USER_B }),
  }));
  assert.equal(foreignAccount.ok, false);
  if (foreignAccount.ok) return;
  assert.equal(foreignAccount.reason, "foreign_execution_account");
});

test("duplicate, foreign, and legacy credential sources are refused", async () => {
  const duplicate = await resolveAccountCommissioningContext(USER_A, ports({
    refs: [ref("verification"), ref("verification", { vaultSecretId: "other" })],
  }));
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.equal(duplicate.reason, "ambiguous_credential_role");
  const foreign = await resolveAccountCommissioningContext(USER_A, ports({
    refs: [ref("verification", { providerConnectionId: "other-connection" })],
  }));
  assert.equal(foreign.ok, false);
  if (foreign.ok) return;
  assert.equal(foreign.reason, "foreign_credential");
  const legacy = await resolveAccountCommissioningContext(USER_A, ports({
    refs: [{ ...ref("restricted_execution"), source: "KALSHI_INDEX2_PRIVATE_KEY" as "vault_connection" }],
  }));
  assert.equal(legacy.ok, false);
  if (legacy.ok) return;
  assert.equal(legacy.reason, "legacy_credential_fallback_refused");
});

test("missing credentials and phase 1 both refuse to open Vault material", async () => {
  const calls: string[] = [];
  process.env.KALSHI_INDEX2_PRIVATE_KEY = SENTINEL;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY = SENTINEL;
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = SENTINEL;
  try {
    const resolved = await resolveAccountCommissioningContext(USER_A, ports({ refs: [], calls }));
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const missing = selectCredentialRef(resolved.context, "restricted_execution");
    assert.equal(missing.ok, false);
    const opened = await useAccountCredential(
      resolved.context,
      "restricted_execution",
      ports({ refs: [], calls }),
      "generate_restricted_key",
      async (material: AccountCredentialMaterial) => material.privateKey,
    );
    assert.equal(opened.ok, false);
    if (opened.ok) return;
    assert.equal(opened.reason, "missing_credential");
    const present = await resolveAccountCommissioningContext(USER_A, ports({ calls }));
    assert.equal(present.ok, true);
    if (!present.ok) return;
    const blocked = await useAccountCredential(
      present.context,
      "restricted_execution",
      ports({ calls }),
      "verify_signer",
      async (material: AccountCredentialMaterial) => material.privateKey,
    );
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason, "operation_not_enabled");
    assert.equal(calls.some((call) => call.startsWith("open:")), false);
    assert.equal(JSON.stringify(blocked).includes(SENTINEL), false);
  } finally {
    delete process.env.KALSHI_INDEX2_PRIVATE_KEY;
    delete process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
    delete process.env.KALSHI_VERIFIER_API_PRIVATE_KEY;
  }
});

test("user-scoped evaluation reuses the legacy decision and does not arm", async () => {
  const snapshot = emptySnapshot("2026-10-12T00:00:00.000Z");
  const legacy = planCommission(snapshot);
  const evaluation = await evaluateAccountCommissioning(USER_A, ports({ snapshot }), {
    ownerUserId: USER_B,
  });
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.executable, false);
  assert.equal(evaluation.armEnabled, false);
  assert.equal(evaluation.workerStarted, false);
  assert.deepEqual(evaluation.plan, legacy.plan);
  assert.deepEqual(evaluation.blockers, legacy.blockers);
  assert.equal(evaluation.reviewedFundingMicros, REVIEWED_FUNDING_MICROS);
  assert.equal(JSON.stringify(evaluation).includes(SENTINEL), false);
  assert.equal(JSON.stringify(evaluation).includes("privateKey"), false);
  const mismatched = await evaluateAccountCommissioning(USER_A, ports({
    snapshot,
    target: target({ subaccount: 0, exchangeIndex: 2 }),
  }));
  assert.equal(mismatched.plan, null);
  assert.equal(mismatched.blockers.includes("account_target_pair_mismatch"), true);
  assert.deepEqual(planCommission(snapshot).blockers, legacy.blockers);
  const held = phase1ExecutionDecision({ ok: true, reason: "arm_database_flags_only" });
  assert.equal(held.executable, false);
  assert.equal(held.armEnabled, false);
  assert.equal(held.workerStarted, false);
  assert.equal(held.reason, "arm_not_enabled");
});

test("the account-scoped module does not read legacy Kalshi environment credentials", () => {
  const source = readFileSync("src/lib/strata/accountCommissioningContext.ts", "utf8");
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("getLiveProductionSupervisor"), false);
  const router = readFileSync("src/routes/userExecutionRouter.ts", "utf8");
  assert.equal(router.includes("accountCommissioningContext"), false);
  assert.equal(router.includes("legacy_claim_not_executed"), true);
  const database = readFileSync("src/lib/strata/userScopeDatabase.ts", "utf8");
  assert.equal(database.includes("user_execution_account_not_commissioned"), true);
});
