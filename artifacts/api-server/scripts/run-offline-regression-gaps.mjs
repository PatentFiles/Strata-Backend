import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// These existing unit/localhost-route regressions were not reachable from CI.
// Run without inherited database URLs, exchange credentials, or runtime flags.
const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "strata-offline-regressions-"));
const stub = join(root, "database-stub.ts");
const fence = join(root, "network-fence.cjs");
const tests = [
  "src/lib/generatePairRestrictedKalshiKey.test.ts",
  "src/lib/microLiveBoundedRunTransition.test.ts",
  "src/lib/microLiveFeeCap.test.ts",
  "src/lib/microLiveFillNormalization.test.ts",
  "src/lib/microLiveOwnership.test.ts",
  "src/lib/microLivePairBoundary.test.ts",
  "src/lib/microLivePosition.test.ts",
  "src/lib/microLivePrimaryCashAccounting.test.ts",
  "src/lib/microLiveRecovery.test.ts",
  "src/lib/microLiveSettlement.test.ts",
  "src/lib/microLiveSubaccountCreation.test.ts",
  "src/lib/readOnlyAnalyticsCache.test.ts",
  "src/lib/strata/effectiveOwnerStake.test.ts",
  "src/lib/strata/kalshiBalanceQuotaSaturation.test.ts",
  "src/lib/strata/walletV4FinalSignedAdmission.test.ts",
  "src/routes/keyProvisioning.test.ts",
  "../btc-paper-dashboard/src/components/stale-accounting-resolution.test.ts",
];
writeFileSync(stub, `
export * from ${JSON.stringify(join(api, "../../lib/db/src/schema/index.ts"))};
const blocked = () => { throw Error("offline_regression_database_io_forbidden"); };
export const pool = { query: blocked, connect: blocked, end: async () => {} };
export const db = new Proxy({}, { get: blocked });
`);
writeFileSync(fence, `
const net = require("node:net");
const connect = net.Socket.prototype.connect;
const local = host => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host);
net.Socket.prototype.connect = function (...args) {
  let options = args[0]; if (Array.isArray(options)) options = options[0];
  const host = (typeof options === "object" && options !== null ? options.host || options.hostname : null)
    || (typeof args[1] === "string" ? args[1] : "localhost");
  if (!local(host)) throw Error("offline_regression_external_socket_forbidden");
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  const url = new URL(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url);
  if (!local(url.hostname)) throw Error("offline_regression_external_fetch_forbidden");
  return fetch(...args);
};
`);
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", TZ: "UTC",
  NODE_PATH: join(api, "node_modules"), NODE_OPTIONS: `--require=${fence}`,
};
function run(command, args) {
  const result = spawnSync(command, args, { cwd: api, env, stdio: "inherit", timeout: 180_000 });
  if (result.status !== 0) throw Error(`Offline regression command failed (${result.status}): ${command}`);
}
try {
  // Each basename is unique; separate output files preserve test isolation.
  for (const path of tests) run(join(api, "node_modules/.bin/esbuild"), [
    path, "--bundle", "--platform=node", "--format=cjs", `--outdir=${root}/out`,
    // Preserve source-relative fixture reads in CommonJS test bundles.
    `--define:import.meta.url=${JSON.stringify(pathToFileURL(resolve(api, path)).href)}`,
    "--entry-names=[name]", "--out-extension:.js=.cjs", `--alias:@workspace/db=${stub}`,
    `--alias:@workspace/db/schema=${join(api, "../../lib/db/src/schema/index.ts")}`,
    `--alias:@workspace/db/pool-checkout-timing=${join(api, "../../lib/db/src/poolCheckoutTiming.ts")}`,
    "--external:pg-native", "--external:pdfjs-dist", "--external:pdfjs-dist/*",
    "--external:pino", "--external:pino-pretty", "--external:express", "--external:@clerk/express",
  ]);
  run(process.execPath, ["--test", ...tests.map(path => join(root, "out", path.split("/").at(-1).replace(/\.ts$/, ".cjs")))]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
