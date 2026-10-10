import { createHash } from "node:crypto";
import type { V13DepthLevel } from "../v13ExecutionPlanner";
import type { V13VerifiedFeeEvidence } from "../v13LiveMoneyEntryPreflight";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
export const money = (value: string | number | bigint): bigint => {
  requireProof(/^-?\d+$/.test(String(value)), "non_integral_money");
  return BigInt(value);
};
export const cents = (micros: bigint): number => {
  requireProof(micros >= 0n && micros / 10_000n <= BigInt(Number.MAX_SAFE_INTEGER), "money_range");
  return Number(micros / 10_000n); // conservative available-capital rounding
};

export type Identity = { subaccount: number; exchangeIndex: number; keyFingerprint: string };
export type Request = {
  market: string; side: "YES" | "NO"; action: "BUY" | "SELL";
  contracts: number; limitMicros: number; timeInForce: "IOC";
  reduceOnly: boolean; clientOrderId: string;
};
export type MarketEvidence = {
  observedAtMs: number; bestAskDollars: string; asks: V13DepthLevel[];
  bestBidDollars: string; bids: V13DepthLevel[];
  fee: V13VerifiedFeeEvidence;
};
export type Fill = {
  id: string; orderId: string; clientOrderId: string; market: string; side: "YES" | "NO";
  action: "BUY" | "SELL"; quantityHundredths: string; priceMicros: number;
  grossMicros: string; feeMicros: string; occurredAtMs: number;
};
export type OrderEvidence = {
  orderId: string; request: Request; terminal: boolean; filledHundredths: string;
};
export type Settlement = {
  id: string; market: string; side: "YES" | "NO"; result: "YES" | "NO";
  quantityHundredths: string; payoutMicros: string; feeMicros: string; occurredAtMs: number;
};
export type Snapshot = {
  identity: Identity; observedAtMs: number; complete: boolean; authenticated: boolean;
  historyFromMs: number; cashMicros: string; cashExact: boolean;
  orders: OrderEvidence[]; fills: Fill[]; settlements: Settlement[];
  positions: { market: string; side: "YES" | "NO"; quantityHundredths: string }[];
  unexplainedCashActivity: boolean;
};
// No POST response is fill evidence. The transport must return full scoped GET
// evidence, including pagination and history coverage, before any release.
export interface Exchange {
  readonly mode: "LIVE" | "SIMULATION";
  market(market: string, side: "YES" | "NO"): Promise<MarketEvidence>;
  snapshot(identity: Identity, historyFromMs: number): Promise<Snapshot>;
  submit(request: Request, finalCheck: () => Promise<void>): Promise<{ orderId?: string }>;
  cancel(orderId: string, finalCheck: () => Promise<void>): Promise<void>;
}
