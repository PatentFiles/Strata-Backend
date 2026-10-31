import {requestQuantityHundredths,formatContractHundredths} from "./requestQuantity";
import { createPrivateKey, createHash, createSign, constants } from "node:crypto";
import {
  readKalshiDedicatedPairEvidence, type KalshiDedicatedPairEvidence,
  type KalshiDedicatedPairFundingAnchor, type KalshiPairEvidenceRecord,
} from "../kalshiAccountClient";
import { ProductionExecutor } from "./executor";
import { canonical, digest, money, requireProof, type Exchange, type Identity,
  type MarketEvidence, type Request, type Snapshot } from "./types";

function decimal(value: string | null, scale: number): bigint {
  requireProof(value && /^\d+(?:\.\d+)?$/.test(value), "production_decimal_missing");
  const [whole, frac = ""] = value.split(".");
  requireProof(frac.length <= scale, "production_decimal_precision_unproven");
  return BigInt(whole!) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, "0"));
}
export function encodeProductionOrder(r: Request) {
  requireProof(r.timeInForce === "IOC" && requestQuantityHundredths(r)>0n &&
    Number.isSafeInteger(r.limitMicros) && r.limitMicros > 0 && r.limitMicros < 1_000_000 &&
    r.limitMicros % 100 === 0 && /^KXBTC15M[A-Za-z0-9._-]+$/.test(r.market) &&
    /^v13p-[a-f0-9-]{36}$/.test(r.clientOrderId) && (r.action === "SELL") === r.reduceOnly,
  "production_order_wire_invalid");
  const yesPrice = r.side === "YES" ? r.limitMicros : 1_000_000 - r.limitMicros;
  return {
    ticker: r.market, client_order_id: r.clientOrderId,
    side: (r.action === "BUY") === (r.side === "YES") ? "bid" : "ask",
    count: formatContractHundredths(requestQuantityHundredths(r)), price: (yesPrice / 1_000_000).toFixed(4),
    time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross",
    // Emit an EXPLICIT false for ENTRY. The final reviewed fee transport
    // must distinguish a genuine BUY from a malformed/absent reduce_only flag.
    // Kalshi V2 accepts a boolean; true remains required for reducing EXITs.
    post_only: false, cancel_order_on_pause: true, reduce_only: r.reduceOnly,
    subaccount: 1, exchange_index: 2,
  };
}
function recordSide(r: KalshiPairEvidenceRecord): "YES" | "NO" {
  const s = r.details.outcome_side ?? r.details.side;
  requireProof(s === "yes" || s === "no", "production_order_outcome_unproven");
  return s === "yes" ? "YES" : "NO";
}
function action(r: KalshiPairEvidenceRecord, side: "YES" | "NO"): "BUY" | "SELL" {
  if (r.details.action === "buy" || r.details.action === "sell") return r.details.action === "buy" ? "BUY" : "SELL";
  const bookSide = r.details.book_side ?? r.details.side;
  requireProof(bookSide === "bid" || bookSide === "ask", "production_order_action_unproven");
  return (bookSide === "bid") === (side === "YES") ? "BUY" : "SELL";
}
function price(r: KalshiPairEvidenceRecord, side: "YES" | "NO"): bigint {
  const named = side === "YES" ? r.details.yes_price_dollars : r.details.no_price_dollars;
  if (named) return decimal(named, 6);
  if (r.details.price_dollars) return decimal(r.details.price_dollars, 6);
  // V2 book price is canonical YES. Legacy integer-cent fallback is explicit.
  if (r.details.book_side || r.details.side === "bid" || r.details.side === "ask") {
    const yes = decimal(r.details.price ?? null, 6);
    return side === "YES" ? yes : 1_000_000n - yes;
  }
  const centPrice = side === "YES" ? r.details.yes_price : r.details.no_price;
  requireProof(centPrice && /^\d+$/.test(centPrice), "production_fill_price_unproven");
  return BigInt(centPrice) * 10_000n;
}

/** Only normalized, authenticated complete account history is admitted. */
export function normalizeProductionSnapshot(e: KalshiDedicatedPairEvidence, identity: Identity,
  requests: Request[], fundingAnchor: KalshiDedicatedPairFundingAnchor): Snapshot {
  requireProof(e.complete && e.allTimeHistoryExhaustive && e.keyRestrictionVerified && e.tradePermissionVerified &&
    e.marketExchangeIndex === 2 && e.pair.subaccountNumber === identity.subaccount &&
    identity.subaccount === 1 && identity.exchangeIndex === 2 && e.records &&
    e.historyCoveredFrom && e.collateralSnapshot?.availableCashMicros &&
    e.collateralSnapshot.restingEntryReserveMicros === "0", "production_pair_read_unproven");
  requireProof(e.records.every(r => r.classification !== "ambiguous"), "production_ambiguous_account_history");
  const records = e.records.filter(r => r.classification === "pair");
  const orderMap = new Map<string, Snapshot["orders"][number]>();
  for (const r of records.filter(r => r.feed === "current_order" || r.feed === "historical_order")) {
    const expected = requests.find(q => q.clientOrderId === r.details.client_order_id);
    const side = recordSide(r);
    requireProof(expected && expected.market === r.details.ticker && expected.side === side &&
      expected.action === action(r, side) && BigInt(expected.limitMicros) === price(r, side) &&
      requestQuantityHundredths(expected) === decimal(r.details.initial_count_fp ?? r.details.initial_count ?? null, 2) &&
      (!expected.reduceOnly || r.details.reduce_only === "true"), "production_signed_order_identity_mismatch");
    const status = r.details.status;
    requireProof(["executed", "canceled", "cancelled", "resting", "pending"].includes(status ?? ""), "production_order_status_unproven");
    const o = { orderId: r.id, request: expected, terminal: ["executed", "canceled", "cancelled"].includes(status!),
      filledHundredths: String(decimal(r.details.fill_count_fp ?? r.details.fill_count ?? null, 2)) };
    const prior = orderMap.get(o.orderId);
    requireProof(!prior || canonical(prior) === canonical(o), "production_order_overlap_conflict");
    orderMap.set(o.orderId, o);
  }
  const fillMap = new Map<string, Snapshot["fills"][number]>();
  for (const r of records.filter(r => r.feed === "current_fill" || r.feed === "historical_fill")) {
    const o = orderMap.get(r.details.order_id ?? "");
    const side = recordSide(r), px = price(r, side);
    requireProof(o && o.request.side === side && o.request.action === action(r, side) &&
      o.request.market === r.details.ticker && r.feeMicros !== null && r.feeMicros !== undefined &&
      r.cashDeltaMicros !== null && r.occurredAt, "production_fill_identity_or_fee_missing");
    const qty = decimal(r.details.count_fp ?? r.details.count ?? null, 2), fee = money(r.feeMicros);
    const gross = o.request.action === "BUY" ? -money(r.cashDeltaMicros) - fee : money(r.cashDeltaMicros) + fee;
    const f = { id: r.id, orderId: o.orderId, clientOrderId: o.request.clientOrderId, market: o.request.market,
      side, action: o.request.action, quantityHundredths: String(qty), priceMicros: Number(px),
      grossMicros: String(gross), feeMicros: String(fee), occurredAtMs: Date.parse(r.occurredAt) };
    const old = fillMap.get(r.id);
    requireProof(!old || canonical(old) === canonical(f), "production_fill_overlap_conflict");
    fillMap.set(r.id, f);
  }
  const settlements: Snapshot["settlements"] = [];
  for (const r of records.filter(r => r.feed === "settlement")) {
    const yes = decimal(r.details.yes_count_fp ?? null, 2), no = decimal(r.details.no_count_fp ?? null, 2);
    requireProof((yes > 0n) !== (no > 0n) && r.occurredAt && r.cashDeltaMicros !== null &&
      ["yes", "no"].includes(r.details.market_result ?? ""), "production_settlement_amount_unproven");
    settlements.push({ id: r.id, market: r.details.ticker!, side: yes > 0n ? "YES" : "NO",
      result: r.details.market_result === "yes" ? "YES" : "NO",
      quantityHundredths: String(yes || no), payoutMicros: r.cashDeltaMicros,
      // Kalshi settlement fee_cost is the aggregate already charged on fills,
      // not another cash debit. The account reader verifies that aggregate.
      feeMicros: "0", occurredAtMs: Date.parse(r.occurredAt) });
  }
  const positions = records.filter(r => r.feed === "position").flatMap(r => {
    const raw = r.details.position_fp ?? r.details.position;
    requireProof(raw && /^-?\d+(?:\.\d+)?$/.test(raw), "production_position_quantity_unproven");
    const qty = decimal(raw.replace(/^-/, ""), 2);
    return qty === 0n ? [] : [{ market: r.details.ticker!, side: raw.startsWith("-") ? "NO" as const : "YES" as const,
      quantityHundredths: String(qty) }];
  });
  const unexpectedTransfers = records.some(r => ["subaccount_transfer", "cross_exchange_transfer"].includes(r.feed) &&
    r.id !== fundingAnchor.transferId && Date.parse(r.occurredAt ?? "") >= Date.parse(fundingAnchor.transferredAt));
  return { identity, observedAtMs: Date.parse(e.scanFinishedAt), historyFromMs: Date.parse(e.historyCoveredFrom),
    complete: true, authenticated: true, cashMicros: e.collateralSnapshot.availableCashMicros, cashExact: true,
    orders: [...orderMap.values()], fills: [...fillMap.values()], settlements, positions,
    unexplainedCashActivity: unexpectedTransfers };
}

export class KalshiProductionExchange implements Exchange {
  readonly mode = "LIVE" as const;
  #spent = new WeakSet<() => Promise<void>>();
  #key: ReturnType<typeof createPrivateKey>;
  readonly fingerprint: string;
  constructor(private readonly options: {
    keyId: string; privateKey: string; identity: Identity; fundingAnchor: KalshiDedicatedPairFundingAnchor;
    ticker: () => Promise<string>; requests: () => Promise<Request[]>;
    orderMarket: (orderId: string) => Promise<string | null>;
    market: (ticker: string, side: "YES" | "NO") => Promise<MarketEvidence>;
    fetchImpl?: typeof fetch;
  }) {
    const pem = options.privateKey.trim().replaceAll("\\n", "\n")
      .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n").replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
    this.#key = createPrivateKey(pem);
    this.fingerprint = createHash("sha256").update(`${options.keyId.trim()}\u001f${pem}`).digest("hex");
    requireProof(options.identity.subaccount === 1 && options.identity.exchangeIndex === 2 &&
      options.identity.keyFingerprint === this.fingerprint &&
      ["rsa", "rsa-pss"].includes(this.#key.asymmetricKeyType ?? ""), "production_signer_binding_mismatch");
  }
  async market(ticker: string, side: "YES" | "NO") { return this.options.market(ticker, side); }
  async snapshot(id: Identity, historyFromMs: number): Promise<Snapshot> {
    requireProof(canonical(id) === canonical(this.options.identity), "production_reader_binding_changed");
    const keyId = process.env.KALSHI_INDEX2_API_KEY_ID?.trim();
    const pem = process.env.KALSHI_INDEX2_PRIVATE_KEY?.trim().replaceAll("\\n", "\n")
      .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n").replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
    requireProof(keyId === this.options.keyId.trim() && pem &&
      createHash("sha256").update(`${keyId}\u001f${pem}`).digest("hex") === this.fingerprint,
    "production_reader_signer_credentials_diverged");
    const e = await readKalshiDedicatedPairEvidence(1, await this.options.ticker(), this.options.fundingAnchor, "index2");
    const s = normalizeProductionSnapshot(e, id, await this.options.requests(), this.options.fundingAnchor);
    requireProof(s.historyFromMs <= historyFromMs, "production_reader_history_gap");
    return s;
  }
  private async mutate(method: "POST" | "DELETE", path: string, body: unknown, check: () => Promise<void>) {
    requireProof(ProductionExecutor.isFinalFence(check) && !this.#spent.has(check), "production_opaque_fence_required");
    await check();
    requireProof(process.env.NODE_ENV === "production" && process.env.LIVE_EXECUTION_ENABLED === "true" &&
      process.env.V13_PRODUCTION_EXECUTION_ENABLED === "true" &&
      process.env.KALSHI_API_ENVIRONMENT === "production" &&
      process.env.MICRO_LIVE_ACCOUNT_MODE === "exclusive" && process.env.KALSHI_BOT_SUBACCOUNT === "1",
    "production_transport_disabled");
    this.#spent.add(check); // consumed even on a timeout; no in-process retries
    const timestamp = String(Date.now()), signer = createSign("sha256");
    signer.update(`${timestamp}${method}${path.split("?")[0]}`); signer.end();
    const signature = signer.sign({ key: this.#key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString("base64");
    const response = await (this.options.fetchImpl ?? fetch)(`https://external-api.kalshi.com${path}`, {
      method, headers: { "Content-Type": "application/json", "KALSHI-ACCESS-KEY": this.options.keyId,
        "KALSHI-ACCESS-TIMESTAMP": timestamp, "KALSHI-ACCESS-SIGNATURE": signature },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    requireProof(response.ok, "production_mutation_response_unproven");
    // A 2xx response carries no accounting clearance and no retry authority.
  }
  async submit(r: Request, check: () => Promise<void>) {
    await this.mutate("POST", "/trade-api/v2/portfolio/events/orders", encodeProductionOrder(r), check);
    return {};
  }
  async cancel(orderId: string, check: () => Promise<void>) {
    requireProof(/^[A-Za-z0-9._:-]{1,128}$/.test(orderId), "production_cancel_id_invalid");
    const market = await this.options.orderMarket(orderId);
    requireProof(market && /^KXBTC15M[A-Za-z0-9._-]+$/.test(market), "production_cancel_market_missing");
    await this.mutate("DELETE", `/trade-api/v2/portfolio/events/orders/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(market)}&subaccount=1&exchange_index=2`, undefined, check);
  }
}
