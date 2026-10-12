import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Pool } from "@workspace/db";
import type { AccountCommissioningPorts } from "./accountCommissioningContext";
import { dedicatedSignerFingerprint } from "./commissioning";
import { probeAccountCredential } from "./accountCredentialProbe";
import {
  persistAccountFundingAuthorization,
  persistAccountFundingEvidence,
} from "./accountFunding";
import type { CredentialClient, CredentialDatabase } from "./accountCredentialStore";
import {
  accountDispatchDecision,
  bindAccountProductionWorker,
  scheduleAccountEntries,
  type AccountDispatchState,
} from "./accountProductionSession";
import { userCommissioningReadiness } from "./accountCredentialLifecycle";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const FINANCIAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FINANCIAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("credential verification uses the caller key and rejects a mismatched fingerprint before any read", async () => {
  const generated = keyMaterial();
  const material = { keyId: generated.apiKeyId, privateKey: generated.privateKey };
  const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
  assert.ok(fingerprint);
  let calls = 0;
  const mismatched = await probeAccountCredential("restricted_execution", "ab".repeat(32), material, async () => {
    calls += 1;
    return {};
  });
  assert.equal(mismatched.reason, "credential_fingerprint_mismatch");
  assert.equal(calls, 0);
  const verified = await probeAccountCredential("restricted_execution", fingerprint!, material, async (_creds, path) => {
    calls += 1;
    if (path.endsWith("/api_keys")) {
      return { api_keys: [{ api_key_id: material.keyId, subaccount: 1, scopes: ["read", "write::trade"] }] };
    }
    return { balance_dollars: "12.3400", subaccount: 1, exchange_index: 2 };
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.evidenceMicros, "12340000");
  assert.notEqual(verified.evidenceMicros, "25000000");
  assert.equal(JSON.stringify(verified).includes("BEGIN"), false);
  const broad = await probeAccountCredential("restricted_execution", fingerprint!, material, async () => ({
    api_keys: [{ api_key_id: material.keyId, subaccount: 1, scopes: ["read", "write"] }],
  }));
  assert.equal(broad.reason, "credential_permission_rejected");
  const source = readFileSync("src/lib/strata/accountCredentialProbe.ts", "utf8");
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("KALSHI_INDEX2"), false);
});

test("funding authorization is per user and does not transfer", async () => {
  const db = fundingDb();
  const authorized = await persistAccountFundingAuthorization(db, ports(), {
    authenticatedUserId: USER_A,
    confirmation: "AUTHORIZE_ACCOUNT_FUNDING",
    authorizedMicros: "1000000",
    liveExecutionEnabled: "false",
    v13ProductionExecutionEnabled: "false",
  });
  const other = await persistAccountFundingAuthorization(db, ports(), {
    authenticatedUserId: USER_B,
    confirmation: "AUTHORIZE_ACCOUNT_FUNDING",
    authorizedMicros: "2000000",
  });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.transferAttempted, false);
  assert.equal(other.authorizedMicros, "2000000");
  const skipped = await persistAccountFundingEvidence(db, ports(), {
    authenticatedUserId: USER_A,
    confirmation: "no",
    evidenceMicros: "1000000",
    evidenceSource: "kalshi_balance",
  });
  assert.equal(skipped.reason, "explicit_authorization_required");
  assert.equal(db.rows[0]?.evidenceMicros, null);
  const mismatch = await persistAccountFundingEvidence(db, ports(), {
    authenticatedUserId: USER_A,
    confirmation: "RECORD_ACCOUNT_FUNDING_EVIDENCE",
    evidenceMicros: "25000000",
    evidenceSource: "kalshi_balance",
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "account_funding_evidence_mismatch");
  assert.equal(mismatch.transferAttempted, false);
  const readiness = userCommissioningReadiness({
    roles: [{ role: "restricted_execution", fingerprint: "ab".repeat(32), verified: true, revoked: false, verificationReason: null }],
    authorizedMicros: mismatch.authorizedMicros,
    evidenceMicros: mismatch.evidenceMicros,
    subaccount: 1,
    exchangeIndex: 2,
    policyOwned: true,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.executable, false);
  const migration = readFileSync("../../lib/db/drizzle/0014_kalshi_account_funding.sql", "utf8");
  assert.match(migration, /REVIEW ONLY/);
  assert.match(migration, /DROP TABLE IF EXISTS private\.kalshi_account_funding/);
  assert.equal(migration.includes("25000000"), false);
  assert.equal(migration.includes("decrypted_secret"), false);
});

test("the per-user worker binds the existing executor and does not start live entries", async () => {
  const pool = unusedPool();
  const first = bindAccountProductionWorker({
    pool,
    ownerUserId: USER_A,
    executionAccountId: "acct-a",
    credentialFingerprint: "ab".repeat(32),
    state: dispatchState(USER_A, "ab".repeat(32)),
  });
  const second = bindAccountProductionWorker({
    pool,
    ownerUserId: USER_B,
    executionAccountId: "acct-b",
    credentialFingerprint: "cd".repeat(32),
    state: dispatchState(USER_B, "cd".repeat(32)),
  });
  assert.equal(first.executor.ledger.accountId, "acct-a");
  assert.equal(second.executor.ledger.accountId, "acct-b");
  assert.equal(first.worker.isScheduled(), false);
  assert.equal(second.worker.isScheduled(), false);
  assert.equal(first.workerStarted, false);
  assert.equal(first.executionActive, false);
  assert.equal(scheduleAccountEntries().reason, "operation_not_enabled");
  const stale = dispatchState(USER_A, "ab".repeat(32));
  stale.presentedToken = 1;
  stale.workerActuallyScheduled = true;
  assert.equal(accountDispatchDecision(stale).reason, "stale_worker_fence");
  const killed = dispatchState(USER_A, "ab".repeat(32));
  killed.accountKill = true;
  killed.workerActuallyScheduled = true;
  assert.equal(accountDispatchDecision(killed).reason, "account_kill_switch");
  const uncertain = dispatchState(USER_A, "ab".repeat(32));
  uncertain.workerActuallyScheduled = true;
  uncertain.uncertainOrderCount = 1;
  assert.equal(accountDispatchDecision(uncertain).reason, "production_uncertain_order_blocks_mutation");
  const armed = dispatchState(USER_A, "ab".repeat(32));
  armed.workerActuallyScheduled = true;
  assert.equal(accountDispatchDecision(armed).reason, "operation_not_enabled");
  await assert.rejects(() => first.exchange.submit({} as never, async () => {}), /worker_not_started/);
  assert.equal(first.exchange.submitAttempts, 1);
  const session = readFileSync("src/lib/strata/accountProductionSession.ts", "utf8");
  assert.equal(session.includes("process.env"), false);
  assert.equal(session.includes("KALSHI_INDEX2"), false);
  assert.equal(session.includes("KalshiProductionExchange"), false);
});

function keyMaterial() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    apiKeyId: "phase5-user-key",
    privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
}

function dispatchState(owner: string, fingerprint: string): AccountDispatchState {
  return {
    leaseState: "owned",
    armRequested: true,
    accountKill: false,
    globalKill: false,
    fencingToken: 2,
    presentedToken: 2,
    workerActuallyScheduled: false,
    authenticatedUserId: owner,
    ownerUserId: owner,
    credentialFingerprint: fingerprint,
    presentedFingerprint: fingerprint,
    uncertainOrderCount: 0,
    duplicateClientOrder: false,
  };
}

function unusedPool(): Pool {
  return {
    query: async () => { throw new Error("pool_not_used"); },
    connect: async () => { throw new Error("pool_not_used"); },
  } as unknown as Pool;
}

function ports(): AccountCommissioningPorts {
  return {
    async listOwnedConnections(userId) {
      if (userId === USER_A) return [{ authenticatedUserId: USER_A, financialAccountId: FINANCIAL_A, providerConnectionId: CONNECTION_A }];
      if (userId === USER_B) return [{ authenticatedUserId: USER_B, financialAccountId: FINANCIAL_B, providerConnectionId: CONNECTION_B }];
      return [];
    },
    async listCredentialRefs() { return []; },
    async readExecutionTarget() { return null; },
    async readSnapshot() { throw new Error("snapshot_not_used"); },
    async openCredential() { throw new Error("vault_not_opened"); },
  };
}

function fundingDb(): CredentialDatabase & { rows: Array<{ owner: string; authorized: string; evidenceMicros: string | null }> } {
  const rows: Array<{ id: string; owner: string; connection: string; authorized: string; evidenceMicros: string | null; revoked: boolean }> = [];
  let sequence = 0;
  const query: CredentialClient["query"] = async (text, params = []) => {
    if (text.includes("account-funding:revoke")) {
      for (const row of rows) {
        if (row.owner === params[0] && row.connection === params[1] && !row.revoked) row.revoked = true;
      }
      return { rows: [] };
    }
    if (text.includes("account-funding:insert")) {
      const id = `funding-${++sequence}`;
      rows.push({
        id,
        owner: String(params[0]),
        connection: String(params[2]),
        authorized: String(params[3]),
        evidenceMicros: null,
        revoked: false,
      });
      return { rows: [{ id, authorized_micros: String(params[3]) }] };
    }
    if (text.includes("account-funding:lock") || text.includes("account-funding:read")) {
      const row = rows.find((item) => item.owner === params[0] && item.connection === params[1] && !item.revoked);
      return { rows: row ? [{ id: row.id, authorized_micros: row.authorized, evidence_micros: row.evidenceMicros }] : [] };
    }
    if (text.includes("account-funding:evidence")) {
      const row = rows.find((item) => item.id === params[0] && item.owner === params[1] && !item.revoked && item.evidenceMicros === null);
      if (!row) return { rows: [] };
      row.evidenceMicros = String(params[2]);
      return { rows: [{ authorized_micros: row.authorized, evidence_micros: row.evidenceMicros }] };
    }
    return { rows: [] };
  };
  return {
    rows,
    query,
    async transaction(work) { return work({ query }); },
  };
}
