const SECRET_KEY = /private|secret|password|credential|pem|authorization|api[-_]?key|database[-_]?url|token/i;
const SECRET_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// A narrowly scoped public *boolean* attestation is allowed despite its key name.
// Never allow arbitrary values or other private-prefixed keys through this exception.
const SAFE_BOOLEAN_DIAGNOSTIC_KEYS = new Set(["privateSchemaUsable"]);
const SIGNER_DIAGNOSTIC_KEY = new Set([
  "credentialIdPresent",
  "credentialVerified",
  "privateKeyPresent",
  "privateKeyParsed",
  "privateKeyType",
  "signatureGenerated",
  "fetchAttempted",
  "localFailureStage",
  "localErrorName",
]);

/** Drops credential-shaped keys and private-key blobs before a response is sent. */
export function sanitizePublic<T>(value: T): T {
  return sanitizeValue(value) as T;
}

function sanitizeValue(value: unknown): unknown {
  // pg timestamptz columns are JavaScript Date objects. Preserve their
  // expiry timestamp as ISO8601, rather than reducing Date to {}.
  // Invalid dates are non-authorizing and serialize to null.
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[redacted]" : value;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && !SIGNER_DIAGNOSTIC_KEY.has(key) &&
        !(SAFE_BOOLEAN_DIAGNOSTIC_KEYS.has(key) && typeof entry === "boolean")) continue;
    out[key] = sanitizeValue(entry);
  }
  return out;
}
