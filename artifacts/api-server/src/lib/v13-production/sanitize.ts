const SECRET_KEY = /private|secret|password|credential|pem|authorization|api[-_]?key|database[-_]?url|token/i;
const SECRET_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Drops credential-shaped keys and private-key blobs before a response is sent. */
export function sanitizePublic<T>(value: T): T {
  return sanitizeValue(value) as T;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[redacted]" : value;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = sanitizeValue(entry);
  }
  return out;
}
