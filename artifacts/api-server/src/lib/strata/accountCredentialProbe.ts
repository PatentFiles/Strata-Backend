import {
  cleanPairInventoryDiagnosis,
  dedicatedSignerFingerprint,
  PRODUCTION_EXCHANGE_INDEX,
  PRODUCTION_SUBACCOUNT,
  subaccountIdentitiesFromBalancePayload,
} from "./commissioning";
import { normalizeKalshiMoney } from "./kalshiUserRead";

export interface CredentialProbeMaterial {
  keyId: string;
  privateKey: string;
}

export interface VerifiedCredentialAuthority {
  expectedFingerprint: string;
  material: CredentialProbeMaterial;
}

export type AccountSetupNextRequirement =
  | "create_subaccount_1"
  | "generate_subaccount_1_restricted_key"
  | "provision_execution_account"
  | "verify_verification_credential"
  | "verify_restricted_execution_credential";

export interface CredentialProbeResult {
  ok: boolean;
  reason: string;
  evidenceMicros: string | null;
  subaccount1Exists: boolean | null;
  subaccount1Exchange2Exists: boolean | null;
  restrictedKeyMetadataVerified: boolean | null;
  nextRequirement: AccountSetupNextRequirement | null;
}

export interface Subaccount1Inspection {
  ok: boolean;
  reason: string;
  exists: boolean | null;
  exchangeIndex2Exists: boolean | null;
}

export interface RestrictedKeyMetadataInspection {
  ok: boolean;
  reason: string;
  boundSubaccount: number | null;
  scopesVerified: boolean;
}

const API_KEYS_PATH = "/trade-api/v2/api_keys";
const BALANCE_PATH = "/trade-api/v2/portfolio/balance";
const SUBACCOUNT_BALANCES_PATH = "/trade-api/v2/portfolio/subaccounts/balances";
const BALANCE_QUERY = `?subaccount=${PRODUCTION_SUBACCOUNT}&exchange_index=${PRODUCTION_EXCHANGE_INDEX}`;
const emptyProbe = (
  reason: string,
  patch: Partial<CredentialProbeResult> = {},
): CredentialProbeResult => ({
  ok: false,
  reason,
  evidenceMicros: null,
  subaccount1Exists: null,
  subaccount1Exchange2Exists: null,
  restrictedKeyMetadataVerified: null,
  nextRequirement: null,
  ...patch,
});

/** Read-only proof for one user key. It does not read process credentials or place orders. */
export async function probeAccountCredential(
  role: string,
  expectedFingerprint: string,
  material: CredentialProbeMaterial,
  getJson: (creds: CredentialProbeMaterial, path: string, query?: string) => Promise<unknown>,
  authority?: VerifiedCredentialAuthority,
): Promise<CredentialProbeResult> {
  const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
  if (!fingerprint || fingerprint !== expectedFingerprint) {
    return emptyProbe("credential_fingerprint_mismatch");
  }
  if (role === "restricted_execution") {
    if (!authority) return emptyProbe("verified_verification_credential_required");
    const authorityFingerprint = dedicatedSignerFingerprint(
      authority.material.keyId,
      authority.material.privateKey,
    );
    if (!authorityFingerprint || authorityFingerprint !== authority.expectedFingerprint) {
      return emptyProbe("verification_credential_fingerprint_mismatch");
    }
    if (authorityFingerprint === fingerprint || authority.material.keyId.trim() === material.keyId.trim()) {
      return emptyProbe("verification_credential_not_independent");
    }
    const metadata = await inspectRestrictedKeyMetadata(material.keyId, authority, getJson);
    if (!metadata.ok) {
      return emptyProbe(metadata.reason, {
        restrictedKeyMetadataVerified: false,
        nextRequirement: restrictedMetadataNextRequirement(metadata.reason),
      });
    }
    const subaccount = await inspectSubaccount1(authority, getJson);
    if (!subaccount.ok || !subaccount.exists || !subaccount.exchangeIndex2Exists) {
      return emptyProbe(subaccount.reason, {
        subaccount1Exists: subaccount.exists,
        subaccount1Exchange2Exists: subaccount.exchangeIndex2Exists,
        restrictedKeyMetadataVerified: true,
        nextRequirement: subaccount.exists === false ? "create_subaccount_1" : null,
      });
    }
    let balance: unknown;
    try {
      balance = await getJson(material, BALANCE_PATH, BALANCE_QUERY);
    } catch {
      return emptyProbe("restricted_credential_read_failed", {
        subaccount1Exists: true,
        subaccount1Exchange2Exists: true,
        restrictedKeyMetadataVerified: true,
      });
    }
    const pair = pairEvidence(balance);
    if (!pair.ok) {
      return emptyProbe(pair.reason, {
        subaccount1Exists: true,
        subaccount1Exchange2Exists: true,
        restrictedKeyMetadataVerified: true,
      });
    }
    return {
      ok: true,
      reason: "credential_verified",
      evidenceMicros: pair.evidenceMicros,
      subaccount1Exists: true,
      subaccount1Exchange2Exists: true,
      restrictedKeyMetadataVerified: true,
      nextRequirement: null,
    };
  }
  let keys: unknown;
  let balance: unknown;
  try {
    keys = await getJson(material, API_KEYS_PATH, "");
    balance = await getJson(material, BALANCE_PATH, BALANCE_QUERY);
  } catch {
    return emptyProbe("credential_verification_failed");
  }
  const record = keyRecord(keys, material.keyId);
  if (!record) return emptyProbe("credential_permission_unproven");
  const scopes = stringList(record.scopes);
  if (!scopes.includes("read")) return emptyProbe("credential_permission_rejected");
  if (typeof record.subaccount === "number" &&
      record.subaccount !== PRODUCTION_SUBACCOUNT && record.subaccount !== 0) {
    return emptyProbe("account_target_pair_mismatch");
  }
  const pair = pairEvidence(balance);
  if (!pair.ok) return emptyProbe(pair.reason);
  return {
    ok: true,
    reason: "credential_verified",
    evidenceMicros: pair.evidenceMicros,
    subaccount1Exists: null,
    subaccount1Exchange2Exists: null,
    restrictedKeyMetadataVerified: null,
    nextRequirement: null,
  };
}

/** Uses a separately verified management-capable key; the target key never calls key management. */
export async function inspectRestrictedKeyMetadata(
  targetKeyId: string,
  authority: VerifiedCredentialAuthority,
  getJson: (creds: CredentialProbeMaterial, path: string, query?: string) => Promise<unknown>,
): Promise<RestrictedKeyMetadataInspection> {
  if (!authorityMatchesFingerprint(authority)) {
    return metadata(false, "verification_credential_fingerprint_mismatch");
  }
  let keys: unknown;
  try {
    keys = await getJson(authority.material, API_KEYS_PATH, "");
  } catch {
    return metadata(false, "credential_metadata_unproven");
  }
  if (!apiKeyInventory(keys)) return metadata(false, "credential_metadata_unproven");
  const verificationRecord = keyRecord(keys, authority.material.keyId);
  if (!verificationRecord) {
    return metadata(false, "verification_credential_permission_unproven");
  }
  const verificationScopes = stringList(verificationRecord.scopes);
  if (!verificationScopes.includes("read") ||
      (Object.hasOwn(verificationRecord, "subaccount") && verificationRecord.subaccount !== null)) {
    return metadata(false, "verification_credential_not_authorized");
  }
  const record = keyRecord(keys, targetKeyId);
  if (!record) return metadata(false, "credential_permission_unproven");
  const scopes = stringList(record.scopes);
  const exactTrade = scopes.length === 2 &&
    scopes.includes("read") &&
    scopes.includes("write::trade");
  if (!exactTrade) return metadata(false, "credential_permission_rejected", subaccount(record));
  const bound = subaccount(record);
  if (bound === null) {
    return metadata(false, "restricted_key_not_bound_to_subaccount_1", null, true);
  }
  if (bound !== PRODUCTION_SUBACCOUNT) {
    return metadata(false, "account_target_pair_mismatch", bound, true);
  }
  return metadata(true, "restricted_key_metadata_verified", bound, true);
}

/** Establishes existence from inventory identity rows and deliberately discards cash amounts. */
export async function inspectSubaccount1(
  authority: VerifiedCredentialAuthority,
  getJson: (creds: CredentialProbeMaterial, path: string, query?: string) => Promise<unknown>,
): Promise<Subaccount1Inspection> {
  if (!authorityMatchesFingerprint(authority)) {
    return { ok: false, reason: "verification_credential_fingerprint_mismatch", exists: null, exchangeIndex2Exists: null };
  }
  let payload: unknown;
  try {
    payload = await getJson(authority.material, SUBACCOUNT_BALANCES_PATH, "");
  } catch {
    return { ok: false, reason: "subaccount_inventory_unproven", exists: null, exchangeIndex2Exists: null };
  }
  try {
    const identities = subaccountIdentitiesFromBalancePayload(payload);
    const exists = identities.some((row) => row.subaccount === PRODUCTION_SUBACCOUNT);
    const diagnosis = cleanPairInventoryDiagnosis(identities);
    if (diagnosis === "clean_pair_inventory_missing") {
      return { ok: true, reason: "subaccount_1_missing", exists: false, exchangeIndex2Exists: false };
    }
    if (diagnosis === "clean_pair_exchange_index_2_missing") {
      return { ok: true, reason: "subaccount_1_exchange_2_missing", exists: true, exchangeIndex2Exists: false };
    }
    if (diagnosis === "clean_pair_inventory_duplicated") {
      return { ok: false, reason: "subaccount_inventory_ambiguous", exists: true, exchangeIndex2Exists: true };
    }
    return { ok: true, reason: "subaccount_1_verified", exists, exchangeIndex2Exists: true };
  } catch {
    return { ok: false, reason: "subaccount_inventory_unproven", exists: null, exchangeIndex2Exists: null };
  }
}

function keyRecord(payload: unknown, keyId: string): Record<string, unknown> | null {
  const keys = apiKeyInventory(payload);
  if (!keys) return null;
  const matches = keys.filter((item) => item.api_key_id === keyId);
  return matches.length === 1 ? matches[0]! : null;
}

function apiKeyInventory(payload: unknown): Record<string, unknown>[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const keys = (payload as Record<string, unknown>).api_keys;
  if (!Array.isArray(keys)) return null;
  const records = keys.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item) &&
    typeof (item as Record<string, unknown>).api_key_id === "string");
  return records.length === keys.length ? records : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function subaccount(record: Record<string, unknown>): number | null {
  return typeof record.subaccount === "number" && Number.isSafeInteger(record.subaccount)
    ? record.subaccount
    : null;
}

function authorityMatchesFingerprint(authority: VerifiedCredentialAuthority): boolean {
  return dedicatedSignerFingerprint(authority.material.keyId, authority.material.privateKey) ===
    authority.expectedFingerprint;
}

function metadata(
  ok: boolean,
  reason: string,
  boundSubaccount: number | null = null,
  scopesVerified = false,
): RestrictedKeyMetadataInspection {
  return { ok, reason, boundSubaccount, scopesVerified };
}

export function restrictedMetadataNextRequirement(reason: string): AccountSetupNextRequirement | null {
  if (reason === "verification_credential_permission_unproven" ||
      reason === "verification_credential_not_authorized") {
    return "verify_verification_credential";
  }
  if (reason === "credential_permission_unproven" ||
      reason === "credential_permission_rejected" ||
      reason === "restricted_key_not_bound_to_subaccount_1" ||
      reason === "account_target_pair_mismatch" ||
      reason === "verification_credential_not_independent") {
    return "generate_subaccount_1_restricted_key";
  }
  return null;
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
