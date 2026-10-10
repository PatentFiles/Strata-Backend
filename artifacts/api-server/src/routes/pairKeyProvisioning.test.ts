import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  createPairKeyProvisioningRouter, pairKeyProvisioningEnabled,
} from "./pairKeyProvisioning";
import {
  PAIR_KEY_NAME, PAIR_SCOPES, PAIR_SUBACCOUNT,
  type PairKeyAttemptState, type PairKeyAttemptStore,
} from "../lib/microLivePairKeyProvisioningAttempt";
import type { GeneratedPairKey } from "../lib/generatePairRestrictedKalshiKey";

const names = [
  "NODE_ENV", "REPLIT_DEPLOYMENT", "KALSHI_INDEX2_KEY_PROVISIONING_ENABLED",
  "KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED", "KALSHI_API_ENVIRONMENT",
  "REPLIT_DEV_DOMAIN", "PHASE4_ADMIN_USER_ID",
] as const;
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const path = "/api/admin/index2-key-provisioning";
const secretPem = "-----BEGIN RSA PRIVATE KEY-----\nprivate-once-test-secret\n-----END RSA PRIVATE KEY-----";

function configure(authorized = true) {
  process.env.NODE_ENV = "development";
  delete process.env.REPLIT_DEPLOYMENT;
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED = "true";
  process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED = authorized ? "true" : "false";
  process.env.KALSHI_API_ENVIRONMENT = "production";
  process.env.REPLIT_DEV_DOMAIN = "owner-dev.replit.dev";
  process.env.PHASE4_ADMIN_USER_ID = "owner";
}

function memoryStore(initial: PairKeyAttemptState | null = null) {
  const calls: string[] = [];
  let record: {
    attemptId: string; state: PairKeyAttemptState; keyId: string | null;
    creationAttemptId: string; cleanBoundaryEvidenceDigest: string;
    metadataVerifiedAt: Date | null; confirmedAt: Date | null;
  } | null = initial ? {
    attemptId: "attempt-existing", state: initial, keyId: null,
    creationAttemptId: "creation-attempt", cleanBoundaryEvidenceDigest: "a".repeat(64),
    metadataVerifiedAt: null, confirmedAt: null,
  } : null;
  const store: PairKeyAttemptStore = {
    async get() { calls.push("get"); return record ? { ...record } : null; },
    async prepare() {
      calls.push("prepare");
      if (record) return null;
      record = {
        attemptId: "attempt-new", state: "prepared", keyId: null,
        creationAttemptId: "creation-attempt",
        cleanBoundaryEvidenceDigest: "a".repeat(64),
        metadataVerifiedAt: null, confirmedAt: null,
      };
      return record.attemptId;
    },
    async markAttempted(id) {
      calls.push("markAttempted");
      if (!record || record.attemptId !== id || record.state !== "prepared") return false;
      record.state = "attempted";
      return true;
    },
    async markResponse(id, keyId) {
      calls.push("markResponse");
      if (!record || record.attemptId !== id || record.state !== "attempted") return false;
      record.state = "response_received";
      record.keyId = keyId;
      return true;
    },
    async markMetadataVerified(id) {
      calls.push("markMetadataVerified");
      if (!record || record.attemptId !== id || !record.keyId ||
          !["response_received", "handoff_confirmed"].includes(record.state)) return false;
      record.state = record.state === "handoff_confirmed" ? "handoff_confirmed" : "metadata_verified";
      record.metadataVerifiedAt = new Date();
      return true;
    },
    async markConfirmed(id) {
      calls.push("markConfirmed");
      if (!record || record.attemptId !== id ||
          !["response_received", "metadata_verified"].includes(record.state)) return false;
      record.state = "handoff_confirmed";
      record.confirmedAt = new Date();
      return true;
    },
    async markUncertain(id) {
      calls.push("markUncertain");
      if (!record || record.attemptId !== id || record.state !== "attempted") return false;
      record.state = "uncertain";
      return true;
    },
    async bindingEligible() { calls.push("bindingEligible"); return false; },
  };
  return { store, calls, get record() { return record ? { ...record } : null; } };
}

type Fixture = Awaited<ReturnType<typeof serve>>;
async function serve(storage: PairKeyAttemptStore, options: {
  readBoundary?: () => Promise<string | null>;
  preflight?: () => Promise<void>;
  generate?: () => Promise<GeneratedPairKey>;
  verifyMetadata?: (keyId: string) => Promise<boolean>;
  verifySavedKey?: () => Promise<boolean>;
  verifyCleanPair?: () => Promise<number>;
  bindKey?: (cleanCheckedAt: number) => Promise<{ status: string; reason: string }>;
  savedKeyMatches?: (keyId: string) => boolean;
} = {}) {
  let boundaryState = "CREATED_CLEAN";
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "1kb" }));
  app.use(path, createPairKeyProvisioningRouter({
    store: storage,
    readBoundary: options.readBoundary ?? (async () => boundaryState),
    preflight: options.preflight ?? (async () => {}),
    generate: options.generate ?? (async () => ({
      id: Buffer.from("dedicated-index2-key-id"),
      pem: Buffer.from(secretPem),
    })),
    verifyMetadata: options.verifyMetadata ?? (async () => true),
    verifySavedKey: options.verifySavedKey ?? (async () => true),
    verifyCleanPair: options.verifyCleanPair ?? (async () => Date.now()),
    savedKeyMatches: options.savedKeyMatches ?? (keyId => keyId === "dedicated-index2-key-id"),
    bindKey: options.bindKey ?? (async () => {
      boundaryState = "KEY_BOUND_VERIFIED";
      return { status: "captured", reason: "pair_restricted_key_bound_verified" };
    }),
    identity: req => ({
      userId: req.get("x-test-user") ?? null,
      sessionId: req.get("x-test-session") ?? null,
    }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function call(f: Fixture, method: string, route: string, options: {
  user?: string | null; session?: string | null; body?: string;
  origin?: string | null; host?: string; forwardedHost?: string;
  forwardedProto?: string;
} = {}) {
  return new Promise<{ status: number; html: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port: f.port, path: `${path}${route}`, method,
      headers: {
        Host: options.host ?? "owner-dev.replit.dev",
        Origin: options.origin === undefined ? "https://owner-dev.replit.dev" : options.origin ?? "",
        "x-forwarded-proto": options.forwardedProto ?? "https",
        ...(options.forwardedHost ? { "x-forwarded-host": options.forwardedHost } : {}),
        "x-test-user": options.user === undefined ? "owner" : options.user ?? "",
        "x-test-session": options.session === undefined ? "session-1" : options.session ?? "",
        ...(options.body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        html: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
      }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function csrf(html: string) {
  const value = html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(value, "form must contain a session CSRF nonce");
  return `csrf=${value}`;
}

test.after(() => {
  for (const name of names) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("route is disabled by default and performs no reservation or network call", async () => {
  configure(false);
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED = "false";
  assert.equal(pairKeyProvisioningEnabled(), false);
  const s = memoryStore();
  let generated = 0;
  const fixture = await serve(s.store, {
    generate: async () => {
      generated++;
      return { id: Buffer.from("never"), pem: Buffer.from(secretPem) };
    },
  });
  try {
    const result = await call(fixture, "GET", "/");
    assert.equal(result.status, 404);
    assert.equal(s.record, null);
    assert.equal(generated, 0);
  } finally {
    await fixture.close();
  }
});

test("new index-2 owner GET identifies the clean pair and separate secrets while generation is OFF", async () => {
  configure(false);
  const s = memoryStore();
  const fixture = await serve(s.store);
  try {
    const unauthenticated = await call(fixture, "GET", "/", { user: null });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers["x-provisioning-route"], "new-index2");
    assert.match(unauthenticated.html, /Sign in required/);
    assert.match(unauthenticated.html, /href="\/sign-in"/);
    assert.doesNotMatch(unauthenticated.html, /Generate index-2 key once/);

    const owner = await call(fixture, "GET", "/");
    assert.equal(owner.status, 200);
    assert.equal(owner.headers["x-provisioning-route"], "new-index2");
    assert.match(owner.html, /NEW INDEX-2 MICRO_LIVE CREDENTIAL/);
    assert.match(owner.html, /Pair: subaccount 1, exchange index 2/);
    assert.match(owner.html, /Current boundary: CREATED_CLEAN/);
    assert.match(owner.html, /Intended scopes: read \+ write::trade; no general write/);
    assert.match(owner.html, /KALSHI_INDEX2_API_KEY_ID and KALSHI_INDEX2_PRIVATE_KEY/);
    assert.match(owner.html, /Generate index-2 key once/);
    assert.match(owner.html, /<button type="submit" disabled>/);
    assert.match(owner.html, /action="\/api\/admin\/index2-key-provisioning\/generate"/);
    assert.doesNotMatch(owner.html, /action="\/api\/admin\/key-provisioning/);
    assert.equal(s.calls.filter(value => value === "prepare" || value === "generate").length, 0);

    const changed = await serve(s.store, { readBoundary: async () => "KEY_BOUND_VERIFIED" });
    try {
      const blocked = await call(changed, "GET", "/");
      assert.equal(blocked.status, 200);
      assert.match(blocked.html, /Current boundary: KEY_BOUND_VERIFIED/);
      assert.doesNotMatch(blocked.html, /Generate index-2 key once/);
    } finally {
      await changed.close();
    }
  } finally {
    await fixture.close();
  }
});

test("owner identity and exact same-origin CSRF checks guard the durable boundary", async () => {
  configure();
  const s = memoryStore();
  let generated = 0;
  const fixture = await serve(s.store, {
    generate: async () => {
      generated++;
      return { id: Buffer.from("dedicated-index2-key-id"), pem: Buffer.from(secretPem) };
    },
  });
  try {
    assert.equal((await call(fixture, "GET", "/", { user: null })).status, 401);
    assert.equal((await call(fixture, "GET", "/", { user: "other" })).status, 403);
    const form = csrf((await call(fixture, "GET", "/")).html);
    for (const options of [
      { origin: "https://owner-dev.replit.dev.attacker.invalid" },
      { origin: "https://evil.invalid" },
      { host: "owner-dev.replit.dev.attacker.invalid" },
      { forwardedHost: "evil.invalid" },
      { forwardedProto: "http" },
    ]) {
      assert.equal((await call(fixture, "POST", "/generate", {
        body: form, ...options,
      })).status, 403);
    }
    assert.equal((await call(fixture, "POST", "/generate", {
      body: "csrf=not-a-token",
    })).status, 403);
    assert.equal(generated, 0);
    assert.deepEqual(s.calls.filter(x => x === "prepare" || x === "markAttempted"), []);
  } finally {
    await fixture.close();
  }
});

test("attempt latch precedes one key request; owner gets one secret handoff only", async () => {
  configure();
  const s = memoryStore();
  const generatedPem = Buffer.from(secretPem);
  const generatedId = Buffer.from("dedicated-index2-key-id");
  let generateCount = 0;
  let metadataGets = 0;
  const fixture = await serve(s.store, {
    preflight: async () => { s.calls.push("preflight"); },
    generate: async () => {
      s.calls.push("generate");
      generateCount++;
      assert.equal(s.record?.state, "attempted");
      assert.ok(s.calls.indexOf("markAttempted") < s.calls.indexOf("generate"));
      return { id: generatedId, pem: generatedPem };
    },
    verifyMetadata: async keyId => {
      metadataGets++;
      s.calls.push(`verifyMetadata:${keyId}`);
      return keyId === "dedicated-index2-key-id";
    },
  });
  try {
    const home = await call(fixture, "GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.html, /MICRO_LIVE_INDEX2_SUBACCOUNT_1/);
    assert.match(home.html, /subaccount: 1/);
    assert.match(home.html, /read, write::trade/);
    assert.match(home.html, /not the historical index-0 key/);
    const form = csrf(home.html);
    const result = await call(fixture, "POST", "/generate", { body: form });
    assert.equal(result.status, 200);
    assert.match(result.html, /KALSHI_INDEX2_API_KEY_ID/);
    assert.match(result.html, /KALSHI_INDEX2_PRIVATE_KEY/);
    assert.doesNotMatch(result.html, /Set KALSHI_API_KEY_ID|Set KALSHI_API_PRIVATE_KEY/);
    assert.match(result.html, /dedicated-index2-key-id/);
    assert.equal(result.html.split(secretPem).length - 1, 1);
    assert.equal(result.headers["cache-control"], "no-store, private, max-age=0");
    assert.equal(result.headers["referrer-policy"], "same-origin");
    assert.equal(generateCount, 1);
    assert.equal(metadataGets, 1);
    assert.ok(s.calls.indexOf("markAttempted") < s.calls.indexOf("generate"));
    assert.equal(s.record?.state, "metadata_verified");
    assert.equal(JSON.stringify(s.record).includes(secretPem), false);
    assert.equal(generatedPem.every(byte => byte === 0), true);
    assert.equal(generatedId.every(byte => byte === 0), true);

    const confirmForm = csrf(result.html);
    const confirmed = await call(fixture, "POST", "/confirm", { body: confirmForm });
    assert.equal(confirmed.status, 200);
    assert.equal(s.record?.state, "handoff_confirmed");
    assert.match(confirmed.html, /KEY_BOUND_VERIFIED/);
    assert.doesNotMatch(confirmed.html, /private-once-test-secret|-----BEGIN RSA PRIVATE KEY-----/);
    assert.equal((await call(fixture, "POST", "/confirm", { body: confirmForm })).status, 403);
    assert.equal(JSON.stringify(s.record).includes(secretPem), false);

    const attemptedPage = await call(fixture, "GET", "/");
    assert.equal(attemptedPage.status, 200);
    assert.doesNotMatch(attemptedPage.html, /private-once-test-secret|-----BEGIN RSA PRIVATE KEY-----/);
    assert.doesNotMatch(attemptedPage.html, /name="csrf"/);
    assert.equal((await call(fixture, "POST", "/generate", {
      body: form,
    })).status, 403);
    assert.equal(generateCount, 1);
    assert.equal(metadataGets, 2);
  } finally {
    await fixture.close();
  }
});

test("existing verified attempt can be acknowledged after a restart without regenerating", async () => {
  configure(true);
  const s = memoryStore();
  // Seed an already-issued key without invoking the route's generator.
  const reserved = await s.store.prepare();
  assert.ok(reserved);
  assert.equal(await s.store.markAttempted(reserved), true);
  assert.equal(await s.store.markResponse(reserved, "dedicated-index2-key-id"), true);
  assert.equal(await s.store.markMetadataVerified(reserved), true);
  configure(false);
  let metadataReads = 0;
  let signedReads = 0;
  let cleanReads = 0;
  let bound = 0;
  let generated = 0;
  const fixture = await serve(s.store, {
    generate: async () => { generated++; throw new Error("must not generate"); },
    verifyMetadata: async () => { metadataReads++; return true; },
    verifySavedKey: async () => { signedReads++; return true; },
    verifyCleanPair: async () => { cleanReads++; return Date.now(); },
    bindKey: async () => {
      bound++;
      assert.equal(s.record?.state, "handoff_confirmed");
      return { status: "captured", reason: "pair_restricted_key_bound_verified" };
    },
  });
  try {
    const home = await call(fixture, "GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.html, /I saved both secrets/);
    assert.doesNotMatch(home.html, /private-once-test-secret|-----BEGIN RSA PRIVATE KEY-----/);
    const form = csrf(home.html);
    assert.equal((await call(fixture, "POST", "/confirm", { body: form, user: null })).status, 401);
    assert.equal((await call(fixture, "POST", "/confirm", { body: form, origin: "null" })).status, 403);
    assert.equal(s.record?.confirmedAt, null);
    const result = await call(fixture, "POST", "/confirm", { body: form });
    assert.equal(result.status, 200);
    assert.equal(s.record?.state, "handoff_confirmed");
    assert.equal(metadataReads, 1);
    assert.equal(signedReads, 1);
    assert.equal(cleanReads, 1);
    assert.equal(bound, 1);
    assert.equal(generated, 0);
  } finally {
    await fixture.close();
  }
});

test("acknowledgement does not persist if fresh read-only checks fail", async () => {
  configure(true);
  const s = memoryStore();
  const id = await s.store.prepare();
  assert.ok(id);
  assert.equal(await s.store.markAttempted(id), true);
  assert.equal(await s.store.markResponse(id, "dedicated-index2-key-id"), true);
  assert.equal(await s.store.markMetadataVerified(id), true);
  configure(false);
  let bound = 0;
  const fixture = await serve(s.store, {
    verifySavedKey: async () => false,
    bindKey: async () => {
      bound++;
      return { status: "captured", reason: "pair_restricted_key_bound_verified" };
    },
  });
  try {
    const form = csrf((await call(fixture, "GET", "/")).html);
    assert.equal((await call(fixture, "POST", "/confirm", { body: form })).status, 409);
    assert.equal(s.record?.confirmedAt, null);
    assert.equal(bound, 0);
  } finally {
    await fixture.close();
  }
});

test("uncertain attempted generation is permanently non-retryable", async () => {
  configure();
  const s = memoryStore();
  let generateCount = 0;
  const fixture = await serve(s.store, {
    generate: async () => {
      generateCount++;
      assert.equal(s.record?.state, "attempted");
      throw new Error("network response lost after possible POST");
    },
  });
  try {
    const form = csrf((await call(fixture, "GET", "/")).html);
    const uncertain = await call(fixture, "POST", "/generate", { body: form });
    assert.equal(uncertain.status, 503);
    assert.match(uncertain.html, /never retry/i);
    assert.equal(s.record?.state, "uncertain");
    const home = await call(fixture, "GET", "/");
    assert.equal(home.status, 409);
    assert.doesNotMatch(home.html, /Generate once/);
    assert.equal(generateCount, 1);
  } finally {
    await fixture.close();
  }
});

test("preflight or reservation failure cannot invoke the one-shot generator", async () => {
  configure();
  const s = memoryStore();
  let generated = 0;
  const fixture = await serve(s.store, {
    preflight: async () => { throw new Error("preflight mismatch"); },
    generate: async () => {
      generated++;
      return { id: Buffer.from("never"), pem: Buffer.from(secretPem) };
    },
  });
  try {
    const form = csrf((await call(fixture, "GET", "/")).html);
    const blocked = await call(fixture, "POST", "/generate", { body: form });
    assert.equal(blocked.status, 503);
    assert.match(blocked.html, /no key POST was sent/);
    assert.equal(generated, 0);
    assert.equal(s.record, null);
  } finally {
    await fixture.close();
  }
});

test("metadata retry endpoint is GET-verification only and never displays a private key", async () => {
  configure();
  const s = memoryStore();
  const attemptId = await s.store.prepare();
  assert.equal(attemptId, "attempt-new");
  assert.equal(await s.store.markAttempted(attemptId), true);
  assert.equal(await s.store.markResponse(attemptId, "dedicated-index2-key-id"), true);
  // Seed only the key ID from a definitive response; no secret is persisted.
  let verifyCount = 0;
  const fixture = await serve(s.store, {
    verifyMetadata: async keyId => {
      verifyCount++;
      assert.equal(keyId, "dedicated-index2-key-id");
      return true;
    },
  });
  try {
    const home = await call(fixture, "GET", "/");
    const form = csrf(home.html);
    const result = await call(fixture, "POST", "/verify", { body: form });
    assert.equal(result.status, 200);
    assert.match(result.html, /Key metadata verified/);
    assert.equal(verifyCount, 1);
    assert.equal(s.record?.state, "metadata_verified");
    assert.equal(JSON.stringify(s.record).includes(secretPem), false);
    assert.doesNotMatch(result.html, /private-once-test-secret|-----BEGIN RSA PRIVATE KEY-----/);
  } finally {
    await fixture.close();
  }
});

assert.deepEqual(PAIR_SCOPES, ["read", "write::trade"]);
assert.equal(PAIR_SUBACCOUNT, 1);
assert.equal(PAIR_KEY_NAME, "MICRO_LIVE_INDEX2_SUBACCOUNT_1");