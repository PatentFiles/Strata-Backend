import { readFileSync, writeFileSync } from "node:fs";

const sourcePath = new URL("../drizzle/0000_reviewed_release_schema.sql", import.meta.url);
const supabasePath = "F:/TradingApp/supabase/migrations/20261010020000_reviewed_release_application_schema.sql";
const src = readFileSync(sourcePath, "utf8");
const out = [];
for (const line of src.split(/\r?\n/)) {
  if (line.startsWith("-- Reviewed release")) break;
  if (line.startsWith("ALTER TABLE") && line.includes("ADD CONSTRAINT")) {
    const stmt = line.replace(/--> statement-breakpoint\s*$/, "").trim();
    const sql = stmt.endsWith(";") ? stmt : `${stmt};`;
    out.push("DO $$ BEGIN");
    out.push(`  ${sql}`);
    out.push("EXCEPTION WHEN duplicate_object THEN NULL;");
    out.push("END $$;");
    continue;
  }
  let next = line;
  if (next.startsWith('CREATE TABLE "')) next = next.replace('CREATE TABLE "', 'CREATE TABLE IF NOT EXISTS "');
  else if (next.startsWith('CREATE UNIQUE INDEX "')) next = next.replace('CREATE UNIQUE INDEX "', 'CREATE UNIQUE INDEX IF NOT EXISTS "');
  else if (next.startsWith('CREATE INDEX "')) next = next.replace('CREATE INDEX "', 'CREATE INDEX IF NOT EXISTS "');
  out.push(next);
}
const text = out.join("\n");
const names = [...text.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g)].map((match) => match[1]);
const forbidden = ["profiles", "financial_accounts", "strategies", "strategy_versions", "strategy_recommendations", "automations"];
const hit = names.filter((name) => forbidden.includes(name));
if (hit.length) throw new Error(`Strata table collision: ${hit.join(",")}`);
if (/^(DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/im.test(text)) throw new Error("Generated SQL contains a data or drop statement");
const revoke = names.map((name) => `REVOKE ALL ON TABLE public."${name}" FROM anon, authenticated;`).join("\n");
const rls = names.map((name) => `ALTER TABLE public."${name}" ENABLE ROW LEVEL SECURITY;`).join("\n");
const header = `-- Reviewed release application schema.
-- Source: carrolldbrady-hub/btc-kalshi-v13 release/c52-53-brit
-- Commit: 03376f2cc125ed649858f19d9aa910e9ff9a57c8
-- Additive only. Creates no rows. Does not commission an account, write funding evidence,
-- or touch Supabase auth, storage, realtime, or existing Strata tables:
-- public.profiles, public.financial_accounts, public.strategies, public.strategy_versions,
-- public.strategy_recommendations, public.automations.
-- Empty V13 production tables are the expected result.
-- Row level security is enabled with no browser policies. The backend owner connection bypasses it.

`;
const footer = `
-- Browser roles cannot read or write the trading schema through the Data API.
${revoke}
${rls}
`;
const finalSql = header + text.trim() + "\n" + footer;
writeFileSync(sourcePath, finalSql);
writeFileSync(supabasePath, finalSql);
console.log(`tables ${names.length}`);
