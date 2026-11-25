import test from "node:test";
import assert from "node:assert/strict";
import { verifyPersonalStartupAuthority } from "./personalStartupAuthority";
import { OWNER_SHA_STARTUP_RELEASE_SQL, PROTECTIVE_STARTUP_RELEASE_SQL } from "./protectiveExitStartupRelease";
import { CONTINUOUS_STARTUP_GRANT_SQL } from "./continuousExecutionAuthorization";

const owner = "11111111-1111-4111-8111-111111111111";
const releaseId = "22222222-2222-4222-8222-222222222222";
const sha = "a".repeat(40);
const env = { NODE_ENV: "production", RAILWAY_PROJECT_ID: "isolated-test",
  RAILWAY_GIT_COMMIT_SHA: sha, STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE: "true" };
function fixture(options: { approval?: boolean; legacy?: boolean; history?: boolean; grant?: boolean; failHistory?: boolean } = {}) {
  const calls: string[] = [];
  return { calls, query: async (sql: string, params?: unknown[]) => {
    calls.push(sql);
    if (sql === OWNER_SHA_STARTUP_RELEASE_SQL || sql === PROTECTIVE_STARTUP_RELEASE_SQL)
      assert.deepEqual(params, [sha, owner]);
    else assert.deepEqual(params, [owner, sha]);
    if (sql === OWNER_SHA_STARTUP_RELEASE_SQL) return { rows: options.approval ? [{ release_id: releaseId }] : [] };
    if (sql === PROTECTIVE_STARTUP_RELEASE_SQL) return { rows: options.legacy ? [{ release_id: releaseId }] : [] };
    if (sql === CONTINUOUS_STARTUP_GRANT_SQL) return { rows: options.grant ? [{ grant_id: releaseId }] : [] };
    if (sql.includes("SELECT grant_id FROM private.strata_continuous_execution_grants")) {
      if (options.failHistory) throw new Error("unavailable");
      return { rows: options.history ? [{ grant_id: releaseId }] : [] };
    }
    throw new Error("Unexpected query");
  }};
}

test("a release change cannot be mistaken for current owner approval", async () => {
  const db = fixture();
  assert.deepEqual(await verifyPersonalStartupAuthority(db, owner, env),
    { ok: false, reason: "owner_code_approval_missing" });
});
test("a stopped owner can repeat the same current standing authority check", async () => {
  const db = fixture({ approval: true, history: true, grant: true });
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await verifyPersonalStartupAuthority(db, owner, env),
      { ok: true, startupSha: sha, standingMode: true });
  assert.ok(db.calls.every(sql => /^\s*SELECT\b/i.test(sql)));
});
test("revoked standing authority cannot fall back to valid historical independent approval", async () => {
  const db = fixture({ approval: true, legacy: true, history: true, grant: false });
  assert.deepEqual(await verifyPersonalStartupAuthority(db, owner, env),
    { ok: false, reason: "standing_grant_not_current" });
});
test("standing authority query failure is fail-closed", async () => {
  assert.deepEqual(await verifyPersonalStartupAuthority(fixture({ approval: true, legacy: true, failHistory: true }), owner, env),
    { ok: false, reason: "standing_authority_unavailable" });
});
test("legacy exact release remains valid only when standing history is absent", async () => {
  assert.deepEqual(await verifyPersonalStartupAuthority(fixture({ approval: true, legacy: true }), owner, env),
    { ok: true, startupSha: sha, standingMode: false });
});
test("a current standing grant cannot override the signed exit feature gate", async () => {
  assert.deepEqual(await verifyPersonalStartupAuthority(fixture({ history: true, grant: true }), owner,
    { ...env, STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE: "false" }),
    { ok: false, reason: "protective_exit_release_disabled" });
});
