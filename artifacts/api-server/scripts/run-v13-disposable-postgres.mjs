import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// Never read ambient DATABASE_URL, Kalshi secrets, or runtime account settings.
// A new cluster/database and credential-stripped child exist only for this run.
const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fullSuite = process.argv[2] === "--full-suite";
const user = fullSuite ? "postgres" : "v13_test";
const candidates = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/15/bin"];
if (existsSync("/nix/store")) candidates.push(...readdirSync("/nix/store")
  .filter(n => /-postgresql-16\./.test(n)).map(n => `/nix/store/${n}/bin`));
const bin = candidates.find(p => existsSync(join(p, "initdb")) && existsSync(join(p, "pg_ctl")));
if (!bin) throw new Error("PostgreSQL binaries required; no connected-database fallback exists");
const root = mkdtempSync(join(tmpdir(), "v13-disposable-"));
const server = createServer();
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(fullSuite ? 5432 : 0, "127.0.0.1", resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const db = fullSuite ? "v13_ci" : `v13_disposable_${Date.now()}`;
const url = `postgresql://${user}@127.0.0.1:${port}/${db}`;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
  PGOPTIONS: "-c statement_timeout=30000 -c lock_timeout=10000",
  MICRO_LIVE_TEST_TIMEOUT_MS: "45000",
  NODE_PATH: join(api, "node_modules"),
  DATABASE_URL: url, V13_DISPOSABLE_DATABASE_URL: url };
// Exercise the existing CI destination pin, never weaken it. Full-suite mode
// exclusively owns a NEW local postgres/v13_ci cluster on 5432, or fails.
if (fullSuite) { env.GITHUB_ACTIONS = "true"; env.CI = "true"; }
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: api, env, stdio: "inherit", timeout: fullSuite ? 600_000 : 180_000, ...options });
  if (r.status !== 0) throw new Error(`Disposable test command failed (${r.status}): ${command}`);
}
let started = false;
try {
  run(join(bin, "initdb"), ["-D", join(root, "data"), "-U", user, "--auth=trust", "--no-locale", "--encoding=UTF8", "--no-sync"]);
  run(join(bin, "pg_ctl"), ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-o",
    `-h 127.0.0.1 -p ${port} -k ${root}`, "-w", "start"]);
  started = true;
  run(join(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", user, db]);
  // Only the newly created cluster receives DDL. This is test setup, not a
  // migration runner, publish hook, or application startup behavior.
  run("pnpm", ["--filter", "@workspace/db", "exec", "drizzle-kit", "push", "--force"]);
  if (process.argv[2] === "--full-suite") {
    run("pnpm", ["run", "test:v13-safety-all"]);
  } else {
    const testFile = process.argv[2] ?? "src/lib/v13-production/acceptance.test.ts";
    run("pnpm", ["exec", "esbuild", testFile, "--bundle", "--platform=node", "--format=cjs",
    `--outfile=${root}/acceptance.cjs`, "--external:pg-native", "--external:pdfjs-dist",
    "--external:pdfjs-dist/*", "--external:pino", "--external:pino-pretty"]);
    run(process.execPath, ["--test", `${root}/acceptance.cjs`]);
  }
} finally {
  if (started) {
    const stopped = spawnSync(join(bin, "pg_ctl"), ["-D", join(root, "data"), "-m", "immediate", "-w", "stop"],
      { env, stdio: "inherit" });
    if (stopped.status !== 0) throw new Error("Disposable cluster cleanup failed");
  }
  rmSync(root, { recursive: true, force: true });
}
