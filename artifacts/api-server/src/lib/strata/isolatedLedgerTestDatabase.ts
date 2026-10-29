import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
type TestClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/** Test-only destination fence. Never falls back to an application database. */
export function isolatedLedgerTestUrl(env: NodeJS.ProcessEnv): URL {
  assert.equal(env.NODE_ENV, "test", "isolated ledger tests require NODE_ENV=test");
  const disposable = env.V13_DISPOSABLE_DATABASE_URL;
  if (disposable && /^postgresql:\/\/v13_test@127\.0\.0\.1:[1-9][0-9]*\/v13_disposable_[0-9]+$/.test(disposable)) {
    const url = new URL(disposable);
    assert.ok(Number(url.port) <= 65535);
    return url;
  }
  assert.equal(env.CI, "true", "isolated ledger tests require explicit CI destination");
  assert.equal(env.GITHUB_ACTIONS, "true");
  const url = new URL(env.DATABASE_URL ?? "invalid");
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.equal(url.port, "5432");
  assert.equal(url.username, "postgres");
  assert.equal(url.pathname, "/v13_ci");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  if (disposable) assert.equal(disposable, env.DATABASE_URL);
  return url;
}

/** Fresh database on a pinned disposable cluster; close drops ONLY our random DB. */
export async function createIsolatedLedgerTestDatabase() {
  const url = isolatedLedgerTestUrl(process.env); // validate BEFORE loading/connecting pg
  const require = createRequire(process.cwd() + "/package.json");
  const { Client } = createRequire(require.resolve("@workspace/db"))("pg") as {
    Client: new(config: Record<string, unknown>) => TestClient;
  };
  const config = {
    host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
    password: () => decodeURIComponent(url.password), database: url.pathname.slice(1),
    ssl: false as const, connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=10000 -c lock_timeout=5000",
  };
  const name = "strata_ledger_test_" + randomUUID().replaceAll("-", "");
  const admin = new Client(config);
  const db = new Client({ ...config, database: name });
  let created = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await db.end(); }
    finally {
      try { if (created) await admin.query(`DROP DATABASE "${name}"`); }
      finally { await admin.end(); }
    }
  };
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    await db.connect();
    return {
      exec: (sql: string) => db.query(sql),
      query: (sql: string, params?: unknown[]) => db.query(sql, params),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
