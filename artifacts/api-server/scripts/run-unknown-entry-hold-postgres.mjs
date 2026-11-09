/** Bounded, Unix-socket-only analytics integration tests. Never reuse a database. */
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { cleanupOwnedAnalyticsPostgres } from "./unknownEntryRecoveryPostgresLifecycle.mjs";

const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [process.env.ANALYTICS_TEST_PG_BIN,
  ...(process.env.PATH ?? "").split(delimiter),
  "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/15/bin",
].filter(Boolean);
const bin = candidates.find(path => ["initdb", "pg_ctl", "createdb"].every(name => existsSync(join(path, name))));
if (!bin) throw new Error("Local PostgreSQL binaries required; there is no existing-database fallback");
const root = mkdtempSync(join(tmpdir(), "strata-analytics-pg-"));
const socket = join(root, "socket"), data = join(root, "data");
mkdirSync(socket, { mode: 0o700 });
const nonce = randomUUID(), database = "analytics_drain", user = "analytics_test";
writeFileSync(join(root, "owned-cluster.json"), JSON.stringify({ nonce, database, user, socket }));
const url = `postgresql:///${database}?host=${encodeURIComponent(socket)}&user=${user}`;
const fence = join(root, "unix-socket-only.cjs");
writeFileSync(fence, `
const net = require('node:net');
const allowed = ${JSON.stringify(join(socket, ".s.PGSQL.5432"))};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  let arg = args[0]; if (Array.isArray(arg)) arg = arg[0];
  const path = typeof arg === 'string' ? arg : arg && arg.path;
  if (path !== allowed) throw new Error('analytics_test_non_owned_socket_denied');
  return connect.apply(this, args);
};
globalThis.fetch = () => { throw new Error('analytics_test_fetch_denied'); };
`);
// This allowlist deliberately ignores ambient credentials, DATABASE_URL and PG*.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: "UTC", PGTZ: "UTC",
  NODE_ENV: "test", NODE_OPTIONS: `--require=${fence}`, PGAPPNAME: "analytics-aggregate",
  DATABASE_URL: url, ANALYTICS_DISPOSABLE_URL: url, ANALYTICS_DISPOSABLE_ROOT: root,
  ANALYTICS_DISPOSABLE_SOCKET: socket, ANALYTICS_DISPOSABLE_NONCE: nonce };
function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, { cwd: api, env, stdio: "inherit", timeout });
  if (result.status !== 0) throw new Error(`Analytics disposable command failed: ${command} (${result.status}, ${result.error?.message ?? "no spawn error"})`);
}
let cleaned = false, startup = "not_attempted";
function cleanup() {
  if (cleaned) return;
  try { cleanupOwnedAnalyticsPostgres({ startup,
    hasPid: () => existsSync(join(data, "postmaster.pid")),
    status: () => spawnSync(join(bin, "pg_ctl"), ["-D", data, "status"], { env, encoding: "utf8", timeout: 5_000 }).status,
    stop: () => spawnSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "-t", "15", "stop"],
      { env, stdio: "inherit", timeout: 20_000 }).status,
    remove: () => rmSync(root, { recursive: true, force: true }),
  }); } catch (cause) {
    throw new Error(`Analytics cleanup unresolved; retained owned cluster directory ${root}`, { cause });
  }
  cleaned = true;
  console.info("ANALYTICS_DISPOSABLE_CLEANUP", JSON.stringify({ clusterStopped: true, rootRemoved: !existsSync(root), unixSocketOnly: true }));
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup(); process.exit(1); });
try {
  await build({ entryPoints: [join(api, "src/lib/strata/unknownEntryRecoveryHold.postgres.test.ts")],
    bundle: true, platform: "node", format: "cjs", outfile: join(root, "analytics.test.cjs"), external: ["pg-native"] });
  run(join(bin, "initdb"), ["-D", data, "-U", user, "--auth=trust", "--no-locale", "--encoding=UTF8", "--no-sync",
    "--set=shared_buffers=16MB"]);
  startup = "uncertain";
  run(join(bin, "pg_ctl"), ["-D", data, "-l", join(root, "postgres.log"), "-o",
    `-h '' -p 5432 -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c max_connections=12 -c statement_timeout=8000 -c lock_timeout=7000 -c idle_in_transaction_session_timeout=15000`,
    "-w", "-t", "15", "start"]);
  startup = "started";
  run(join(bin, "createdb"), ["-h", socket, "-p", "5432", "-U", user, database]);
  console.info("ANALYTICS_DISPOSABLE_START", JSON.stringify({ socketOnly: true, database, statementTimeoutMs: 8000, lockTimeoutMs: 7000, maxConnections: 12 }));
  run(process.execPath, ["--unhandled-rejections=strict", "--test", join(root, "analytics.test.cjs")], 90_000);
} catch (error) {
  if (existsSync(join(root, "postgres.log"))) console.error(readFileSync(join(root, "postgres.log"), "utf8"));
  throw error;
} finally {
  cleanup();
}
