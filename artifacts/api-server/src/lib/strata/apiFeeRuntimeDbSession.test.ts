import test from "node:test";
import assert from "node:assert/strict";
import { inspectRuntimeDbSession, RUNTIME_DB_SESSION_SQL, SESSION_ADMIN_SQL, SESSION_RELATIONS, SESSION_QUERY_TIMEOUT_MS } from "./apiFeeRuntimeDbSession";
import { sanitizePublic } from "../v13-production/sanitize";
const admin = "22222222-2222-4222-8222-222222222222";
function validRow(): Record<string, unknown> {
  return {current_role: "postgres", session_role: "postgres", search_path: '"$user", public',
    replication_role: "origin", row_security: "on", superuser: true, bypass_rls: true, schema_usage: true,
    ...Object.fromEntries(SESSION_RELATIONS.flatMap((_, i) => ["exists", "select", "insert", "update"].map(p => [`relation_${i}_${p}`, true])))};
}
function harness(options: {allowed?: unknown; rows?: Array<Record<string, unknown>>; failAt?: number} = {}) {
  const queries: Array<{text: string; values?: unknown[]; query_timeout: number}> = [];
  const releases: boolean[] = [];
  let connects = 0;
  return {queries, releases, get connects() {return connects;}, db: {async connect() {
    connects++;
    return {async query(q: typeof queries[number]) {
      queries.push(q);
      if (queries.length === options.failAt) throw new Error("postgres://password=SECRET");
      return {rows: queries.length === 1 ? [{is_admin: options.allowed ?? true}] : options.rows ?? [validRow()]};
    }, release(destroy?: boolean) {releases.push(destroy ?? false);}};
  }}};
}
test("invalid subject never checks out; denied ADMIN never reads metadata", async () => {
  const invalid = harness();
  assert.equal((await inspectRuntimeDbSession("invalid", invalid.db)).ok, false);
  assert.equal(invalid.connects, 0);
  for (const allowed of [false, "true", 1]) {
    const h = harness({allowed});
    const result = await inspectRuntimeDbSession(admin, h.db);
    assert.equal(result.reason, "confirmed_administrator_required");
    assert.equal(h.queries.length, 1);
    assert.equal(h.queries[0]?.text, SESSION_ADMIN_SQL);
    assert.deepEqual(h.queries[0]?.values, [admin]);
    assert.deepEqual(h.releases, [false]);
    assert.equal("currentUser" in result, false);
  }
});
test("one checkout, bounded queries and allowlisted non-authorizing output", async () => {
  const h = harness({rows: [{...validRow(), password: "SECRET", arbitrary: "SECRET"}]});
  const result = await inspectRuntimeDbSession(admin, h.db);
  assert.equal(h.connects, 1);
  assert.deepEqual(h.queries.map(q => q.query_timeout), [SESSION_QUERY_TIMEOUT_MS, SESSION_QUERY_TIMEOUT_MS]);
  assert.equal(h.queries[1]?.text, RUNTIME_DB_SESSION_SQL);
  assert.equal(result.ok, true);
  assert.equal(result.policyApproved, false);
  assert.equal(result.commissioningApproved, false);
  assert.equal(result.tradingAuthorized, false);
  if (!result.ok) throw new Error("expected success");
  assert.deepEqual(result.tablePrivileges.map(p => p.relation), SESSION_RELATIONS);
  assert.equal(sanitizePublic(result).privateSchemaUsable, true);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.deepEqual(h.releases, [false]);
});
test("missing relations and denied privileges remain false, not readiness or authority", async () => {
  const row = validRow();
  row.schema_usage = false;
  for (const key of Object.keys(row)) if (key.startsWith("relation_")) row[key] = false;
  const result = await inspectRuntimeDbSession(admin, harness({rows: [row]}).db);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.tablePrivileges.every(p => p.exists === false && p.select === false && p.insert === false && p.update === false), true);
});
test("malformed output fails closed without echoing metadata", async () => {
  for (const rows of [[], [validRow(), validRow()], ...[
    {current_role: ""}, {session_role: 1}, {search_path: "x".repeat(4097)},
    {replication_role: "invalid"}, {row_security: "yes"}, {superuser: "true"},
    {relation_7_update: undefined}, {current_role: "bad\nrole"},
  ].map(patch => [{...validRow(), ...patch}])]) {
    const result = await inspectRuntimeDbSession(admin, harness({rows}).db);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "runtime_db_session_invalid");
    assert.equal("currentUser" in result, false);
  }
});
test("query errors and timeouts destroy checkout; connection errors are sanitized", async () => {
  for (const failAt of [1, 2]) {
    const h = harness({failAt});
    const result = await inspectRuntimeDbSession(admin, h.db);
    assert.equal(result.reason, "runtime_db_session_unavailable");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.deepEqual(h.releases, [true]);
  }
  const result = await inspectRuntimeDbSession(admin, {connect: async () => {throw new Error("SECRET");}});
  assert.equal(result.reason, "runtime_db_session_unavailable");
});
test("fixed metadata SQL has no application FROM/JOIN, fingerprint, writes or session changes", () => {
  assert.equal(SESSION_RELATIONS.length, 8);
  assert.equal(/\b(?:from|join)\s+(?:public|private|auth)\./i.test(RUNTIME_DB_SESSION_SQL), false);
  const withoutLiterals = RUNTIME_DB_SESSION_SQL.replace(/'[^']*'/g, "''");
  assert.equal(/\b(?:insert|update|delete|grant|create|alter|drop|set|set_config|string_agg|md5)\b/i.test(withoutLiterals), false);
  assert.equal((RUNTIME_DB_SESSION_SQL.match(/current_setting\(/g) ?? []).length, 3);
  assert.match(SESSION_ADMIN_SQL, /u\.email_confirmed_at IS NOT NULL AND r\.role='ADMIN'/);
});

test("cleanup errors cannot replace the sanitized response", async () => {
  const result = await inspectRuntimeDbSession(admin, {connect: async () => ({
    query: async () => ({rows: [{is_admin: false}]}),
    release: () => {throw new Error("SECRET");},
  })});
  assert.equal(result.reason, "confirmed_administrator_required");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});
