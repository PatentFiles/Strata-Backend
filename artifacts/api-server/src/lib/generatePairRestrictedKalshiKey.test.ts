import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify, constants } from "node:crypto";
import test from "node:test";
import {
  preflightPairKeyProvisioning,
  generatePairRestrictedKalshiKey,
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