import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { requireDevelopmentDatabase } from "./require-development-db.mjs";

const { Client } = createRequire(import.meta.resolve("@workspace/db"))("pg");
const schema = `shadow_test_${randomBytes(12).toString("hex")}`;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const isolatedUrl = new URL(process.env.DATABASE_URL);
const oldOptions = isolatedUrl.searchParams.get("options");
isolatedUrl.searchParams.set("options",
  [oldOptions, `-csearch_path=${schema}`].filter(Boolean).join(" "));

const setup = new Client({ connectionString: process.env.DATABASE_URL });
await setup.connect();
let schemaCreated = false;
try {
  // This must precede BEGIN, CREATE SCHEMA, and any database-backed test.
  await requireDevelopmentDatabase(setup);
  await setup.query("BEGIN");
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    for (const table of [
      "forward_test_engine", "micro_live_config", "micro_live_run_archive", "micro_live_orders",
      "micro_live_fills", "micro_live_decisions",
    ]) {
      await setup.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK");
    throw error;
  }

  const isolation = new Client({ connectionString: isolatedUrl.toString() });
  try {
    await isolation.connect();
    const { rows: [context] } = await isolation.query(
      "SELECT current_schema() AS schema, count(*)::integer AS configs FROM micro_live_config",
    );
    if (context.schema !== schema || context.configs !== 0) {
      throw new Error("Micro-live test connection is not isolated");
    }
  } finally {
    await isolation.end();
  }

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ["--test",
        ...(process.env.MICRO_LIVE_TEST_NAME_PATTERN
          ? ["--test-name-pattern", process.env.MICRO_LIVE_TEST_NAME_PATTERN] : []),
        "dist/microLive.authorization.test.cjs"], {
        stdio: "inherit",
        env: {
          ...process.env, NODE_ENV: "development",
          DATABASE_URL: isolatedUrl.toString(), SHADOW_TEST_ISOLATED_SCHEMA: schema,
        },
      });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Micro-live tests terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  if (schemaCreated) await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await setup.end();
}