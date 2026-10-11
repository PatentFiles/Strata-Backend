import { reviewedKalshiCents } from "../kalshiAccountClient";
import { predictionsApiTier } from "../kalshiSubaccountInventory";

export const BOT_SUBACCOUNT = 1;
export const BOT_EXCHANGE_INDEX = 2;
export const ADVANCED_API_TIER_REQUIRED = "ADVANCED_API_TIER_REQUIRED";

export interface KalshiMoney {
  cashCents: number | null;
  portfolioValueCents: number | null;
}

export interface KalshiUserRead {
  credentialVerified: boolean;
  apiUsageTier: string | null;
  botEligible: boolean;
  botEligibilityReason: string | null;
  primary: KalshiMoney;
  botSubaccount: KalshiMoney | null;
  positions: unknown[];
  orders: unknown[];
  fills: unknown[];
  settlements: unknown[];
  subaccountTransfers: unknown[];
  deposits: unknown[];
  withdrawals: unknown[];
}

/** Documented Kalshi balance fields only. Dollar strings win; integer fields are cents. */
export function normalizeKalshiMoney(payload: unknown): KalshiMoney {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { cashCents: null, portfolioValueCents: null };
  }
  const row = payload as Record<string, unknown>;
  return {
    cashCents: reviewedKalshiCents(row, ["balance_dollars"], ["balance"]),
    portfolioValueCents: reviewedKalshiCents(row, ["portfolio_value_dollars"], ["portfolio_value"]),
  };
}

export function botEligibility(limitsPayload: unknown, numberedSubaccountAvailable: boolean): {
  apiUsageTier: string | null;
  botEligible: boolean;
  botEligibilityReason: string | null;
  walletConnected: true;
} {
  const tier = predictionsApiTier(limitsPayload);
  if (!tier.subaccountCreationTierEligible) {
    return {
      apiUsageTier: tier.apiTier,
      botEligible: false,
      botEligibilityReason: ADVANCED_API_TIER_REQUIRED,
      walletConnected: true,
    };
  }
  if (!numberedSubaccountAvailable) {
    return {
      apiUsageTier: tier.apiTier,
      botEligible: false,
      botEligibilityReason: "DEDICATED_SUBACCOUNT_UNAVAILABLE",
      walletConnected: true,
    };
  }
  return { apiUsageTier: tier.apiTier, botEligible: true, botEligibilityReason: null, walletConnected: true };
}

export function emptyKalshiUserRead(): KalshiUserRead {
  return {
    credentialVerified: false,
    apiUsageTier: null,
    botEligible: false,
    botEligibilityReason: null,
    primary: { cashCents: null, portfolioValueCents: null },
    botSubaccount: null,
    positions: [],
    orders: [],
    fills: [],
    settlements: [],
    subaccountTransfers: [],
    deposits: [],
    withdrawals: [],
  };
}

const ACTIVITY = ["positions", "orders", "fills", "settlements", "subaccountTransfers", "deposits", "withdrawals"] as const;

/** Drops credential-shaped activity fields. Does not invent KYC or withdrawable cash. */
export function sanitizeActivity(rows: unknown[]): Record<string, unknown>[] {
  return rows.filter((row) => row && typeof row === "object" && !Array.isArray(row)).map((row) => {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (/private|secret|pem|api[-_]?key|token|authorization/i.test(key)) continue;
      copy[key] = value;
    }
    return copy;
  });
}

export function assembleKalshiUserRead(input: {
  credentialVerified: boolean;
  limits: unknown;
  numberedSubaccountAvailable: boolean;
  primary: unknown;
  botSubaccount: unknown | null;
  activity: Partial<Record<(typeof ACTIVITY)[number], unknown[]>>;
}): KalshiUserRead {
  const eligibility = botEligibility(input.limits, input.numberedSubaccountAvailable);
  const read = emptyKalshiUserRead();
  read.credentialVerified = input.credentialVerified;
  read.apiUsageTier = eligibility.apiUsageTier;
  read.botEligible = input.credentialVerified && eligibility.botEligible;
  read.botEligibilityReason = input.credentialVerified ? eligibility.botEligibilityReason : "CREDENTIAL_UNVERIFIED";
  read.primary = normalizeKalshiMoney(input.primary);
  read.botSubaccount = input.numberedSubaccountAvailable ? normalizeKalshiMoney(input.botSubaccount) : null;
  for (const key of ACTIVITY) read[key] = sanitizeActivity(input.activity[key] ?? []);
  return read;
}
