import assert from "node:assert/strict";
import test from "node:test";
import {
  assertVerifiedDevelopmentDestination,
  classifyDatabaseDestination,
  requireDevelopmentDatabase,
} from "./require-development-db.mjs";

const verifiedDevelopment = {
  database_name_hash: "3674a53cdc4f6baa13fd11b18153eedf",
  server_endpoint_hash: "e6cef578c7102f8739db4a57c25c29f2",
  database_oid: 16384,
  has_claim_column: true,
  has_budget_column: true,
};

test("read-only destination classification uses fingerprints, not NODE_ENV", () => {
  assert.equal(classifyDatabaseDestination(verifiedDevelopment), "DEVELOPMENT");
  assert.equal(classifyDatabaseDestination({
    database_name_hash: "1aad2780f5bf2f804f5c5f6de0e3969e",
    server_endpoint_hash: "9d285fbb85820f09eb5f718a7091b5c3", database_oid: 16394,
  }), "PRODUCTION");
  assert.equal(classifyDatabaseDestination({ ...verifiedDevelopment, database_oid: 1 }), "UNKNOWN");
  assert.equal(classifyDatabaseDestination(undefined), "UNKNOWN");
});

test("verified development database is eligible", () => {
  assert.doesNotThrow(() => assertVerifiedDevelopmentDestination(verifiedDevelopment));
});

test("production database and any unverified destination are refused", () => {
  const production = {
    database_name_hash: "1aad2780f5bf2f804f5c5f6de0e3969e",
    server_endpoint_hash: "9d285fbb85820f09eb5f718a7091b5c3",
    database_oid: 16394,
    has_claim_column: false,
    has_budget_column: false,
  };
  for (const row of [
    production,
    { ...production, has_claim_column: true, has_budget_column: true },
    { ...verifiedDevelopment, server_endpoint_hash: production.server_endpoint_hash },
    { ...verifiedDevelopment, has_claim_column: false },
    null,
  ]) {
    assert.throws(() => assertVerifiedDevelopmentDestination(row),
      /not the verified development database/);
  }
});

test("a rejected destination does not reach any write", async () => {
  const queries = [];
  await assert.rejects(
    requireDevelopmentDatabase({
      query: async (sql) => {
        queries.push(sql);
        return { rows: [{ ...verifiedDevelopment, has_budget_column: false }] };
      },
    }),
    /not the verified development database/,
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^\s*SELECT\b/i);
});

test("exact local GitHub Actions CI database is eligible only under test mode", () => {
  const previous = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    CI: process.env.CI,
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  const ciRow = {
    database_name: "v13_ci",
    database_user: "postgres",
    database_name_hash: "not-a-pinned-replit-hash",
    server_endpoint_hash: "ephemeral-container",
    database_oid: 16384,
    has_claim_column: true,
    has_budget_column: true,
  };
  try {
    process.env.GITHUB_ACTIONS = "true";
    process.env.CI = "true";
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/v13_ci";
    assert.doesNotThrow(() => assertVerifiedDevelopmentDestination(ciRow));

    process.env.NODE_ENV = "development";
    assert.throws(() => assertVerifiedDevelopmentDestination(ciRow),
      /not the verified development database/);

    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://postgres:postgres@prod.example.com:5432/v13_ci";
    assert.throws(() => assertVerifiedDevelopmentDestination(ciRow),
      /not the verified development database/);

    process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/production";
    assert.throws(() => assertVerifiedDevelopmentDestination(ciRow),
      /not the verified development database/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
