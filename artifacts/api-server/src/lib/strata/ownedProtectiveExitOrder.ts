import { randomUUID } from "node:crypto";
import type { MarketEvidence } from "../v13-production/types";
import type { ProtectiveExitDispatch } from "../v13-production/consumer";
import type { EmergencyExitOrder } from "./ownerFeeEmergencyExit";

/**
 * Convert VERIFIED owned V13 depth to exactly one V2 reduce-only IOC candidate.
 * There is no authority or HTTP request here. All monetary arithmetic uses
 * integer ticks/hundredths: NO liquidation is a YES bid at (1 - NO bid).
 * Never sweep beyond top-of-book liquidity or the owned position.
 */
type Selection = Parameters<ProtectiveExitDispatch>[0];
const MARKET = /^KXBTC15M-[A-Za-z0-9-]+$/;
const PRICE = /^0\.[0-9]{4}$/;
const COUNT = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/;
const MAX_CONTRACT_HUNDREDTHS = 100_000n;
const deny = (reason: string): never => { throw new Error(reason); };

function quantityHundredths(raw: string): bigint {
  const m = COUNT.exec(raw);
  if (!m) return deny("protective_exit_depth_quantity_invalid");
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}
function priceTicks(raw: string): number {
  if (!PRICE.test(raw)) return deny("protective_exit_book_price_invalid");
  return Number(raw.slice(2));
}
export function makeOwnedProtectiveExitOrder(
  selection: Selection, book: MarketEvidence, nowMs: number = Date.now(),
  id: string = randomUUID(),
): EmergencyExitOrder {
  if (!MARKET.test(selection.market) || !["YES", "NO"].includes(selection.side) ||
      !/^(0|[1-9][0-9]*)$/.test(selection.quantityHundredths) ||
      !Number.isSafeInteger(selection.minimumExitMicros) ||
      selection.minimumExitMicros < 1 || selection.minimumExitMicros >= 1_000_000) {
    return deny("protective_exit_owned_position_or_floor_invalid");
  }
  if (!Number.isSafeInteger(nowMs) ||
      !Number.isSafeInteger(book?.observedAtMs) ||
      nowMs < book.observedAtMs || nowMs - book.observedAtMs > 3_000) {
    return deny("protective_exit_book_not_fresh");
  }
  if (!Array.isArray(book.bids) || !book.bids.length || !book.bids[0]) {
    return deny("protective_exit_book_liquidity_missing");
  }
  const best = book.bids[0];
  // Book bid prices are for the selected YES or NO position, whereas V2
  // prices always refer to YES. The complementary NO conversion is exact.
  const bid = priceTicks(best.priceDollars);
  const yesTicks = selection.side === "YES" ? bid : 10_000 - bid;
  const proceedsMicros = (selection.side === "YES" ? yesTicks : 10_000 - yesTicks) * 100;
  if (yesTicks < 1 || yesTicks > 9_999 || proceedsMicros < selection.minimumExitMicros) {
    return deny("protective_exit_below_owner_floor_or_invalid_price");
  }
  const owned = BigInt(selection.quantityHundredths);
  const depth = quantityHundredths(best.availableContracts);
  const count = [owned, depth, MAX_CONTRACT_HUNDREDTHS].reduce((a,b) => a < b ? a : b);
  if (count <= 0n) return deny("protective_exit_verified_liquidity_empty");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return deny("protective_exit_client_id_invalid");
  }
  return Object.freeze({
    ticker: selection.market,
    side: selection.side === "YES" ? "ask" : "bid",
    count: `${count / 100n}.${String(count % 100n).padStart(2, "0")}`,
    price: `0.${String(yesTicks).padStart(4, "0")}`,
    client_order_id: `v13p-${id.toLowerCase()}`,
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
    post_only: false,
    reduce_only: true,
    subaccount: 1,
    exchange_index: 2,
  });
}
