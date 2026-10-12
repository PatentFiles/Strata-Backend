import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { planCommission, emptySnapshot } from "./commissioning";
import {
  credentialDatabaseFromPool,
  replaceOwnedCredentialBinding,
  type PgPoolLike,
} from "./accountCredentialStore";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WALLET_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WALLET_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SECRET_A = "12121212-1212-4121-8121-121212121212";
const SECRET_NEXT = "56565656-5656-4565-8565-565656565656";
const SECRET_MISSING = "90909090-9090-4909-8909-909090909090";
const FINGERPRINT = "ab".repeat(32);

test("ordered replacement SQL commits and rolls back on disposable PostgreSQL", async (t) => {
  let PGlite: new () => {
    exec(query: string): Promise<unknown>;
    query(query: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    close(): Promise<void>;
  };
  try {
    const loaded = createRequire(process.cwd() + "/package.json")("@electric-sql/pglite") as { PGlite: typeof PGlite };
    PGlite = loaded.PGlite;
  } catch {
    t.skip("disposable PostgreSQL is not installed");
    return;
  }
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS private;
      CREATE SCHEMA IF NOT EXISTS vault;
      CREATE TABLE vault.secrets (id uuid PRIMARY KEY);
      CREATE TABLE public.financial_accounts (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        provider text NOT NULL,
        UNIQUE (id, user_id)
      );
      CREATE TABLE private.provider_connections (
        id uuid PRIMARY KEY,
        financial_account_id uuid NOT NULL UNIQUE REFERENCES public.financial_accounts(id),
        vault_secret_id uuid NOT NULL REFERENCES vault.secrets(id)
      );
    `);
    await db.exec(readFileSync("../../lib/db/drizzle/0012_kalshi_connection_credentials.sql", "utf8"));
    await db.query("INSERT INTO vault.secrets (id) VALUES ($1), ($2), ($3), ($4)", [WALLET_A, WALLET_B, SECRET_A, SECRET_NEXT]);
    await db.query(
      "INSERT INTO public.financial_accounts (id, user_id, provider) VALUES ($1,$2,'kalshi'), ($3,$4,'kalshi')",
      [ACCOUNT_A, USER_A, ACCOUNT_B, USER_B],
    );
    await db.query(
      "INSERT INTO private.provider_connections (id, financial_account_id, vault_secret_id) VALUES ($1,$2,$3), ($4,$5,$6)",
      [CONNECTION_A, ACCOUNT_A, WALLET_A, CONNECTION_B, ACCOUNT_B, WALLET_B],
    );
    await db.query(
      `INSERT INTO private.kalshi_connection_credentials
        (owner_user_id, financial_account_id, provider_connection_id, role, vault_secret_id, key_fingerprint)
       VALUES ($1,$2,$3,'restricted_execution',$4,$5)`,
      [USER_A, ACCOUNT_A, CONNECTION_A, SECRET_A, FINGERPRINT],
    );
    const pool = pglitePool(db);
    const replaced = await replaceOwnedCredentialBinding(credentialDatabaseFromPool(pool), {
      authenticatedUserId: USER_A,
      providerConnectionId: CONNECTION_A,
      role: "restricted_execution",
      vaultSecretId: SECRET_NEXT,
      keyFingerprint: FINGERPRINT,
    });
    assert.equal(replaced.ok, true);
    const rows = await db.query(
      `SELECT vault_secret_id::text AS vault_secret_id, revoked_at IS NOT NULL AS revoked, replaced_by::text AS replaced_by
       FROM private.kalshi_connection_credentials
       WHERE provider_connection_id = $1
       ORDER BY revoked_at NULLS LAST`,
      [CONNECTION_A],
    );
    const successor = await db.query(
      "SELECT id::text AS id FROM private.kalshi_connection_credentials WHERE vault_secret_id = $1",
      [SECRET_NEXT],
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0]?.vault_secret_id, SECRET_A);
    assert.equal(rows.rows[0]?.revoked, true);
    assert.equal(rows.rows[0]?.replaced_by, successor.rows[0]?.id);
    assert.equal(rows.rows[1]?.vault_secret_id, SECRET_NEXT);
    assert.equal(rows.rows[1]?.revoked, false);

    const foreign = await replaceOwnedCredentialBinding(credentialDatabaseFromPool(pool), {
      authenticatedUserId: USER_B,
      providerConnectionId: CONNECTION_A,
      role: "restricted_execution",
      vaultSecretId: SECRET_MISSING,
      keyFingerprint: FINGERPRINT,
    });
    assert.equal(foreign.ok, false);
    if (foreign.ok) return;
    assert.equal(foreign.reason, "credential_not_owned");

    const reused = await replaceOwnedCredentialBinding(credentialDatabaseFromPool(pool), {
      authenticatedUserId: USER_A,
      providerConnectionId: CONNECTION_A,
      role: "verification",
      vaultSecretId: WALLET_A,
      keyFingerprint: FINGERPRINT,
    });
    assert.equal(reused.ok, false);
    if (reused.ok) return;
    assert.equal(reused.reason, "vault_secret_reused_from_provider_connection");

    const rolledBack = await replaceOwnedCredentialBinding(credentialDatabaseFromPool(pool), {
      authenticatedUserId: USER_A,
      providerConnectionId: CONNECTION_A,
      role: "restricted_execution",
      vaultSecretId: SECRET_MISSING,
      keyFingerprint: FINGERPRINT,
    });
    assert.equal(rolledBack.ok, false);
    const after = await db.query(
      `SELECT count(*)::int AS active
       FROM private.kalshi_connection_credentials
       WHERE provider_connection_id = $1 AND role = 'restricted_execution' AND revoked_at IS NULL`,
      [CONNECTION_A],
    );
    assert.equal(Number(after.rows[0]?.active), 1);
    const wallet = await db.query("SELECT vault_secret_id::text AS id FROM private.provider_connections WHERE id = $1", [CONNECTION_A]);
    assert.equal(wallet.rows[0]?.id, WALLET_A);
    assert.equal(planCommission(emptySnapshot("2026-10-12T00:00:00.000Z")).plan, null);
  } finally {
    await db.close();
  }
});

function pglitePool(db: {
  exec(query: string): Promise<unknown>;
  query(query: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}): PgPoolLike {
  let tail = Promise.resolve();
  return {
    query: (text, params) => db.query(text, params),
    async connect() {
      const previous = tail;
      let releaseLock = () => {};
      tail = new Promise<void>((resolve) => { releaseLock = resolve; });
      await previous;
      let open = true;
      return {
        async query(text, params) {
          if (!open) throw new Error("released");
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            await db.exec(text);
            return { rows: [], rowCount: 0 };
          }
          const result = await db.query(text, params);
          return { rows: result.rows, rowCount: result.rows.length };
        },
        release() {
          if (!open) return;
          open = false;
          releaseLock();
        },
      };
    },
  };
}
