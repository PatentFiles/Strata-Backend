import type { CanonicalInventory, PairIdentity } from "./microLiveSubaccountCreation";

const SUBACCOUNT_LIMIT = 63;

export function inventoryObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kalshi inventory response is malformed.");
  }
  return value as Record<string, unknown>;
}

export function inventoryInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function pairKey(identity: PairIdentity): string {
  return `${identity.subaccountNumber}:${identity.exchangeIndex}`;
}

function pairIdentity(row: Record<string, unknown>): PairIdentity {
  const subaccountNumber = inventoryInteger(row.subaccount_number ?? row.subaccount);
  const exchangeIndex = inventoryInteger(row.exchange_index);
  if (subaccountNumber === null || subaccountNumber > SUBACCOUNT_LIMIT ||
      exchangeIndex === null || exchangeIndex > SUBACCOUNT_LIMIT) {
    throw new Error("Kalshi inventory contains an account without explicit valid pair identity.");
  }
  return { subaccountNumber, exchangeIndex };
}

function amountMicros(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const stringValue = String(value);
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(stringValue);
  if (!match) throw new Error("Kalshi inventory contains an invalid balance.");
  const micros = BigInt(match[2]!) * 1_000_000n + BigInt((match[3] ?? "").padEnd(6, "0"));
  return `${match[1] === "-" ? "-" : ""}${micros}`;
}

function extractRows(payload: Record<string, unknown>, candidates: string[]): Record<string, unknown>[] {
  if (payload.cursor) throw new Error("Kalshi inventory is paginated; complete inventory is required.");
  const key = candidates.find((candidate) => Array.isArray(payload[candidate]));
  if (!key) throw new Error("Kalshi inventory response does not contain a complete account list.");
  return (payload[key] as unknown[]).map(inventoryObject);
}

/** Same canonical parse Brady's micro-live creation path uses. Balance amounts stay internal. */
export function canonicalInventory(nettingPayload: unknown, balancePayload: unknown): CanonicalInventory {
  const nettingRows = extractRows(inventoryObject(nettingPayload), ["netting_configs"]);
  const balanceRows = extractRows(inventoryObject(balancePayload), ["subaccount_balances"]);
  const nettingConfigs = nettingRows.map((row) => {
    const identity = pairIdentity(row);
    if (typeof row.enabled !== "boolean") {
      throw new Error("Kalshi netting inventory is missing its enabled flag.");
    }
    return { ...identity, enabled: row.enabled };
  }).sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
  const balances = balanceRows.map((row) => {
    const identity = pairIdentity(row);
    const balanceMicros = amountMicros(row.balance ?? row.balance_dollars);
    const updatedAt = inventoryInteger(row.updated_ts);
    if (balanceMicros === null || updatedAt === null || updatedAt === 0) {
      throw new Error("Kalshi balances inventory is missing a valid balance or timestamp.");
    }
    return { ...identity, balanceMicros, updatedAt };
  }).sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
  const ensureUnique = (rows: readonly PairIdentity[]) => {
    const keys = rows.map(pairKey);
    if (new Set(keys).size !== keys.length) throw new Error("Kalshi inventory has duplicate account identities.");
  };
  ensureUnique(nettingConfigs);
  ensureUnique(balances);
  return { nettingConfigs, balances };
}

export function validateInventory(inventory: CanonicalInventory): void {
  const netting = new Map(inventory.nettingConfigs.map((row) => [pairKey(row), row]));
  const balances = new Map(inventory.balances.map((row) => [pairKey(row), row]));
  if (netting.size !== balances.size || [...netting.keys()].some((key) => !balances.has(key))) {
    throw new Error("Kalshi account and balance inventory views contradict each other.");
  }
}

const TIER_RANK: Record<string, number> = {
  basic: 0,
  advanced: 1,
  premier: 2,
  prime: 3,
  paragon: 4,
};

/** Predictions usage_tier only. Grants and rate limits are ignored. */
export function predictionsApiTier(payload: unknown): {
  apiTier: string | null;
  subaccountCreationTierEligible: boolean;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { apiTier: null, subaccountCreationTierEligible: false };
  }
  const tier = (payload as Record<string, unknown>).usage_tier;
  if (typeof tier !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(tier)) {
    return { apiTier: null, subaccountCreationTierEligible: false };
  }
  const normalized = tier.toLowerCase();
  return {
    apiTier: normalized,
    subaccountCreationTierEligible: (TIER_RANK[normalized] ?? -1) >= TIER_RANK.advanced!,
  };
}

/**
 * Scalar cash proof for a scoped Get Balance body.
 * Callers may supply this body only after HTTP 200 from the fixed request
 * `subaccount=1&exchange_index=2`. That request, plus the two canonical
 * inventory views, establishes the pair. Get Balance does not have to echo
 * those fields. balance_breakdown is neither identity nor cash proof.
 * An echoed identity that disagrees still fails closed. The amount is not returned.
 */
export function scopedPairBalanceProven(
  payload: unknown,
  subaccount = 1,
  exchangeIndex = 2,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const root = payload as Record<string, unknown>;
  const value = root.balance && typeof root.balance === "object" && !Array.isArray(root.balance)
    ? root.balance as Record<string, unknown>
    : root;
  const scalar = value.balance_dollars ?? value.balance;
  if (typeof scalar === "object" || scalar == null) return false;
  if (typeof scalar !== "number" && typeof scalar !== "string") return false;
  if (!/^(-?)(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.test(String(scalar))) return false;
  const echoedSubaccount = "subaccount_number" in value || "subaccount" in value;
  const echoedIndex = "exchange_index" in value;
  if (!echoedSubaccount && !echoedIndex) return true;
  const seenSubaccount = inventoryInteger(value.subaccount_number ?? value.subaccount);
  const seenIndex = inventoryInteger(value.exchange_index);
  if (echoedSubaccount && seenSubaccount !== subaccount) return false;
  if (echoedIndex && seenIndex !== exchangeIndex) return false;
  return true;
}
