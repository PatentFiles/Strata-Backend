import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Reuse the database workspace's existing driver without adding a runtime dependency.
const dbRequire = createRequire(import.meta.resolve("@workspace/db"));
const { Client } = dbRequire("pg");

const schema = `worker_test_${randomBytes(12).toString("hex")}`;
const tables = [
  "forward_test_engine",
  "forward_test_btc_points",
  "forward_test_evaluations",
  "forward_test_positions",
  "forward_test_windows",
];

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run the isolated worker tests");
}

const originalUrl = process.env.DATABASE_URL;
const isolatedUrl = new URL(originalUrl);
const previousOptions = isolatedUrl.searchParams.get("options");
isolatedUrl.searchParams.set(
  "options",
  [previousOptions, `-csearch_path=${schema}`].filter(Boolean).join(" "),
);
const setup = new Client({ connectionString: originalUrl });
let setupConnected = false;

try {
  await setup.connect();
  setupConnected = true;
  await setup.query("BEGIN");
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    for (const table of tables) {
      // LIKE copies the source table's checks, defaults, and unique indexes,
      // including the one-enabled-engine partial unique index, but no rows.
      await setup.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    const { rows: [singletonIndex] } = await setup.query(`
      SELECT count(*)::integer AS count
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'forward_test_engine'
        AND i.indisunique AND pg_get_expr(i.indpred, i.indrelid) LIKE '%enabled%'
    `, [schema]);
    if (singletonIndex.count !== 1) {
      throw new Error("The isolated engine is missing its enabled-engine unique index");
    }
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK");
    throw error;
  }

  const isolationCheck = new Client({ connectionString: isolatedUrl.toString() });
  try {
    await isolationCheck.connect();
    const { rows: [context] } = await isolationCheck.query(
      "SELECT current_schema() AS schema, count(*)::integer AS engines FROM forward_test_engine",
    );
    if (context.schema !== schema || context.engines !== 0) {
      throw new Error("Worker test connection is not isolated from development records");
    }
  } finally {
    await isolationCheck.end();
  }

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test", "dist/forwardTestWorker.integration.test.cjs",
    ], {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: isolatedUrl.toString(),
        FORWARD_TEST_ISOLATED_SCHEMA: schema,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Worker test process terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  // The name is generated in this process and only this schema is removed.
  // Never delete, update, or pause anything in the public development schema.
  if (setupConnected) {
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.end();
  }
}