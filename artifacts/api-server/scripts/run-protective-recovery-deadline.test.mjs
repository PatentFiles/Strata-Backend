import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { childEnvironment, disposableTarget, networkFence, postgresBinaries, withDisposableCluster } from "./run-protective-recovery-deadline.mjs";

test("disposable target pins generated name, loopback and isolated user", () => {
  assert.equal(disposableTarget(32001, 123), "postgresql://v13_test@127.0.0.1:32001/protective_deadline_disposable_123");
  for (const port of [0, -1, 65536, NaN, 1.2, "5432"]) assert.throws(() => disposableTarget(port, 123));
  for (const stamp of [0, -1, NaN, "production"]) assert.throws(() => disposableTarget(32001, stamp));
});

test("children receive only allowlisted environment with no ambient credentials or runtime flags", () => {
  const env = childEnvironment({ path: "/test/bin", home: "/test/home", apiDirectory: "/test/api", fence: "/test/a b/fence.cjs" });
  assert.deepEqual(Object.keys(env).sort(), ["DATABASE_URL", "HOME", "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "PATH", "PGOPTIONS", "PGTZ", "TZ"].sort());
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.DATABASE_URL, "postgresql://offline:offline@127.0.0.1:1/offline");
  assert.equal(env.NODE_OPTIONS, '--require="/test/a b/fence.cjs"');
  const target = disposableTarget(32001, 123);
  const pg = childEnvironment({ path: "/test/bin", home: "/test/home", apiDirectory: "/test/api", fence: "/test/fence.cjs", target });
  assert.equal(pg.DATABASE_URL, target);assert.equal(pg.V13_PROTECTIVE_DEADLINE_DISPOSABLE_URL, target);
});

test("network fence admits only the generated PostgreSQL host and port, no HTTP or Unix sockets", () => {
  for (const port of [null, 32001]) {
    let connects = 0, exit;
    const net = { Socket: function() {} };
    net.Socket.prototype.connect = () => { connects++; };
    const process = { on: (_event, callback) => { exit = callback; } };
    const context = { require: name => { assert.equal(name, "node:net");return net; }, process, console: { log() {} } };
    runInNewContext(networkFence(port), context);
    const connect = (...args) => net.Socket.prototype.connect(...args);
    if (port !== null) {
      connect({ host: "127.0.0.1", port });connect(port, "127.0.0.1");connect([{ host: "127.0.0.1", port }]);
      assert.equal(connects, 3);
    }
    for (const target of [{ host: "127.0.0.1", port: 5432 }, { host: "example.com", port: 32001 },
      { host: "localhost", port: 32001 }, { path: "/tmp/postgres.sock" }, { port: 32001 }])
      assert.throws(() => connect(target), /network_forbidden/);
    if (port === null) assert.throws(() => connect({ host: "127.0.0.1", port: 32001 }), /network_forbidden/);
    assert.throws(() => context.fetch("https://example.com"), /network_forbidden/);
    exit();assert.equal(process.exitCode, 1);
  }
});

test("PostgreSQL tool discovery requires all three installed tools with no fallback", () => {
  assert.throws(() => postgresBinaries("/missing", () => false), /no connected-database fallback/);
  const bin = postgresBinaries("/test/pg", path => path.startsWith("/test/pg/"));
  assert.match(bin.initdb, /initdb(?:\.exe)?$/);assert.match(bin.createdb, /createdb(?:\.exe)?$/);
});

for (const failure of [null, "initdb", "start", "createdb", "test", "stop"]) {
  test(`cluster cleanup uses only its own target and handles ${failure ?? "success"} with mocks`, () => {
    const calls = [];let removed = false;
    const run = (command, args) => {
      const phase = command === "pg_ctl" ? args.at(-1) : command;
      calls.push({ phase, args });if (phase === failure) throw Error(`failed_${phase}`);
    };
    const execute = () => withDisposableCluster({ root: "/isolated/run", binaries: { initdb: "initdb", pg_ctl: "pg_ctl", createdb: "createdb" },
      port: 32001, database: "protective_deadline_disposable_123", run,
      test: () => { calls.push({ phase: "test" });if (failure === "test") throw Error("failed_test"); }, remove: () => { removed = true; } });
    if (failure) assert.throws(execute, new RegExp(`failed_${failure}`));else execute();
    assert.equal(removed, failure !== "stop");
    assert.equal(calls.some(call => call.phase === "stop"), failure !== "initdb");
    const start = calls.find(call => call.phase === "start");
    if (start) assert.ok(start.args.includes("-h 127.0.0.1 -p 32001 -c unix_socket_directories=''"));
    const create = calls.find(call => call.phase === "createdb");
    if (create) assert.deepEqual(create.args, ["-h", "127.0.0.1", "-p", "32001", "-U", "v13_test", "protective_deadline_disposable_123"]);
  });
}
