import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// Never read ambient DATABASE_URL, Kalshi secrets, or runtime account settings.
// A new cluster/database and credential-stripped child exist only for this run.
const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recovery = process.argv[2] === "--recovery";
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
const db = fullSuite ? "v13_ci" : `${restore ? "restore" : recovery ? "recovery" : "v13"}_disposable_${Date.now()}`;
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
  // Avoid host timezone autodetection during initdb in restricted containers.
  TZ: "UTC", PGTZ: "UTC",
  NODE_OPTIONS: `--require=${fence}`,
  PGOPTIONS: "-c statement_timeout=30000 -c lock_timeout=10000",
  MICRO_LIVE_TEST_TIMEOUT_MS: "45000",
  NODE_PATH: join(api, "node_modules"),
  DATABASE_URL: url, V13_DISPOSABLE_DATABASE_URL: url,
  ...(recovery ? {V13_RECOVERY_DISPOSABLE_URL:url} : {}),
  ...(restore ? {V13_RESTORE_DISPOSABLE_URL:url} : {}) };
// Exercise the existing CI destination pin, never weaken it. Full-suite mode
// exclusively owns a NEW local postgres/v13_ci cluster on 5432, or fails.
if (fullSuite) { env.GITHUB_ACTIONS = "true"; env.CI = "true"; }
function run(command, args, options = {}) {
  const shell = process.platform === "win32" && /\.cmd$/i.test(command);
  const r = spawnSync(command, args, {
    cwd: api,
    env,
    stdio: "inherit",
    timeout: fullSuite ? 600_000 : 180_000,
    shell,
    ...options,
  });
  if (r.status !== 0) throw new Error(`Disposable test command failed (${r.status}): ${command}`);
}
let started = false;
try {
  run(executable(bin, "initdb"), ["-D", join(root, "data"), "-U", user, "--auth=trust", "--no-locale", "--encoding=UTF8", "--no-sync",
    "--set=shared_buffers=16MB"]);
  run(executable(bin, "pg_ctl"), ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-o",
    // Every test client is pinned to loopback TCP. Do not also require a Unix
    // socket, which restricted test containers may not permit creating.
    `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`, "-w", "start"]);
  started = true;
  run(executable(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", user, db]);
  // Only the newly created cluster receives DDL. This is test setup, not a
  // migration runner, publish hook, or application startup behavior.
  if (!recovery && !restore) run(process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@workspace/db", "exec", "drizzle-kit", "push", "--force"]);
  if (process.argv[2] === "--full-suite") {
    run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "test:v13-safety-all"]);
  } else {
    const testFile = restore ? "src/lib/strata/ownerShaRestore.postgres.test.ts" : recovery ? "src/lib/strata/ownerTransientFreezeRecovery.postgres.test.ts" : process.argv[2] ?? "src/lib/v13-production/acceptance.test.ts";
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
