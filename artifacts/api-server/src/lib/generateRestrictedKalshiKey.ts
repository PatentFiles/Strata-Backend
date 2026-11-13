import { createPrivateKey, createSign, constants } from "node:crypto";
import { KEY_NAME, SCOPES, SUBACCOUNT } from "./keyProvisioningAttempt";

export interface GeneratedKey {
  id: Buffer;
  pem: Buffer;
}

export async function generateRestrictedKalshiKey(): Promise<GeneratedKey> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.REPLIT_DEPLOYMENT === "1" ||
      process.env.KALSHI_KEY_PROVISIONING_ENABLED !== "true" ||
      process.env.KALSHI_KEY_GENERATION_AUTHORIZED !== "true" ||
      process.env.KALSHI_API_ENVIRONMENT !== "production") {
    throw new Error("Key provisioning disabled");
  }
  const id = process.env.KALSHI_PROVISIONING_API_KEY_ID?.trim();
  const raw = process.env.KALSHI_PROVISIONING_PRIVATE_KEY?.trim();
  if (!id || !raw) throw new Error("Provisioning credential unavailable");
  const pem = raw.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  const key = createPrivateKey(pem);
  const path = "/trade-api/v2/api_keys/generate";
  const timestamp = Date.now().toString();
  const signer = createSign("sha256");
  signer.update(timestamp + "POST" + path);
  signer.end();
  const body = JSON.stringify({
    name: KEY_NAME, key_type: "rsa", scopes: [...SCOPES], subaccount: SUBACCOUNT,
  });
  // fetch makes no automatic retry. Never include the response or exception in logs.
  const response = await fetch("https://external-api.kalshi.com" + path, {
    method: "POST", redirect: "manual", cache: "no-store",
    signal: AbortSignal.timeout(20000), body,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": id,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signer.sign({
        key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
      }).toString("base64"),
    },
  });
  if (response.status !== 201) {
    await response.body?.cancel();
    throw new Error("Kalshi generation did not return success");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" ||
        !("api_key_id" in parsed) || typeof parsed.api_key_id !== "string" ||
        !("private_key" in parsed) || typeof parsed.private_key !== "string" ||
        !/^-----BEGIN RSA PRIVATE KEY-----/.test(parsed.private_key) ||
        parsed.api_key_id.length < 10) {
      throw new Error("Generated key response invalid");
    }
    return { id: Buffer.from(parsed.api_key_id), pem: Buffer.from(parsed.private_key) };
  } finally {
    bytes.fill(0);
  }
}