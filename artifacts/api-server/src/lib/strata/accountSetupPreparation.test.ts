import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accountCredentialControls } from "./accountCredentialControls";
import {
  inspectProvisioningCredential,
  inspectSubaccount1,
  type VerifiedCredentialAuthority,
} from "./accountCredentialProbe";
import type { CredentialClient, CredentialDatabase } from "./accountCredentialStore";
import {
  accountSetupPlan,
  accountSetupPreconditionDigest,
  listOwnedAccountSetupAttempts,
  prepareAccountSetupOperation,
  type AccountSetupAttemptState,
  type AccountSetupOperation,
} from "./accountSetupPreparation";
import { dedicatedSignerFingerprint } from "./commissioning";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CREDENTIAL_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CREDENTIAL_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FINGERPRINT_A = "ab".repeat(32);
const FINGERPRINT_B = "cd".repeat(32);

test("setup plans are exact, disabled, and contain no generated private material", () => {
  assert.deepEqual(accountSetupPlan("create_subaccount", CONNECTION_A), {
    operation: "create_subaccount",
    exchangePath: "/trade-api/v2/portfolio/subaccounts",
    method: "POST",
    request: { exchange_index: 2 },
    expectedSubaccount: 1,
  });
  assert.deepEqual(accountSetupPlan("generate_api_key", CONNECTION_A), {
    operation: "generate_api_key",
    exchangePath: "/trade-api/v2/api_keys/generate",
    method: "POST",
    request: {
      name: "STRATA_V13_SUBACCOUNT_1",
      key_type: "rsa",
      scopes: ["read", "write::trade"],
      subaccount: 1,
    },
    vaultDestination: "supabase_vault",
  });
  const provision = accountSetupPlan("provision_execution_account", CONNECTION_A);
  assert.equal(provision.operation, "provision_execution_account");
  if (provision.operation !== "provision_execution_account") assert.fail("wrong plan");
  assert.match(provision.plannedExecutionAccountId, /^strata-account-[0-9a-f]{24}$/);
  assert.equal(provision.commissioned, false);
  assert.equal(provision.executionEnabled, false);
  assert.equal(provision.killSwitch, true);
  assert.equal(provision.cashPrecisionVerified, false);
  assert.equal(JSON.stringify([provision, accountSetupPlan("generate_api_key", CONNECTION_A)])
    .includes("private_key"), false);
});

test("provisioning metadata requires exact management scopes and an account-wide key", async () => {
  const authority = keyAuthority("provisioning-key");
  const get = async (_material: unknown, _path: string) => ({
    api_keys: [{ api_key_id: authority.material.keyId, subaccount: null, scopes: ["read", "write"] }],
  });
  assert.deepEqual(
    await inspectProvisioningCredential(authority.expectedFingerprint, authority.material, get),
    {
      ok: true,
      reason: "provisioning_credential_verified",
      scopesVerified: true,
      unrestricted: true,
    },
  );
  const wrongScopes = await inspectProvisioningCredential(
    authority.expectedFingerprint,
    authority.material,
    async () => ({
      api_keys: [{ api_key_id: authority.material.keyId, subaccount: null, scopes: ["read", "write::trade"] }],
    }),
  );
  assert.equal(wrongScopes.reason, "provisioning_credential_scopes_rejected");
  const restricted = await inspectProvisioningCredential(
    authority.expectedFingerprint,
    authority.material,
    async () => ({
      api_keys: [{ api_key_id: authority.material.keyId, subaccount: 1, scopes: ["read", "write"] }],
    }),
  );
  assert.equal(restricted.reason, "provisioning_credential_must_be_unrestricted");
});

test("subaccount creation is allowed only when inventory proves primary account zero is the sole account", async () => {
  const authority = keyAuthority("verification-key");
  const absent = await inspectSubaccount1(authority, async () => ({
    subaccount_balances: [{ subaccount_number: 0, exchange_index: 2, balance: "0.0000", updated_ts: 1 }],
  }));
  assert.equal(absent.exists, false);
  assert.equal(absent.safeToCreate, true);
  const gap = await inspectSubaccount1(authority, async () => ({
    subaccount_balances: [
      { subaccount_number: 0, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
      { subaccount_number: 2, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
    ],
  }));
  assert.equal(gap.exists, false);
  assert.equal(gap.safeToCreate, false);
  assert.equal(gap.reason, "next_subaccount_would_not_be_1");
});

test("wrong operation confirmation performs no database or exchange reads", async () => {
  let reads = 0;
  const controls = accountCredentialControls({
    async query() {
      reads += 1;
      throw new Error("must_not_read");
    },
  }, {
    async kalshiGet() {
      reads += 1;
      throw new Error("must_not_read");
    },
  });
  const result = await controls.authorizeOperation(USER_A, {
    operation: "generate_api_key",
    confirmation: "wrong",
  });
  assert.equal(result.reason, "explicit_authorization_required");
  assert.equal(result.attempted, false);
  assert.equal(reads, 0);
});

test("durable preparation is isolated, idempotent, and blocks uncertain retries", async () => {
  const db = preparationDatabase();
  const first = await prepare(db, USER_A, ACCOUNT_A, CONNECTION_A, CREDENTIAL_A, FINGERPRINT_A);
  const duplicate = await prepare(db, USER_A, ACCOUNT_A, CONNECTION_A, CREDENTIAL_A, FINGERPRINT_A);
  const other = await prepare(db, USER_B, ACCOUNT_B, CONNECTION_B, CREDENTIAL_B, FINGERPRINT_B);
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.attempt?.attemptId, first.attempt?.attemptId);
  assert.notEqual(other.attempt?.attemptId, first.attempt?.attemptId);
  assert.deepEqual(
    (await listOwnedAccountSetupAttempts(db, USER_A, CONNECTION_A)).map((row) => row.attemptId),
    [first.attempt?.attemptId],
  );
  const row = db.rows.find((item) => item.owner === USER_A);
  assert.ok(row);
  row.state = "uncertain";
  const blocked = await prepare(db, USER_A, ACCOUNT_A, CONNECTION_A, CREDENTIAL_A, FINGERPRINT_A);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "operation_retry_blocked_uncertain");
  assert.equal(blocked.attempted, false);
  assert.equal(db.rows.filter((item) => item.owner === USER_A).length, 1);
});

test("account controls prepare isolated subaccount plans for two users without an exchange mutation", async () => {
  const fixture = operationFixture("create", { twoUsers: true });
  const controls = accountCredentialControls(fixture.db, { kalshiGet: fixture.kalshiGet });
  const first = await controls.authorizeOperation(USER_A, {
    operation: "create_subaccount",
    confirmation: "CREATE_ACCOUNT_SUBACCOUNT",
  });
  const second = await controls.authorizeOperation(USER_B, {
    operation: "create_subaccount",
    confirmation: "CREATE_ACCOUNT_SUBACCOUNT",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.attempted, false);
  assert.equal(first.executable, false);
  assert.deepEqual(first.attempt?.plan, {
    operation: "create_subaccount",
    exchangePath: "/trade-api/v2/portfolio/subaccounts",
    method: "POST",
    request: { exchange_index: 2 },
    expectedSubaccount: 1,
  });
  assert.notEqual(first.attempt?.attemptId, second.attempt?.attemptId);
  assert.deepEqual(fixture.attempts.rows.map((row) => row.owner).sort(), [USER_A, USER_B]);
  assert.equal(fixture.exchangeReads.every((call) => call.path.includes("/trade-api/v2/")), true);
  const status = await controls.commissioningStatus(USER_A);
  assert.equal(status.operationPreparationAvailable, true);
  assert.equal(status.operationPreparations.length, 1);
  assert.equal(status.nextAuthorizedAction?.action, "separately_authorize_prepared_operation");
  assert.equal(status.nextAuthorizedAction?.effect,
    "review_only_preparation_exists_no_mutation_executor_enabled");
});

test("preparation rejects scope mismatch, foreign ownership, and authority rotation", async () => {
  const scopeFixture = operationFixture("create", { provisioningScopes: ["read"] });
  const scopeControls = accountCredentialControls(scopeFixture.db, { kalshiGet: scopeFixture.kalshiGet });
  const scopeRejected = await scopeControls.authorizeOperation(USER_A, {
    operation: "create_subaccount",
    confirmation: "CREATE_ACCOUNT_SUBACCOUNT",
  });
  assert.equal(scopeRejected.reason, "provisioning_credential_scopes_rejected");
  assert.equal(scopeFixture.attempts.rows.length, 0);

  const foreign = await scopeControls.authorizeOperation(USER_B, {
    operation: "create_subaccount",
    confirmation: "CREATE_ACCOUNT_SUBACCOUNT",
  });
  assert.equal(foreign.reason, "owned_connection_missing");
  assert.equal(scopeFixture.attempts.rows.length, 0);

  const rotatedFixture = operationFixture("create", { rotateProvisioningAtLimits: true });
  const rotatedControls = accountCredentialControls(rotatedFixture.db, {
    kalshiGet: rotatedFixture.kalshiGet,
  });
  const rotated = await rotatedControls.authorizeOperation(USER_A, {
    operation: "create_subaccount",
    confirmation: "CREATE_ACCOUNT_SUBACCOUNT",
  });
  assert.equal(rotated.reason, "setup_authority_rotated");
  assert.equal(rotatedFixture.attempts.rows.length, 0);
});

test("unrestricted legacy key prepares exact restricted-key replacement and verified key prepares disabled execution account", async () => {
  const generationFixture = operationFixture("generate");
  const generationControls = accountCredentialControls(generationFixture.db, {
    kalshiGet: generationFixture.kalshiGet,
  });
  const generated = await generationControls.authorizeOperation(USER_A, {
    operation: "generate_api_key",
    confirmation: "GENERATE_ACCOUNT_API_KEY",
  });
  assert.equal(generated.ok, true);
  assert.deepEqual(generated.attempt?.plan, {
    operation: "generate_api_key",
    exchangePath: "/trade-api/v2/api_keys/generate",
    method: "POST",
    request: {
      name: "STRATA_V13_SUBACCOUNT_1",
      key_type: "rsa",
      scopes: ["read", "write::trade"],
      subaccount: 1,
    },
    vaultDestination: "supabase_vault",
  });

  const provisionFixture = operationFixture("provision");
  const provisionControls = accountCredentialControls(provisionFixture.db, {
    kalshiGet: provisionFixture.kalshiGet,
  });
  const provisioned = await provisionControls.authorizeOperation(USER_A, {
    operation: "provision_execution_account",
    confirmation: "PROVISION_ACCOUNT_EXECUTION",
  });
  assert.equal(provisioned.ok, true);
  assert.equal(provisioned.attempt?.plan.operation, "provision_execution_account");
  if (provisioned.attempt?.plan.operation !== "provision_execution_account") {
    assert.fail("missing execution plan");
  }
  assert.equal(provisioned.attempt.plan.executionEnabled, false);
  assert.equal(provisioned.attempt.plan.killSwitch, true);
  assert.equal(provisioned.attempt.plan.commissioned, false);
  assert.equal(provisioned.attempt.plan.cashPrecisionVerified, false);
  assert.equal(provisionFixture.exchangeReads.some((call) =>
    call.keyId === provisionFixture.users[0]?.restricted.keyId &&
    call.path.endsWith("/portfolio/balance")), true);
});

test("review-only migration and implementation contain no mutation executor or secret payload", () => {
  const migration = readFileSync("../../lib/db/drizzle/0015_kalshi_account_operation_attempts.sql", "utf8");
  const preparation = readFileSync("src/lib/strata/accountSetupPreparation.ts", "utf8");
  const controls = readFileSync("src/lib/strata/accountCredentialControls.ts", "utf8");
  const startup = readFileSync("src/index.ts", "utf8");
  const build = readFileSync("build.mjs", "utf8");
  const journal = readFileSync("../../lib/db/drizzle/meta/_journal.json", "utf8");
  assert.match(migration, /REVIEW ONLY/);
  assert.match(migration, /state IN \('prepared', 'attempted', 'response_received', 'uncertain', 'completed', 'cancelled'\)/);
  assert.match(migration, /UNIQUE INDEX[\s\S]*provider_connection_id, operation/);
  assert.equal(migration.includes("private_key"), false);
  assert.equal(migration.includes("decrypted_secret"), false);
  assert.equal(preparation.includes("vault.decrypted_secrets"), false);
  assert.equal(preparation.includes("INSERT INTO public.v13_production_account"), false);
  assert.equal(controls.includes("kalshiPost"), false);
  assert.equal(controls.includes("fetch("), false);
  assert.equal(controls.includes("INSERT INTO public.v13_production_account"), false);
  assert.equal(startup.includes("0015_kalshi_account_operation_attempts"), false);
  assert.equal(build.includes("0015_kalshi_account_operation_attempts"), false);
  assert.equal(journal.includes("0015_kalshi_account_operation_attempts"), false);
});

function keyAuthority(keyId: string): VerifiedCredentialAuthority {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const expectedFingerprint = dedicatedSignerFingerprint(keyId, privateKey);
  assert.ok(expectedFingerprint);
  return { expectedFingerprint, material: { keyId, privateKey } };
}

function operationFixture(
  mode: "create" | "generate" | "provision",
  options: {
    twoUsers?: boolean;
    provisioningScopes?: string[];
    rotateProvisioningAtLimits?: boolean;
  } = {},
) {
  const identities = [
    {
      userId: USER_A,
      accountId: ACCOUNT_A,
      connectionId: CONNECTION_A,
      provisioningId: CREDENTIAL_A,
      verificationId: "10000000-0000-4000-8000-000000000001",
      restrictedId: "10000000-0000-4000-8000-000000000002",
      provisioningVault: "20000000-0000-4000-8000-000000000001",
      verificationVault: "20000000-0000-4000-8000-000000000002",
      restrictedVault: "20000000-0000-4000-8000-000000000003",
    },
    {
      userId: USER_B,
      accountId: ACCOUNT_B,
      connectionId: CONNECTION_B,
      provisioningId: CREDENTIAL_B,
      verificationId: "30000000-0000-4000-8000-000000000001",
      restrictedId: "30000000-0000-4000-8000-000000000002",
      provisioningVault: "40000000-0000-4000-8000-000000000001",
      verificationVault: "40000000-0000-4000-8000-000000000002",
      restrictedVault: "40000000-0000-4000-8000-000000000003",
    },
  ].slice(0, options.twoUsers ? 2 : 1);
  const users = identities.map((identity, index) => {
    const provisioning = keyAuthority(`provisioning-${index + 1}`);
    const verification = keyAuthority(`verification-${index + 1}`);
    const restricted = keyAuthority(`restricted-${index + 1}`);
    return {
      ...identity,
      provisioning: provisioning.material,
      verification: verification.material,
      restricted: restricted.material,
      provisioningFingerprint: provisioning.expectedFingerprint,
      verificationFingerprint: verification.expectedFingerprint,
      restrictedFingerprint: restricted.expectedFingerprint,
    };
  });
  const bindings = users.flatMap((user) => {
    const rows = [
      {
        id: user.provisioningId,
        owner: user.userId,
        account: user.accountId,
        connection: user.connectionId,
        role: "provisioning",
        vault: user.provisioningVault,
        fingerprint: user.provisioningFingerprint,
        material: user.provisioning,
        verified: true,
      },
      {
        id: user.verificationId,
        owner: user.userId,
        account: user.accountId,
        connection: user.connectionId,
        role: "verification",
        vault: user.verificationVault,
        fingerprint: user.verificationFingerprint,
        material: user.verification,
        verified: true,
      },
    ];
    if (mode !== "create") {
      rows.push({
        id: user.restrictedId,
        owner: user.userId,
        account: user.accountId,
        connection: user.connectionId,
        role: "restricted_execution",
        vault: user.restrictedVault,
        fingerprint: user.restrictedFingerprint,
        material: user.restricted,
        verified: mode === "provision",
      });
    }
    return rows;
  });
  const attempts = preparationDatabase();
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("account-setup-attempt:")) return attempts.query(sql, params);
      if (sql.includes("to_regclass('private.kalshi_account_operation_attempts')")) {
        return { rows: [{ name: "private.kalshi_account_operation_attempts" }] };
      }
      if (sql.includes("to_regclass('private.kalshi_connection_credentials')")) {
        return { rows: [{ name: "private.kalshi_connection_credentials" }] };
      }
      if (sql.includes("to_regclass('private.kalshi_account_funding')")) {
        return { rows: [{ name: null }] };
      }
      if (sql.includes("account-credential:verified-role-secret")) {
        return { rows: bindings.filter((row) =>
          row.owner === params[0] && row.connection === params[1] &&
          row.role === params[2] && row.verified).map((row) => ({
          credential_id: row.id,
          vault_secret_id: row.vault,
          key_fingerprint: row.fingerprint,
          decrypted_secret: JSON.stringify({
            api_key_id: row.material.keyId,
            private_key: row.material.privateKey,
          }),
        })) };
      }
      if (sql.includes("SELECT fa.user_id::text AS authenticated_user_id")) {
        const user = users.find((item) => item.userId === params[0]);
        return { rows: user ? [{
          authenticated_user_id: user.userId,
          financial_account_id: user.accountId,
          provider_connection_id: user.connectionId,
        }] : [] };
      }
      if (sql.includes("SELECT c.role,")) {
        return { rows: bindings.filter((row) =>
          row.owner === params[0] && row.connection === params[1]).map((row) => ({
          role: row.role,
          provider_connection_id: row.connection,
          vault_secret_id: row.vault,
          key_fingerprint: row.fingerprint,
        })) };
      }
      if (sql.includes("account-credential:list")) {
        return { rows: bindings.filter((row) =>
          row.owner === params[0] && row.connection === params[1]).map((row) => ({
          role: row.role,
          key_fingerprint: row.fingerprint,
          verified_at: row.verified ? "2026-10-12T00:00:00.000Z" : null,
          verification_reason: row.verified ? "credential_verified" : null,
          revoked_at: null,
        })) };
      }
      if (sql.includes("FROM vault.decrypted_secrets")) {
        const row = bindings.find((item) =>
          item.vault === params[0] && item.owner === params[1]);
        return { rows: row ? [{
          decrypted_secret: JSON.stringify({
            api_key_id: row.material.keyId,
            private_key: row.material.privateKey,
          }),
        }] : [] };
      }
      if (sql.includes("FROM v13_production_account a")) return { rows: [] };
      return { rows: [] };
    },
  };
  const exchangeReads: Array<{ keyId: string; path: string }> = [];
  const kalshiGet = async (
    material: { keyId: string; privateKey: string },
    path: string,
  ): Promise<unknown> => {
    exchangeReads.push({ keyId: material.keyId, path });
    const user = users.find((item) =>
      item.provisioning.keyId === material.keyId ||
      item.verification.keyId === material.keyId ||
      item.restricted.keyId === material.keyId);
    assert.ok(user);
    if (path.endsWith("/portfolio/subaccounts/balances")) {
      assert.equal(material.keyId, user.verification.keyId);
      return {
        subaccount_balances: mode === "create"
          ? [{ subaccount_number: 0, exchange_index: 2, balance: "0.0000", updated_ts: 1 }]
          : [
            { subaccount_number: 0, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
            { subaccount_number: 1, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
          ],
      };
    }
    if (path.endsWith("/api_keys")) {
      if (material.keyId === user.provisioning.keyId) {
        return { api_keys: [{
          api_key_id: user.provisioning.keyId,
          subaccount: null,
          scopes: options.provisioningScopes ?? ["read", "write"],
        }] };
      }
      assert.equal(material.keyId, user.verification.keyId);
      return { api_keys: [
        { api_key_id: user.verification.keyId, subaccount: null, scopes: ["read"] },
        ...(mode === "create" ? [] : [{
          api_key_id: user.restricted.keyId,
          subaccount: mode === "generate" ? null : 1,
          scopes: ["read", "write::trade"],
        }]),
      ] };
    }
    if (path.endsWith("/account/limits")) {
      assert.equal(material.keyId, user.provisioning.keyId);
      if (options.rotateProvisioningAtLimits) {
        const binding = bindings.find((row) =>
          row.owner === user.userId && row.role === "provisioning");
        assert.ok(binding);
        binding.verified = false;
      }
      return { usage_tier: "advanced" };
    }
    if (path.endsWith("/portfolio/balance")) {
      assert.equal(material.keyId, user.restricted.keyId);
      return { balance_dollars: "0.0000", subaccount: 1, exchange_index: 2 };
    }
    throw new Error(`unexpected_read:${path}`);
  };
  return { db, users, bindings, attempts, exchangeReads, kalshiGet };
}

async function prepare(
  db: ReturnType<typeof preparationDatabase>,
  ownerUserId: string,
  financialAccountId: string,
  providerConnectionId: string,
  authorityCredentialId: string,
  authorityFingerprint: string,
) {
  const operation = "generate_api_key";
  const plan = accountSetupPlan(operation, providerConnectionId);
  return prepareAccountSetupOperation(db, {
    ownerUserId,
    financialAccountId,
    providerConnectionId,
    operation,
    authorityCredentialId,
    authorityFingerprint,
    targetCredentialId: null,
    targetFingerprint: null,
    plan,
    preconditionDigest: accountSetupPreconditionDigest({
      ownerUserId,
      financialAccountId,
      providerConnectionId,
      operation,
      authorityCredentialId,
      authorityFingerprint,
      plan,
    }),
  });
}

interface AttemptRow {
  id: string;
  owner: string;
  account: string;
  connection: string;
  operation: AccountSetupOperation;
  state: AccountSetupAttemptState;
  plan: unknown;
  preparedAt: string;
  updatedAt: string;
}

function preparationDatabase(): CredentialDatabase & { rows: AttemptRow[] } {
  const rows: AttemptRow[] = [];
  const query: CredentialClient["query"] = async (sql, params = []) => {
    if (sql.includes("account-setup-attempt:prepare")) {
      const existing = rows.find((row) => row.connection === params[2] && row.operation === params[3]);
      if (existing && (existing.owner !== params[0] || existing.account !== params[1] ||
          existing.state !== "prepared")) return { rows: [] };
      const now = "2026-10-12T00:00:00.000Z";
      const row = existing ?? {
        id: randomUUID(),
        owner: String(params[0]),
        account: String(params[1]),
        connection: String(params[2]),
        operation: params[3] as AccountSetupOperation,
        state: "prepared" as const,
        plan: JSON.parse(String(params[9])),
        preparedAt: now,
        updatedAt: now,
      };
      if (!existing) rows.push(row);
      else row.plan = JSON.parse(String(params[9]));
      return { rows: [{
        attempt_id: row.id,
        operation: row.operation,
        state: row.state,
        plan: row.plan,
        prepared_at: row.preparedAt,
        updated_at: row.updatedAt,
        reused: Boolean(existing),
      }] };
    }
    if (sql.includes("account-setup-attempt:read-one")) {
      const row = rows.find((item) => item.connection === params[0] && item.operation === params[1]);
      return { rows: row ? [databaseRow(row)] : [] };
    }
    if (sql.includes("account-setup-attempt:list-owned")) {
      return { rows: rows.filter((row) => row.owner === params[0] && row.connection === params[1])
        .map(databaseRow) };
    }
    return { rows: [] };
  };
  return {
    rows,
    query,
    async transaction(work) {
      return work({ query });
    },
  };
}

function databaseRow(row: AttemptRow): Record<string, unknown> {
  return {
    attempt_id: row.id,
    owner_user_id: row.owner,
    financial_account_id: row.account,
    operation: row.operation,
    state: row.state,
    plan: row.plan,
    prepared_at: row.preparedAt,
    updated_at: row.updatedAt,
  };
}
