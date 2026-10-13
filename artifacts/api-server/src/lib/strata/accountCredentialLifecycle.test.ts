import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AccountCommissioningPorts } from "./accountCommissioningContext";
import type { CredentialClient, CredentialDatabase } from "./accountCredentialStore";
import {
  accountFundingAuthorization,
  listAccountCredentialStatus,
  registerAccountCredential,
  revokeAccountCredential,
  userCommissioningReadiness,
  verifyAccountCredential,
} from "./accountCredentialLifecycle";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const FINANCIAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FINANCIAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WALLET_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WALLET_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";

interface Binding {
  id: string;
  ownerUserId: string;
  financialAccountId: string;
  providerConnectionId: string;
  role: string;
  vaultSecretId: string;
  keyFingerprint: string | null;
  revokedAt: string | null;
  replacedBy: string | null;
  verifiedAt: string | null;
  verificationReason: string | null;
}

function keyMaterial() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    apiKeyId: "user-test-key",
    privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
}

function harness(failInsert = false) {
  const secrets: Array<{ id: string; payload: string }> = [];
  const bindings: Binding[] = [];
  const executionAccounts: Array<{ ownerUserId: string; financialAccountId: string }> = [];
  let sequence = 0;
  let fail = failInsert;
  let turn = Promise.resolve();
  const connections = [
    { userId: USER_A, financialAccountId: FINANCIAL_A, providerConnectionId: CONNECTION_A, vaultSecretId: WALLET_A },
    { userId: USER_B, financialAccountId: FINANCIAL_B, providerConnectionId: CONNECTION_B, vaultSecretId: WALLET_B },
  ];
  const query: CredentialClient["query"] = async (text, params = []) => {
    if (text.includes("account-credential:create-secret")) {
      const id = `12121212-1212-4121-8121-${String(secrets.length + 1).padStart(12, "0")}`;
      secrets.push({ id, payload: String(params[0]) });
      return { rows: [{ id }] };
    }
    if (text.includes("credential-replacement:lock-connection")) {
      const connection = connections.find((item) => item.userId === params[0] && item.providerConnectionId === params[1]);
      return { rows: connection ? [{
        provider_connection_id: connection.providerConnectionId,
        financial_account_id: connection.financialAccountId,
        owner_user_id: connection.userId,
        connection_vault_secret_id: connection.vaultSecretId,
      }] : [] };
    }
    if (text.includes("credential-replacement:vault-used")) {
      const used = bindings.find((item) => item.vaultSecretId === params[0]) ||
        connections.find((item) => item.vaultSecretId === params[0]);
      return { rows: used ? [{ id: "used" }] : [] };
    }
    if (text.includes("credential-replacement:execution-account") ||
        text.includes("account-credential:execution-account-before-revoke")) {
      return { rows: executionAccounts.filter((item) =>
        item.ownerUserId === params[0] &&
        item.financialAccountId === params[1]).map(() => ({ id: "execution-account" })) };
    }
    if (text.includes("credential-replacement:lock-active")) {
      return { rows: bindings.filter((item) => item.providerConnectionId === params[0] && item.ownerUserId === params[1] &&
        item.financialAccountId === params[2] && item.role === params[3] && !item.revokedAt).map((item) => ({ id: item.id })) };
    }
    if (text.includes("credential-replacement:revoke")) {
      const row = bindings.find((item) => item.id === params[0] && !item.revokedAt);
      if (!row) return { rows: [] };
      row.revokedAt = new Date().toISOString();
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("credential-replacement:insert")) {
      if (fail) {
        fail = false;
        throw Object.assign(new Error("insert_failed"), { code: "23503" });
      }
      const id = `binding-${++sequence}`;
      bindings.push({
        id,
        ownerUserId: String(params[0]),
        financialAccountId: String(params[1]),
        providerConnectionId: String(params[2]),
        role: String(params[3]),
        vaultSecretId: String(params[4]),
        keyFingerprint: params[5] == null ? null : String(params[5]),
        revokedAt: null,
        replacedBy: null,
        verifiedAt: null,
        verificationReason: null,
      });
      return { rows: [{ credential_id: id }] };
    }
    if (text.includes("credential-replacement:link")) {
      const row = bindings.find((item) => item.id === params[0] && item.revokedAt && !item.replacedBy);
      if (!row) return { rows: [] };
      row.replacedBy = String(params[1]);
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("account-credential:revoke")) {
      const row = bindings.find((item) => item.ownerUserId === params[0] && item.providerConnectionId === params[1] &&
        item.role === params[2] && !item.revokedAt);
      if (!row) return { rows: [] };
      row.revokedAt = new Date().toISOString();
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("account-credential:lock-revoke-connection")) {
      const connection = connections.find((item) =>
        item.userId === params[0] && item.providerConnectionId === params[1]);
      return { rows: connection ? [{
        provider_connection_id: connection.providerConnectionId,
        financial_account_id: connection.financialAccountId,
      }] : [] };
    }
    if (text.includes("account-credential:list")) {
      return { rows: bindings.filter((item) => item.ownerUserId === params[0] && item.providerConnectionId === params[1]).map((item) => ({
        role: item.role,
        key_fingerprint: item.keyFingerprint,
        verified_at: item.verifiedAt,
        verification_reason: item.verificationReason,
        revoked_at: item.revokedAt,
      })) };
    }
    if (text.includes("account-credential:lock-role")) {
      const row = bindings.find((item) => item.ownerUserId === params[0] && item.providerConnectionId === params[1] &&
        item.role === params[2] && !item.revokedAt);
      return { rows: row ? [{
        id: row.id,
        vault_secret_id: row.vaultSecretId,
        key_fingerprint: row.keyFingerprint,
      }] : [] };
    }
    if (text.includes("account-credential:verify-record")) {
      const row = bindings.find((item) => item.id === params[0] && item.ownerUserId === params[1] &&
        item.vaultSecretId === params[2] && item.keyFingerprint === params[3] && !item.revokedAt);
      if (!row) return { rows: [] };
      row.verifiedAt = new Date().toISOString();
      row.verificationReason = String(params[4]);
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("FROM public.financial_accounts")) {
      return { rows: connections.filter((item) => item.userId === params[0]).map((item) => ({
        authenticated_user_id: item.userId,
        financial_account_id: item.financialAccountId,
        provider_connection_id: item.providerConnectionId,
      })) };
    }
    if (text.includes("FROM private.kalshi_connection_credentials")) {
      return { rows: bindings.filter((item) => item.ownerUserId === params[0] && item.providerConnectionId === params[1] && !item.revokedAt).map((item) => ({
        role: item.role,
        provider_connection_id: item.providerConnectionId,
        vault_secret_id: item.vaultSecretId,
        key_fingerprint: item.keyFingerprint,
      })) };
    }
    return { rows: [] };
  };
  const db: CredentialDatabase & { secrets: typeof secrets; bindings: Binding[] } = {
    secrets,
    bindings,
    query,
    async transaction(work) {
      const previous = turn;
      let release = () => {};
      turn = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const savedSecrets = secrets.map((item) => ({ ...item }));
      const savedBindings = structuredClone(bindings);
      try {
        return await work({ query });
      } catch (error) {
        secrets.splice(0, secrets.length, ...savedSecrets);
        bindings.splice(0, bindings.length, ...savedBindings);
        throw error;
      } finally {
        release();
      }
    },
  };
  const ports: AccountCommissioningPorts = {
    async listOwnedConnections(userId) {
      return connections.filter((item) => item.userId === userId).map((item) => ({
        authenticatedUserId: item.userId,
        financialAccountId: item.financialAccountId,
        providerConnectionId: item.providerConnectionId,
      }));
    },
    async listCredentialRefs(userId, providerConnectionId) {
      return bindings.filter((item) => item.ownerUserId === userId && item.providerConnectionId === providerConnectionId && !item.revokedAt).map((item) => ({
        role: item.role,
        providerConnectionId: item.providerConnectionId,
        vaultSecretId: item.vaultSecretId,
        keyFingerprint: item.keyFingerprint,
        source: "vault_connection" as const,
      }));
    },
    async readExecutionTarget() { return null; },
    async readSnapshot() { throw new Error("snapshot_unused"); },
    async openCredential() { throw new Error("vault_opened"); },
  };
  return { db, ports, executionAccounts };
}

test("two users register, rotate, and revoke only their own credential roles", async () => {
  const { db, ports } = harness();
  const material = keyMaterial();
  const registered = await registerAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
    ...material,
  });
  const other = await registerAccountCredential(db, ports, {
    authenticatedUserId: USER_B,
    role: "verification",
    ...keyMaterial(),
  });
  assert.equal(registered.ok, true);
  assert.equal(other.ok, true);
  assert.equal(registered.executable, false);
  assert.equal(JSON.stringify(registered).includes(material.privateKey), false);
  assert.equal(JSON.stringify(registered).includes("BEGIN"), false);
  const rotated = await registerAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
    ...keyMaterial(),
  });
  assert.equal(rotated.ok, true);
  assert.equal(db.bindings.filter((item) => item.ownerUserId === USER_A && item.revokedAt).length, 1);
  assert.equal(db.bindings.filter((item) => item.ownerUserId === USER_A && !item.revokedAt).length, 1);
  const foreign = await revokeAccountCredential(db, ports, { authenticatedUserId: USER_B, role: "restricted_execution" });
  assert.equal(foreign.ok, false);
  const revoked = await revokeAccountCredential(db, ports, { authenticatedUserId: USER_A, role: "restricted_execution" });
  assert.equal(revoked.ok, true);
  const status = await listAccountCredentialStatus(db, ports, USER_A);
  assert.equal(status.roles.some((role) => role.revoked), true);
  assert.equal(status.roles.some((role) => role.role === "verification"), false);
});

test("provisioned execution account blocks restricted credential rotation and revocation", async () => {
  const { db, ports } = harness();
  const active = await registerAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
    ...keyMaterial(),
  });
  assert.equal(active.ok, true);
  ports.readExecutionTarget = async (userId, providerConnectionId) =>
    userId === USER_A && providerConnectionId === CONNECTION_A
      ? {
        ownerUserId: USER_A,
        providerConnectionId: CONNECTION_A,
        executionAccountId: "strata-account-existing",
        subaccount: 1,
        exchangeIndex: 2,
        keyFingerprint: active.fingerprint,
      }
      : null;
  const secretCount = db.secrets.length;
  const rotation = await registerAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
    ...keyMaterial(),
  });
  assert.equal(rotation.reason, "restricted_execution_rebinding_required");
  assert.equal(db.secrets.length, secretCount);
  const revocation = await revokeAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
  });
  assert.equal(revocation.reason, "restricted_execution_rebinding_required");
  assert.equal(db.bindings.filter((item) =>
    item.ownerUserId === USER_A && item.role === "restricted_execution" &&
    !item.revokedAt).length, 1);
});

test("transactional recheck closes credential rotation and revoke races with provisioning", async () => {
  const { db, ports, executionAccounts } = harness();
  const active = await registerAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
    ...keyMaterial(),
  });
  assert.equal(active.ok, true);
  ports.readExecutionTarget = async () => {
    if (executionAccounts.length === 0) {
      executionAccounts.push({
        ownerUserId: USER_A,
        financialAccountId: FINANCIAL_A,
      });
    }
    return null;
  };
  const rotation = await registerAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
    ...keyMaterial(),
  });
  assert.equal(rotation.reason, "restricted_execution_rebinding_required");
  const revocation = await revokeAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
  });
  assert.equal(revocation.reason, "restricted_execution_rebinding_required");
  assert.equal(db.bindings.filter((item) =>
    item.ownerUserId === USER_A && item.role === "restricted_execution" &&
    !item.revokedAt).length, 1);
});

test("a failed binding rolls the new Vault secret back", async () => {
  const { db, ports } = harness(true);
  const result = await registerAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "provisioning",
    ...keyMaterial(),
  });
  assert.equal(result.ok, false);
  assert.equal(db.secrets.length, 0);
  assert.equal(db.bindings.length, 0);
});

test("verification stays unauthorized until explicitly confirmed and funding is user-specific", async () => {
  const { db, ports } = harness();
  const material = keyMaterial();
  await registerAccountCredential(db, ports, { authenticatedUserId: USER_A, role: "restricted_execution", ...material });
  let probed = 0;
  const skipped = await verifyAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
    confirmation: "no",
    async readSecret() { throw new Error("secret_read"); },
    async probe() { probed += 1; return { ok: true, reason: "ok" }; },
  });
  assert.equal(skipped.reason, "explicit_authorization_required");
  assert.equal(probed, 0);
  const funding = accountFundingAuthorization({
    confirmation: "AUTHORIZE_ACCOUNT_FUNDING",
    authorizedMicros: "1000000",
    liveExecutionEnabled: "false",
    v13ProductionExecutionEnabled: "false",
  });
  assert.equal(funding.ok, true);
  assert.equal(funding.transferAttempted, false);
  assert.notEqual(funding.authorizedMicros, "25000000");
  const blocked = userCommissioningReadiness({
    roles: [{ role: "restricted_execution", fingerprint: null, verified: false, revoked: false, verificationReason: null }],
    authorizedMicros: funding.authorizedMicros,
    evidenceMicros: "25000000",
    subaccount: 1,
    exchangeIndex: 2,
    policyOwned: true,
  });
  assert.equal(blocked.executable, false);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.includes("account_funding_evidence_mismatch"), true);
  const secretReads: string[] = [];
  const verified = await verifyAccountCredential(db, ports, {
    authenticatedUserId: USER_A,
    role: "restricted_execution",
    confirmation: "VERIFY_ACCOUNT_CREDENTIAL",
    async readSecret(vaultSecretId) {
      secretReads.push(vaultSecretId);
      return { keyId: material.apiKeyId, privateKey: material.privateKey };
    },
    async probe() {
      const active = db.bindings.find((item) => item.ownerUserId === USER_A && item.role === "restricted_execution" && !item.revokedAt);
      if (active) active.revokedAt = new Date().toISOString();
      db.bindings.push({
        id: "binding-rotated",
        ownerUserId: USER_A,
        financialAccountId: FINANCIAL_A,
        providerConnectionId: CONNECTION_A,
        role: "restricted_execution",
        vaultSecretId: "34343434-3434-4343-8343-343434343434",
        keyFingerprint: "cd".repeat(32),
        revokedAt: null,
        replacedBy: null,
        verifiedAt: null,
        verificationReason: null,
      });
      return { ok: true, reason: "credential_verified" };
    },
  });
  assert.equal(verified.reason, "credential_rotated");
  assert.equal(verified.vaultSecretId, null);
  assert.equal(db.bindings.find((item) => item.id === "binding-rotated")?.verifiedAt, null);
  assert.equal(secretReads.length, 1);
  const source = readFileSync("src/lib/strata/accountCredentialLifecycle.ts", "utf8");
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("KALSHI_INDEX2"), false);
});
