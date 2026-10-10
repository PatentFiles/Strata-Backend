import { constants, createPrivateKey, createSign } from "node:crypto";
import {
  PAIR_KEY_NAME, PAIR_SCOPES, PAIR_SUBACCOUNT,
} from "./microLivePairKeyProvisioningAttempt";
import { captureCleanPairSnapshot } from "./kalshiAccountClient";
import {
  STRATA_INDEX2_KEY_NAME,
  STRATA_INDEX2_KEY_SCOPES,
} from "./strata/commissioning";

const HOST = "https://external-api.kalshi.com";
const PREFIX = "/trade-api/v2";

export type GeneratedPairKey = { id: Buffer; pem: Buffer };

function credential(kind: "provisioning" | "verifier") {
  const id = process.env[kind === "provisioning"
    ? "KALSHI_PROVISIONING_API_KEY_ID" : "KALSHI_VERIFIER_API_KEY_ID"]?.trim();
  const raw = process.env[kind === "provisioning"
    ? "KALSHI_PROVISIONING_PRIVATE_KEY" : "KALSHI_VERIFIER_API_PRIVATE_KEY"]?.trim();
  if (!id || !raw) throw new Error("Independent key credential unavailable");
  const pem = raw.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") {
    throw new Error("Independent key credential is not RSA");
  }
  return { id, key };
}

async function request(kind: "provisioning" | "verifier", method: "GET" | "POST",
  path: string, body?: string): Promise<Response> {
  const { id, key } = credential(kind);
  const timestamp = String(Date.now());
  const signer = createSign("sha256");
  signer.update(`${timestamp}${method}${path}`);
  signer.end();
  return fetch(`${HOST}${path}`, {
    method, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20_000),
    body, headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "KALSHI-ACCESS-KEY": id,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signer.sign({
        key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
      }).toString("base64"),
    },
  });
}

function exactScopes(value: unknown, scopes: readonly string[]): boolean {
  return Array.isArray(value) && value.length === scopes.length &&
    value.every((scope) => typeof scope === "string" && scopes.includes(scope)) &&
    scopes.every((scope) => value.includes(scope));
}

async function keyInventory(kind: "provisioning" | "verifier") {
  const response = await request(kind, "GET", `${PREFIX}/api_keys`);
  if (!response.ok) throw new Error("Independent API key inventory GET failed");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !("api_keys" in body) || !Array.isArray(body.api_keys) ||
      ("cursor" in body && !!body.cursor)) {
    throw new Error("Independent API key inventory incomplete");
  }
  return body.api_keys as Array<Record<string, unknown>>;
}

export async function verifyFreshPairClean(): Promise<void> {
  // The persisted CREATED_CLEAN boundary alone cannot prove that the pair
  // remained empty after it was recorded. Recheck before reserving the POST.
  const response = await fetch(`${HOST}${PREFIX}/markets?series_ticker=KXBTC15M&status=open&limit=200`, {
    method: "GET", cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Current pair market GET failed");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !("markets" in body) || !Array.isArray(body.markets) ||
      ("cursor" in body && !!body.cursor)) {
    throw new Error("Current pair market inventory incomplete");
  }
  const now = Date.now();
  const current = body.markets.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item) &&
    typeof item.ticker === "string" && item.ticker.startsWith("KXBTC15M-") &&
    item.exchange_index === 2 && item.status === "active" &&
    typeof item.open_time === "string" && Date.parse(item.open_time) <= now &&
    typeof item.close_time === "string" && Date.parse(item.close_time) > now);
  if (current.length !== 1) throw new Error("Current index-2 market identity unavailable");
  const snapshot = await captureCleanPairSnapshot(
    PAIR_SUBACCOUNT, current[0]!.ticker as string, { creationBoundary: true },
  );
  if (snapshot.status !== "clean" || snapshot.reasons.length ||
      snapshot.availableCashMicros !== "0" || snapshot.inventoryCashMicros !== "0" ||
      snapshot.portfolioValueMicros !== "0" ||
      !snapshot.zeroOrders || !snapshot.zeroPositions ||
      !snapshot.zeroFills || !snapshot.zeroSettlements ||
      !snapshot.zeroPriorPairTransfers || !snapshot.evidenceDigest) {
    throw new Error("Fresh authenticated pair clean boundary not proven");
  }
}

/** Read-only preflight. The old index-0 credential may exist; the new name must not. */
export async function preflightPairKeyProvisioning(
  verifyCleanPair: () => Promise<void> = verifyFreshPairClean,
): Promise<void> {
  const keys = await keyInventory("provisioning");
  const provisioningId = process.env.KALSHI_PROVISIONING_API_KEY_ID?.trim();
  const owner = keys.filter((item) => item.api_key_id === provisioningId);
  if (owner.length !== 1 || !exactScopes(owner[0]?.scopes, ["read", "write"]) ||
      (Object.hasOwn(owner[0]!, "subaccount") && owner[0]!.subaccount !== null) ||
      keys.some((item) => item.name === PAIR_KEY_NAME)) {
    throw new Error("Unrestricted provisioning identity or new key name is not available");
  }
  await verifyCleanPair();
}

const STRATA_INDEX2_GENERATION_BODY = {
  name: STRATA_INDEX2_KEY_NAME,
  key_type: "rsa" as const,
  subaccount: 1 as const,
  scopes: [...STRATA_INDEX2_KEY_SCOPES],
};

/** Read-only inventory. A failed GET is not a generation attempt. */
export async function inspectStrataIndex2Credentials(): Promise<{
  provisioningCredentialValid: boolean;
  provisioningUnrestricted: boolean;
  provisioningScopesExact: boolean;
  verifierCredentialValid: boolean;
  existingIndex2Name: boolean;
}> {
  const provisioningId = process.env.KALSHI_PROVISIONING_API_KEY_ID?.trim();
  const provisioning = await keyInventory("provisioning");
  const owner = provisioning.filter((item) => item.api_key_id === provisioningId);
  const verifier = await keyInventory("verifier");
  const named = [...provisioning, ...verifier].some((item) => item.name === STRATA_INDEX2_KEY_NAME);
  return {
    provisioningCredentialValid: owner.length === 1,
    provisioningUnrestricted: owner.length === 1 &&
      (!Object.hasOwn(owner[0]!, "subaccount") || owner[0]!.subaccount === null),
    provisioningScopesExact: owner.length === 1 && exactScopes(owner[0]?.scopes, ["read", "write"]),
    verifierCredentialValid: true,
    existingIndex2Name: named,
  };
}

async function generatedKey(response: Response): Promise<GeneratedPairKey> {
  if (response.status !== 201) {
    await response.body?.cancel();
    throw new Error("Dedicated pair key generation did not return HTTP 201");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    const body: unknown = JSON.parse(bytes.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !("api_key_id" in body) || typeof body.api_key_id !== "string" ||
        body.api_key_id.length < 10 ||
        !("private_key" in body) || typeof body.private_key !== "string" ||
        !/^-----BEGIN RSA PRIVATE KEY-----/.test(body.private_key)) {
      throw new Error("Dedicated pair key response is invalid; no retry permitted");
    }
    return { id: Buffer.from(body.api_key_id), pem: Buffer.from(body.private_key) };
  } finally {
    bytes.fill(0);
  }
}

/** The reviewed development POST. Its body and gate stay unchanged. */
export async function generatePairRestrictedKalshiKey(): Promise<GeneratedPairKey> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.REPLIT_DEPLOYMENT === "1" ||
      process.env.KALSHI_API_ENVIRONMENT !== "production" ||
      process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED !== "true" ||
      process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED !== "true") {
    throw new Error("Dedicated pair key generation is disabled");
  }
  return generatedKey(await request("provisioning", "POST", `${PREFIX}/api_keys/generate`,
    JSON.stringify({
      name: PAIR_KEY_NAME, key_type: "rsa", subaccount: PAIR_SUBACCOUNT,
      scopes: [...PAIR_SCOPES],
    })));
}

/**
 * One Kalshi POST for the Railway key. Callers must commit an attempt first
 * and must not call this again after an uncertain result.
 */
export async function generateStrataIndex2Key(): Promise<GeneratedPairKey> {
  if (process.env.NODE_ENV !== "production" ||
      process.env.KALSHI_API_ENVIRONMENT !== "production" ||
      process.env.LIVE_EXECUTION_ENABLED === "true" ||
      process.env.V13_PRODUCTION_EXECUTION_ENABLED === "true") {
    throw new Error("Strata INDEX2 key generation is closed");
  }
  return generatedKey(await request(
    "provisioning",
    "POST",
    `${PREFIX}/api_keys/generate`,
    JSON.stringify(STRATA_INDEX2_GENERATION_BODY),
  ));
}

/** Independent unrestricted metadata GET, not an assertion of shard isolation. */
export async function verifyPairKeyMetadata(keyId: string): Promise<boolean> {
  try {
    if (!keyId || process.env.NODE_ENV !== "development" ||
        process.env.REPLIT_DEPLOYMENT === "1") return false;
    const keys = await keyInventory("verifier");
    const matches = keys.filter((item) =>
      item.api_key_id === keyId && item.name === PAIR_KEY_NAME);
    return matches.length === 1 && matches[0]?.subaccount === PAIR_SUBACCOUNT &&
      exactScopes(matches[0].scopes, PAIR_SCOPES) &&
      !keys.some((item) => item.api_key_id === keyId && item.name !== PAIR_KEY_NAME);
  } catch {
    return false;
  }
}