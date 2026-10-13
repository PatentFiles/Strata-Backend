import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTE_SUBACCOUNT_CREATION_CONFIRMATION,
  executePreparedSubaccountCreation,
  type SubaccountCreationTransport,
} from "./accountSubaccountCreation";
import { inspectAccountSetupExecutionCredential } from "./accountCredentialProbe";
import type { CredentialClient, CredentialDatabase } from "./accountCredentialStore";
import { dedicatedSignerFingerprint } from "./commissioning";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createScopedKalshiSubaccountOne } from "../kalshiAccountClient";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CREDENTIAL_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CREDENTIAL_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";

test("successful creation is one simulated POST followed by inventory verification", async () => {
  const fixture = executionFixture();
  let posts = 0;
  const result = await executePreparedSubaccountCreation(
    fixture.db,
    executionInput(fixture.first, async () => {
      posts += 1;
      return { status: 201, body: { subaccount_number: 1 }, unreadable: false };
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, "subaccount_1_created_and_verified");
  assert.equal(result.attempted, true);
  assert.equal(result.state, "completed");
  assert.equal(posts, 1);
  assert.equal(fixture.first.state, "completed");
});

test("live transport fixes the official path, method, and exchange-index-2 body", async () => {
  const execution = keyMaterial("execution");
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ subaccount_number: 1 }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  const response = await createScopedKalshiSubaccountOne(
    execution.material,
    fetchImpl as typeof fetch,
  );
  assert.equal(response.status, 201);
  const request = requests[0];
  assert.ok(request);
  assert.match(request.url, /\/trade-api\/v2\/portfolio\/subaccounts$/);
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), { exchange_index: 2 });
});

test("a completed attempt and foreign ownership both prevent duplicate creation", async () => {
  const fixture = executionFixture({ twoUsers: true });
  let posts = 0;
  const transport: SubaccountCreationTransport = async () => {
    posts += 1;
    return { status: 201, body: { subaccount_number: 1 }, unreadable: false };
  };
  const first = await executePreparedSubaccountCreation(
    fixture.db,
    executionInput(fixture.first, transport),
  );
  const duplicate = await executePreparedSubaccountCreation(
    fixture.db,
    executionInput(fixture.first, transport),
  );
  const foreign = await executePreparedSubaccountCreation(fixture.db, {
    ...executionInput(fixture.first, transport),
    authenticatedUserId: USER_B,
    financialAccountId: ACCOUNT_B,
    providerConnectionId: CONNECTION_B,
    executionCredentialId: CREDENTIAL_B,
    executionFingerprint: fixture.second?.executionFingerprint ?? "",
  });
  assert.equal(first.ok, true);
  assert.equal(duplicate.reason, "subaccount_creation_already_completed");
  assert.equal(duplicate.attempted, false);
  assert.equal(foreign.reason, "owned_prepared_creation_attempt_missing");
  assert.equal(posts, 1);
});

test("wrong confirmation and fail-open master controls perform no exchange mutation", async () => {
  const wrong = executionFixture();
  let posts = 0;
  const transport: SubaccountCreationTransport = async () => {
    posts += 1;
    return { status: 201, body: { subaccount_number: 1 }, unreadable: false };
  };
  const rejected = await executePreparedSubaccountCreation(wrong.db, {
    ...executionInput(wrong.first, transport),
    confirmation: "wrong",
  });
  assert.equal(rejected.reason, "explicit_execution_authorization_required");
  assert.equal(wrong.reads, 0);

  const unsafe = executionFixture({ liveExecutionEnabled: true });
  const blocked = await executePreparedSubaccountCreation(
    unsafe.db,
    executionInput(unsafe.first, transport),
  );
  assert.equal(blocked.reason, "production_safety_controls_not_fail_closed");
  assert.equal(blocked.attempted, false);
  assert.equal(posts, 0);
});

test("network timeout and malformed success become durable uncertain no-retry states", async () => {
  const transports: SubaccountCreationTransport[] = [
    async (_material) => {
      throw new Error("timeout");
    },
    async (_material) => ({ status: 201, body: "{", unreadable: true }),
  ];
  for (const transport of transports) {
    const fixture = executionFixture();
    let calls = 0;
    const counted: SubaccountCreationTransport = async (material) => {
      calls += 1;
      return transport(material);
    };
    const first = await executePreparedSubaccountCreation(
      fixture.db,
      executionInput(fixture.first, counted),
    );
    const retry = await executePreparedSubaccountCreation(
      fixture.db,
      executionInput(fixture.first, counted),
    );
    assert.equal(first.reason, "subaccount_creation_outcome_uncertain_no_retry");
    assert.equal(first.state, "uncertain");
    assert.equal(retry.reason, "subaccount_creation_retry_blocked_uncertain");
    assert.equal(calls, 1);
  }
});

test("a changed inventory after 201 stays response-received and cannot retry", async () => {
  const fixture = executionFixture();
  let posts = 0;
  const input = executionInput(fixture.first, async () => {
    posts += 1;
    return { status: 201, body: { subaccount_number: 1 }, unreadable: false };
  });
  input.verifyCreated = async () => ({
    ok: false,
    reason: "subaccount_inventory_unproven",
    subaccount1Exists: null,
    subaccount1Exchange2Exists: null,
  });
  const first = await executePreparedSubaccountCreation(fixture.db, input);
  const retry = await executePreparedSubaccountCreation(fixture.db, input);
  assert.equal(first.reason, "creation_response_received_inventory_verification_required");
  assert.equal(first.state, "response_received");
  assert.equal(retry.reason, "subaccount_creation_retry_blocked_response_received");
  assert.equal(posts, 1);
});

test("execution metadata requires exact account-wide read and write permissions", async () => {
  const execution = keyMaterial("execution");
  const verification = keyMaterial("verification");
  const authority = {
    expectedFingerprint: verification.fingerprint,
    material: verification.material,
  };
  const inspect = (scopes: string[], subaccount: number | null) =>
    inspectAccountSetupExecutionCredential(
      execution.material.keyId,
      authority,
      async () => ({
        api_keys: [
          { api_key_id: verification.material.keyId, subaccount: null, scopes: ["read"] },
          { api_key_id: execution.material.keyId, subaccount, scopes },
        ],
      }),
    );
  assert.equal((await inspect(["read", "write"], null)).ok, true);
  assert.equal(
    (await inspect(["read"], null)).reason,
    "account_setup_execution_permission_rejected",
  );
  assert.equal(
    (await inspect(["read", "write"], 1)).reason,
    "account_setup_execution_must_be_unrestricted",
  );
});

interface Attempt {
  id: string;
  owner: string;
  account: string;
  connection: string;
  executionCredentialId: string;
  executionFingerprint: string;
  executionMaterial: { keyId: string; privateKey: string };
  state: "prepared" | "attempted" | "response_received" | "uncertain" | "completed";
  responseStatus: number | null;
}

function executionFixture(
  options: { twoUsers?: boolean; liveExecutionEnabled?: boolean; killSwitch?: boolean } = {},
) {
  const first = attempt(USER_A, ACCOUNT_A, CONNECTION_A, CREDENTIAL_A, "execution-a");
  const second = options.twoUsers
    ? attempt(USER_B, ACCOUNT_B, CONNECTION_B, CREDENTIAL_B, "execution-b")
    : undefined;
  const attempts = [first, ...(second ? [second] : [])];
  let reads = 0;
  const query: CredentialClient["query"] = async (sql, params = []) => {
    reads += 1;
    if (sql.includes("account-subaccount-creation:lock-attempt")) {
      const row = attempts.find((item) =>
        item.id === params[0] &&
        item.owner === params[1] &&
        item.account === params[2] &&
        item.connection === params[3] &&
        item.executionCredentialId === params[4] &&
        item.executionFingerprint === params[5]);
      return { rows: row ? [{
        attempt_id: row.id,
        state: row.state,
        plan: {
          operation: "create_subaccount",
          exchangePath: "/trade-api/v2/portfolio/subaccounts",
          method: "POST",
          request: { exchange_index: 2 },
          expectedSubaccount: 1,
        },
        execution_credential_id: row.executionCredentialId,
      }] : [] };
    }
    if (sql.includes("account-subaccount-creation:master-safety")) {
      return { rows: [{
        live_execution_enabled: options.liveExecutionEnabled ?? false,
        manual_kill_switch: options.killSwitch ?? true,
      }] };
    }
    const row = attempts.find((item) =>
      item.id === params[0] && item.owner === params[1] && item.connection === params[2]);
    if (sql.includes("account-subaccount-creation:mark-attempted")) {
      const claimed = attempts.find((item) =>
        item.id === params[0] && item.owner === params[1] &&
        item.account === params[2] && item.connection === params[3] &&
        item.state === "prepared");
      if (!claimed) return { rows: [] };
      claimed.state = "attempted";
      return { rows: [{ attempt_id: claimed.id, state: claimed.state }] };
    }
    if (!row) return { rows: [] };
    if (sql.includes("account-subaccount-creation:mark-uncertain") && row.state === "attempted") {
      row.state = "uncertain";
      row.responseStatus = typeof params[3] === "number" ? params[3] : null;
      return { rows: [{ attempt_id: row.id }] };
    }
    if (sql.includes("account-subaccount-creation:mark-response") && row.state === "attempted") {
      row.state = "response_received";
      row.responseStatus = Number(params[3]);
      return { rows: [{ attempt_id: row.id }] };
    }
    if (sql.includes("account-subaccount-creation:mark-completed") &&
        row.state === "response_received" && row.responseStatus === 201) {
      row.state = "completed";
      return { rows: [{ attempt_id: row.id }] };
    }
    return { rows: [] };
  };
  const db: CredentialDatabase = {
    query,
    async transaction(work) {
      return work({ query });
    },
  };
  return {
    db,
    first,
    second,
    get reads() {
      return reads;
    },
  };
}

function attempt(
  owner: string,
  account: string,
  connection: string,
  executionCredentialId: string,
  keyId: string,
): Attempt {
  const execution = keyMaterial(keyId);
  return {
    id: randomUUID(),
    owner,
    account,
    connection,
    executionCredentialId,
    executionFingerprint: execution.fingerprint,
    executionMaterial: execution.material,
    state: "prepared",
    responseStatus: null,
  };
}

function executionInput(
  row: Attempt,
  transport: SubaccountCreationTransport,
): Parameters<typeof executePreparedSubaccountCreation>[1] {
  return {
    authenticatedUserId: row.owner,
    financialAccountId: row.account,
    providerConnectionId: row.connection,
    attemptId: row.id,
    confirmation: EXECUTE_SUBACCOUNT_CREATION_CONFIRMATION,
    executionCredentialId: row.executionCredentialId,
    executionFingerprint: row.executionFingerprint,
    executionMaterial: row.executionMaterial,
    transport,
    async verifyCreated() {
      return {
        ok: true,
        reason: "subaccount_1_exists_on_exchange_index_2",
        subaccount1Exists: true,
        subaccount1Exchange2Exists: true,
      };
    },
  };
}

function keyMaterial(keyId: string) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const material = {
    keyId,
    privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
  const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
  assert.ok(fingerprint);
  return { material, fingerprint };
}
