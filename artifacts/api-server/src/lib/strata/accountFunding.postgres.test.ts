import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WALLET_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WALLET_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";

test("funding migration isolates two users on disposable PostgreSQL", async (t) => {
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
      CREATE UNIQUE INDEX provider_connections_id_financial_account_uidx
        ON private.provider_connections (id, financial_account_id);
    `);
    await db.exec(readFileSync("../../lib/db/drizzle/0014_kalshi_account_funding.sql", "utf8"));
    await db.query("INSERT INTO vault.secrets (id) VALUES ($1), ($2)", [WALLET_A, WALLET_B]);
    await db.query(
      "INSERT INTO public.financial_accounts (id, user_id, provider) VALUES ($1,$2,'kalshi'), ($3,$4,'kalshi')",
      [ACCOUNT_A, USER_A, ACCOUNT_B, USER_B],
    );
    await db.query(
      "INSERT INTO private.provider_connections (id, financial_account_id, vault_secret_id) VALUES ($1,$2,$3), ($4,$5,$6)",
      [CONNECTION_A, ACCOUNT_A, WALLET_A, CONNECTION_B, ACCOUNT_B, WALLET_B],
    );
    await db.query(
      `INSERT INTO private.kalshi_account_funding
        (owner_user_id, financial_account_id, provider_connection_id, authorized_micros)
       VALUES ($1,$2,$3,1000000), ($4,$5,$6,2000000)`,
      [USER_A, ACCOUNT_A, CONNECTION_A, USER_B, ACCOUNT_B, CONNECTION_B],
    );
    const visible = await db.query(
      `SELECT owner_user_id::text AS owner, authorized_micros::text AS authorized
       FROM private.kalshi_account_funding WHERE owner_user_id = $1`,
      [USER_A],
    );
    assert.equal(visible.rows.length, 1);
    assert.equal(visible.rows[0]?.authorized, "1000000");
    await assert.rejects(() => db.query(
      `INSERT INTO private.kalshi_account_funding
        (owner_user_id, financial_account_id, provider_connection_id, authorized_micros)
       VALUES ($1,$2,$3,3000000)`,
      [USER_A, ACCOUNT_A, CONNECTION_A],
    ));
    await db.exec("BEGIN");
    await db.query(
      `UPDATE private.kalshi_account_funding SET revoked_at = now()
       WHERE owner_user_id = $1 AND revoked_at IS NULL`,
      [USER_A],
    );
    await db.exec("ROLLBACK");
    const active = await db.query(
      `SELECT count(*)::int AS active FROM private.kalshi_account_funding
       WHERE owner_user_id = $1 AND revoked_at IS NULL`,
      [USER_A],
    );
    assert.equal(Number(active.rows[0]?.active), 1);
  } finally {
    await db.close();
  }
});
