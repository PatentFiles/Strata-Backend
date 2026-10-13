import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { accountCredentialControls } from "./accountCredentialControls";
import {
  EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
  RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
  executePreparedRestrictedKeyGeneration,
  reconcileStoredRestrictedKeyGeneration,
  type RestrictedKeyGenerationTransport,
} from "./accountRestrictedKeyGeneration";
import {
  EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION,
  executePreparedExecutionAccountProvisioning,
} from "./accountExecutionProvisioning";
import type {
  CredentialClient,
  CredentialDatabase,
} from "./accountCredentialStore";
import { dedicatedSignerFingerprint } from "./commissioning";
import { generateScopedKalshiSubaccountOneKey } from "../kalshiAccountClient";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROVISIONING_A = "10000000-0000-4000-8000-000000000001";
const VERIFICATION_A = "10000000-0000-4000-8000-000000000002";
const SETUP_EXECUTION_A = "10000000-0000-4000-8000-000000000003";
const OLD_RESTRICTED_A = "10000000-0000-4000-8000-000000000004";
const PROVISIONING_B = "20000000-0000-4000-8000-000000000001";
const VERIFICATION_B = "20000000-0000-4000-8000-000000000002";
const SETUP_EXECUTION_B = "20000000-0000-4000-8000-000000000003";
const OLD_RESTRICTED_B = "20000000-0000-4000-8000-000000000004";
const GENERATE_ATTEMPT_A = "30000000-0000-4000-8000-000000000001";
const PROVISION_ATTEMPT_A = "30000000-0000-4000-8000-000000000002";
const GENERATE_ATTEMPT_B = "30000000-0000-4000-8000-000000000003";
const FP_PROVISIONING_A = "11".repeat(32);
const FP_VERIFICATION_A = "22".repeat(32);
const FP_SETUP_EXECUTION_A = "33".repeat(32);
const FP_OLD_RESTRICTED_A = "44".repeat(32);
const FP_PROVISIONING_B = "55".repeat(32);
const FP_VERIFICATION_B = "66".repeat(32);
const FP_SETUP_EXECUTION_B = "77".repeat(32);
const FP_OLD_RESTRICTED_B = "88".repeat(32);
const EXECUTION_ACCOUNT_A = "strata-account-0123456789abcdef01234567";

type DisposablePg = {
  exec(query: string): Promise<unknown>;
  query(query: string, params?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number | null;
  }>;
  close(): Promise<void>;
};

test("fixed live key-generation transport sends only the documented restricted request", async () => {
  const signing = rsaPrivateKey();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const response = await generateScopedKalshiSubaccountOneKey(
    { keyId: "setup-execution-key", privateKey: signing },
    async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        api_key_id: "generated-key",
        private_key: rsaPrivateKey(),
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  );
  assert.equal(response.status, 201);
  const request = requests[0];
  assert.ok(request);
  assert.match(request.url, /\/trade-api\/v2\/api_keys\/generate$/);
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    name: "STRATA_V13_SUBACCOUNT_1",
    key_type: "rsa",
    scopes: ["read", "write::trade"],
    subaccount: 1,
  });
});

test("one-shot key generation is owner-isolated, concurrent-safe, Vault-bound, and secret-free", async (t) => {
  const fixture = await setup(t);
  if (!fixture) return;
  try {
    await insertGenerationAttempt(fixture.raw);
    const generated = generatedCredential();
    let posts = 0;
    let releasePost!: () => void;
    let announcePost!: () => void;
    const postStarted = new Promise<void>((resolve) => { announcePost = resolve; });
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const transport: RestrictedKeyGenerationTransport = async () => {
      posts += 1;
      announcePost();
      await postGate;
      return {
        status: 201,
        unreadable: false,
        body: {
          api_key_id: generated.keyId,
          private_key: generated.privateKey,
        },
      };
    };
    const first = executeKeyGeneration(fixture.db, transport, generated);
    await postStarted;
    const concurrent = await executeKeyGeneration(fixture.db, transport, generated);
    assert.equal(concurrent.ok, false);
    assert.equal(concurrent.state, "attempted");
    releasePost();
    const completed = await first;
    assert.equal(completed.ok, true, JSON.stringify(completed));
    assert.equal(completed.state, "completed");
    assert.equal(posts, 1);
    assert.equal(JSON.stringify(completed).includes(generated.privateKey), false);
    assert.equal(JSON.stringify(completed).includes(generated.keyId), false);

    const repeated = await executeKeyGeneration(fixture.db, transport, generated);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.attempted, false);
    assert.equal(repeated.state, "completed");
    assert.equal(posts, 1);

    const foreign = await executePreparedRestrictedKeyGeneration(fixture.db, {
      ...keyGenerationInput(generated),
      authenticatedUserId: USER_B,
      financialAccountId: ACCOUNT_B,
      providerConnectionId: CONNECTION_B,
      verificationCredentialId: VERIFICATION_B,
      verificationFingerprint: FP_VERIFICATION_B,
      provisioningCredentialId: PROVISIONING_B,
      executionCredentialId: SETUP_EXECUTION_B,
      executionFingerprint: FP_SETUP_EXECUTION_B,
      transport,
      verifyGenerated: async () => ({ ok: true, reason: "credential_verified" }),
    });
    assert.equal(foreign.ok, false);
    assert.equal(posts, 1);

    await insertGenerationAttempt(fixture.raw, "B");
    const generatedB = generatedCredential();
    const independentB = await executePreparedRestrictedKeyGeneration(fixture.db, {
      authenticatedUserId: USER_B,
      financialAccountId: ACCOUNT_B,
      providerConnectionId: CONNECTION_B,
      attemptId: GENERATE_ATTEMPT_B,
      confirmation: EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
      verificationCredentialId: VERIFICATION_B,
      verificationFingerprint: FP_VERIFICATION_B,
      provisioningCredentialId: PROVISIONING_B,
      executionCredentialId: SETUP_EXECUTION_B,
      executionFingerprint: FP_SETUP_EXECUTION_B,
      executionMaterial: { keyId: "setup-execution-b", privateKey: "mock-only" },
      transport: async () => ({
        status: 201,
        unreadable: false,
        body: {
          api_key_id: generatedB.keyId,
          private_key: generatedB.privateKey,
        },
      }),
      verifyGenerated: async (material, fingerprint) => ({
        ok: material.keyId === generatedB.keyId &&
          fingerprint === generatedB.fingerprint,
        reason: "credential_verified",
      }),
    });
    assert.equal(independentB.ok, true);
    const activeB = await fixture.raw.query(
      `SELECT count(*)::int AS count
       FROM private.kalshi_connection_credentials
       WHERE owner_user_id = $1::uuid AND role = 'restricted_execution'
         AND revoked_at IS NULL AND verified_at IS NOT NULL`,
      [USER_B],
    );
    assert.equal(Number(activeB.rows[0]?.count), 1);

    const active = await fixture.raw.query(
      `SELECT id::text AS id, verified_at, verification_reason
       FROM private.kalshi_connection_credentials
       WHERE owner_user_id = $1::uuid AND role = 'restricted_execution'
         AND revoked_at IS NULL`,
      [USER_A],
    );
    assert.equal(active.rows.length, 1);
    assert.ok(active.rows[0]?.verified_at);
    assert.equal(active.rows[0]?.verification_reason, "credential_verified");
    const old = await fixture.raw.query(
      `SELECT revoked_at, replaced_by::text AS replaced_by
       FROM private.kalshi_connection_credentials WHERE id = $1::uuid`,
      [OLD_RESTRICTED_A],
    );
    assert.ok(old.rows[0]?.revoked_at);
    assert.equal(old.rows[0]?.replaced_by, active.rows[0]?.id);
    const attempt = await fixture.raw.query(
      `SELECT state, response_digest, result_reference, plan::text AS plan,
              uncertainty_reason
       FROM private.kalshi_account_operation_attempts WHERE id = $1::uuid`,
      [GENERATE_ATTEMPT_A],
    );
    assert.equal(attempt.rows[0]?.state, "completed");
    assert.match(String(attempt.rows[0]?.response_digest), /^[0-9a-f]{64}$/);
    assert.equal(attempt.rows[0]?.result_reference, "restricted_credential_bound_and_verified");
    assert.equal(JSON.stringify(attempt.rows[0]).includes(generated.privateKey), false);
    assert.equal(JSON.stringify(attempt.rows[0]).includes(generated.keyId), false);
    const vault = await fixture.raw.query("SELECT count(*)::int AS count FROM vault.secrets");
    assert.equal(Number(vault.rows[0]?.count), 10);
  } finally {
    await fixture.raw.close();
  }
});

test("timeout and Vault failure latch reconciliation and never regenerate", async (t) => {
  await t.test("ambiguous transport", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      await insertGenerationAttempt(fixture.raw);
      let posts = 0;
      const generated = generatedCredential();
      const transport: RestrictedKeyGenerationTransport = async () => {
        posts += 1;
        return "uncertain";
      };
      const uncertain = await executeKeyGeneration(fixture.db, transport, generated);
      assert.equal(uncertain.state, "uncertain");
      assert.equal(uncertain.reconciliationRequired, true);
      await executeKeyGeneration(fixture.db, transport, generated);
      assert.equal(posts, 1);
    } finally {
      await fixture.raw.close();
    }
  });

  await t.test("Vault transaction failure", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      await insertGenerationAttempt(fixture.raw);
      const generated = generatedCredential();
      const failing = interceptTransactions(fixture.db, (text) => {
        if (text.includes("account-restricted-key-generation:create-secret")) {
          throw new Error("simulated_vault_failure");
        }
      });
      let posts = 0;
      const failed = await executeKeyGeneration(failing, async () => {
        posts += 1;
        return {
          status: 201,
          unreadable: false,
          body: { api_key_id: generated.keyId, private_key: generated.privateKey },
        };
      }, generated);
      assert.equal(failed.reason, "restricted_key_storage_failed_reconciliation_required");
      assert.equal(failed.state, "uncertain");
      assert.equal(posts, 1);
      const active = await fixture.raw.query(
        `SELECT id::text AS id FROM private.kalshi_connection_credentials
         WHERE owner_user_id = $1::uuid AND role = 'restricted_execution'
           AND revoked_at IS NULL`,
        [USER_A],
      );
      assert.deepEqual(active.rows.map((row) => row.id), [OLD_RESTRICTED_A]);
      const vault = await fixture.raw.query("SELECT count(*)::int AS count FROM vault.secrets");
      assert.equal(Number(vault.rows[0]?.count), 8);
      assert.equal(JSON.stringify(failed).includes(generated.privateKey), false);
    } finally {
      await fixture.raw.close();
    }
  });
});

test("invalid generated scope/subaccount and authority rotation remain fail-closed", async (t) => {
  for (const reason of [
    "credential_permission_rejected",
    "restricted_key_not_bound_to_subaccount_1",
  ]) {
    await t.test(reason, async (t) => {
      const fixture = await setup(t);
      if (!fixture) return;
      try {
        await insertGenerationAttempt(fixture.raw);
        const generated = generatedCredential();
        const failed = await executePreparedRestrictedKeyGeneration(fixture.db, {
          ...keyGenerationInput(generated),
          transport: async () => ({
            status: 201,
            unreadable: false,
            body: { api_key_id: generated.keyId, private_key: generated.privateKey },
          }),
          verifyGenerated: async () => ({ ok: false, reason }),
        });
        assert.equal(failed.ok, false);
        assert.equal(failed.state, "uncertain");
        const active = await fixture.raw.query(
          `SELECT verified_at FROM private.kalshi_connection_credentials
           WHERE owner_user_id = $1::uuid AND role = 'restricted_execution'
             AND revoked_at IS NULL`,
          [USER_A],
        );
        assert.equal(active.rows.length, 1);
        assert.equal(active.rows[0]?.verified_at, null);
      } finally {
        await fixture.raw.close();
      }
    });
  }

  await t.test("credential rotation during verification", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      await insertGenerationAttempt(fixture.raw);
      const generated = generatedCredential();
      const failed = await executePreparedRestrictedKeyGeneration(fixture.db, {
        ...keyGenerationInput(generated),
        transport: async () => ({
          status: 201,
          unreadable: false,
          body: { api_key_id: generated.keyId, private_key: generated.privateKey },
        }),
        verifyGenerated: async () => {
          await fixture.raw.query(
            `UPDATE private.kalshi_connection_credentials
             SET revoked_at = now() WHERE id = $1::uuid`,
            [SETUP_EXECUTION_A],
          );
          return { ok: true, reason: "credential_verified" };
        },
      });
      assert.equal(failed.reason, "restricted_key_completion_reconciliation_required");
      assert.equal(failed.state, "uncertain");
    } finally {
      await fixture.raw.close();
    }
  });

  await t.test("restricted role rotation during the one-shot POST", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      await insertGenerationAttempt(fixture.raw);
      const generated = generatedCredential();
      const rotatedId = "10000000-0000-4000-8000-000000000099";
      const rotatedFingerprint = "99".repeat(32);
      let verificationCalled = false;
      const outcome = await executePreparedRestrictedKeyGeneration(fixture.db, {
        ...keyGenerationInput(generated),
        transport: async () => {
          const secret = await fixture.raw.query(
            `INSERT INTO vault.secrets(secret,name) VALUES ('{}','rotated')
             RETURNING id::text AS id`,
          );
          await fixture.raw.query(
            `UPDATE private.kalshi_connection_credentials
             SET revoked_at = now() WHERE id = $1::uuid`,
            [OLD_RESTRICTED_A],
          );
          await fixture.raw.query(
            `INSERT INTO private.kalshi_connection_credentials(
               id,owner_user_id,financial_account_id,provider_connection_id,role,
               vault_secret_id,key_fingerprint,verified_at,verification_reason
             ) VALUES ($1,$2,$3,$4,'restricted_execution',$5,$6,now(),'credential_verified')`,
            [
              rotatedId,
              USER_A,
              ACCOUNT_A,
              CONNECTION_A,
              secret.rows[0]?.id,
              rotatedFingerprint,
            ],
          );
          return {
            status: 201,
            unreadable: false,
            body: { api_key_id: generated.keyId, private_key: generated.privateKey },
          };
        },
        verifyGenerated: async () => {
          verificationCalled = true;
          return { ok: true, reason: "credential_verified" };
        },
      });
      assert.equal(outcome.reason, "restricted_key_stored_rotation_reconciliation_required");
      assert.equal(outcome.state, "uncertain");
      assert.equal(verificationCalled, false);
      const active = await fixture.raw.query(
        `SELECT id::text AS id, key_fingerprint
         FROM private.kalshi_connection_credentials
         WHERE owner_user_id = $1::uuid AND role = 'restricted_execution'
           AND revoked_at IS NULL`,
        [USER_A],
      );
      assert.deepEqual(active.rows, [{
        id: rotatedId,
        key_fingerprint: rotatedFingerprint,
      }]);
      const held = await fixture.raw.query(
        `SELECT verification_reason, revoked_at
         FROM private.kalshi_connection_credentials
         WHERE owner_user_id = $1::uuid AND role = 'restricted_execution'
           AND key_fingerprint = $2`,
        [USER_A, generated.fingerprint],
      );
      assert.equal(held.rows.length, 1);
      assert.equal(held.rows[0]?.verification_reason, "generated_reconciliation_required");
      assert.ok(held.rows[0]?.revoked_at);
      const attempt = await fixture.raw.query(
        `SELECT uncertainty_reason
         FROM private.kalshi_account_operation_attempts WHERE id = $1::uuid`,
        [GENERATE_ATTEMPT_A],
      );
      assert.equal(
        attempt.rows[0]?.uncertainty_reason,
        "restricted_execution_credential_rotated_during_generation",
      );
    } finally {
      await fixture.raw.close();
    }
  });
});

test("stored key reconciliation completes GET-verified material without another POST", async (t) => {
  const fixture = await setup(t);
  if (!fixture) return;
  try {
    await insertGenerationAttempt(fixture.raw);
    const generated = generatedCredential();
    let posts = 0;
    const failed = await executePreparedRestrictedKeyGeneration(fixture.db, {
      ...keyGenerationInput(generated),
      transport: async () => {
        posts += 1;
        return {
          status: 201,
          unreadable: false,
          body: { api_key_id: generated.keyId, private_key: generated.privateKey },
        };
      },
      verifyGenerated: async () => ({
        ok: false,
        reason: "credential_permission_unproven",
      }),
    });
    assert.equal(failed.state, "uncertain");
    const stored = await fixture.raw.query(
      `SELECT id::text AS id, key_fingerprint
       FROM private.kalshi_connection_credentials
       WHERE owner_user_id = $1::uuid
         AND role = 'restricted_execution'
         AND revoked_at IS NULL`,
      [USER_A],
    );
    const credentialId = String(stored.rows[0]?.id);
    const fingerprint = String(stored.rows[0]?.key_fingerprint);
    await fixture.raw.query(
      `UPDATE private.kalshi_connection_credentials
       SET verified_at = now(), verification_reason = 'credential_verified'
       WHERE id = $1::uuid`,
      [credentialId],
    );
    const input = {
      authenticatedUserId: USER_A,
      financialAccountId: ACCOUNT_A,
      providerConnectionId: CONNECTION_A,
      attemptId: GENERATE_ATTEMPT_A,
      confirmation: RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
      targetCredentialId: credentialId,
      targetFingerprint: fingerprint,
      verificationCredentialId: VERIFICATION_A,
      verificationFingerprint: FP_VERIFICATION_A,
    };
    const reconciled = await reconcileStoredRestrictedKeyGeneration(fixture.db, input);
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.equal(reconciled.state, "completed");
    assert.equal(reconciled.attempted, false);
    assert.equal(posts, 1);
    const repeated = await reconcileStoredRestrictedKeyGeneration(fixture.db, input);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.state, "completed");
    assert.equal(posts, 1);
    const foreign = await reconcileStoredRestrictedKeyGeneration(fixture.db, {
      ...input,
      authenticatedUserId: USER_B,
      financialAccountId: ACCOUNT_B,
      providerConnectionId: CONNECTION_B,
      verificationCredentialId: VERIFICATION_B,
      verificationFingerprint: FP_VERIFICATION_B,
    });
    assert.equal(foreign.ok, false);
    assert.equal(posts, 1);
  } finally {
    await fixture.raw.close();
  }
});

test("account execute route reconciles a stored key with GET-only verification", async (t) => {
  const fixture = await setup(t);
  if (!fixture) return;
  try {
    const verification = {
      keyId: "verification-route-key",
      privateKey: rsaPrivateKey(),
    };
    const verificationFingerprint = dedicatedSignerFingerprint(
      verification.keyId,
      verification.privateKey,
    );
    assert.ok(verificationFingerprint);
    const verificationRow = await fixture.raw.query(
      `SELECT vault_secret_id::text AS vault_secret_id
       FROM private.kalshi_connection_credentials
       WHERE id = $1::uuid`,
      [VERIFICATION_A],
    );
    await fixture.raw.query(
      "UPDATE vault.secrets SET secret = $1 WHERE id = $2::uuid",
      [
        JSON.stringify({
          api_key_id: verification.keyId,
          private_key: verification.privateKey,
        }),
        verificationRow.rows[0]?.vault_secret_id,
      ],
    );
    await fixture.raw.query(
      `UPDATE private.kalshi_connection_credentials
       SET key_fingerprint = $2
       WHERE id = $1::uuid`,
      [VERIFICATION_A, verificationFingerprint],
    );
    await insertGenerationAttempt(fixture.raw);
    const generated = generatedCredential();
    let posts = 0;
    const failed = await executePreparedRestrictedKeyGeneration(fixture.db, {
      ...keyGenerationInput(generated),
      verificationFingerprint,
      transport: async () => {
        posts += 1;
        return {
          status: 201,
          unreadable: false,
          body: { api_key_id: generated.keyId, private_key: generated.privateKey },
        };
      },
      verifyGenerated: async () => ({
        ok: false,
        reason: "credential_metadata_unproven",
      }),
    });
    assert.equal(failed.state, "uncertain");
    const reads: Array<{ keyId: string; path: string }> = [];
    const controls = accountCredentialControls(fixture.db, {
      async kalshiGet(material, path) {
        reads.push({ keyId: material.keyId, path });
        if (path.endsWith("/api_keys")) {
          assert.equal(material.keyId, verification.keyId);
          return {
            api_keys: [
              {
                api_key_id: verification.keyId,
                scopes: ["read"],
                subaccount: null,
              },
              {
                api_key_id: generated.keyId,
                scopes: ["read", "write::trade"],
                subaccount: 1,
              },
            ],
          };
        }
        if (path.endsWith("/portfolio/subaccounts/balances")) {
          assert.equal(material.keyId, verification.keyId);
          return {
            subaccount_balances: [
              { subaccount_number: 0, exchange_index: 2, balance: "0.0000" },
              { subaccount_number: 1, exchange_index: 2, balance: "0.0000" },
            ],
          };
        }
        if (path.endsWith("/portfolio/balance")) {
          assert.equal(material.keyId, generated.keyId);
          return { balance_dollars: "0.0000", subaccount: 1, exchange_index: 2 };
        }
        throw new Error(`unexpected GET ${path}`);
      },
    });
    const reconciled = await controls.executeOperation(USER_A, {
      operation: "generate_api_key",
      attemptId: GENERATE_ATTEMPT_A,
      confirmation: RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
    });
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.equal(reconciled.state, "completed");
    assert.equal(posts, 1);
    assert.equal(reads.length, 3);
    assert.equal(JSON.stringify(reconciled).includes(generated.privateKey), false);
    assert.equal(JSON.stringify(reconciled).includes(generated.keyId), false);
    const quiet = accountCredentialControls(fixture.db, {
      async kalshiGet() {
        throw new Error("completed reconciliation must not call Kalshi");
      },
    });
    const repeated = await quiet.executeOperation(USER_A, {
      operation: "generate_api_key",
      attemptId: GENERATE_ATTEMPT_A,
      confirmation: RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
    });
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.reason, "restricted_key_already_generated_and_verified");
    assert.equal(repeated.state, "completed");
    assert.equal(posts, 1);
  } finally {
    await fixture.raw.close();
  }
});

test("execution provisioning is transactional, idempotent, concurrent-safe, and preserves empty safety domains", async (t) => {
  const fixture = await setup(t);
  if (!fixture) return;
  try {
    const fingerprint = FP_OLD_RESTRICTED_A;
    await fixture.raw.query(
      `UPDATE private.kalshi_connection_credentials
       SET verified_at = now(), verification_reason = 'credential_verified'
       WHERE id = $1::uuid`,
      [OLD_RESTRICTED_A],
    );
    await insertProvisioningAttempt(fixture.raw, OLD_RESTRICTED_A, fingerprint);
    const input = {
      authenticatedUserId: USER_A,
      financialAccountId: ACCOUNT_A,
      providerConnectionId: CONNECTION_A,
      attemptId: PROVISION_ATTEMPT_A,
      confirmation: EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION,
      restrictedCredentialId: OLD_RESTRICTED_A,
      restrictedFingerprint: fingerprint,
    };
    const outcomes = await Promise.all([
      executePreparedExecutionAccountProvisioning(fixture.db, input),
      executePreparedExecutionAccountProvisioning(fixture.db, input),
    ]);
    assert.equal(outcomes.every((item) => item.ok), true);
    assert.equal(outcomes.filter((item) => item.attempted).length, 1);
    assert.equal(outcomes.filter((item) => item.idempotent).length, 1);
    const account = await fixture.raw.query(
      `SELECT id, owner_user_id::text AS owner_user_id,
              kalshi_connection_id::text AS kalshi_connection_id,
              subaccount, exchange_index, commissioned, execution_enabled,
              kill_switch, cash_precision_verified, cash_micros::text AS cash_micros,
              reserved_micros::text AS reserved_micros,
              initial_cash_micros::text AS initial_cash_micros,
              policy_id
       FROM v13_production_account`,
    );
    assert.deepEqual(account.rows, [{
      id: EXECUTION_ACCOUNT_A,
      owner_user_id: USER_A,
      kalshi_connection_id: ACCOUNT_A,
      subaccount: 1,
      exchange_index: 2,
      commissioned: false,
      execution_enabled: false,
      kill_switch: true,
      cash_precision_verified: false,
      cash_micros: "0",
      reserved_micros: "0",
      initial_cash_micros: "0",
      policy_id: null,
    }]);
    for (const table of [
      "v13_live_money_policy",
      "strata_configured_stake",
      "private.kalshi_account_worker_lease",
    ]) {
      const count = await fixture.raw.query(`SELECT count(*)::int AS count FROM ${table}`);
      assert.equal(Number(count.rows[0]?.count), 0);
    }
    const safety = await fixture.raw.query(
      "SELECT live_execution_enabled, manual_kill_switch FROM live_execution_config",
    );
    assert.deepEqual(safety.rows, [{
      live_execution_enabled: false,
      manual_kill_switch: true,
    }]);
    const foreign = await executePreparedExecutionAccountProvisioning(fixture.db, {
      ...input,
      authenticatedUserId: USER_B,
      financialAccountId: ACCOUNT_B,
      providerConnectionId: CONNECTION_B,
      restrictedCredentialId: OLD_RESTRICTED_B,
      restrictedFingerprint: FP_OLD_RESTRICTED_B,
    });
    assert.equal(foreign.ok, false);
    assert.equal((await fixture.raw.query(
      "SELECT count(*)::int AS count FROM v13_production_account",
    )).rows[0]?.count, 1);
    let providerReads = 0;
    const controls = accountCredentialControls(fixture.db, {
      async kalshiGet() {
        providerReads += 1;
        throw new Error("completed provisioning must not call Kalshi");
      },
    });
    const repeated = await controls.executeOperation(USER_A, {
      operation: "provision_execution_account",
      attemptId: PROVISION_ATTEMPT_A,
      confirmation: EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION,
    });
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.reason, "execution_account_already_provisioned");
    assert.equal(providerReads, 0);
    assert.equal((await fixture.raw.query(
      "SELECT count(*)::int AS count FROM v13_production_account",
    )).rows[0]?.count, 1);
  } finally {
    await fixture.raw.close();
  }
});

test("safe-looking pre-existing row is never adopted by a prepared provisioning attempt", async (t) => {
  const fixture = await setup(t);
  if (!fixture) return;
  try {
    await fixture.raw.query(
      `UPDATE private.kalshi_connection_credentials
       SET verified_at = now(), verification_reason = 'credential_verified'
       WHERE id = $1::uuid`,
      [OLD_RESTRICTED_A],
    );
    await insertProvisioningAttempt(fixture.raw, OLD_RESTRICTED_A, FP_OLD_RESTRICTED_A);
    await fixture.raw.query(
      `INSERT INTO v13_production_account (
         id, owner_user_id, kalshi_connection_id, subaccount, exchange_index,
         key_fingerprint, kill_switch, execution_enabled, commissioned,
         cash_precision_verified, cash_micros, reserved_micros, initial_cash_micros
       ) VALUES (
         $4, $1::uuid, $2::uuid, 1, 2, $3,
         true, false, false, false, 0, 0, 0
       )`,
      [USER_A, ACCOUNT_A, FP_OLD_RESTRICTED_A, EXECUTION_ACCOUNT_A],
    );
    const blocked = await executePreparedExecutionAccountProvisioning(fixture.db, {
      authenticatedUserId: USER_A,
      financialAccountId: ACCOUNT_A,
      providerConnectionId: CONNECTION_A,
      attemptId: PROVISION_ATTEMPT_A,
      confirmation: EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION,
      restrictedCredentialId: OLD_RESTRICTED_A,
      restrictedFingerprint: FP_OLD_RESTRICTED_A,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "execution_account_already_exists");
    const accounts = await fixture.raw.query("SELECT id FROM v13_production_account");
    assert.deepEqual(accounts.rows, [{ id: EXECUTION_ACCOUNT_A }]);
    const attempt = await fixture.raw.query(
      "SELECT state FROM private.kalshi_account_operation_attempts WHERE id = $1::uuid",
      [PROVISION_ATTEMPT_A],
    );
    assert.equal(attempt.rows[0]?.state, "prepared");
  } finally {
    await fixture.raw.close();
  }
});

test("unresolved key generation transactionally blocks execution provisioning", async (t) => {
  const fixture = await setup(t);
  if (!fixture) return;
  try {
    await fixture.raw.query(
      `UPDATE private.kalshi_connection_credentials
       SET verified_at = now(), verification_reason = 'credential_verified'
       WHERE id = $1::uuid`,
      [OLD_RESTRICTED_A],
    );
    await insertGenerationAttempt(fixture.raw);
    await fixture.raw.query(
      `UPDATE private.kalshi_account_operation_attempts
       SET state = 'uncertain', attempted_at = now(),
           uncertainty_reason = 'provider_response_ambiguous'
       WHERE id = $1::uuid`,
      [GENERATE_ATTEMPT_A],
    );
    await insertProvisioningAttempt(
      fixture.raw,
      OLD_RESTRICTED_A,
      FP_OLD_RESTRICTED_A,
    );
    const blocked = await executePreparedExecutionAccountProvisioning(fixture.db, {
      authenticatedUserId: USER_A,
      financialAccountId: ACCOUNT_A,
      providerConnectionId: CONNECTION_A,
      attemptId: PROVISION_ATTEMPT_A,
      confirmation: EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION,
      restrictedCredentialId: OLD_RESTRICTED_A,
      restrictedFingerprint: FP_OLD_RESTRICTED_A,
    });
    assert.equal(blocked.reason, "restricted_key_generation_reconciliation_required");
    assert.equal(Number((await fixture.raw.query(
      "SELECT count(*)::int AS count FROM v13_production_account",
    )).rows[0]?.count), 0);
  } finally {
    await fixture.raw.close();
  }
});

test("both operations refuse fail-open global controls without a POST or account row", async (t) => {
  await t.test("key generation", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      await insertGenerationAttempt(fixture.raw);
      await fixture.raw.query(
        "UPDATE live_execution_config SET live_execution_enabled = true",
      );
      const generated = generatedCredential();
      let posts = 0;
      const blocked = await executeKeyGeneration(fixture.db, async () => {
        posts += 1;
        return "uncertain";
      }, generated);
      assert.equal(blocked.reason, "production_safety_controls_not_fail_closed");
      assert.equal(posts, 0);
      const attempt = await fixture.raw.query(
        "SELECT state FROM private.kalshi_account_operation_attempts WHERE id = $1::uuid",
        [GENERATE_ATTEMPT_A],
      );
      assert.equal(attempt.rows[0]?.state, "prepared");
    } finally {
      await fixture.raw.close();
    }
  });

  await t.test("execution provisioning", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      await fixture.raw.query(
        `UPDATE private.kalshi_connection_credentials
         SET verified_at = now(), verification_reason = 'credential_verified'
         WHERE id = $1::uuid`,
        [OLD_RESTRICTED_A],
      );
      await insertProvisioningAttempt(
        fixture.raw,
        OLD_RESTRICTED_A,
        FP_OLD_RESTRICTED_A,
      );
      await fixture.raw.query(
        "UPDATE live_execution_config SET manual_kill_switch = false",
      );
      const blocked = await executePreparedExecutionAccountProvisioning(fixture.db, {
        authenticatedUserId: USER_A,
        financialAccountId: ACCOUNT_A,
        providerConnectionId: CONNECTION_A,
        attemptId: PROVISION_ATTEMPT_A,
        confirmation: EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION,
        restrictedCredentialId: OLD_RESTRICTED_A,
        restrictedFingerprint: FP_OLD_RESTRICTED_A,
      });
      assert.equal(blocked.reason, "production_safety_controls_not_fail_closed");
      const accounts = await fixture.raw.query(
        "SELECT count(*)::int AS count FROM v13_production_account",
      );
      assert.equal(Number(accounts.rows[0]?.count), 0);
    } finally {
      await fixture.raw.close();
    }
  });
});

async function setup(t: { skip(message: string): void }): Promise<{
  raw: DisposablePg;
  db: CredentialDatabase;
} | null> {
  let PGlite: new () => DisposablePg;
  try {
    const loaded = createRequire(process.cwd() + "/package.json")("@electric-sql/pglite") as {
      PGlite: typeof PGlite;
    };
    PGlite = loaded.PGlite;
  } catch {
    t.skip("disposable PostgreSQL is not installed");
    return null;
  }
  const raw = new PGlite();
  await raw.exec(`
    CREATE SCHEMA auth;
    CREATE SCHEMA private;
    CREATE SCHEMA vault;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.financial_accounts (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES auth.users(id),
      provider text NOT NULL,
      UNIQUE (id, user_id)
    );
    CREATE TABLE vault.secrets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      secret text NOT NULL,
      name text,
      description text
    );
    CREATE FUNCTION vault.create_secret(new_secret text, new_name text, new_description text)
    RETURNS uuid LANGUAGE plpgsql AS $$
    DECLARE created uuid := gen_random_uuid();
    BEGIN
      INSERT INTO vault.secrets (id, secret, name, description)
      VALUES (created, new_secret, new_name, new_description);
      RETURN created;
    END $$;
    CREATE VIEW vault.decrypted_secrets AS
      SELECT id, secret AS decrypted_secret FROM vault.secrets;
    CREATE TABLE private.provider_connections (
      id uuid PRIMARY KEY,
      financial_account_id uuid NOT NULL UNIQUE REFERENCES public.financial_accounts(id),
      vault_secret_id uuid
    );
    CREATE UNIQUE INDEX provider_connections_id_financial_account_uidx
      ON private.provider_connections (id, financial_account_id);
    CREATE TABLE private.kalshi_connection_credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL,
      financial_account_id uuid NOT NULL,
      provider_connection_id uuid NOT NULL,
      role text NOT NULL CHECK (role IN (
        'provisioning', 'verification', 'restricted_execution', 'account_setup_execution'
      )),
      vault_secret_id uuid NOT NULL UNIQUE REFERENCES vault.secrets(id),
      key_fingerprint text,
      verified_at timestamptz,
      verification_reason text,
      revoked_at timestamptz,
      replaced_by uuid REFERENCES private.kalshi_connection_credentials(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (financial_account_id, owner_user_id)
        REFERENCES public.financial_accounts(id, user_id),
      FOREIGN KEY (provider_connection_id, financial_account_id)
        REFERENCES private.provider_connections(id, financial_account_id)
    );
    CREATE UNIQUE INDEX kalshi_connection_credentials_one_active_role
      ON private.kalshi_connection_credentials(provider_connection_id, role)
      WHERE revoked_at IS NULL;
    CREATE TABLE live_execution_config (
      id text PRIMARY KEY,
      live_execution_enabled boolean NOT NULL,
      manual_kill_switch boolean NOT NULL
    );
    INSERT INTO live_execution_config VALUES ('singleton', false, true);
    CREATE TABLE v13_production_account (
      id text PRIMARY KEY,
      owner_user_id uuid,
      kalshi_connection_id uuid,
      policy_id text,
      subaccount integer NOT NULL,
      exchange_index integer NOT NULL,
      key_fingerprint text NOT NULL,
      commissioning_digest text,
      kill_switch boolean NOT NULL DEFAULT true,
      execution_enabled boolean NOT NULL DEFAULT false,
      commissioned boolean NOT NULL DEFAULT false,
      minimum_exit_micros integer,
      fee_artifact_digest text,
      cash_precision_verified boolean NOT NULL DEFAULT false,
      cash_micros bigint NOT NULL,
      reserved_micros bigint NOT NULL DEFAULT 0,
      initial_cash_micros bigint NOT NULL,
      blocked_reason text,
      reconciled_at timestamptz,
      evidence_digest text,
      revision bigint NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX v13_production_account_owned_pair
      ON v13_production_account(owner_user_id, subaccount, exchange_index)
      WHERE owner_user_id IS NOT NULL;
    CREATE TABLE v13_live_money_policy (
      id text PRIMARY KEY,
      execution_account_id text
    );
    CREATE TABLE strata_configured_stake (
      id text PRIMARY KEY,
      execution_account_id text
    );
    CREATE TABLE private.kalshi_account_worker_lease (
      execution_account_id text PRIMARY KEY
    );
  `);
  await raw.exec(readFileSync("../../lib/db/drizzle/0015_kalshi_account_operation_attempts.sql", "utf8"));
  await raw.query("INSERT INTO auth.users(id) VALUES ($1),($2)", [USER_A, USER_B]);
  await raw.query(
    `INSERT INTO public.financial_accounts(id,user_id,provider)
     VALUES ($1,$2,'kalshi'),($3,$4,'kalshi')`,
    [ACCOUNT_A, USER_A, ACCOUNT_B, USER_B],
  );
  await raw.query(
    `INSERT INTO private.provider_connections(id,financial_account_id)
     VALUES ($1,$2),($3,$4)`,
    [CONNECTION_A, ACCOUNT_A, CONNECTION_B, ACCOUNT_B],
  );
  const credentials = [
    [PROVISIONING_A, USER_A, ACCOUNT_A, CONNECTION_A, "provisioning", FP_PROVISIONING_A],
    [VERIFICATION_A, USER_A, ACCOUNT_A, CONNECTION_A, "verification", FP_VERIFICATION_A],
    [SETUP_EXECUTION_A, USER_A, ACCOUNT_A, CONNECTION_A, "account_setup_execution", FP_SETUP_EXECUTION_A],
    [OLD_RESTRICTED_A, USER_A, ACCOUNT_A, CONNECTION_A, "restricted_execution", FP_OLD_RESTRICTED_A],
    [PROVISIONING_B, USER_B, ACCOUNT_B, CONNECTION_B, "provisioning", FP_PROVISIONING_B],
    [VERIFICATION_B, USER_B, ACCOUNT_B, CONNECTION_B, "verification", FP_VERIFICATION_B],
    [SETUP_EXECUTION_B, USER_B, ACCOUNT_B, CONNECTION_B, "account_setup_execution", FP_SETUP_EXECUTION_B],
    [OLD_RESTRICTED_B, USER_B, ACCOUNT_B, CONNECTION_B, "restricted_execution", FP_OLD_RESTRICTED_B],
  ] as const;
  for (const [id, owner, account, connection, role, fingerprint] of credentials) {
    const secret = await raw.query(
      `INSERT INTO vault.secrets(secret,name) VALUES ('{}',$1) RETURNING id::text AS id`,
      [`fixture-${id}`],
    );
    await raw.query(
      `INSERT INTO private.kalshi_connection_credentials(
         id,owner_user_id,financial_account_id,provider_connection_id,role,
         vault_secret_id,key_fingerprint,verified_at,verification_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,
         CASE WHEN $5 = 'restricted_execution' THEN NULL ELSE now() END,
         CASE WHEN $5 = 'restricted_execution' THEN NULL ELSE 'credential_verified' END
       )`,
      [id, owner, account, connection, role, secret.rows[0]?.id, fingerprint],
    );
  }
  return { raw, db: serialDatabase(raw) };
}

function serialDatabase(raw: DisposablePg): CredentialDatabase {
  let tail = Promise.resolve();
  return {
    query: (text, params) => raw.query(text, params),
    async transaction<T>(work: (client: CredentialClient) => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        await raw.exec("BEGIN");
        const value = await work(raw);
        await raw.exec("COMMIT");
        return value;
      } catch (error) {
        await raw.exec("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        release();
      }
    },
  };
}

function interceptTransactions(
  db: CredentialDatabase,
  beforeQuery: (text: string) => void,
): CredentialDatabase {
  return {
    query: (text, params) => db.query(text, params),
    transaction: (work) => db.transaction((client) => work({
      query(text, params) {
        beforeQuery(text);
        return client.query(text, params);
      },
    })),
  };
}

test("rotation during generation can be reconciled without another POST", async (t) => {
  await t.test("retains a different verified active key and leaves the generated key inactive", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      const verification = await bindVerificationKey(fixture.raw);
      await insertGenerationAttempt(fixture.raw);
      const generated = generatedCredential();
      const active = generatedCredential();
      const rotated = await generateDuringRotation(
        fixture,
        verification.fingerprint,
        active,
        generated,
      );
      assert.equal(rotated.outcome.state, "uncertain");
      assert.equal(rotated.outcome.reason, "restricted_key_stored_rotation_reconciliation_required");
      const controls = accountCredentialControls(fixture.db, {
        kalshiGet: inventoryGet(verification.keyId, [generated.keyId, active.keyId]),
      });
      const reconciled = await controls.executeOperation(USER_A, {
        operation: "generate_api_key",
        attemptId: GENERATE_ATTEMPT_A,
        confirmation: RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
      });
      assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
      assert.equal(reconciled.reason, "restricted_key_held_inactive_active_key_retained");
      assert.equal(reconciled.state, "completed");
      assert.equal(rotated.posts, 1);
      assert.equal(JSON.stringify(reconciled).includes(generated.privateKey), false);
      assert.equal(JSON.stringify(reconciled).includes(active.privateKey), false);
      const held = await fixture.raw.query(
        `SELECT key_fingerprint, revoked_at IS NOT NULL AS revoked, verification_reason
         FROM private.kalshi_connection_credentials
         WHERE owner_user_id = $1::uuid AND role = 'restricted_execution'
           AND key_fingerprint = $2`,
        [USER_A, generated.fingerprint],
      );
      assert.equal(held.rows[0]?.revoked, true);
      assert.equal(held.rows[0]?.verification_reason, "generated_reconciliation_required");
      const activeRow = await fixture.raw.query(
        `SELECT id::text AS id, revoked_at IS NULL AS active
         FROM private.kalshi_connection_credentials
         WHERE id = $1::uuid`,
        [rotated.rotatedId],
      );
      assert.deepEqual(activeRow.rows, [{ id: rotated.rotatedId, active: true }]);
      const attempt = await fixture.raw.query(
        `SELECT state, result_reference FROM private.kalshi_account_operation_attempts
         WHERE id = $1::uuid`,
        [GENERATE_ATTEMPT_A],
      );
      assert.equal(attempt.rows[0]?.state, "completed");
      assert.equal(attempt.rows[0]?.result_reference, "generated_key_held_inactive");
    } finally {
      await fixture.raw.close();
    }
  });

  await t.test("activates the held key when no other restricted credential remains", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      const verification = await bindVerificationKey(fixture.raw);
      await insertGenerationAttempt(fixture.raw);
      const generated = generatedCredential();
      const active = generatedCredential();
      const rotated = await generateDuringRotation(
        fixture,
        verification.fingerprint,
        active,
        generated,
      );
      await fixture.raw.query(
        `UPDATE private.kalshi_connection_credentials
         SET revoked_at = now() WHERE id = $1::uuid`,
        [rotated.rotatedId],
      );
      const controls = accountCredentialControls(fixture.db, {
        kalshiGet: inventoryGet(verification.keyId, [generated.keyId]),
      });
      const reconciled = await controls.executeOperation(USER_A, {
        operation: "generate_api_key",
        attemptId: GENERATE_ATTEMPT_A,
        confirmation: RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
      });
      assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
      assert.equal(reconciled.reason, "restricted_key_reconciled_and_verified");
      assert.equal(rotated.posts, 1);
      const held = await fixture.raw.query(
        `SELECT revoked_at IS NULL AS active, verification_reason
         FROM private.kalshi_connection_credentials
         WHERE owner_user_id = $1::uuid AND role = 'restricted_execution'
           AND key_fingerprint = $2`,
        [USER_A, generated.fingerprint],
      );
      assert.equal(held.rows[0]?.active, true);
      assert.equal(held.rows[0]?.verification_reason, "credential_verified");
      const displaced = await fixture.raw.query(
        `SELECT revoked_at IS NOT NULL AS revoked
         FROM private.kalshi_connection_credentials WHERE id = $1::uuid`,
        [rotated.rotatedId],
      );
      assert.equal(displaced.rows[0]?.revoked, true);
    } finally {
      await fixture.raw.close();
    }
  });

  await t.test("does not swap or complete when the active key fails verification", async (t) => {
    const fixture = await setup(t);
    if (!fixture) return;
    try {
      const verification = await bindVerificationKey(fixture.raw);
      await insertGenerationAttempt(fixture.raw);
      const generated = generatedCredential();
      const active = generatedCredential();
      const rotated = await generateDuringRotation(
        fixture,
        verification.fingerprint,
        active,
        generated,
      );
      const controls = accountCredentialControls(fixture.db, {
        kalshiGet: inventoryGet(verification.keyId, [generated.keyId]),
      });
      const reconciled = await controls.executeOperation(USER_A, {
        operation: "generate_api_key",
        attemptId: GENERATE_ATTEMPT_A,
        confirmation: RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
      });
      assert.equal(reconciled.ok, false);
      assert.equal(reconciled.reason, "credential_permission_unproven");
      assert.equal(rotated.posts, 1);
      const attempt = await fixture.raw.query(
        `SELECT state FROM private.kalshi_account_operation_attempts WHERE id = $1::uuid`,
        [GENERATE_ATTEMPT_A],
      );
      assert.equal(attempt.rows[0]?.state, "uncertain");
      const held = await fixture.raw.query(
        `SELECT revoked_at IS NOT NULL AS revoked
         FROM private.kalshi_connection_credentials
         WHERE key_fingerprint = $1`,
        [generated.fingerprint],
      );
      assert.equal(held.rows[0]?.revoked, true);
      const activeRow = await fixture.raw.query(
        `SELECT revoked_at IS NULL AS active, key_fingerprint
         FROM private.kalshi_connection_credentials WHERE id = $1::uuid`,
        [rotated.rotatedId],
      );
      assert.equal(activeRow.rows[0]?.active, true);
      assert.equal(activeRow.rows[0]?.key_fingerprint, active.fingerprint);
    } finally {
      await fixture.raw.close();
    }
  });
});

async function bindVerificationKey(raw: DisposablePg) {
  const privateKey = rsaPrivateKey();
  const keyId = "verification-route-key";
  const fingerprint = dedicatedSignerFingerprint(keyId, privateKey);
  assert.ok(fingerprint);
  const row = await raw.query(
    `SELECT vault_secret_id::text AS vault_secret_id
     FROM private.kalshi_connection_credentials WHERE id = $1::uuid`,
    [VERIFICATION_A],
  );
  await raw.query(
    "UPDATE vault.secrets SET secret = $1 WHERE id = $2::uuid",
    [
      JSON.stringify({ api_key_id: keyId, private_key: privateKey }),
      row.rows[0]?.vault_secret_id,
    ],
  );
  await raw.query(
    `UPDATE private.kalshi_connection_credentials
     SET key_fingerprint = $2 WHERE id = $1::uuid`,
    [VERIFICATION_A, fingerprint],
  );
  return { keyId, privateKey, fingerprint };
}

function inventoryGet(verificationKeyId: string, listedKeyIds: string[]) {
  return async (material: { keyId: string }, path: string) => {
    if (path.endsWith("/api_keys")) {
      assert.equal(material.keyId, verificationKeyId);
      return {
        api_keys: [
          { api_key_id: verificationKeyId, scopes: ["read"], subaccount: null },
          ...listedKeyIds.map((apiKeyId) => ({
            api_key_id: apiKeyId,
            scopes: ["read", "write::trade"],
            subaccount: 1,
          })),
        ],
      };
    }
    if (path.endsWith("/portfolio/subaccounts/balances")) {
      return {
        subaccount_balances: [
          { subaccount_number: 0, exchange_index: 2, balance: "0.0000" },
          { subaccount_number: 1, exchange_index: 2, balance: "0.0000" },
        ],
      };
    }
    if (path.endsWith("/portfolio/balance")) {
      return { balance_dollars: "0.0000", subaccount: 1, exchange_index: 2 };
    }
    throw new Error(`unexpected GET ${path}`);
  };
}

async function generateDuringRotation(
  fixture: { raw: DisposablePg; db: CredentialDatabase },
  verificationFingerprint: string,
  active: { keyId: string; privateKey: string; fingerprint: string },
  generated: { keyId: string; privateKey: string; fingerprint: string },
) {
  const rotatedId = "10000000-0000-4000-8000-000000000099";
  let posts = 0;
  const outcome = await executePreparedRestrictedKeyGeneration(fixture.db, {
    ...keyGenerationInput(generated),
    verificationFingerprint,
    transport: async () => {
      posts += 1;
      const secret = await fixture.raw.query(
        `INSERT INTO vault.secrets(secret,name) VALUES ($1,'rotated')
         RETURNING id::text AS id`,
        [JSON.stringify({ api_key_id: active.keyId, private_key: active.privateKey })],
      );
      await fixture.raw.query(
        `UPDATE private.kalshi_connection_credentials
         SET revoked_at = now() WHERE id = $1::uuid`,
        [OLD_RESTRICTED_A],
      );
      await fixture.raw.query(
        `INSERT INTO private.kalshi_connection_credentials(
           id,owner_user_id,financial_account_id,provider_connection_id,role,
           vault_secret_id,key_fingerprint,verified_at,verification_reason
         ) VALUES ($1,$2,$3,$4,'restricted_execution',$5,$6,now(),'credential_verified')`,
        [
          rotatedId,
          USER_A,
          ACCOUNT_A,
          CONNECTION_A,
          secret.rows[0]?.id,
          active.fingerprint,
        ],
      );
      return {
        status: 201,
        unreadable: false,
        body: { api_key_id: generated.keyId, private_key: generated.privateKey },
      };
    },
    verifyGenerated: async () => ({ ok: true, reason: "credential_verified" }),
  });
  return { outcome, posts, rotatedId };
}

async function insertGenerationAttempt(
  raw: DisposablePg,
  owner: "A" | "B" = "A",
): Promise<void> {
  const isB = owner === "B";
  await raw.query(
    `INSERT INTO private.kalshi_account_operation_attempts(
       id,owner_user_id,financial_account_id,provider_connection_id,operation,
       authority_credential_id,authority_fingerprint,target_fingerprint,
       plan,precondition_digest
     ) VALUES ($1,$2,$3,$4,'generate_api_key',$5,$6,$7,$8::jsonb,$9)`,
    [
      isB ? GENERATE_ATTEMPT_B : GENERATE_ATTEMPT_A,
      isB ? USER_B : USER_A,
      isB ? ACCOUNT_B : ACCOUNT_A,
      isB ? CONNECTION_B : CONNECTION_A,
      isB ? PROVISIONING_B : PROVISIONING_A,
      isB ? FP_PROVISIONING_B : FP_PROVISIONING_A,
      isB ? FP_OLD_RESTRICTED_B : FP_OLD_RESTRICTED_A,
      JSON.stringify({
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
      }),
      "aa".repeat(32),
    ],
  );
}

async function insertProvisioningAttempt(
  raw: DisposablePg,
  credentialId: string,
  fingerprint: string,
): Promise<void> {
  await raw.query(
    `INSERT INTO private.kalshi_account_operation_attempts(
       id,owner_user_id,financial_account_id,provider_connection_id,operation,
       authority_credential_id,authority_fingerprint,target_credential_id,
       target_fingerprint,planned_execution_account_id,plan,precondition_digest
     ) VALUES (
       $1,$2,$3,$4,'provision_execution_account',$5,$6,$5,$6,$7,$8::jsonb,$9
     )`,
    [
      PROVISION_ATTEMPT_A,
      USER_A,
      ACCOUNT_A,
      CONNECTION_A,
      credentialId,
      fingerprint,
      EXECUTION_ACCOUNT_A,
      JSON.stringify({
        operation: "provision_execution_account",
        plannedExecutionAccountId: EXECUTION_ACCOUNT_A,
        subaccount: 1,
        exchangeIndex: 2,
        commissioned: false,
        executionEnabled: false,
        killSwitch: true,
        cashPrecisionVerified: false,
      }),
      "bb".repeat(32),
    ],
  );
}

function generatedCredential(): {
  keyId: string;
  privateKey: string;
  fingerprint: string;
} {
  const privateKey = rsaPrivateKey();
  const keyId = `generated-${Math.random().toString(16).slice(2)}`;
  const fingerprint = dedicatedSignerFingerprint(keyId, privateKey);
  assert.ok(fingerprint);
  return { keyId, privateKey, fingerprint };
}

function rsaPrivateKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  }).privateKey;
}

function keyGenerationInput(generated: {
  keyId: string;
  privateKey: string;
  fingerprint: string;
}) {
  return {
    authenticatedUserId: USER_A,
    financialAccountId: ACCOUNT_A,
    providerConnectionId: CONNECTION_A,
    attemptId: GENERATE_ATTEMPT_A,
    confirmation: EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
    verificationCredentialId: VERIFICATION_A,
    verificationFingerprint: FP_VERIFICATION_A,
    provisioningCredentialId: PROVISIONING_A,
    executionCredentialId: SETUP_EXECUTION_A,
    executionFingerprint: FP_SETUP_EXECUTION_A,
    executionMaterial: { keyId: "setup-execution", privateKey: "not-read-by-transport-mock" },
    verifyGenerated: async (
      material: { keyId: string; privateKey: string },
      fingerprint: string,
    ) => ({
      ok: material.keyId === generated.keyId &&
        material.privateKey === generated.privateKey.trim() &&
        fingerprint === generated.fingerprint,
      reason: "credential_verified",
    }),
  };
}

function executeKeyGeneration(
  db: CredentialDatabase,
  transport: RestrictedKeyGenerationTransport,
  generated: { keyId: string; privateKey: string; fingerprint: string },
) {
  return executePreparedRestrictedKeyGeneration(db, {
    ...keyGenerationInput(generated),
    transport,
  });
}
