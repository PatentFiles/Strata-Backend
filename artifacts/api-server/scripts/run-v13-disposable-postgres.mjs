import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// Never read ambient DATABASE_URL, Kalshi secrets, or runtime account settings.
// A new cluster/database and credential-stripped child exist only for this run.
const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rounding = process.argv[2] === "--rounding-authority";
const auditCursor = process.argv[2] === "--audit-cursor";
const renewal = process.argv[2] === "--renewal";
const recovery = ["--recovery","--settled-cash-recovery"].includes(process.argv[2]);
const stoppedCashDiagnostic = process.argv[2] === "--stopped-cash-diagnostic";
const liveHistory = process.argv[2] === "--live-decision-history";
const restore = process.argv[2] === "--restore";
const fullSuite = process.argv[2] === "--full-suite";
const user = fullSuite ? "postgres" : "v13_test";
const candidates = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
  "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/15/bin"];
const executable = (directory, name) => {
  const direct = join(directory, name);
  if (existsSync(direct)) return direct;
  const windows = `${direct}.exe`;
  return process.platform === "win32" && existsSync(windows) ? windows : null;
};
const available = p => executable(p, "initdb") !== null && executable(p, "pg_ctl") !== null;
// Prefer installed tools; enumerating a large Nix store can stall before initdb.
if (!candidates.some(available) && existsSync("/nix/store")) candidates.push(...readdirSync("/nix/store")
  .filter(n => /-postgresql-16\./.test(n)).map(n => `/nix/store/${n}/bin`));
const bin = candidates.find(available);
if (!bin) throw new Error("PostgreSQL binaries required; no connected-database fallback exists");
const root = mkdtempSync(join(tmpdir(), "v13-disposable-"));
const server = createServer();
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(fullSuite ? 5432 : 0, "127.0.0.1", resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const db = fullSuite ? "v13_ci" : `${renewal ? "renewal" : restore ? "restore" : recovery ? "recovery" : "v13"}_disposable_${Date.now()}`;
const url = `postgresql://${user}@127.0.0.1:${port}/${db}`;
const fence = join(root, "offline-network-fence.cjs");
writeFileSync(fence, `
const net = require("node:net");
const connect = net.Socket.prototype.connect;
const local = h => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(h);
net.Socket.prototype.connect = function(...args) {
  let o = args[0]; if (Array.isArray(o)) o = o[0];
  const host = (typeof o === "object" && o !== null ? o.host || o.hostname : null)
    || (typeof args[1] === "string" ? args[1] : "localhost");
  if (!local(host)) throw Error("offline_external_socket_denied");
  return connect.apply(this, args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  const u = new URL(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url);
  if (!local(u.hostname)) throw Error("offline_external_fetch_denied");
  return realFetch(...args);
};
`);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
  ...Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC']
    .filter(key=>process.env[key]).map(key=>[key,process.env[key]])),
  // Avoid host timezone autodetection during initdb in restricted containers.
  TZ: "UTC", PGTZ: "UTC",
  STRATA_FINAL_PUBLIC_METADATA_PREFETCH_ENABLED: process.env.STRATA_FINAL_PUBLIC_METADATA_PREFETCH_ENABLED,
  STRATA_PUBLIC_METADATA_PREFETCH_ENABLED: process.env.STRATA_PUBLIC_METADATA_PREFETCH_ENABLED,
  NODE_OPTIONS: `--require=${fence}`,
  PGOPTIONS: "-c statement_timeout=30000 -c lock_timeout=10000",
  MICRO_LIVE_TEST_TIMEOUT_MS: "45000",
  NODE_PATH: join(api, "node_modules"),
  DATABASE_URL: url, V13_DISPOSABLE_DATABASE_URL: url,
  ...(recovery ? {V13_RECOVERY_DISPOSABLE_URL:url} : {}),
  ...(restore ? {V13_RESTORE_DISPOSABLE_URL:url} : {}),
  ...(renewal ? {V13_RENEWAL_DISPOSABLE_URL:url} : {}) };
if(process.argv[2]==='src/lib/strata/directDispatchTimingReplay.postgres.test.ts'){
  const scenario=process.argv[3] ?? '';
  if(!/^(reviewed|durable)\/(serial|overlap|candidate|final_only)(\/(duplicate_latency|wire_expiry|protective_cycle|yes_1523|yes_1523_db|yes_1523_plan|yes_1523_work|yes_1523_lock|mismatch|revoked|wire_fee_deadline))?$/.test(scenario))
    throw Error('Unknown direct dispatch timing scenario');
  env.V13_DIRECT_TIMING_CASE=scenario;
}
// Exercise the existing CI destination pin, never weaken it. Full-suite mode
// exclusively owns a NEW local postgres/v13_ci cluster on 5432, or fails.
if (fullSuite) { env.GITHUB_ACTIONS = "true"; env.CI = "true"; }
function run(command, args, options = {}) {
  const timeout = options.timeout ?? (fullSuite ? 600_000 : 180_000);
  const shell = process.platform === "win32" && /\.cmd$/i.test(command);
  const startedAt = performance.now();
  const r = spawnSync(command, args, {
    cwd: api,
    env,
    stdio: "inherit",
    timeout,
    shell,
    windowsHide: true,
    ...options,
  });
  if (r.status !== 0) {
    if(command===executable(bin,'pg_ctl')&&existsSync(join(root,'postgres.log')))console.error(readFileSync(join(root,'postgres.log'),'utf8'));
    throw new Error(`Disposable test command failed (status=${r.status}, signal=${r.signal ?? "none"}, timedOut=${r.error?.code === "ETIMEDOUT"}, timeoutMs=${timeout}, elapsedMs=${Math.round(performance.now() - startedAt)}): ${command}`);
  }
}
console.info("ISOLATED_FINAL_OVERLAP_ENV",JSON.stringify({port,fullSuite,final:env.STRATA_FINAL_PUBLIC_METADATA_PREFETCH_ENABLED,older:env.STRATA_PUBLIC_METADATA_PREFETCH_ENABLED}));
let started = false;
try {
  run(executable(bin, "initdb"), ["-D", join(root, "data"), "-U", user, "--auth=trust", "--no-locale", "--encoding=UTF8", "--no-sync",
    "--set=shared_buffers=16MB"]);
  // Configuration avoids nested shell quoting differences in Windows pg_ctl.
  appendFileSync(join(root,'data','postgresql.conf'), "\nunix_socket_directories = ''\n");
  run(executable(bin, "pg_ctl"), ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-o",
    // Every test client is pinned to loopback TCP. Do not also require a Unix
    // socket, which restricted test containers may not permit creating.
    `-h 127.0.0.1 -p ${port}`, "-w", "start"]);
  started = true;
  run(executable(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", user, db]);
  // Only the newly created cluster receives DDL. This is test setup, not a
  // migration runner, publish hook, or application startup behavior.
  if (!rounding && !recovery && !restore && !renewal && !auditCursor && !stoppedCashDiagnostic && !liveHistory) run(process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@workspace/db", "exec", "drizzle-kit", "push", "--force"]);
  if (rounding) {
    run(process.execPath, ["scripts/direct-rounding-postgres.cjs"]);
  } else if (process.argv[2] === "--full-suite") {
    // This aggregates all safety groups; individual child/SQL/wire budgets remain unchanged.
    // Both workflow callers reserve additional setup and cleanup headroom.
    run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "test:v13-safety-all"], { timeout: 1_200_000 });
  } else {
    const testFile = liveHistory ? "src/lib/strata/liveHistoryReadModel.postgres.test.ts" : stoppedCashDiagnostic ? "src/lib/strata/stoppedCashDiagnosticLoader.postgres.test.ts" : auditCursor ? "src/lib/v13-production/signalAuditCursor.postgres.test.ts" : renewal ? "src/lib/strata/ownerNeverPostedReleaseRenewal.postgres.test.ts" : restore ? "src/lib/strata/ownerShaRestore.postgres.test.ts" : recovery ? (process.argv[2] === "--settled-cash-recovery" ? "src/lib/strata/ownerSettledCashFreezeRecovery.postgres.test.ts" : "src/lib/strata/ownerTransientFreezeRecovery.postgres.test.ts") : process.argv[2] ?? "src/lib/v13-production/acceptance.test.ts";
    run(process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["exec", "esbuild", testFile, "--bundle", "--platform=node", "--format=cjs",
    `--outfile=${root}/acceptance.cjs`, "--external:pg-native", "--external:pdfjs-dist",
    "--external:pdfjs-dist/*", "--external:pino", "--external:pino-pretty"]);
    run(process.execPath, ["--test", `${root}/acceptance.cjs`]);
  }
} finally {
  if (started) {
    const stopped = spawnSync(executable(bin, "pg_ctl"),
      ["-D", join(root, "data"), "-m", "immediate", "-w", "stop"],
      { env, stdio: "inherit" });
    if (stopped.status !== 0) throw new Error("Disposable cluster cleanup failed");
  }
  rmSync(root, { recursive: true, force: true });
}
