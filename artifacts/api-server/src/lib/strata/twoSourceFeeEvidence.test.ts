import test from "node:test";
import assert from "node:assert/strict";
import { probeCurrentKalshiFeeApi, REVIEWED_REFERENCE_PDF_SHA256, KALSHI_API_ORIGIN } from "./twoSourceFeeEvidence";

const now = Date.parse("2026-10-15T22:00:00Z");
const future = "2026-10-15T22:12:00Z";
const done = "2026-10-15T22:13:00Z";
const ticker = "KXBTC15M-26OCT15T2200";
const eventTicker = "KXBTC15M-26OCT15T2200";

function responses() {
  return {
    "/markets?series_ticker=KXBTC15M&status=open&limit=100": {
      markets: [{ ticker, event_ticker: eventTicker, close_time: future,
        status: "open" }], cursor: "",
    },
    ["/markets/" + ticker]: {
      market: { ticker, event_ticker: eventTicker, close_time: future, status: "open",
        expiration_time: done, latest_expiration_time: done, expected_expiration_time: done },
    },
    ["/events/" + eventTicker]: {
      event: { event_ticker: eventTicker, series_ticker: "KXBTC15M",
        fee_type_override: null, fee_multiplier_override: null },
    },
    "/series/KXBTC15M": {
      series: { ticker: "KXBTC15M", exchange_index: 2, fee_type: "quadratic", fee_multiplier: 1 },
    },
    "/series/fee_changes?series_ticker=KXBTC15M&show_historical=false&limit=100": {
      series_fee_change_arr: [], cursor: "",
    },
    ["/events/fee_changes?event_ticker=" + eventTicker + "&show_historical=false&limit=100"]: {
      event_fee_changes: [], cursor: "",
    },
  } as Record<string, Record<string, unknown>>;
}
function transport(pages: Record<string, Record<string, unknown>>,
  opts: { status?: number; redirects?: boolean } = {}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input), origin = "https://external-api.kalshi.com/trade-api/v2";
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(url.startsWith(origin + "/"), "no caller-controlled URL");
    const body = pages[url.slice(origin.length)];
    return new Response(JSON.stringify(body ?? {unexpected:true}), {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
test("read-only two-source candidate accepts fixed series + clear event + complete fee changes", async () => {
  const result = await probeCurrentKalshiFeeApi(transport(responses()), () => now);
  assert.equal(result.ok, true);
  assert.equal(result.feeType, "quadratic");
  assert.equal(result.feeMultiplier, "1");
  assert.equal(result.referenceDigest, REVIEWED_REFERENCE_PDF_SHA256);
  assert.match(result.metadataDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(result.pdfProvenanceApproved, false);
  assert.equal(result.ownerPolicyApproved, false);
  assert.equal(result.commissioningApproved, false);
  assert.equal(result.tradingEnabled, false);
});
test("rejects incorrect series multiplier or unrecognized fee type", async () => {
  for (const patch of [{fee_multiplier:0.5},{fee_type:"flat"}]) {
    const pages=responses();
    Object.assign(pages["/series/KXBTC15M"].series as object,patch);
    assert.equal((await probeCurrentKalshiFeeApi(transport(pages),()=>now)).ok,false);
  }
});
test("rejects event override or any fee change scheduled before market lifecycle ends", async () => {
  const pages=responses();
  (pages["/events/" + eventTicker].event as Record<string,unknown>).fee_multiplier_override=2;
  assert.equal((await probeCurrentKalshiFeeApi(transport(pages),()=>now)).ok,false);
  const other=responses();
  other["/series/fee_changes?series_ticker=KXBTC15M&show_historical=false&limit=100"].series_fee_change_arr=[
    {id:"change1",scheduled_ts:"2026-10-15T22:01:00Z",series_ticker:"KXBTC15M",
      fee_type:"quadratic",fee_multiplier:1},
  ];
  assert.equal((await probeCurrentKalshiFeeApi(transport(other),()=>now)).ok,false);
});
test("rejects incomplete pagination, missing metadata, ambiguous target and provider failures", async () => {
  const pages=responses();
  pages["/series/fee_changes?series_ticker=KXBTC15M&show_historical=false&limit=100"].cursor="missing-page";
  assert.equal((await probeCurrentKalshiFeeApi(transport(pages),()=>now)).ok,false);
  const broken=responses();
  broken["/series/KXBTC15M"]={series:null};
  assert.equal((await probeCurrentKalshiFeeApi(transport(broken),()=>now)).ok,false);
  assert.equal((await probeCurrentKalshiFeeApi(transport(responses(),{status:429}),()=>now)).ok,false);
});

test("pins the documented official Kalshi Predictions API origin", () => {
  assert.equal(KALSHI_API_ORIGIN,"https://external-api.kalshi.com/trade-api/v2");
});
test("rejects wrong-exchange series metadata and conflicting market/event shard", async () => {
  for (const [page,field] of [
    ["/series/KXBTC15M","series"],
    ["/markets/" + ticker,"market"],
    ["/events/" + eventTicker,"event"],
  ] as const) {
    const pages = responses();
    (pages[page]![field] as Record<string, unknown>).exchange_index = 0;
    const result = await probeCurrentKalshiFeeApi(transport(pages), () => now);
    assert.equal(result.ok, false, page);
    assert.equal(result.tradingEnabled, false);
    assert.equal(result.pdfProvenanceApproved, false);
  }
});
test("ignores other-exchange listing candidates instead of misattributing fees", async () => {
  const pages = responses();
  (pages["/markets?series_ticker=KXBTC15M&status=open&limit=100"]!.markets as Record<string,unknown>[])[0]!.exchange_index=0;
  assert.equal((await probeCurrentKalshiFeeApi(transport(pages),()=>now)).ok,false);
});

test("exact market fee probe never substitutes a different open BTC contract", async () => {
  const wrong="KXBTC15M-26OCT15T2215";
  const missing=await probeCurrentKalshiFeeApi(transport(responses()),()=>now,wrong);
  assert.equal(missing.ok,false);
  assert.equal(missing.reason,"exact_market_not_in_complete_open_listing");
  const valid=await probeCurrentKalshiFeeApi(transport(responses()),()=>now,ticker);
  assert.equal(valid.ok,true);
  assert.equal(valid.marketTicker,ticker);
  assert.equal((await probeCurrentKalshiFeeApi(transport(responses()),()=>now,"ABC")).ok,false);
});
