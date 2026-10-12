import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  credentialDatabaseFromPool,
  type PgPoolLike,
} from "./accountCredentialStore";
import {
  registerAccountCredential,
  revokeAccountCredential,
  type AccountCredentialRegistration,
} from "./accountCredentialLifecycle";
import type { AccountCommissioningPorts } from "./accountCommissioningContext";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WALLET_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WALLET_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";

test("vault registration commits per user and rolls back a rejected binding", async (t) => {
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
      CREATE TABLE vault.secrets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        secret text,
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
    await db.query("INSERT INTO vault.secrets (id) VALUES ($1), ($2)", [WALLET_A, WALLET_B]);
    await db.query(
      "INSERT INTO public.financial_accounts (id, user_id, provider) VALUES ($1,$2,'kalshi'), ($3,$4,'kalshi')",
      [ACCOUNT_A, USER_A, ACCOUNT_B, USER_B],
    );
    await db.query(
      "INSERT INTO private.provider_connections (id, financial_account_id, vault_secret_id) VALUES ($1,$2,$3), ($4,$5,$6)",
      [CONNECTION_A, ACCOUNT_A, WALLET_A, CONNECTION_B, ACCOUNT_B, WALLET_B],
    );
    const pool = pglitePool(db);
    const database = credentialDatabaseFromPool(pool);
    const first = await registerAccountCredential(database, ports(), {
      authenticatedUserId: USER_A,
      role: "restricted_execution",
      ...key(),
    });
    const second = await registerAccountCredential(database, ports(), {
      authenticatedUserId: USER_B,
      role: "verification",
      ...key(),
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(published(first).includes("BEGIN"), false);
    assert.equal(published(second).includes("BEGIN"), false);
    const names = await db.query(
      "SELECT name FROM vault.secrets WHERE name IS NOT NULL ORDER BY name",
    );
    assert.equal(names.rows.length, 2);
    assert.equal(String(names.rows[0]?.name).startsWith(`kalshi:${USER_A}:`), true);
    assert.equal(String(names.rows[1]?.name).startsWith(`kalshi:${USER_B}:`), true);
    const foreign = await revokeAccountCredential(database, ports(), {
      authenticatedUserId: USER_B,
      role: "restricted_execution",
    });
    assert.equal(foreign.ok, false);
    const active = await db.query(
      `SELECT owner_user_id::text AS owner, role, revoked_at IS NULL AS active
       FROM private.kalshi_connection_credentials
       ORDER BY owner_user_id::text`,
    );
    assert.equal(active.rows.length, 2);
    assert.equal(active.rows.every((row) => row.active === true), true);
    await db.exec(`
      CREATE FUNCTION phase4_reject_provisioning() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.role = 'provisioning' THEN
          RAISE EXCEPTION 'phase4_reject_provisioning' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER phase4_reject_provisioning
      BEFORE INSERT ON private.kalshi_connection_credentials
      FOR EACH ROW EXECUTE FUNCTION phase4_reject_provisioning();
    `);
    const before = await db.query("SELECT count(*)::int AS secrets FROM vault.secrets WHERE name IS NOT NULL");
    const rejected = await registerAccountCredential(database, ports(), {
      authenticatedUserId: USER_A,
      role: "provisioning",
      ...key(),
    });
    const after = await db.query("SELECT count(*)::int AS secrets FROM vault.secrets WHERE name IS NOT NULL");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "credential_binding_rejected");
    assert.equal(Number(after.rows[0]?.secrets), Number(before.rows[0]?.secrets));
    const stillActive = await db.query(
      "SELECT count(*)::int AS active FROM private.kalshi_connection_credentials WHERE revoked_at IS NULL",
    );
    assert.equal(Number(stillActive.rows[0]?.active), 2);
  } finally {
    await db.close();
  }
});

function ports(): AccountCommissioningPorts {
  return {
    async listOwnedConnections(userId) {
      if (userId === USER_A) {
        return [{ authenticatedUserId: USER_A, financialAccountId: ACCOUNT_A, providerConnectionId: CONNECTION_A }];
      }
      if (userId === USER_B) {
        return [{ authenticatedUserId: USER_B, financialAccountId: ACCOUNT_B, providerConnectionId: CONNECTION_B }];
      }
      return [];
    },
    async listCredentialRefs() { return []; },
    async readExecutionTarget() { return null; },
    async readSnapshot() { throw new Error("snapshot_not_used"); },
    async openCredential() { throw new Error("vault_material_not_opened"); },
  };
}

function key(): { apiKeyId: string; privateKey: string } {
  const generated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    apiKeyId: `phase4-${generated.publicKey.export({ type: "pkcs1", format: "pem" }).length}`,
    privateKey: generated.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
}

function published(result: AccountCredentialRegistration): string {
  return JSON.stringify(result);
}

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
