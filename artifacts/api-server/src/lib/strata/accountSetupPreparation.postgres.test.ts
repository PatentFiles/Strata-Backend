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
const CREDENTIAL_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CREDENTIAL_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";

test("setup attempt migration isolates users and durably prevents duplicate lifecycles", async (t) => {
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
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS private;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE public.financial_accounts (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES auth.users(id),
        provider text NOT NULL,
        UNIQUE (id, user_id)
      );
      CREATE TABLE private.provider_connections (
        id uuid PRIMARY KEY,
        financial_account_id uuid NOT NULL UNIQUE REFERENCES public.financial_accounts(id)
      );
      CREATE UNIQUE INDEX provider_connections_id_financial_account_uidx
        ON private.provider_connections (id, financial_account_id);
      CREATE TABLE private.kalshi_connection_credentials (
        id uuid PRIMARY KEY,
        owner_user_id uuid NOT NULL,
        provider_connection_id uuid NOT NULL
      );
    `);
    await db.exec(readFileSync("../../lib/db/drizzle/0015_kalshi_account_operation_attempts.sql", "utf8"));
    await db.query("INSERT INTO auth.users (id) VALUES ($1), ($2)", [USER_A, USER_B]);
    await db.query(
      "INSERT INTO public.financial_accounts (id, user_id, provider) VALUES ($1,$2,'kalshi'), ($3,$4,'kalshi')",
      [ACCOUNT_A, USER_A, ACCOUNT_B, USER_B],
    );
    await db.query(
      "INSERT INTO private.provider_connections (id, financial_account_id) VALUES ($1,$2), ($3,$4)",
      [CONNECTION_A, ACCOUNT_A, CONNECTION_B, ACCOUNT_B],
    );
    await db.query(
      `INSERT INTO private.kalshi_connection_credentials
         (id, owner_user_id, provider_connection_id)
       VALUES ($1,$2,$3), ($4,$5,$6)`,
      [CREDENTIAL_A, USER_A, CONNECTION_A, CREDENTIAL_B, USER_B, CONNECTION_B],
    );
    await assert.rejects(() =>
      insertAttempt(db, USER_A, ACCOUNT_A, CONNECTION_A, CREDENTIAL_B, "cd".repeat(32)));
    await insertAttempt(db, USER_A, ACCOUNT_A, CONNECTION_A, CREDENTIAL_A, "ab".repeat(32));
    await insertAttempt(db, USER_B, ACCOUNT_B, CONNECTION_B, CREDENTIAL_B, "cd".repeat(32));
    const isolated = await db.query(
      `SELECT owner_user_id::text AS owner
       FROM private.kalshi_account_operation_attempts
       WHERE owner_user_id = $1::uuid`,
      [USER_A],
    );
    assert.deepEqual(isolated.rows.map((row) => row.owner), [USER_A]);
    await assert.rejects(() =>
      insertAttempt(db, USER_A, ACCOUNT_A, CONNECTION_A, CREDENTIAL_A, "ab".repeat(32)));
    await db.query(
      `UPDATE private.kalshi_account_operation_attempts
       SET state = 'uncertain', attempted_at = now(),
           uncertainty_reason = 'transport_result_unknown', updated_at = now()
       WHERE owner_user_id = $1::uuid AND operation = 'generate_api_key'`,
      [USER_A],
    );
    const uncertain = await db.query(
      `SELECT state, uncertainty_reason
       FROM private.kalshi_account_operation_attempts
       WHERE owner_user_id = $1::uuid`,
      [USER_A],
    );
    assert.equal(uncertain.rows[0]?.state, "uncertain");
    assert.equal(uncertain.rows[0]?.uncertainty_reason, "transport_result_unknown");

    await db.exec("BEGIN");
    await db.query(
      `INSERT INTO private.kalshi_account_operation_attempts (
         owner_user_id, financial_account_id, provider_connection_id, operation,
         authority_credential_id, authority_fingerprint, plan, precondition_digest
       ) VALUES ($1,$2,$3,'create_subaccount',$4,$5,$6::jsonb,$7)`,
      [
        USER_A,
        ACCOUNT_A,
        CONNECTION_A,
        CREDENTIAL_A,
        "ab".repeat(32),
        JSON.stringify({
          operation: "create_subaccount",
          exchangePath: "/trade-api/v2/portfolio/subaccounts",
          method: "POST",
          request: { exchange_index: 2 },
          expectedSubaccount: 1,
        }),
        "ef".repeat(32),
      ],
    );
    await db.exec("ROLLBACK");
    const rolledBack = await db.query(
      `SELECT count(*)::int AS count
       FROM private.kalshi_account_operation_attempts
       WHERE owner_user_id = $1::uuid AND operation = 'create_subaccount'`,
      [USER_A],
    );
    assert.equal(Number(rolledBack.rows[0]?.count), 0);
  } finally {
    await db.close();
  }
});

async function insertAttempt(
  db: { query(query: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  owner: string,
  account: string,
  connection: string,
  authority: string,
  fingerprint: string,
): Promise<void> {
  await db.query(
    `INSERT INTO private.kalshi_account_operation_attempts (
       owner_user_id, financial_account_id, provider_connection_id, operation,
       authority_credential_id, authority_fingerprint, plan, precondition_digest
     ) VALUES ($1,$2,$3,'generate_api_key',$4,$5,$6::jsonb,$7)`,
    [
      owner,
      account,
      connection,
      authority,
      fingerprint,
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
      "12".repeat(32),
    ],
  );
}
