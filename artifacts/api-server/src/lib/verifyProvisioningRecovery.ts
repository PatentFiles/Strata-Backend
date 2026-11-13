import { constants, createPrivateKey, createSign } from "node:crypto";
import { KEY_NAME, SCOPES, SUBACCOUNT } from "./keyProvisioningAttempt";

const PREFIX = "/trade-api/v2";
const READ_PATHS = [
  "/portfolio/balance", "/portfolio/orders", "/portfolio/positions",
  "/portfolio/fills", "/portfolio/settlements",
] as const;
type Credential = { id: string; key: ReturnType<typeof createPrivateKey> };

function credential(id: string | undefined, privateKey: string | undefined): Credential {
  if (!id?.trim() || !privateKey?.trim()) throw new Error("Recovery credential unavailable");
  const pem = privateKey.trim().replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") {
    throw new Error("Recovery credential type invalid");
  }
  return { id: id.trim(), key };
}

async function read(cred: Credential, path: string, query = ""): Promise<Record<string, unknown>> {
  if (path !== `${PREFIX}/api_keys` &&
      !READ_PATHS.some(allowed => path === `${PREFIX}${allowed}`)) {
    throw new Error("Recovery GET path forbidden");
  }
  const timestamp = String(Date.now());
  const signer = createSign("sha256");
  signer.update(`${timestamp}GET${path}`);
  signer.end();
  const signature = signer.sign({
    key: cred.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
  }).toString("base64");
  const response = await fetch(`https://external-api.kalshi.com${path}${query}`, {
    method: "GET", cache: "no-store", signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      "KALSHI-ACCESS-KEY": cred.id,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signature,
    },
  });
  if (!response.ok) throw new Error("Recovery GET rejected");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Recovery GET response invalid");
  }
  return data as Record<string, unknown>;
}

/** Fail closed. Never return the saved ID, private key, or unfiltered API data. */
export async function verifyProvisioningRecovery(): Promise<boolean> {
  try {
    if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT === "1" ||
        process.env.KALSHI_API_ENVIRONMENT !== "production" ||
        process.env.KALSHI_KEY_GENERATION_AUTHORIZED !== "false") return false;
    const verifier = credential(process.env.KALSHI_VERIFIER_API_KEY_ID,
      process.env.KALSHI_VERIFIER_API_PRIVATE_KEY);
    const restricted = credential(process.env.KALSHI_MICRO_LIVE_API_KEY_ID,
      process.env.KALSHI_MICRO_LIVE_PRIVATE_KEY);
    const keys = await read(verifier, `${PREFIX}/api_keys`);
    if (!Array.isArray(keys.api_keys) || keys.cursor) return false;
    const matching = keys.api_keys.filter((value): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value) &&
      (value as Record<string, unknown>).name === KEY_NAME);
    if (matching.length !== 1) return false;
    const key = matching[0];
    const scopes = key.scopes;
    if (key.api_key_id !== restricted.id || key.subaccount !== SUBACCOUNT ||
        !Array.isArray(scopes) || scopes.length !== 2 ||
        !SCOPES.every(scope => scopes.includes(scope))) return false;

    for (const suffix of READ_PATHS) {
      const data = await read(restricted, `${PREFIX}${suffix}`,
        `?subaccount=${SUBACCOUNT}${suffix === "/portfolio/balance" ? "" : "&limit=100"}`);
      if (data.subaccount !== undefined && data.subaccount !== SUBACCOUNT) return false;
      if (suffix === "/portfolio/balance") {
        if (typeof data.balance !== "number" || typeof data.portfolio_value !== "number") return false;
      } else {
        const field = suffix === "/portfolio/positions" ? "market_positions" : suffix.slice("/portfolio/".length);
        if (!Array.isArray(data[field]) || data.cursor) return false;
        if (suffix === "/portfolio/positions" && !Array.isArray(data.event_positions)) return false;
      }
    }
    return process.env.KALSHI_KEY_GENERATION_AUTHORIZED === "false";
  } catch {
    return false;
  }
}