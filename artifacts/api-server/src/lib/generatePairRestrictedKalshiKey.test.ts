import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify, constants } from "node:crypto";
import test from "node:test";
import {
  preflightPairKeyProvisioning,
  generatePairRestrictedKalshiKey,
  generateStrataIndex2Key,
  inspectStrataIndex2Credentials,
  createStrataSubaccount,
  readStrataSubaccountBalances,
  verifyPairKeyMetadata,
} from "./generatePairRestrictedKalshiKey";
import { PAIR_KEY_NAME } from "./microLivePairKeyProvisioningAttempt";

const saved = {
  nodeEnv: process.env.NODE_ENV,
  deployment: process.env.REPLIT_DEPLOYMENT,
  apiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
  provisioningEnabled: process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED,
  generationAuthorized: process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED,
  provisioningId: process.env.KALSHI_PROVISIONING_API_KEY_ID,
  provisioningPem: process.env.KALSHI_PROVISIONING_PRIVATE_KEY,
  verifierId: process.env.KALSHI_VERIFIER_API_KEY_ID,
  verifierPem: process.env.KALSHI_VERIFIER_API_PRIVATE_KEY,
  fetch: globalThis.fetch,
};

test.after(() => {
  const values = [
    ["NODE_ENV", saved.nodeEnv],
    ["REPLIT_DEPLOYMENT", saved.deployment],
    ["KALSHI_API_ENVIRONMENT", saved.apiEnvironment],
    ["KALSHI_INDEX2_KEY_PROVISIONING_ENABLED", saved.provisioningEnabled],
    ["KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED", saved.generationAuthorized],
    ["KALSHI_PROVISIONING_API_KEY_ID", saved.provisioningId],
    ["KALSHI_PROVISIONING_PRIVATE_KEY", saved.provisioningPem],
    ["KALSHI_VERIFIER_API_KEY_ID", saved.verifierId],
    ["KALSHI_VERIFIER_API_PRIVATE_KEY", saved.verifierPem],
  ] as const;
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = saved.fetch;
});

const ownerId = "provisioning-owner-id";
const oldHistoricalId = "historical-index0-key-id";
const generatedId = "new-dedicated-index2-key-id";
const privatePem = "-----BEGIN RSA PRIVATE KEY-----\ntest-only-private-key\n-----END RSA PRIVATE KEY-----";
const newRecord = (overrides: Record<string, unknown> = {}) => ({
  api_key_id: generatedId,
  name: PAIR_KEY_NAME,
  key_type: "rsa",
  subaccount: 1,
  scopes: ["read", "write::trade"],
  ...overrides,
});
function setDevelopmentAuthorization() {
  process.env.NODE_ENV = "development";
  delete process.env.REPLIT_DEPLOYMENT;
  process.env.KALSHI_API_ENVIRONMENT = "production";
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED = "true";
  process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED = "true";
}
function rsa() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}
function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

test("pair key generation is disabled without the dedicated authorization flags", async () => {
  const provisioning = rsa();
  process.env.KALSHI_PROVISIONING_API_KEY_ID = ownerId;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
    provisioning.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.NODE_ENV = "development";
  process.env.KALSHI_API_ENVIRONMENT = "production";
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED = "true";
  process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED = "false";
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount++;
    throw new Error("network must not be reached");
  }) as typeof fetch;

  await assert.rejects(generatePairRestrictedKalshiKey(), /disabled/);
  assert.equal(fetchCount, 0);
});

test("preflight permits the distinct historical key but blocks an existing dedicated name", async () => {
  const provisioning = rsa();
  process.env.KALSHI_PROVISIONING_API_KEY_ID = ownerId;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
    provisioning.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push(`${init?.method}:${url.pathname}`);
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("KALSHI-ACCESS-KEY"), ownerId);
    const old = {
      api_key_id: oldHistoricalId,
      name: "MICRO_LIVE_SUBACCOUNT_1",
      subaccount: 1,
      scopes: ["read", "write::trade"],
    };
    return response({
      api_keys: [
        { api_key_id: ownerId, name: "unrestricted-owner", subaccount: null,
          scopes: ["read", "write"] },
        old,
      ],
    });
  }) as typeof fetch;

  let cleanPairChecks = 0;
  await assert.doesNotReject(() => preflightPairKeyProvisioning(() => {
    cleanPairChecks++;
    return Promise.resolve();
  }));
  assert.deepEqual(requested, ["GET:/trade-api/v2/api_keys"]);
  assert.equal(cleanPairChecks, 1);

  globalThis.fetch = (async () => response({
    api_keys: [
      { api_key_id: ownerId, subaccount: null, scopes: ["read", "write"] },
      { api_key_id: oldHistoricalId, name: PAIR_KEY_NAME, subaccount: 1,
        scopes: ["read", "write::trade"] },
    ],
  })) as typeof fetch;
  await assert.rejects(
    preflightPairKeyProvisioning(() => Promise.resolve()),
    /not available/,
  );
});

test("preflight requires fresh clean-pair verification and stops when it fails", async () => {
  const provisioning = rsa();
  process.env.KALSHI_PROVISIONING_API_KEY_ID = ownerId;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
    provisioning.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push(`${init?.method}:${url.pathname}`);
    assert.equal(init?.method, "GET");
    return response({
      api_keys: [
        { api_key_id: ownerId, name: "unrestricted-owner", subaccount: null,
          scopes: ["read", "write"] },
        { api_key_id: oldHistoricalId, name: "MICRO_LIVE_SUBACCOUNT_1",
          subaccount: 1, scopes: ["read", "write::trade"] },
      ],
    });
  }) as typeof fetch;

  let cleanPairChecks = 0;
  await assert.rejects(
    preflightPairKeyProvisioning(async () => {
      cleanPairChecks++;
      throw new Error("fresh clean pair verification failed");
    }),
    /fresh clean pair verification failed/,
  );
  assert.equal(cleanPairChecks, 1);
  assert.deepEqual(requested, ["GET:/trade-api/v2/api_keys"]);
});

test("generation sends exactly one signed RSA (1,2) key request after authorization", async () => {
  setDevelopmentAuthorization();
  const provisioning = rsa();
  process.env.KALSHI_PROVISIONING_API_KEY_ID = ownerId;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
    provisioning.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let postCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.href, "https://external-api.kalshi.com/trade-api/v2/api_keys/generate");
    assert.equal(init?.method, "POST");
    postCount++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("KALSHI-ACCESS-KEY"), ownerId);
    assert.equal(headers.get("Content-Type"), "application/json");
    const path = url.pathname;
    const timestamp = headers.get("KALSHI-ACCESS-TIMESTAMP")!;
    const verifier = createVerify("sha256");
    verifier.update(`${timestamp}POST${path}`);
    verifier.end();
    assert.equal(verifier.verify({
      key: provisioning.publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE")!, "base64")), true);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      name: PAIR_KEY_NAME,
      key_type: "rsa",
      subaccount: 1,
      scopes: ["read", "write::trade"],
    });
    assert.equal(JSON.parse(String(init?.body)).scopes.includes("write"), false);
    return response({ api_key_id: generatedId, private_key: privatePem }, 201);
  }) as typeof fetch;

  const result = await generatePairRestrictedKalshiKey();
  try {
    assert.equal(result.id.toString(), generatedId);
    assert.equal(result.pem.toString(), privatePem);
    assert.equal(postCount, 1);
  } finally {
    result.id.fill(0);
    result.pem.fill(0);
  }
});

test("non-201 response and an uncertain POST are never retried by the client", async () => {
  setDevelopmentAuthorization();
  const provisioning = rsa();
  process.env.KALSHI_PROVISIONING_API_KEY_ID = ownerId;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
    provisioning.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let postCount = 0;
  globalThis.fetch = (async () => {
    postCount++;
    return response({ error: "uncertain" }, 503);
  }) as typeof fetch;
  await assert.rejects(generatePairRestrictedKalshiKey(), /HTTP 201/);
  assert.equal(postCount, 1);
});

test("metadata verifier uses only unrestricted GET and matches exact ID/name/N/scopes", async () => {
  const verifier = rsa();
  process.env.NODE_ENV = "development";
  delete process.env.REPLIT_DEPLOYMENT;
  process.env.KALSHI_VERIFIER_API_KEY_ID = "independent-verifier-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY =
    verifier.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let getCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.href, "https://external-api.kalshi.com/trade-api/v2/api_keys");
    assert.equal(init?.method, "GET");
    getCount++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("KALSHI-ACCESS-KEY"), "independent-verifier-id");
    const timestamp = headers.get("KALSHI-ACCESS-TIMESTAMP")!;
    const signature = createVerify("sha256");
    signature.update(`${timestamp}GET${url.pathname}`);
    signature.end();
    assert.equal(signature.verify({
      key: verifier.publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE")!, "base64")), true);
    return response({ api_keys: [
      { api_key_id: oldHistoricalId, name: "MICRO_LIVE_SUBACCOUNT_1",
        subaccount: 1, scopes: ["read", "write::trade"] },
      newRecord(),
    ] });
  }) as typeof fetch;

  assert.equal(await verifyPairKeyMetadata(generatedId), true);
  assert.equal(getCount, 1);

  const invalidCases = [
    { ...newRecord(), api_key_id: oldHistoricalId },
    newRecord({ subaccount: 0 }),
    newRecord({ scopes: ["read", "write"] }),
    newRecord({ scopes: ["read", "write::trade", "write"] }),
    newRecord({ name: "MICRO_LIVE_SUBACCOUNT_1" }),
    newRecord({ api_key_id: generatedId, name: "MICRO_LIVE_SUBACCOUNT_1" }),
  ];
  for (const record of invalidCases) {
    globalThis.fetch = (async () => response({ api_keys: [record] })) as typeof fetch;
    assert.equal(await verifyPairKeyMetadata(generatedId), false);
  }
});

test("Strata INDEX2 generation posts the restricted payload once and does not trade", async () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    apiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
    live: process.env.LIVE_EXECUTION_ENABLED,
    v13: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
  };
  const provisioning = rsa();
  const verifier = rsa();
  process.env.NODE_ENV = "production";
  process.env.KALSHI_API_ENVIRONMENT = "production";
  delete process.env.LIVE_EXECUTION_ENABLED;
  delete process.env.V13_PRODUCTION_EXECUTION_ENABLED;
  process.env.KALSHI_PROVISIONING_API_KEY_ID = ownerId;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
    provisioning.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.KALSHI_VERIFIER_API_KEY_ID = "independent-verifier-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY =
    verifier.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "", path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    if (init?.method === "GET") {
      return response({
        api_keys: [{ api_key_id: ownerId, name: "provisioning", subaccount: null, scopes: ["read", "write"] }],
      });
    }
    return response({ api_key_id: generatedId, private_key: privatePem }, 201);
  }) as typeof fetch;
  try {
    const inspection = await inspectStrataIndex2Credentials();
    assert.equal(inspection.provisioningCredentialValid, true);
    assert.equal(inspection.provisioningUnrestricted, true);
    assert.equal(inspection.provisioningScopesExact, true);
    assert.equal(inspection.verifierCredentialValid, true);
    assert.equal(inspection.existingIndex2Name, false);
    const generated = await generateStrataIndex2Key();
    assert.equal(generated.id.toString(), generatedId);
    generated.id.fill(0);
    generated.pem.fill(0);
    assert.equal(calls.filter((item) => item.method === "POST").length, 1);
    assert.deepEqual(JSON.parse(calls.find((item) => item.method === "POST")?.body ?? "{}"), {
      name: "Strata INDEX2",
      key_type: "rsa",
      subaccount: 1,
      scopes: ["read", "write::trade"],
    });
    assert.equal(calls.every((item) => item.path === "/trade-api/v2/api_keys" || item.path === "/trade-api/v2/api_keys/generate"), true);
    assert.equal(calls.some((item) => item.path.includes("transfer") || item.path.includes("order")), false);
    globalThis.fetch = (async (_input, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "", path: "/trade-api/v2/api_keys" });
      return response({
        api_keys: [{ api_key_id: ownerId, name: "provisioning", subaccount: 1, scopes: ["read", "write::trade"] }],
      });
    }) as typeof fetch;
    const wrongScope = await inspectStrataIndex2Credentials();
    assert.equal(wrongScope.provisioningScopesExact, false);
    assert.equal(wrongScope.provisioningUnrestricted, false);
    globalThis.fetch = (async (_input, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "", path: "/trade-api/v2/api_keys" });
      return response({
        api_keys: [{
          api_key_id: ownerId, name: "Strata INDEX2", subaccount: null, scopes: ["read", "write"],
        }],
      });
    }) as typeof fetch;
    assert.equal((await inspectStrataIndex2Credentials()).existingIndex2Name, true);
    process.env.LIVE_EXECUTION_ENABLED = "true";
    const postsBefore = calls.filter((item) => item.method === "POST").length;
    await assert.rejects(generateStrataIndex2Key(), /closed/);
    assert.equal(calls.filter((item) => item.method === "POST").length, postsBefore);
  } finally {
    for (const [name, value] of [
      ["NODE_ENV", saved.nodeEnv],
      ["KALSHI_API_ENVIRONMENT", saved.apiEnvironment],
      ["LIVE_EXECUTION_ENABLED", saved.live],
      ["V13_PRODUCTION_EXECUTION_ENABLED", saved.v13],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Strata subaccount inventory is GET-only and creation posts exchange index 2 once", async () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    apiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
    live: process.env.LIVE_EXECUTION_ENABLED,
    v13: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
  };
  const provisioning = rsa();
  process.env.NODE_ENV = "production";
  process.env.KALSHI_API_ENVIRONMENT = "production";
  delete process.env.LIVE_EXECUTION_ENABLED;
  delete process.env.V13_PRODUCTION_EXECUTION_ENABLED;
  process.env.KALSHI_PROVISIONING_API_KEY_ID = ownerId;
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
    provisioning.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.KALSHI_VERIFIER_API_KEY_ID = "independent-verifier-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY =
    provisioning.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "", path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    assert.equal(init?.method, "GET");
    return response({
      subaccount_balances: [
        { subaccount_number: 0, exchange_index: 2, balance: "999.0000" },
      ],
    });
  }) as typeof fetch;
  try {
    const identities = await readStrataSubaccountBalances("verifier");
    assert.deepEqual(identities, [{ subaccount: 0, exchangeIndex: 2 }]);
    assert.equal(JSON.stringify(identities).includes("999"), false);
    assert.equal(calls.every((item) => item.method === "GET" && item.path === "/trade-api/v2/portfolio/subaccounts/balances"), true);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "", path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
      assert.equal(init?.method, "POST");
      assert.equal(url.pathname, "/trade-api/v2/portfolio/subaccounts");
      return response({ subaccount_number: 7, exchange_index: 2 }, 201);
    }) as typeof fetch;
    const wrong = await createStrataSubaccount();
    assert.equal(wrong.outcome, "wrong_number");
    if (wrong.outcome === "wrong_number") assert.equal(wrong.subaccountNumber, 7);
    assert.equal(calls.filter((item) => item.method === "POST").length, 1);
    assert.deepEqual(JSON.parse(calls.find((item) => item.method === "POST")?.body ?? "{}"), { exchange_index: 2 });
    assert.equal(calls.some((item) => item.path.includes("transfer") || item.path.includes("order")), false);
    process.env.LIVE_EXECUTION_ENABLED = "true";
    await assert.rejects(createStrataSubaccount(), /closed/);
    assert.equal(calls.filter((item) => item.method === "POST").length, 1);
  } finally {
    for (const [name, value] of [
      ["NODE_ENV", saved.nodeEnv],
      ["KALSHI_API_ENVIRONMENT", saved.apiEnvironment],
      ["LIVE_EXECUTION_ENABLED", saved.live],
      ["V13_PRODUCTION_EXECUTION_ENABLED", saved.v13],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});