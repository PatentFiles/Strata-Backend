import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const dbRequire = createRequire(import.meta.resolve("@workspace/db"));
const { Client } = dbRequire("pg");
const schema = `shadow_test_${randomBytes(12).toString("hex")}`;
const tables = [
  "forward_test_evaluations",
  "live_execution_config",
  "live_proposed_orders",
  "live_notification_events",
];
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const isolatedUrl = new URL(process.env.DATABASE_URL);
const oldOptions = isolatedUrl.searchParams.get("options");
isolatedUrl.searchParams.set("options", [oldOptions, `-csearch_path=${schema}`].filter(Boolean).join(" "));
const setup = new Client({ connectionString: process.env.DATABASE_URL });
await setup.connect();
try {
  await setup.query("BEGIN");
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    for (const table of tables) {
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
      "SELECT current_schema() AS schema, count(*)::integer AS proposals FROM live_proposed_orders",
    );
    if (context.schema !== schema || context.proposals !== 0) {
      throw new Error("Shadow test connection is not isolated");
    }
  } finally {
    await isolation.end();
  }
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", process.argv[2] ?? "dist/shadowLive.integration.test.cjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "development",
        DATABASE_URL: isolatedUrl.toString(),
        SHADOW_TEST_ISOLATED_SCHEMA: schema,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Shadow tests terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await setup.end();
}