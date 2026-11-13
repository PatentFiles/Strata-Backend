import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createMicroLiveSubaccountCreationService,
  type CreationAttemptRecord,
  type CreationAttemptStore,
  type CreationFetch,
} from "./microLiveSubaccountCreation";

const oldEnvironment = new Map(
  ["NODE_ENV", "REPLIT_DEPLOYMENT", "KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED",
    "KALSHI_API_ENVIRONMENT", "KALSHI_KEY_PROVISIONING_ENABLED",
    "KALSHI_KEY_GENERATION_AUTHORIZED", "KALSHI_PROVISIONING_API_KEY_ID",
    "KALSHI_PROVISIONING_PRIVATE_KEY", "KALSHI_API_KEY_ID", "KALSHI_API_PRIVATE_KEY"]
    .map((key) => [key, process.env[key]]),
);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test.beforeEach(() => {
  process.env.NODE_ENV = "development";
  delete process.env.REPLIT_DEPLOYMENT;
  process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED = "true";
  process.env.KALSHI_API_ENVIRONMENT = "production";
  process.env.KALSHI_KEY_PROVISIONING_ENABLED = "true";
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
  process.env.KALSHI_PROVISIONING_API_KEY_ID = "unit-test-provisioning-id";
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY = privatePem;
  // Deliberately set conflicting regular-account credentials: the creation
  // client must use only the separately verified provisioning key.
  process.env.KALSHI_API_KEY_ID = "wrong-regular-key";
  process.env.KALSHI_API_PRIVATE_KEY = "must-not-be-used";
});

test.after(() => {
  for (const [key, value] of oldEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function rawInventory(candidates: number[] = [], contradictory = false) {
  const balances = [
    { subaccount_number: 0, exchange_index: 0, balance: "0.0100", updated_ts: 1790422846 },
    { subaccount_number: 0, exchange_index: 2, balance: "163.2567", updated_ts: 1790422846 },
  ];
  const netting = [
    { subaccount_number: 0, exchange_index: 0, enabled: false },
    { subaccount_number: 0, exchange_index: 2, enabled: false },
  ];
  for (const n of candidates) {
    balances.push({
      subaccount_number: n, exchange_index: 2, balance: "0.0000", updated_ts: 1790422846,
    });
    netting.push({ subaccount_number: n, exchange_index: 2, enabled: false });
  }
  if (contradictory) balances[0]!.balance = "1.0100";
  return {
    netting: { netting_configs: netting },
    balances: { subaccount_balances: balances },
  };
}

class MemoryAttemptStore implements CreationAttemptStore {
  row: CreationAttemptRecord | null = null;

  async get() {
    return this.row ? structuredClone(this.row) : null;
  }
  async reserve(record: CreationAttemptRecord) {
    if (this.row) return null;
    this.row = structuredClone(record);
    return structuredClone(this.row);
  }
  async markAttempted(attemptId: string, at: Date) {
    if (this.row?.attemptId !== attemptId || this.row.state !== "reserved") return false;
    this.row.state = "attempted";
    this.row.attemptedAt = at;
    return true;
  }
  async markResponseReceived(
    attemptId: string, subaccountNumber: number, responseStatus: number,
    metadata: Record<string, unknown>, at: Date,
  ) {
    if (this.row?.attemptId !== attemptId || this.row.state !== "attempted") return false;
    Object.assign(this.row, {
      state: "response_received", subaccountNumber, responseStatus,
      responseMetadata: metadata, responseReceivedAt: at,
    });
    return true;
  }
  async markUncertain(attemptId: string, metadata: Record<string, unknown>, responseStatus?: number) {
    if (this.row?.attemptId !== attemptId || this.row.state !== "attempted") return;
    Object.assign(this.row, { state: "uncertain", responseMetadata: metadata,
      responseStatus: responseStatus ?? null });
  }
  async markVerified(attemptId: string, subaccountNumber: number, at: Date) {
    if (this.row?.attemptId !== attemptId ||
        !["attempted", "uncertain", "response_received"].includes(this.row.state)) return false;
    Object.assign(this.row, { state: "verified", subaccountNumber, verifiedAt: at });
    return true;
  }
  async getVerifiedForPair(subaccountNumber: number) {
    if (this.row?.state !== "verified" || this.row.subaccountNumber !== subaccountNumber) return null;
    return structuredClone(this.row);
  }
}

function harness(options: {
  store?: MemoryAttemptStore;
  candidates?: number[];
  post?: (store: MemoryAttemptStore) => Promise<Response>;
  contradictory?: boolean;
}) {
  const store = options.store ?? new MemoryAttemptStore();
  let inventory = rawInventory(options.candidates, options.contradictory);
  let postCount = 0;
  const fetchImpl: CreationFetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://external-api.kalshi.com");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("KALSHI-ACCESS-KEY"), "unit-test-provisioning-id");
    assert.ok(headers.get("KALSHI-ACCESS-SIGNATURE"));
    assert.notEqual(headers.get("KALSHI-ACCESS-KEY"), process.env.KALSHI_API_KEY_ID);
    assert.equal(init?.redirect, "manual");
    if (init?.method === "GET" && url.pathname === "/trade-api/v2/api_keys") {
      return Response.json({ api_keys: [{
        api_key_id: "unit-test-provisioning-id",
        scopes: ["read", "write"],
        subaccount: null,
      }] });
    }
    if (init?.method === "GET" && url.pathname === "/trade-api/v2/portfolio/subaccounts/balances") {
      return Response.json(inventory.balances);
    }
    if (init?.method === "GET" && url.pathname === "/trade-api/v2/portfolio/subaccounts/netting") {
      return Response.json(inventory.netting);
    }
    if (init?.method === "POST" && url.pathname === "/trade-api/v2/portfolio/subaccounts") {
      postCount += 1;
      assert.equal(url.search, "");
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.equal(init.body, JSON.stringify({ exchange_index: 2 }));
      return options.post
        ? options.post(store)
        : Response.json({ subaccount_number: 7 }, { status: 201 });
    }
    throw new Error(`Unexpected mocked request ${init?.method} ${url.pathname}`);
  };
  const service = createMicroLiveSubaccountCreationService({ store, fetchImpl });
  return {
    store,
    service,
    get postCount() { return postCount; },
    setInventory: (next: ReturnType<typeof rawInventory>) => { inventory = next; },
  };
}

test("restart after network latch but before POST performs GET-only recovery and never retries", async () => {
  const store = new MemoryAttemptStore();
  let crashAfterLatch = true;
  const markAttempted = store.markAttempted.bind(store);
  store.markAttempted = async (attemptId, at) => {
    const latched = await markAttempted(attemptId, at);
    if (crashAfterLatch && latched) {
      crashAfterLatch = false;
      throw new Error("simulated crash immediately before POST");
    }
    return latched;
  };
  const fixture = harness({
    store,
  });
  await assert.rejects(fixture.service.submit(), /immediately before POST/);
  assert.equal(store.row?.state, "attempted");
  assert.ok(store.row?.attemptId);
  assert.match(store.row?.prePostInventoryDigest ?? "", /^[0-9a-f]{64}$/);
  const restarted = createMicroLiveSubaccountCreationService({
    store,
    fetchImpl: async (input, init) => {
      assert.notEqual(init?.method, "POST");
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("KALSHI-ACCESS-KEY"), "unit-test-provisioning-id");
      if (url.pathname === "/trade-api/v2/portfolio/subaccounts/balances") {
        return Response.json(rawInventory().balances);
      }
      if (url.pathname === "/trade-api/v2/portfolio/subaccounts/netting") {
        return Response.json(rawInventory().netting);
      }
      if (url.pathname === "/trade-api/v2/api_keys") {
        return Response.json({ api_keys: [{
          api_key_id: "unit-test-provisioning-id",
          scopes: ["read", "write"], subaccount: null,
        }] });
      }
      assert.fail(`Unexpected GET path ${url.pathname}`);
    },
  });
  const recovered = await restarted.verify();
  assert.equal(recovered.state, "attempted");
  const repeat = await restarted.submit();
  assert.equal(repeat.state, "attempted");
  assert.equal(fixture.postCount, 0);
});

test("restart after reservation resumes its one reserved attempt, with no N assumption", async () => {
  const store = new MemoryAttemptStore();
  let crashAfterCommit = true;
  const reserve = store.reserve.bind(store);
  store.reserve = async (record) => {
    const persisted = await reserve(record);
    if (crashAfterCommit) {
      crashAfterCommit = false;
      throw new Error("simulated process loss after reservation commit");
    }
    return persisted;
  };
  const fixture = harness({ store });
  // Simulate process A crashing after the durable reservation was committed.
  await assert.rejects(fixture.service.submit(), /process loss/);
  assert.equal(store.row?.state, "reserved");
  // A process restart shares only the durable row and resumes this still-safe
  // reservation exactly once.
  const restarted = createMicroLiveSubaccountCreationService({
    store,
    fetchImpl: async (_input, init) => {
      if (init?.method === "POST") {
        return Response.json({ subaccount_number: 7 }, { status: 201 });
      }
      const url = new URL(String(_input));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("KALSHI-ACCESS-KEY"), "unit-test-provisioning-id");
      if (url.pathname.endsWith("/balances")) return Response.json(rawInventory().balances);
      if (url.pathname.endsWith("/netting")) return Response.json(rawInventory().netting);
      if (url.pathname.endsWith("/api_keys")) {
        return Response.json({ api_keys: [{
          api_key_id: "unit-test-provisioning-id", scopes: ["read", "write"], subaccount: null,
        }] });
      }
      assert.fail(`Unexpected GET path ${url.pathname}`);
    },
  });
  const result = await restarted.submit();
  assert.equal(result.state, "uncertain");
  assert.equal(store.row?.state, "uncertain");
  assert.equal(fixture.postCount, 0);
});

test("201 without exchange_index waits for inventory to prove arbitrary N at index 2", async () => {
  const store = new MemoryAttemptStore();
  const fixture = harness({
    store,
    post: async () => {
      fixture.setInventory(rawInventory([7]));
      return Response.json({ subaccount_number: 7 }, { status: 201 });
    },
  });
  const result = await fixture.service.submit();
  // Historical successful responses contain only subaccount_number. Until
  // authenticated inventory independently proves exchange_index=2, N is not
  // treated as a verified (N,2) result.
  assert.equal(result.state, "uncertain");
  assert.equal(result.subaccountNumber, null);
  assert.equal(store.row?.subaccountNumber, null);
  const verified = await fixture.service.verify();
  assert.equal(verified.state, "verified");
  assert.equal(verified.subaccountNumber, 7);
  assert.equal(store.row?.responseStatus, 201);
  assert.ok(store.row?.verifiedAt);
  assert.equal(store.row?.prePostInventoryDigest.length, 64);
});

test("validated 201 with explicit index 2 verifies against the real inventory routes", async () => {
  const store = new MemoryAttemptStore();
  const fixture = harness({
    store,
    post: async () => {
      fixture.setInventory(rawInventory([14]));
      return Response.json({ subaccount_number: 14, exchange_index: 2 }, { status: 201 });
    },
  });
  const result = await fixture.service.submit();
  assert.equal(result.state, "verified");
  assert.equal(result.subaccountNumber, 14);
  assert.equal(store.row?.state, "verified");
});

test("timeout after possible submission becomes uncertain and resolves with GET only", async () => {
  const store = new MemoryAttemptStore();
  const fixture = harness({
    store,
    post: async () => {
      fixture.setInventory(rawInventory([9]));
      throw new Error("socket timed out after request submission");
    },
  });
  const outcome = await fixture.service.submit();
  assert.equal(outcome.state, "uncertain");
  assert.equal(outcome.subaccountNumber, null);
  const creationAuthorization = process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED;
  delete process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED;
  try {
    const recovered = await fixture.service.verify();
    assert.equal(recovered.state, "verified");
    assert.equal(recovered.subaccountNumber, 9);
    await assert.rejects(fixture.service.submit(), /explicit authorization/);
  } finally {
    if (creationAuthorization === undefined) {
      delete process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED;
    } else {
      process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED = creationAuthorization;
    }
  }
  assert.equal(fixture.postCount, 1);
});

test("201 response without exchange_index is uncertain and does not invent index 2", async () => {
  const store = new MemoryAttemptStore();
  const fixture = harness({
    store,
    post: async () => Response.json({ subaccount_number: 1 }, { status: 201 }),
  });
  const outcome = await fixture.service.submit();
  assert.equal(outcome.state, "uncertain");
  assert.equal(outcome.subaccountNumber, null);
  assert.equal(store.row?.subaccountNumber, null);
  assert.equal((await fixture.service.submit()).state, "uncertain");
  assert.equal(fixture.postCount, 1);
});

test("201 explicitly identifying another exchange index cannot be recovered as index 2", async () => {
  const store = new MemoryAttemptStore();
  const fixture = harness({
    store,
    post: async () => {
      fixture.setInventory(rawInventory([12]));
      return Response.json({ subaccount_number: 12, exchange_index: 0 }, { status: 201 });
    },
  });
  const outcome = await fixture.service.submit();
  assert.equal(outcome.state, "uncertain");
  assert.equal(store.row?.subaccountNumber, null);
  assert.equal(store.row?.responseMetadata?.contradictoryIndex2Response, true);
  const recovered = await fixture.service.verify();
  assert.equal(recovered.state, "uncertain");
  assert.match(recovered.reason, /contradicted exchange index 2/);
  assert.equal((await fixture.service.submit()).state, "uncertain");
  assert.equal(fixture.postCount, 1);
});

test("changed pre-existing balance blocks attribution during recovery", async () => {
  const store = new MemoryAttemptStore();
  const fixture = harness({
    store,
    post: async () => {
      fixture.setInventory(rawInventory([7], true));
      throw new Error("submission may have reached Kalshi");
    },
  });
  assert.equal((await fixture.service.submit()).state, "uncertain");
  const recovered = await fixture.service.verify();
  assert.equal(recovered.state, "uncertain");
  assert.match(recovered.reason, /balance changed|contradict/);
});

test("multiple new index-2 accounts are ambiguous and cannot be recovered", async () => {
  const store = new MemoryAttemptStore();
  const fixture = harness({
    store,
    post: async () => {
      fixture.setInventory(rawInventory([7, 8]));
      throw new Error("submission may have reached Kalshi");
    },
  });
  assert.equal((await fixture.service.submit()).state, "uncertain");
  const recovered = await fixture.service.verify();
  assert.equal(recovered.state, "uncertain");
  assert.match(recovered.reason, /exactly one/);
});

test("repeated operator submission is blocked permanently after crossing the POST latch", async () => {
  const store = new MemoryAttemptStore();
  const fixture = harness({
    store,
    post: async () => Response.json({ subaccount_number: 12, exchange_index: 2 }, { status: 201 }),
  });
  assert.equal((await fixture.service.submit()).state, "response_received");
  const second = await fixture.service.submit();
  assert.equal(second.state, "response_received");
  assert.match(second.reason, /POST is blocked/);
  assert.equal(fixture.postCount, 1);
});

test("preflight rejects provisioning credentials lacking unrestricted read plus write", async () => {
  const store = new MemoryAttemptStore();
  let postCalls = 0;
  const fetchImpl: CreationFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/trade-api/v2/api_keys") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("KALSHI-ACCESS-KEY"), "unit-test-provisioning-id");
      return Response.json({ api_keys: [{
        api_key_id: "unit-test-provisioning-id",
        scopes: ["read", "write::trade"],
      }] });
    }
    if (init?.method === "POST") postCalls += 1;
    // Reuse the exact live-preflight inventory shape while ensuring no write escapes.
    if (init?.method === "GET" &&
        url.pathname === "/trade-api/v2/portfolio/subaccounts/netting") {
      return Response.json(rawInventory().netting);
    }
    if (init?.method === "GET" &&
        url.pathname === "/trade-api/v2/portfolio/subaccounts/balances") {
      return Response.json(rawInventory().balances);
    }
    assert.fail("Unexpected request while rejecting bad provisioning scopes.");
  };
  const service = createMicroLiveSubaccountCreationService({ store, fetchImpl });
  await assert.rejects(service.submit(), /unrestricted read \+ write/);
  assert.equal(postCalls, 0);
  assert.equal(store.row, null);
});