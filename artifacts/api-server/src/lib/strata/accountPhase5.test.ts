import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Pool } from "@workspace/db";
import type { AccountCommissioningPorts } from "./accountCommissioningContext";
import { accountCredentialControls } from "./accountCredentialControls";
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
import type { UserScopeQuery } from "./userScopeDatabase";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const FINANCIAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FINANCIAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("credential verification uses the caller key and rejects a mismatched fingerprint before any read", async () => {
  const generated = keyMaterial("restricted-user-key");
  const verifier = keyMaterial("verified-management-key");
  const material = { keyId: generated.apiKeyId, privateKey: generated.privateKey };
  const verifierMaterial = { keyId: verifier.apiKeyId, privateKey: verifier.privateKey };
  const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
  const verifierFingerprint = dedicatedSignerFingerprint(verifierMaterial.keyId, verifierMaterial.privateKey);
  assert.ok(fingerprint);
  assert.ok(verifierFingerprint);
  const verifierRecord = {
    api_key_id: verifierMaterial.keyId,
    subaccount: null,
    scopes: ["read"],
  };
  let calls = 0;
  const mismatched = await probeAccountCredential("restricted_execution", "ab".repeat(32), material, async () => {
    calls += 1;
    return {};
  });
  assert.equal(mismatched.reason, "credential_fingerprint_mismatch");
  assert.equal(calls, 0);
  const seen: Array<{ keyId: string; path: string }> = [];
  const authority = { expectedFingerprint: verifierFingerprint!, material: verifierMaterial };
  const verified = await probeAccountCredential("restricted_execution", fingerprint!, material, async (creds, path) => {
    calls += 1;
    seen.push({ keyId: creds.keyId, path });
    if (path.endsWith("/api_keys")) {
      return { api_keys: [
        verifierRecord,
        { api_key_id: material.keyId, subaccount: 1, scopes: ["read", "write::trade"] },
      ] };
    }
    if (path.endsWith("/subaccounts/balances")) {
      return { subaccount_balances: [
        { subaccount_number: 0, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
        { subaccount_number: 1, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
      ] };
    }
    return { balance_dollars: "12.3400", subaccount: 1, exchange_index: 2 };
  }, authority);
  assert.equal(verified.ok, true);
  assert.equal(verified.evidenceMicros, "12340000");
  assert.notEqual(verified.evidenceMicros, "25000000");
  assert.equal(JSON.stringify(verified).includes("BEGIN"), false);
  assert.deepEqual(seen, [
    { keyId: verifierMaterial.keyId, path: "/trade-api/v2/api_keys" },
    { keyId: verifierMaterial.keyId, path: "/trade-api/v2/portfolio/subaccounts/balances" },
    { keyId: material.keyId, path: "/trade-api/v2/portfolio/balance" },
  ]);
  const broad = await probeAccountCredential("restricted_execution", fingerprint!, material, async () => ({
    api_keys: [verifierRecord, { api_key_id: material.keyId, subaccount: 1, scopes: ["read", "write"] }],
  }), authority);
  assert.equal(broad.reason, "credential_permission_rejected");
  const unrestricted = await probeAccountCredential("restricted_execution", fingerprint!, material, async () => ({
    api_keys: [verifierRecord, { api_key_id: material.keyId, subaccount: null, scopes: ["read", "write::trade"] }],
  }), authority);
  assert.equal(unrestricted.reason, "restricted_key_not_bound_to_subaccount_1");
  assert.equal(unrestricted.nextRequirement, "generate_subaccount_1_restricted_key");
  const wrongSubaccount = await probeAccountCredential("restricted_execution", fingerprint!, material, async () => ({
    api_keys: [verifierRecord, { api_key_id: material.keyId, subaccount: 2, scopes: ["read", "write::trade"] }],
  }), authority);
  assert.equal(wrongSubaccount.reason, "account_target_pair_mismatch");
  const foreign = await probeAccountCredential("restricted_execution", fingerprint!, material, async () => ({
    api_keys: [verifierRecord, { api_key_id: "another-users-key", subaccount: 1, scopes: ["read", "write::trade"] }],
  }), authority);
  assert.equal(foreign.reason, "credential_permission_unproven");
  const restrictedVerifier = await probeAccountCredential("restricted_execution", fingerprint!, material, async () => ({
    api_keys: [
      { ...verifierRecord, subaccount: 1 },
      { api_key_id: material.keyId, subaccount: 1, scopes: ["read", "write::trade"] },
    ],
  }), authority);
  assert.equal(restrictedVerifier.reason, "verification_credential_not_authorized");
  const unavailableMetadata = await probeAccountCredential("restricted_execution", fingerprint!, material, async () => {
    throw new Error("network_unavailable");
  }, authority);
  assert.equal(unavailableMetadata.reason, "credential_metadata_unproven");
  assert.equal(unavailableMetadata.nextRequirement, null);
  const missingSubaccount = await probeAccountCredential("restricted_execution", fingerprint!, material, async (_creds, path) => {
    if (path.endsWith("/api_keys")) {
      return { api_keys: [
        verifierRecord,
        { api_key_id: material.keyId, subaccount: 1, scopes: ["read", "write::trade"] },
      ] };
    }
    return { subaccount_balances: [
      { subaccount_number: 0, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
    ] };
  }, authority);
  assert.equal(missingSubaccount.reason, "subaccount_1_missing");
  assert.equal(missingSubaccount.subaccount1Exists, false);
  assert.equal(missingSubaccount.nextRequirement, "create_subaccount_1");
  const source = readFileSync("src/lib/strata/accountCredentialProbe.ts", "utf8");
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("KALSHI_INDEX2"), false);
});

test("restricted verification uses each user's verified management credential", async () => {
  const fixture = credentialControlFixture();
  const calls: Array<{ keyId: string; path: string }> = [];
  const controls = accountCredentialControls(fixture.db, {
    async kalshiGet(creds, path) {
      calls.push({ keyId: creds.keyId, path });
      const user = fixture.users.find((item) =>
        item.verifier.apiKeyId === creds.keyId || item.restricted.apiKeyId === creds.keyId);
      assert.ok(user);
      if (path.endsWith("/api_keys")) {
        assert.equal(creds.keyId, user.verifier.apiKeyId);
        return {
          api_keys: [
            { api_key_id: user.verifier.apiKeyId, subaccount: null, scopes: ["read"] },
            {
              api_key_id: user.restricted.apiKeyId,
              subaccount: 1,
              scopes: ["read", "write::trade"],
            },
          ],
        };
      }
      if (path.endsWith("/subaccounts/balances")) {
        assert.equal(creds.keyId, user.verifier.apiKeyId);
        return { subaccount_balances: [
          { subaccount_number: 0, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
          { subaccount_number: 1, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
        ] };
      }
      assert.equal(path.endsWith("/portfolio/balance"), true);
      assert.equal(creds.keyId, user.restricted.apiKeyId);
      return { balance_dollars: "0.0000", subaccount: 1, exchange_index: 2 };
    },
  });
  const first = await controls.verifyCredential(USER_A, {
    role: "restricted_execution",
    confirmation: "VERIFY_ACCOUNT_CREDENTIAL",
  });
  const second = await controls.verifyCredential(USER_B, {
    role: "restricted_execution",
    confirmation: "VERIFY_ACCOUNT_CREDENTIAL",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal("nextRequirement" in first ? first.nextRequirement : null, "provision_execution_account");
  assert.equal("nextRequirement" in second ? second.nextRequirement : null, "provision_execution_account");
  for (const user of fixture.users) {
    assert.deepEqual(calls.filter((call) =>
      call.keyId === user.verifier.apiKeyId || call.keyId === user.restricted.apiKeyId), [
      { keyId: user.verifier.apiKeyId, path: "/trade-api/v2/api_keys" },
      { keyId: user.verifier.apiKeyId, path: "/trade-api/v2/portfolio/subaccounts/balances" },
      { keyId: user.restricted.apiKeyId, path: "/trade-api/v2/portfolio/balance" },
    ]);
  }
  assert.equal(calls.some((call) =>
    call.path.endsWith("/api_keys") &&
    fixture.users.some((user) => user.restricted.apiKeyId === call.keyId)), false);
  const status = await controls.commissioningStatus(USER_A);
  assert.equal(status.subaccount1Exists, true);
  assert.equal(status.subaccount1Exchange2Exists, true);
  assert.equal(status.subaccountEvidence, "kalshi_subaccount_balance_inventory");
  assert.equal(status.restrictedKeyMetadataVerified, true);
  assert.equal(status.restrictedKeyReadVerified, true);
  assert.equal(status.executionAccountExists, false);
  assert.equal(status.nextRequirement, "provision_execution_account");
  assert.equal(status.setupReason, "execution_account_not_provisioned");
  const callsBeforeForeignVerifier = calls.length;
  const verifierA = fixture.bindings.find((row) =>
    row.ownerUserId === USER_A && row.role === "verification");
  assert.ok(verifierA);
  verifierA.ownerUserId = USER_B;
  const refused = await controls.verifyCredential(USER_A, {
    role: "restricted_execution",
    confirmation: "VERIFY_ACCOUNT_CREDENTIAL",
  });
  assert.equal(refused.reason, "verified_verification_credential_required");
  assert.equal(calls.length, callsBeforeForeignVerifier);
});

test("verification authority rotation cannot mark the restricted key verified", async () => {
  const fixture = credentialControlFixture();
  const user = fixture.users[0]!;
  const controls = accountCredentialControls(fixture.db, {
    async kalshiGet(_creds, path) {
      if (path.endsWith("/api_keys")) {
        return { api_keys: [
          { api_key_id: user.verifier.apiKeyId, subaccount: null, scopes: ["read"] },
          {
            api_key_id: user.restricted.apiKeyId,
            subaccount: 1,
            scopes: ["read", "write::trade"],
          },
        ] };
      }
      if (path.endsWith("/subaccounts/balances")) {
        return { subaccount_balances: [
          { subaccount_number: 1, exchange_index: 2, balance: "0.0000", updated_ts: 1 },
        ] };
      }
      const verifier = fixture.bindings.find((row) =>
        row.ownerUserId === USER_A && row.role === "verification");
      assert.ok(verifier);
      verifier.verifiedAt = null;
      return { balance_dollars: "0.0000", subaccount: 1, exchange_index: 2 };
    },
  });
  const result = await controls.verifyCredential(USER_A, {
    role: "restricted_execution",
    confirmation: "VERIFY_ACCOUNT_CREDENTIAL",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verification_credential_rotated");
  assert.equal(fixture.bindings.find((row) =>
    row.ownerUserId === USER_A && row.role === "restricted_execution")?.verifiedAt, null);
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

function keyMaterial(apiKeyId = "phase5-user-key") {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    apiKeyId,
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

function credentialControlFixture() {
  const users = [
    {
      userId: USER_A,
      financialAccountId: FINANCIAL_A,
      connectionId: CONNECTION_A,
      verifier: keyMaterial("verifier-a"),
      restricted: keyMaterial("restricted-a"),
    },
    {
      userId: USER_B,
      financialAccountId: FINANCIAL_B,
      connectionId: CONNECTION_B,
      verifier: keyMaterial("verifier-b"),
      restricted: keyMaterial("restricted-b"),
    },
  ];
  const bindings = users.flatMap((user, userIndex) => [
    {
      id: `11111111-1111-4111-8111-${String(userIndex * 2 + 1).padStart(12, "0")}`,
      ownerUserId: user.userId,
      financialAccountId: user.financialAccountId,
      connectionId: user.connectionId,
      role: "verification",
      vaultSecretId: `22222222-2222-4222-8222-${String(userIndex * 2 + 1).padStart(12, "0")}`,
      fingerprint: dedicatedSignerFingerprint(user.verifier.apiKeyId, user.verifier.privateKey)!,
      verifiedAt: "2026-10-12T00:00:00.000Z",
    },
    {
      id: `11111111-1111-4111-8111-${String(userIndex * 2 + 2).padStart(12, "0")}`,
      ownerUserId: user.userId,
      financialAccountId: user.financialAccountId,
      connectionId: user.connectionId,
      role: "restricted_execution",
      vaultSecretId: `22222222-2222-4222-8222-${String(userIndex * 2 + 2).padStart(12, "0")}`,
      fingerprint: dedicatedSignerFingerprint(user.restricted.apiKeyId, user.restricted.privateKey)!,
      verifiedAt: null as string | null,
    },
  ]);
  const secrets = new Map(bindings.map((binding) => {
    const user = users.find((item) => item.userId === binding.ownerUserId)!;
    const material = binding.role === "verification" ? user.verifier : user.restricted;
    return [binding.vaultSecretId, JSON.stringify({
      api_key_id: material.apiKeyId,
      private_key: material.privateKey,
    })];
  }));
  const db: UserScopeQuery = {
    async query(text, params = []) {
      if (text.includes("to_regclass('private.kalshi_connection_credentials')")) {
        return { rows: [{ name: "private.kalshi_connection_credentials" }] };
      }
      if (text.includes("account-credential:verified-role-secret")) {
        const matches = bindings.filter((row) =>
          row.ownerUserId === params[0] && row.connectionId === params[1] &&
          row.role === params[2] && row.verifiedAt !== null);
        return { rows: matches.map((row) => ({
          credential_id: row.id,
          vault_secret_id: row.vaultSecretId,
          key_fingerprint: row.fingerprint,
          decrypted_secret: secrets.get(row.vaultSecretId),
        })) };
      }
      if (text.includes("account-credential:lock-role")) {
        const row = bindings.find((item) =>
          item.ownerUserId === params[0] && item.connectionId === params[1] && item.role === params[2]);
        return { rows: row ? [{
          id: row.id,
          vault_secret_id: row.vaultSecretId,
          key_fingerprint: row.fingerprint,
        }] : [] };
      }
      if (text.includes("account-credential:verify-record")) {
        const row = bindings.find((item) =>
          item.id === params[0] && item.ownerUserId === params[1] &&
          item.vaultSecretId === params[2] && item.fingerprint === params[3]);
        if (!row) return { rows: [] };
        row.verifiedAt = "2026-10-12T00:01:00.000Z";
        return { rows: [{ id: row.id }] };
      }
      if (text.includes("account-credential:list")) {
        return { rows: bindings.filter((item) =>
          item.ownerUserId === params[0] && item.connectionId === params[1]).map((item) => ({
          role: item.role,
          key_fingerprint: item.fingerprint,
          verified_at: item.verifiedAt,
          verification_reason: item.verifiedAt ? "credential_verified" : null,
          revoked_at: null,
        })) };
      }
      if (text.includes("FROM vault.decrypted_secrets")) {
        const row = bindings.find((item) =>
          item.vaultSecretId === params[0] && item.ownerUserId === params[1]);
        return { rows: row ? [{ decrypted_secret: secrets.get(row.vaultSecretId) }] : [] };
      }
      if (text.includes("SELECT fa.user_id::text AS authenticated_user_id")) {
        const user = users.find((item) => item.userId === params[0]);
        return { rows: user ? [{
          authenticated_user_id: user.userId,
          financial_account_id: user.financialAccountId,
          provider_connection_id: user.connectionId,
        }] : [] };
      }
      if (text.includes("SELECT c.role,")) {
        return { rows: bindings.filter((item) =>
          item.ownerUserId === params[0] && item.connectionId === params[1]).map((item) => ({
          role: item.role,
          provider_connection_id: item.connectionId,
          vault_secret_id: item.vaultSecretId,
          key_fingerprint: item.fingerprint,
        })) };
      }
      if (text.includes("FROM v13_production_account a")) return { rows: [] };
      return { rows: [] };
    },
  };
  return { db, users, bindings };
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

test("credential role probes preserve fractional-cent cash and retain pair and metadata guards",async()=>{
 const key=keyMaterial("subcent-restricted"), verifier=keyMaterial("subcent-verifier");
 const material={keyId:key.apiKeyId,privateKey:key.privateKey};
 const verification={keyId:verifier.apiKeyId,privateKey:verifier.privateKey};
 const fingerprint=dedicatedSignerFingerprint(material.keyId,material.privateKey)!;
 const authority={expectedFingerprint:dedicatedSignerFingerprint(verification.keyId,verification.privateKey)!,material:verification};
 for(const role of ["restricted_execution","verification_read"]){
   for(const [pair,expected] of [[{subaccount:1,exchange_index:2},true],[{subaccount:0,exchange_index:2},false],[{subaccount:1,exchange_index:1},false]] as const){
     const result=await probeAccountCredential(role,fingerprint,material,async(_creds,path)=>{
       if(path.endsWith("/api_keys"))return {api_keys:[{api_key_id:material.keyId,subaccount:1,scopes:["read","write::trade"]},{api_key_id:verification.keyId,subaccount:null,scopes:["read"]}]};
       if(path.endsWith("/subaccounts/balances"))return {subaccount_balances:[{subaccount_number:1,exchange_index:2,balance:"24.4825",updated_ts:1}]};
       return {...pair,balance_dollars:"24.4825",balance:2448};
     },authority);
     assert.equal(result.ok,expected,JSON.stringify(result));
     if(expected)assert.equal(result.evidenceMicros,"24482500");else assert.equal(result.reason,"account_target_pair_mismatch");
   }
 }
});
