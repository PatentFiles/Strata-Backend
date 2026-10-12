import { dedicatedSignerFingerprint, PRODUCTION_EXCHANGE_INDEX, PRODUCTION_SUBACCOUNT } from "./commissioning";
import { normalizeKalshiMoney } from "./kalshiUserRead";

export interface CredentialProbeMaterial {
  keyId: string;
  privateKey: string;
}

export interface CredentialProbeResult {
  ok: boolean;
  reason: string;
  evidenceMicros: string | null;
}

const API_KEYS_PATH = "/trade-api/v2/api_keys";
const BALANCE_PATH = "/trade-api/v2/portfolio/balance";
const BALANCE_QUERY = `?subaccount=${PRODUCTION_SUBACCOUNT}&exchange_index=${PRODUCTION_EXCHANGE_INDEX}`;

/** Read-only proof for one user key. It does not read process credentials or place orders. */
export async function probeAccountCredential(
  role: string,
  expectedFingerprint: string,
  material: CredentialProbeMaterial,
  getJson: (creds: CredentialProbeMaterial, path: string, query?: string) => Promise<unknown>,
): Promise<CredentialProbeResult> {
  const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
  if (!fingerprint || fingerprint !== expectedFingerprint) {
    return { ok: false, reason: "credential_fingerprint_mismatch", evidenceMicros: null };
  }
  let keys: unknown;
  let balance: unknown;
  try {
    keys = await getJson(material, API_KEYS_PATH, "");
    balance = await getJson(material, BALANCE_PATH, BALANCE_QUERY);
  } catch {
    return { ok: false, reason: "credential_verification_failed", evidenceMicros: null };
  }
  const record = keyRecord(keys, material.keyId);
  if (!record) return { ok: false, reason: "credential_permission_unproven", evidenceMicros: null };
  const scopes = stringList(record.scopes);
  if (!scopes.includes("read")) return { ok: false, reason: "credential_permission_rejected", evidenceMicros: null };
  if (role === "restricted_execution") {
    const exactTrade = scopes.length === 2 && scopes.includes("read") && scopes.includes("write::trade");
    if (!exactTrade || record.subaccount !== PRODUCTION_SUBACCOUNT) {
      return { ok: false, reason: "credential_permission_rejected", evidenceMicros: null };
    }
  } else if (typeof record.subaccount === "number" && record.subaccount !== PRODUCTION_SUBACCOUNT && record.subaccount !== 0) {
    return { ok: false, reason: "account_target_pair_mismatch", evidenceMicros: null };
  }
  const pair = pairEvidence(balance);
  if (!pair.ok) return { ok: false, reason: pair.reason, evidenceMicros: null };
  return { ok: true, reason: "credential_verified", evidenceMicros: pair.evidenceMicros };
}

function keyRecord(payload: unknown, keyId: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const keys = (payload as Record<string, unknown>).api_keys;
  if (!Array.isArray(keys)) return null;
  const found = keys.find((item) => item && typeof item === "object" &&
    (item as Record<string, unknown>).api_key_id === keyId);
  return found && typeof found === "object" ? found as Record<string, unknown> : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pairEvidence(payload: unknown): { ok: true; evidenceMicros: string } | { ok: false; reason: string } {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const nested = record.balance && typeof record.balance === "object" && !Array.isArray(record.balance)
    ? record.balance as Record<string, unknown>
    : record;
  const subaccount = nested.subaccount_number ?? nested.subaccount ?? record.subaccount_number ?? record.subaccount;
  const exchangeIndex = nested.exchange_index ?? record.exchange_index;
  if (subaccount !== undefined && subaccount !== null && subaccount !== PRODUCTION_SUBACCOUNT) {
    return { ok: false, reason: "account_target_pair_mismatch" };
  }
  if (exchangeIndex !== undefined && exchangeIndex !== null && exchangeIndex !== PRODUCTION_EXCHANGE_INDEX) {
    return { ok: false, reason: "account_target_pair_mismatch" };
  }
  const money = normalizeKalshiMoney(nested);
  if (money.cashCents === null) return { ok: false, reason: "credential_balance_unproven" };
  return { ok: true, evidenceMicros: String(money.cashCents * 10_000) };
}
