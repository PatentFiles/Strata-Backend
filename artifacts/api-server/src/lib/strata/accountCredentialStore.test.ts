import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { emptySnapshot, planCommission } from "./commissioning";
import {
  evaluateAccountCommissioning,
  resolveAccountCommissioningContext,
  selectCredentialRef,
  useAccountCredential,
} from "./accountCommissioningContext";
import {
  createDatabaseAccountCommissioningPorts,
  replaceOwnedCredentialBinding,
  type CredentialClient,
  type CredentialDatabase,
} from "./accountCredentialStore";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const CONNECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FINANCIAL_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FINANCIAL_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WALLET_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WALLET_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SECRET_A = "12121212-1212-4121-8121-121212121212";
const SECRET_B = "34343434-3434-4343-8343-343434343434";
const SECRET_NEXT = "56565656-5656-4565-8565-565656565656";
const FINGERPRINT = "ab".repeat(32);
const SENTINEL = "LEGACY-SENTINEL-PRIVATE-KEY";

interface ConnectionRow {
  userId: string;
  financialAccountId: string;
  providerConnectionId: string;
  vaultSecretId: string;
}

interface BindingRow {
  id: string;
  ownerUserId: string;
  financialAccountId: string;
  providerConnectionId: string;
  role: string;
  vaultSecretId: string;
  keyFingerprint: string | null;
  revokedAt: string | null;
  replacedBy: string | null;
}

interface ExecutionRow {
  id: string;
  ownerUserId: string;
  financialAccountId: string;
  subaccount: number;
  exchangeIndex: number;
  commissioned: boolean;
  executionEnabled: boolean;
  killSwitch: boolean;
  keyFingerprint: string;
}

function memory(seed?: {
  connections?: ConnectionRow[];
  bindings?: BindingRow[];
  executions?: ExecutionRow[];
  duplicateList?: boolean;
  failInsert?: boolean;
}) {
  const calls: string[] = [];
  let sequence = 0;
  let turn = Promise.resolve();
  const connections = [...(seed?.connections ?? [
    { userId: USER_A, financialAccountId: FINANCIAL_A, providerConnectionId: CONNECTION_A, vaultSecretId: WALLET_A },
    { userId: USER_B, financialAccountId: FINANCIAL_B, providerConnectionId: CONNECTION_B, vaultSecretId: WALLET_B },
  ])];
  const bindings = [...(seed?.bindings ?? [])];
  const executions = [...(seed?.executions ?? [])];
  const query: CredentialClient["query"] = async (text, params = []) => {
    calls.push(text);
    assert.equal(text.includes("decrypted_secret"), false);
    assert.equal(text.includes("KALSHI_"), false);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    if (text.includes("credential-replacement:lock-connection")) {
      assert.match(text, /FOR UPDATE OF pc/);
      assert.match(text, /fa\.user_id = \$1::uuid/);
      return {
        rows: connections.filter((row) => row.userId === params[0] && row.providerConnectionId === params[1]).map((row) => ({
          provider_connection_id: row.providerConnectionId,
          financial_account_id: row.financialAccountId,
          owner_user_id: row.userId,
          connection_vault_secret_id: row.vaultSecretId,
        })),
      };
    }
    if (text.includes("credential-replacement:vault-used")) {
      return { rows: bindings.filter((row) => row.vaultSecretId === params[0]).map((row) => ({ id: row.id })) };
    }
    if (text.includes("credential-replacement:lock-active")) {
      assert.match(text, /FOR UPDATE/);
      return {
        rows: bindings.filter((row) =>
          row.providerConnectionId === params[0] &&
          row.ownerUserId === params[1] &&
          row.financialAccountId === params[2] &&
          row.role === params[3] &&
          row.revokedAt === null).map((row) => ({ id: row.id })),
      };
    }
    if (text.includes("credential-replacement:revoke")) {
      const row = bindings.find((binding) => binding.id === params[0] && binding.revokedAt === null);
      if (!row || row.ownerUserId !== params[1] || row.providerConnectionId !== params[2]) return { rows: [] };
      row.revokedAt = "2026-10-12T20:00:00.000Z";
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("credential-replacement:insert")) {
      if (seed?.failInsert) {
        const error = new Error("insert failed") as Error & { code: string };
        error.code = "23503";
        throw error;
      }
      const id = `cred-${sequence += 1}`;
      bindings.push({
        id,
        ownerUserId: String(params[0]),
        financialAccountId: String(params[1]),
        providerConnectionId: String(params[2]),
        role: String(params[3]),
        vaultSecretId: String(params[4]),
        keyFingerprint: typeof params[5] === "string" ? params[5] : null,
        revokedAt: null,
        replacedBy: null,
      });
      return { rows: [{ credential_id: id }] };
    }
    if (text.includes("credential-replacement:link")) {
      const row = bindings.find((binding) => binding.id === params[0] && binding.revokedAt !== null && binding.replacedBy === null);
      if (!row || row.ownerUserId !== params[2] || row.providerConnectionId !== params[3]) return { rows: [] };
      row.replacedBy = String(params[1]);
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("FROM public.financial_accounts fa") && text.includes("provider_connection_id")) {
      assert.match(text, /fa\.user_id = \$1::uuid/);
      return {
        rows: connections.filter((row) => row.userId === params[0]).map((row) => ({
          authenticated_user_id: row.userId,
          financial_account_id: row.financialAccountId,
          provider_connection_id: row.providerConnectionId,
        })),
      };
    }
    if (text.includes("FROM private.kalshi_connection_credentials c")) {
      assert.match(text, /c\.owner_user_id = \$1::uuid/);
      assert.match(text, /c\.provider_connection_id = \$2::uuid/);
      assert.match(text, /c\.revoked_at IS NULL/);
      const rows = bindings.filter((row) =>
        row.ownerUserId === params[0] &&
        row.providerConnectionId === params[1] &&
        row.revokedAt === null);
      const visible = seed?.duplicateList ? [...rows, ...rows] : rows;
      return {
        rows: visible.map((row) => ({
          role: row.role,
          provider_connection_id: row.providerConnectionId,
          vault_secret_id: row.vaultSecretId,
          key_fingerprint: row.keyFingerprint,
        })),
      };
    }
    if (text.includes("FROM v13_production_account")) {
      assert.match(text, /a\.owner_user_id = \$1::uuid/);
      assert.match(text, /pc\.id = \$2::uuid/);
      const connection = connections.find((row) => row.userId === params[0] && row.providerConnectionId === params[1]);
      const rows = executions.filter((row) =>
        row.ownerUserId === params[0] && connection && row.financialAccountId === connection.financialAccountId);
      return {
        rows: rows.map((row) => ({
          execution_account_id: row.id,
          owner_user_id: row.ownerUserId,
          provider_connection_id: connection?.providerConnectionId,
          subaccount: row.subaccount,
          exchange_index: row.exchangeIndex,
          commissioned: row.commissioned,
          execution_enabled: row.executionEnabled,
          kill_switch: row.killSwitch,
          key_fingerprint: row.keyFingerprint,
        })),
      };
    }
    throw new Error(`unexpected credential sql: ${text.slice(0, 80)}`);
  };
  const db: CredentialDatabase = {
    query,
    async transaction(work) {
      const previous = turn;
      let release: () => void = () => {};
      turn = new Promise((resolve) => { release = resolve; });
      await previous;
      const snapshot = bindings.map((row) => ({ ...row }));
      try {
        return await work({ query });
      } catch (error) {
        bindings.splice(0, bindings.length, ...snapshot);
        throw error;
      } finally {
        release();
      }
    },
  };
  return { db, calls, connections, bindings, executions };
}

test("two users resolve only their own connection and roles", async () => {
  const state = memory({
    bindings: [
      binding(USER_A, CONNECTION_A, FINANCIAL_A, "verification", SECRET_A),
      binding(USER_B, CONNECTION_B, FINANCIAL_B, "verification", SECRET_B),
    ],
  });
  const ports = createDatabaseAccountCommissioningPorts(state.db);
  const resolved = await resolveAccountCommissioningContext(USER_A, ports, { owner_user_id: USER_B });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.context.authenticatedUserId, USER_A);
  assert.equal(resolved.context.providerConnectionId, CONNECTION_A);
  assert.deepEqual(resolved.context.credentials.map((ref) => ref.vaultSecretId), [SECRET_A]);
  assert.equal(JSON.stringify(resolved.context).includes(SECRET_B), false);
  assert.equal(JSON.stringify(resolved.context).includes(WALLET_A), false);
});

test("missing, duplicate, revoked, and invalid credential roles are refused", async () => {
  const state = memory({
    bindings: [binding(USER_A, CONNECTION_A, FINANCIAL_A, "provisioning", SECRET_A)],
  });
  const ports = createDatabaseAccountCommissioningPorts(state.db);
  const resolved = await resolveAccountCommissioningContext(USER_A, ports);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(selectCredentialRef(resolved.context, "restricted_execution").ok, false);
  state.bindings[0]!.revokedAt = "2026-10-12T20:00:00.000Z";
  const revoked = await resolveAccountCommissioningContext(USER_A, ports);
  assert.equal(revoked.ok, true);
  if (!revoked.ok) return;
  assert.equal(selectCredentialRef(revoked.context, "provisioning").ok, false);

  const duplicate = memory({
    bindings: [binding(USER_A, CONNECTION_A, FINANCIAL_A, "verification", SECRET_A)],
    duplicateList: true,
  });
  const ambiguous = await resolveAccountCommissioningContext(
    USER_A,
    createDatabaseAccountCommissioningPorts(duplicate.db),
  );
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok) return;
  assert.equal(ambiguous.reason, "ambiguous_credential_role");

  const invalid = memory({
    bindings: [{
      ...binding(USER_A, CONNECTION_A, FINANCIAL_A, "verification", SECRET_A),
      keyFingerprint: "not-a-fingerprint",
    }],
  });
  const rejected = await resolveAccountCommissioningContext(
    USER_A,
    createDatabaseAccountCommissioningPorts(invalid.db),
  );
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.reason, "credential_fingerprint_invalid");
});

test("cross-user replacement and reused secrets are refused", async () => {
  const state = memory({
    bindings: [binding(USER_A, CONNECTION_A, FINANCIAL_A, "restricted_execution", SECRET_A)],
  });
  const foreign = await replaceOwnedCredentialBinding(state.db, {
    authenticatedUserId: USER_B,
    providerConnectionId: CONNECTION_A,
    role: "restricted_execution",
    vaultSecretId: SECRET_NEXT,
    keyFingerprint: FINGERPRINT,
  });
  assert.equal(foreign.ok, false);
  if (foreign.ok) return;
  assert.equal(foreign.reason, "credential_not_owned");
  assert.equal(state.bindings[0]?.revokedAt, null);

  const reusedWallet = await replaceOwnedCredentialBinding(state.db, {
    authenticatedUserId: USER_A,
    providerConnectionId: CONNECTION_A,
    role: "verification",
    vaultSecretId: WALLET_A,
    keyFingerprint: FINGERPRINT,
  });
  assert.equal(reusedWallet.ok, false);
  if (reusedWallet.ok) return;
  assert.equal(reusedWallet.reason, "vault_secret_reused_from_provider_connection");

  const reusedBinding = await replaceOwnedCredentialBinding(state.db, {
    authenticatedUserId: USER_A,
    providerConnectionId: CONNECTION_A,
    role: "verification",
    vaultSecretId: SECRET_A,
    keyFingerprint: FINGERPRINT,
  });
  assert.equal(reusedBinding.ok, false);
  if (reusedBinding.ok) return;
  assert.equal(reusedBinding.reason, "vault_secret_reused");
  assert.equal(state.bindings.length, 1);
});

test("replacement keeps the old secret reference and does not copy the wallet secret", async () => {
  const state = memory({
    bindings: [binding(USER_A, CONNECTION_A, FINANCIAL_A, "restricted_execution", SECRET_A)],
  });
  const replaced = await replaceOwnedCredentialBinding(state.db, {
    authenticatedUserId: USER_A,
    providerConnectionId: CONNECTION_A,
    role: "restricted_execution",
    vaultSecretId: SECRET_NEXT,
    keyFingerprint: FINGERPRINT,
  });
  assert.equal(replaced.ok, true);
  if (!replaced.ok) return;
  const old = state.bindings.find((row) => row.vaultSecretId === SECRET_A);
  const created = state.bindings.find((row) => row.id === replaced.credentialId);
  assert.equal(old?.revokedAt !== null, true);
  assert.equal(old?.replacedBy, replaced.credentialId);
  assert.equal(created?.vaultSecretId, SECRET_NEXT);
  assert.equal(created?.revokedAt, null);
  assert.equal(state.connections[0]?.vaultSecretId, WALLET_A);
  assert.equal(state.bindings.some((row) => row.vaultSecretId === WALLET_A), false);
  const active = state.bindings.filter((row) => row.role === "restricted_execution" && row.revokedAt === null);
  assert.equal(active.length, 1);
  const markers = state.calls.map((sql) => sql.match(/credential-replacement:([a-z-]+)/)?.[1]).filter(Boolean);
  assert.deepEqual(markers, ["lock-connection", "vault-used", "lock-active", "revoke", "insert", "link"]);
});

test("a failed insert rolls the revoked binding back", async () => {
  const state = memory({
    bindings: [binding(USER_A, CONNECTION_A, FINANCIAL_A, "restricted_execution", SECRET_A)],
    failInsert: true,
  });
  const result = await replaceOwnedCredentialBinding(state.db, {
    authenticatedUserId: USER_A,
    providerConnectionId: CONNECTION_A,
    role: "restricted_execution",
    vaultSecretId: SECRET_NEXT,
    keyFingerprint: FINGERPRINT,
  });
  assert.equal(result.ok, false);
  assert.equal(state.bindings.length, 1);
  assert.equal(state.bindings[0]?.revokedAt, null);
  assert.equal(state.bindings[0]?.replacedBy, null);
  assert.equal(state.bindings[0]?.vaultSecretId, SECRET_A);
});

test("concurrent replacements serialize to one active binding", async () => {
  const state = memory({
    bindings: [binding(USER_A, CONNECTION_A, FINANCIAL_A, "restricted_execution", SECRET_A)],
  });
  const second = "78787878-7878-4787-8787-787878787878";
  const [first, next] = await Promise.all([
    replaceOwnedCredentialBinding(state.db, {
      authenticatedUserId: USER_A,
      providerConnectionId: CONNECTION_A,
      role: "restricted_execution",
      vaultSecretId: SECRET_NEXT,
      keyFingerprint: FINGERPRINT,
    }),
    replaceOwnedCredentialBinding(state.db, {
      authenticatedUserId: USER_A,
      providerConnectionId: CONNECTION_A,
      role: "restricted_execution",
      vaultSecretId: second,
      keyFingerprint: FINGERPRINT,
    }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(next.ok, true);
  const active = state.bindings.filter((row) => row.role === "restricted_execution" && row.revokedAt === null);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.vaultSecretId, second);
  assert.equal(state.bindings.filter((row) => row.revokedAt !== null).length, 2);
});

test("database resolution does not open secrets or fall back to Railway credentials", async () => {
  process.env.KALSHI_INDEX2_PRIVATE_KEY = SENTINEL;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY = SENTINEL;
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = SENTINEL;
  try {
    const state = memory({
      bindings: [binding(USER_A, CONNECTION_A, FINANCIAL_A, "verification", SECRET_A)],
      executions: [{
        id: "acct-a",
        ownerUserId: USER_A,
        financialAccountId: FINANCIAL_A,
        subaccount: 1,
        exchangeIndex: 2,
        commissioned: false,
        executionEnabled: false,
        killSwitch: true,
        keyFingerprint: FINGERPRINT,
      }],
    });
    const ports = createDatabaseAccountCommissioningPorts(state.db, () => "2026-10-12T00:00:00.000Z");
    const evaluation = await evaluateAccountCommissioning(USER_A, ports, { ownerUserId: USER_B });
    const legacy = planCommission(emptySnapshot("2026-10-12T00:00:00.000Z"));
    assert.equal(evaluation.executable, false);
    assert.equal(evaluation.armEnabled, false);
    assert.equal(evaluation.plan, null);
    assert.deepEqual(evaluation.blockers, legacy.blockers);
    assert.equal(JSON.stringify(evaluation).includes(SENTINEL), false);
    assert.equal(JSON.stringify(evaluation).includes("privateKey"), false);
    const resolved = await resolveAccountCommissioningContext(USER_A, ports);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const opened = await useAccountCredential(
      resolved.context,
      "verification",
      ports,
      "verify_signer",
      async (material) => material.privateKey,
    );
    assert.equal(opened.ok, false);
    assert.equal(state.calls.some((sql) => sql.includes("decrypted_secret")), false);
  } finally {
    delete process.env.KALSHI_INDEX2_PRIVATE_KEY;
    delete process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
    delete process.env.KALSHI_VERIFIER_API_PRIVATE_KEY;
  }
});

test("the credential migration is private, additive, and has a rollback path", () => {
  const sql = readFileSync("../../lib/db/drizzle/0012_kalshi_connection_credentials.sql", "utf8");
  const store = readFileSync("src/lib/strata/accountCredentialStore.ts", "utf8");
  const wallet = readFileSync("src/lib/strata/userScopeDatabase.ts", "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS private\.kalshi_connection_credentials/);
  assert.match(sql, /FOREIGN KEY \(financial_account_id, owner_user_id\)/);
  assert.match(sql, /FOREIGN KEY \(provider_connection_id, financial_account_id\)/);
  assert.match(sql, /REFERENCES vault\.secrets \(id\)/);
  assert.match(sql, /WHERE revoked_at IS NULL/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE private\.kalshi_connection_credentials FROM PUBLIC/);
  assert.match(sql, /FROM anon/);
  assert.match(sql, /FROM authenticated/);
  assert.equal(sql.includes("decrypted_secret"), false);
  assert.equal(sql.includes("INSERT INTO private.kalshi_connection_credentials"), false);
  assert.match(sql, /DROP TABLE IF EXISTS private\.kalshi_connection_credentials/);
  assert.equal(store.includes("process.env"), false);
  assert.equal(store.includes("WITH owned AS"), false);
  assert.match(store, /credential-replacement:revoke/);
  assert.match(store, /credential-replacement:insert/);
  assert.match(store, /FOR UPDATE OF pc/);
  assert.equal(wallet.includes("kalshi_connection_credentials"), false);
  assert.match(wallet, /legacy_unassigned_not_startable|user_execution_account_not_commissioned/);
});

test("a unique-role collision from the database stays ambiguous", async () => {
  const db: CredentialDatabase = {
    async query() {
      throw new Error("replacement must use a transaction");
    },
    async transaction(work) {
      return work({
        async query(text) {
          if (text.includes("credential-replacement:lock-connection")) {
            return {
              rows: [{
                owner_user_id: USER_A,
                financial_account_id: FINANCIAL_A,
                provider_connection_id: CONNECTION_A,
                connection_vault_secret_id: WALLET_A,
              }],
            };
          }
          if (text.includes("credential-replacement:vault-used") || text.includes("credential-replacement:lock-active")) {
            return { rows: [] };
          }
          if (text.includes("credential-replacement:insert")) {
            const error = new Error("duplicate") as Error & { code: string };
            error.code = "23505";
            throw error;
          }
          throw new Error(text.slice(0, 80));
        },
      });
    },
  };
  const result = await replaceOwnedCredentialBinding(db, {
    authenticatedUserId: USER_A,
    providerConnectionId: CONNECTION_A,
    role: "provisioning",
    vaultSecretId: SECRET_NEXT,
    keyFingerprint: FINGERPRINT,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "ambiguous_credential_role");
});

function binding(
  ownerUserId: string,
  providerConnectionId: string,
  financialAccountId: string,
  role: string,
  vaultSecretId: string,
): BindingRow {
  return {
    id: `${role}-${ownerUserId.slice(0, 8)}`,
    ownerUserId,
    financialAccountId,
    providerConnectionId,
    role,
    vaultSecretId,
    keyFingerprint: FINGERPRINT,
    revokedAt: null,
    replacedBy: null,
  };
}
