import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const base = fileURLToPath(new URL("../", import.meta.url));
const dist = name => new URL("../dist/" + name, import.meta.url);
const marker = "STRATA_PROTECTIVE_HISTORY_DIAGNOSTIC_SHA";
const provenance = JSON.parse(readFileSync(dist("build-manifest.json"), "utf8"));
const previewPath = "/api/strata/me/release/protective-history-preview";
const expectedOrigin = "https://wallets.example.invalid";
const { outputFiles: [generated] } = await build({
  stdin: {
    contents: [
      'export * from "./src/lib/strata/protectiveHistoryRuntimeMode";',
      'export * from "./src/lib/strata/protectiveHistoryDiagnosticPolicy";',
      'export * from "./src/protectiveHistoryDiagnosticApp";',
    ].join("\n"), resolveDir: base, loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", write: false,
  external: ["express", "cors"],
});
const mod = { exports: {} };
new Function("module", "exports", "require", generated.text)(mod, mod.exports, require);
const { protectiveHistoryRuntimeMode, configuredDiagnosticOrigins, createProtectiveHistoryDiagnosticFetch,
  diagnosticJwksUrl, createProtectiveHistoryDiagnosticApp } = mod.exports;

test("new switch pins clean embedded and injected Git SHAs, otherwise refuses without normal fallback", () => {
  const sha = "a".repeat(40), clean = { revision: sha, tree: "c".repeat(40), dirty: false, provenance: "git-at-build" };
  const enabled = { [marker]: sha, RAILWAY_GIT_COMMIT_SHA: sha };
  assert.equal(protectiveHistoryRuntimeMode({}, null), "NORMAL");
  assert.equal(protectiveHistoryRuntimeMode(enabled, clean), "DIAGNOSTIC");
  for (const [env, stamp] of [
    [{ ...enabled, [marker]: "" }, clean], [{ ...enabled, [marker]: "false" }, clean],
    [{ [marker]: sha }, clean], [{ ...enabled, RAILWAY_GIT_COMMIT_SHA: "b".repeat(40) }, clean],
    [enabled, null], [enabled, { ...clean, dirty: true }], [enabled, { ...clean, tree: null }],
    [enabled, { ...clean, provenance: "provider-commit-at-build" }],
  ]) assert.equal(protectiveHistoryRuntimeMode(env, stamp), "REFUSE");
});

function simulatedHttp(app, method, path, headers={}) {
  return new Promise((resolve, reject) => {
    // Node request/response framing on a memory-only stream: no bound socket.
    const memory = new Duplex({ read() {}, write(_chunk, _enc, callback) { callback(); } });
    const req = new IncomingMessage(memory);
    req.method = method; req.url = path; req.headers = headers;
    req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req);
    res.assignSocket(memory);
    const pieces = [];
    const end = res.end;
    res.end = function(chunk, ...args) {
      if (chunk != null && typeof chunk !== "function") pieces.push(Buffer.from(chunk));
      const val = Reflect.apply(end, this, [chunk, ...args]);
      resolve({ status: this.statusCode, headers: this.getHeaders(),
        body: Buffer.concat(pieces).toString() });
      return val;
    };
    app(req, res, err => err ? reject(err) : reject(Error("diagnostic router was not terminal")));
  });
}

test("physical diagnostic app exposes exact health and AAL2 owner path only; preflights cannot mutate", async () => {
  let auth = 0, read = 0, enabled = true;
  const sha = "a".repeat(40);
  const app = createProtectiveHistoryDiagnosticApp({
    origins: configuredDiagnosticOrigins(expectedOrigin + ",http://bad.example.invalid"),
    buildSha: sha, enabled: () => enabled,
    requireOwner: (req, res, next) => {
      auth++;
      if (req.get("Authorization") !== "Bearer synthetic-owner-aal2") return res.status(401).end();
      next();
    },
    preview(_req, res) {
      read++;
      res.json({ order: "EXACT_TERMINAL", readOnly: true, accountingPosted: false, tradingAuthorized: false });
    },
  });
  const health = await simulatedHttp(app, "GET", "/api/healthz");
  assert.deepEqual(JSON.parse(health.body), { status: "ok", mode: "protective_history_diagnostic_only",
    deployedGitSha: sha, executionAuthority: "NONE" });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "TRACE"]) {
    for (const p of [previewPath, "/api/strata/me/arm", "/api/admin/index2-pair-funding"])
      assert.equal((await simulatedHttp(app, method, p)).status, 405);
  }
  for (const p of [previewPath + "?account=other", previewPath + "/", "/api/strata/me/arm",
    "/api/strata/me/wallet", "/api/strata/me/disarm", "/api/strata/me/release", "/api/admin/key-provisioning"])
    assert.equal((await simulatedHttp(app, "GET", p)).status, 404);
  assert.equal((await simulatedHttp(app, "GET", previewPath, { "content-length": "1" })).status, 400);
  assert.equal((await simulatedHttp(app, "GET", previewPath, { "transfer-encoding": "chunked" })).status, 400);
  assert.equal((await simulatedHttp(app, "GET", previewPath, { origin:"https://different.example.invalid" })).status, 403);
  const ok = { origin: expectedOrigin, "access-control-request-method": "GET",
    "access-control-request-headers": "authorization,x-strata-read-intent" };
  const preflight = await simulatedHttp(app, "OPTIONS", previewPath, ok);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-methods"], "GET");
  assert.equal((await simulatedHttp(app, "OPTIONS", previewPath, {
    ...ok, "access-control-request-method": "POST",
  })).status, 403);
  assert.equal((await simulatedHttp(app, "OPTIONS", previewPath, {
    ...ok, "access-control-request-headers": "authorization,transfer-encoding",
  })).status, 403);
  assert.equal(auth, 0); assert.equal(read, 0);
  assert.equal((await simulatedHttp(app, "GET", previewPath)).status, 401);
  const view = await simulatedHttp(app, "GET", previewPath, {
    origin: expectedOrigin, authorization: "Bearer synthetic-owner-aal2",
  });
  assert.equal(view.status, 200);
  assert.equal(view.headers["cache-control"], "private, no-store");
  assert.equal(JSON.parse(view.body).tradingAuthorized, false);
  enabled = false;
  assert.equal((await simulatedHttp(app, "GET", previewPath)).status, 503);
  assert.equal(auth, 2); assert.equal(read, 1);
});

test("diagnostic web egress admits only pinned issuer keys and specified scoped venue GETs; redirects and all writes blocked", async () => {
  const jwks = diagnosticJwksUrl("https://issuer.example.invalid/");
  const upstream = [];
  const fetch = createProtectiveHistoryDiagnosticFetch(jwks, async (url, init) => {
    upstream.push({ url: String(url), init });
    return new Response("{}");
  });
  const history = "https://external-api.kalshi.com/trade-api/v2/portfolio/orders?subaccount=1&exchange_index=2";
  await fetch(jwks);
  await fetch(history, { method: "GET" });
  assert.equal(upstream.length, 2);
  assert.ok(upstream.every(x => x.init.redirect === "error"));
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"])
    assert.throws(() => fetch(history, { method }), /egress_forbidden/);
  for (const endpoint of [
    history.replace("/orders?", "/orders/specific?"), history.replace("subaccount=1", "subaccount=0"),
    history + "&exchange_index=2", history.replace("external-api.kalshi.com", "uncertain.example.invalid"),
    history.replace("/orders?", "/transfers?"), jwks.href + "?secret=foo",
  ]) assert.throws(() => fetch(endpoint), /egress_forbidden/);
  assert.equal(upstream.length, 2);
});

test("compiled diagnostic switch refuses mutation-capable bundles and does not start observers or external I/O", () => {
  assert.match(provenance.revision ?? "", /^[a-f0-9]{40}$/);
  assert.equal(provenance.dirty, false);
  const normal = readFileSync(dist("normalApiMain.mjs"), "utf8");
  const diagnostic = readFileSync(dist("protectiveHistoryDiagnosticMain.mjs"), "utf8");
  const boot = readFileSync(dist("index.mjs"), "utf8");
  for (const name of ["startAutoSweepWorker", "startForwardTestWorker", "startShadowObserver",
    "dispatchReviewedProtectiveExitOnce", "ProductionWorker", "v13DevelopmentStagingMiddleware",
    "createUserExecutionRouter", "createPairFundingRouter", "startOwnerIndependentFeeV5Collector"]) {
    assert.equal(diagnostic.includes(name), false, name + " reached diagnostic bundle");
    assert.equal(boot.includes(name), false, name + " reached bootstrap");
  }
  assert.match(normal, /startAutoSweepWorker/);
  const preload = `
    import http from "node:http";
    import net from "node:net";
    net.Socket.prototype.connect = () => { throw Error("qualification_external_socket"); };
    globalThis.fetch = () => { throw Error("qualification_external_fetch"); };
    globalThis.setInterval = () => { throw Error("qualification_worker_timer"); };
    http.Server.prototype.listen = function () {
      console.log("TEST_LISTENER_REACHED_WITHOUT_NETWORK");
      // Never bind. Diagnostic boot returns adding only local close handlers.
      return this;
    };
  `;
  function bootResult(name, env) {
    return spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
      fileURLToPath(dist(name))], {
      env: { NODE_ENV: "production", PORT: "43219", SUPABASE_URL: "https://issuer.example.invalid",
        DATABASE_URL: "postgresql://fixture@127.0.0.1:1/no_account", ...env },
      encoding: "utf8", timeout: 5000,
    });
  }
  const sha = provenance.revision;
  for (const [entry, env] of [
    ["index.mjs", { [marker]: "a".repeat(40), RAILWAY_GIT_COMMIT_SHA: sha }],
    ["index.mjs", { [marker]: sha }],
    ["protectiveHistoryDiagnosticMain.mjs", {}],
    ["normalApiMain.mjs", { [marker]: sha, RAILWAY_GIT_COMMIT_SHA: sha }],
    ["paperWorkerMain.mjs", { [marker]: sha, RAILWAY_GIT_COMMIT_SHA: sha }],
  ]) {
    const r = bootResult(entry, env);
    assert.equal(r.error, undefined);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /protective_history_diagnostic_(?:build_mismatch|normal_runtime_forbidden)/);
    assert.doesNotMatch(r.stdout, /TEST_LISTENER/);
    assert.doesNotMatch(r.stderr, /qualification_worker_timer|qualification_external/);
  }
  const positive = bootResult("index.mjs", { [marker]: sha, RAILWAY_GIT_COMMIT_SHA: sha });
  assert.equal(positive.error, undefined);
  assert.equal(positive.status, 0, positive.stderr);
  assert.match(positive.stdout, /TEST_LISTENER_REACHED_WITHOUT_NETWORK/);
  assert.equal(positive.stderr, "");
});
