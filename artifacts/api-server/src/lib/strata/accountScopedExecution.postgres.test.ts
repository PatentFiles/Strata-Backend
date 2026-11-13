import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { ACQUIRE_LEASE_SQL, executionDatabaseFromPool, readScopedActivity } from "./accountScopedExecution";
import type { PgPoolLike } from "./accountCredentialStore";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const FINANCIAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FINANCIAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECRET_A = "12121212-1212-4121-8121-121212121212";
const SECRET_B = "34343434-3434-4343-8343-343434343434";
const FINGERPRINT_A = "ab".repeat(32);
const FINGERPRINT_B = "cd".repeat(32);

test("worker lease SQL isolates two accounts and rolls back on disposable PostgreSQL", async (t) => {
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
      CREATE TABLE public.v13_production_account (
        id text PRIMARY KEY,
        owner_user_id uuid,
        policy_id text,
        subaccount integer NOT NULL,
        exchange_index integer NOT NULL,
        key_fingerprint text NOT NULL,
        commissioned boolean NOT NULL,
        execution_enabled boolean NOT NULL,
        kill_switch boolean NOT NULL,
        cash_micros bigint NOT NULL,
        kalshi_connection_id uuid
      );
      CREATE TABLE public.v13_live_money_policy (
        id text PRIMARY KEY,
        state text NOT NULL,
        policy_hash text NOT NULL,
        execution_account_id text,
        max_entry_stake_cents integer NOT NULL,
        max_daily_loss_cents integer NOT NULL,
        max_total_loss_cents integer NOT NULL
      );
      CREATE TABLE public.strata_configured_stake (
        id text PRIMARY KEY,
        execution_account_id text,
        configured_stake_cents integer NOT NULL,
        revision integer NOT NULL
      );
      CREATE TABLE public.v13_production_position (
        account_id text NOT NULL,
        market text NOT NULL,
        side text NOT NULL,
        quantity_hundredths integer NOT NULL
      );
      CREATE TABLE public.v13_production_intent (
        id text PRIMARY KEY,
        account_id text NOT NULL,
        client_order_id text NOT NULL UNIQUE,
        state text NOT NULL
      );
      CREATE TABLE public.v13_production_event (
        account_id text NOT NULL,
        event_id text NOT NULL,
        pnl_micros bigint NOT NULL
      );
    `);
    await db.exec(readFileSync("../../lib/db/drizzle/0012_kalshi_connection_credentials.sql", "utf8"));
    await db.exec(readFileSync("../../lib/db/drizzle/0013_kalshi_account_worker_lease.sql", "utf8"));
    await db.query("INSERT INTO vault.secrets (id) VALUES ($1), ($2)", [SECRET_A, SECRET_B]);
    await db.query(
      "INSERT INTO public.financial_accounts (id, user_id, provider) VALUES ($1,$2,'kalshi'), ($3,$4,'kalshi')",
      [FINANCIAL_A, USER_A, FINANCIAL_B, USER_B],
    );
    await db.query(
      "INSERT INTO private.provider_connections (id, financial_account_id, vault_secret_id) VALUES ($1,$2,$3), ($4,$5,$6)",
      [CONNECTION_A, FINANCIAL_A, SECRET_A, CONNECTION_B, FINANCIAL_B, SECRET_B],
    );
    await db.query(
      `INSERT INTO public.v13_production_account
        (id, owner_user_id, policy_id, subaccount, exchange_index, key_fingerprint, commissioned, execution_enabled, kill_switch, cash_micros, kalshi_connection_id)
       VALUES
        ('user-a','${USER_A}','policy-a',1,2,'${FINGERPRINT_A}',true,false,false,1000000,'${FINANCIAL_A}'),
        ('user-b','${USER_B}','policy-b',1,2,'${FINGERPRINT_B}',true,false,false,5000000,'${FINANCIAL_B}')`,
    );
    await db.exec(`
      INSERT INTO public.v13_live_money_policy
        (id, state, policy_hash, execution_account_id, max_entry_stake_cents, max_daily_loss_cents, max_total_loss_cents)
      VALUES
        ('policy-a','APPROVED','${"aa".repeat(32)}','user-a',100,100,200),
        ('policy-b','APPROVED','${"bb".repeat(32)}','user-b',500,400,800);
      INSERT INTO public.strata_configured_stake (id, execution_account_id, configured_stake_cents, revision)
      VALUES ('stake-a','user-a',100,1), ('stake-b','user-b',500,1);
      INSERT INTO public.v13_production_position (account_id, market, side, quantity_hundredths)
      VALUES ('user-a','KXBTC15M-A','YES',0), ('user-b','KXBTC15M-B','YES',100);
      INSERT INTO public.v13_production_intent (id, account_id, client_order_id, state)
      VALUES ('intent-a','user-a','order-a','TERMINAL'), ('intent-b','user-b','order-b','DISPATCHED');
      INSERT INTO public.v13_production_event (account_id, event_id, pnl_micros)
      VALUES ('user-a','fill:fill-a',0), ('user-b','fill:fill-b',-50000);
    `);
    const scoped = await readScopedActivity(db, USER_A, "user-a");
    assert.equal(scoped.account?.execution_account_id, "user-a");
    assert.equal(scoped.configuredStakeCents, 100);
    assert.equal(scoped.positions.length, 0);
    assert.equal(scoped.orders.length, 1);
    assert.equal(scoped.orders[0]?.client_order_id, "order-a");
    assert.equal(scoped.policy?.execution_account_id, "user-a");
    const other = await readScopedActivity(db, USER_A, "user-b");
    assert.equal(other.account, null);
    assert.equal(other.orders.length, 0);
    const leases = executionDatabaseFromPool(pglitePool(db));
    await leases.query(
      `INSERT INTO private.kalshi_account_worker_lease (
         execution_account_id, owner_user_id, financial_account_id, provider_connection_id,
         holder_id, fencing_token, state, heartbeat_at, released_at, account_kill,
         arm_requested, credential_fingerprint, vault_secret_id
       ) VALUES ($1,$2,$3,$4,'process-a',1,'released',now(),now(),false,true,$5,$6)`,
      ["user-a", USER_A, FINANCIAL_A, CONNECTION_A, FINGERPRINT_A, SECRET_A],
    );
    await assert.rejects(() => leases.query(
      `INSERT INTO private.kalshi_account_worker_lease (
         execution_account_id, owner_user_id, financial_account_id, provider_connection_id,
         holder_id, fencing_token, state, heartbeat_at, released_at, account_kill,
         arm_requested, credential_fingerprint, vault_secret_id
       ) VALUES ('user-a',$1,$2,$3,'process-b',1,'released',now(),now(),false,true,$4,$5)`,
      [USER_B, FINANCIAL_B, CONNECTION_B, FINGERPRINT_B, SECRET_B],
    ));
    const acquired = await leases.transaction((client) => client.query(ACQUIRE_LEASE_SQL, [
      "user-a",
      "process-a",
      "2026-10-12T21:00:00.000Z",
      FINGERPRINT_A,
      SECRET_A,
      CONNECTION_A,
      FINANCIAL_A,
      USER_A,
      "2026-10-12T20:00:00.000Z",
    ]));
    assert.equal(acquired.rows[0]?.fencing_token, "2");
    const second = await leases.query(ACQUIRE_LEASE_SQL, [
      "user-a",
      "process-b",
      "2026-10-12T21:00:01.000Z",
      FINGERPRINT_A,
      SECRET_A,
      CONNECTION_A,
      FINANCIAL_A,
      USER_A,
      "2026-10-12T20:59:00.000Z",
    ]);
    assert.equal(second.rows.length, 0);
    await leases.transaction(async (client) => {
      await client.query(
        "UPDATE private.kalshi_account_worker_lease SET fencing_token = 99 WHERE execution_account_id = 'user-a'",
      );
      throw new Error("rollback_acquire");
    }).catch((error: Error) => {
      assert.equal(error.message, "rollback_acquire");
    });
    const remaining = await db.query(
      "SELECT fencing_token::text AS fencing_token, state, execution_enabled FROM private.kalshi_account_worker_lease lease JOIN public.v13_production_account account ON account.id = lease.execution_account_id WHERE lease.execution_account_id = 'user-a'",
    );
    assert.equal(remaining.rows[0]?.fencing_token, "2");
    assert.equal(remaining.rows[0]?.state, "owned");
    assert.equal(remaining.rows[0]?.execution_enabled, false);
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
