/**
 * Fail-closed fee metadata for the EXACT market about to be ordered by the
 * personal C52/C53 worker. Pure validation; no signals, prices or strategy
 * parameters are changed here. Re-run through readMarket at FINAL POST fence.
 */
import { digest } from "../v13-production/types";

type Obj = Record<string, unknown>;
function obj(x: unknown): Obj | null {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? x as Obj : null;
}
const iso = (x: unknown): number | null => {
  if (typeof x !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(x)) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
};
function scheduledClear(response: unknown, key: string, lifecycleEnd: number): boolean {
  const r = obj(response);
  if (!r || (r.cursor !== undefined && r.cursor !== "") ||
      !Array.isArray(r[key]) || r[key].length > 100) return false;
  return r[key].every((value: unknown) => {
    const row=obj(value);
    const at=iso(row?.scheduled_ts);
    return row && typeof row.id === "string" && row.id.length > 0 &&
      at !== null && at > lifecycleEnd;
  });
}
export type OwnedFeeMetadataInput = {
  marketTicker: string;
  seriesPayload: unknown;
  marketPayload: unknown;
  eventPayload: unknown;
  seriesChangesPayload: unknown;
  eventChangesPayload: unknown;
  observedAtMs: number;
  nowMs: number;
};
export type OwnedFeeMetadataProof =
  | { ok: true; fingerprint: string; eventTicker: string; verifiedAtMs: number }
  | { ok: false; reason: "production_event_fee_evidence_unverified" };

export function verifyOwnedFeeMetadata(input: OwnedFeeMetadataInput): OwnedFeeMetadataProof {
  const fail = (): OwnedFeeMetadataProof =>
    ({ok:false,reason:"production_event_fee_evidence_unverified"});
  if (!/^KXBTC15M-[A-Za-z0-9-]+$/.test(input.marketTicker) ||
      !Number.isSafeInteger(input.observedAtMs) || !Number.isSafeInteger(input.nowMs) ||
      input.nowMs < input.observedAtMs || input.nowMs - input.observedAtMs > 15_000)
    return fail();
  const market=obj(obj(input.marketPayload)?.market);
  const series=obj(obj(input.seriesPayload)?.series);
  const event=obj(obj(input.eventPayload)?.event);
  const eventTicker=market?.event_ticker;
  if (!market || !series || !event ||
      market.ticker !== input.marketTicker ||
      market.exchange_index !== 2 ||
      typeof eventTicker !== "string" || !/^KXBTC15M-[A-Za-z0-9-]+$/.test(eventTicker) ||
      event.event_ticker !== eventTicker || event.series_ticker !== "KXBTC15M" ||
      (event.exchange_index !== undefined && event.exchange_index !== 2) ||
      series.ticker !== "KXBTC15M" || series.exchange_index !== 2 ||
      series.fee_type !== "quadratic" ||
      ![1,"1","1.0"].includes(series.fee_multiplier as string|number) ||
      (event.fee_type_override !== null && event.fee_type_override !== undefined) ||
      (event.fee_multiplier_override !== null && event.fee_multiplier_override !== undefined) ||
      Object.keys(market).some(key =>
        /fee|rebate/i.test(key) && market[key] !== null &&
        market[key] !== undefined && market[key] !== false))
    return fail();
  const closing=iso(market.close_time);
  if (closing === null || closing <= input.nowMs) return fail();
  const expires=[market.expiration_time, market.latest_expiration_time,
    market.expected_expiration_time];
  const timeline=expires.map(iso);
  if (timeline.some(t => t===null || (t as number)<closing)) return fail();
  const end=Math.max(closing,...timeline as number[]);
  if (!scheduledClear(input.seriesChangesPayload,"series_fee_change_arr",end) ||
      !scheduledClear(input.eventChangesPayload,"event_fee_changes",end)) return fail();
  const sr=obj(input.seriesChangesPayload)!;
  const er=obj(input.eventChangesPayload)!;
  return {
    ok:true,eventTicker,verifiedAtMs:input.nowMs,
    fingerprint:digest({
      scope:"personal_KXBTC15M_market_fee_metadata_v1",
      market:input.marketTicker,event:eventTicker,
      feeType:"quadratic",multiplier:"1",
      seriesFeeChanges:sr.series_fee_change_arr,
      eventFeeChanges:er.event_fee_changes,
      marketClose:market.close_time,expiry:expires,
    }),
  };
}
