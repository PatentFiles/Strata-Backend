import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
/*
 * The isolated micro-live runner verifies the development DB and creates a
 * disposable schema; fee approval is persisted there, never in the real
 * configuration. Keep pdfjs-dist external for pdf.worker.mjs resolution.
 */
import { eq } from "drizzle-orm";
import { db, microLiveConfigTable, pool } from "@workspace/db";
import {
  maximumExitCashDebitOnMarketGridPerContractMicros,
  feeBoundForContracts,
  feeEvidenceMatchesApproval,
  entryCashDebitMicrosForContracts,
  maximumEntryCashDebitPerContractMicros,
  maximumEntryFeePerContractMicros,
  maximumExitFeePerContractAtLimitMicros,
  maximumExitFeePerContractMicros,
  maximumExitLossAtLimitOnMarketGridPerContractMicros,
  maximumExitLossOnMarketGridPerContractMicros,
  readCurrentEntryFeeTerms,
} from "./microLiveEntryFees";
import {
  BOUNDED_RUN_TEST_CAP_MICROS, withinAllInLiveTestCap,
} from "./microLiveFeeCap";
import {
  approvedFeeSession, approveFeeSchedule, checkApprovedFeeArtifactNow, feeApprovalView,
  parseScheduleText, reviewFeeSchedulePdf, revokeFeeApproval,
  STANDING_FEE_POLICY_VERSION,
} from "./microLiveFeeApproval";
import { getFeeVerificationState } from "./microLiveFeeVerification";

if (!/^micro_live_test_[a-f0-9]{24}$/.test(process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "")) {
  throw new Error("Fee approval tests require a disposable isolated schema");
}
const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
});
const ticker = "KXBTC15M-SAMPLE";
const eventTicker = "KXBTC15M-EVENT";
const taperedPriceRanges = [
  { start: "0.0000", end: "0.1000", step: "0.0010" },
  { start: "0.1000", end: "0.9000", step: "0.0100" },
  { start: "0.9000", end: "1.0000", step: "0.0010" },
];

function response(body: unknown): Response {
  return { ok: true, json: async () => body, text: async () => String(body) } as Response;
}

function fixture(options: {
  seriesMultiplier?: number;
  seriesExchangeIndex?: number;
  eventExchangeIndex?: number;
  eventMultiplier?: number | null;
  eventType?: string | null;
  seriesChanges?: unknown[];
  eventChanges?: unknown[];
  scheduledSeriesMultiplier?: number;
  scheduledEventMultiplier?: number;
  scheduledAt?: number;
  seriesType?: string;
  selectedTicker?: string;
  additionalOpenMarket?: "earlier" | "tied";
  listingPriceRanges?: unknown;
  marketPriceRanges?: unknown;
  marketFeeFields?: Record<string, unknown>;
  marketExchangeIndex?: number;
} = {}) {
  const closes = new Date(Date.now() + 600_000).toISOString();
  const expiration = new Date(Date.parse(closes) + 7 * 24 * 60 * 60_000).toISOString();
  const scheduledAt = new Date(options.scheduledAt ?? Date.now() + 30_000).toISOString();
  const listingPriceRanges = "listingPriceRanges" in options
    ? options.listingPriceRanges : taperedPriceRanges;
  const marketPriceRanges = "marketPriceRanges" in options
    ? options.marketPriceRanges : taperedPriceRanges;
  const market = {
    ticker, event_ticker: eventTicker, status: "active",
    exchange_index: options.marketExchangeIndex ?? 2, close_time: closes,
    expiration_time: expiration, latest_expiration_time: expiration,
    expected_expiration_time: closes, price_ranges: marketPriceRanges,
    ...options.marketFeeFields,
  };
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith("https://external-api.kalshi.com/trade-api/v2/"), "only canonical Kalshi API host");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    seen.push(url);
    if (url.includes("fee-schedule")) throw new Error("fee-schedule URL must never be requested");
    if (url.includes("/markets?")) {
      const targetMarket = {
        ...market, ticker: options.selectedTicker ?? ticker,
        price_ranges: listingPriceRanges,
      };
      const additionalMarket = options.additionalOpenMarket ? [{
        ...market,
        ticker: "KXBTC15M-EARLIER",
        close_time: options.additionalOpenMarket === "tied"
          ? closes : new Date(Date.now() + 300_000).toISOString(),
        price_ranges: listingPriceRanges,
      }] : [];
      return response({ markets: [targetMarket, ...additionalMarket], cursor: "" });
    }
    if (url.endsWith(`/markets/${ticker}`)) return response({ market });
    if (url.endsWith("/series/KXBTC15M")) return response({
      series: {
        ticker: "KXBTC15M", exchange_index: options.seriesExchangeIndex ?? 2,
        fee_type: options.seriesType ?? "quadratic",
        fee_multiplier: options.seriesMultiplier ?? 1,
        last_updated_ts: "2026-09-18T15:20:18.321673Z",
      },
    });
    if (url.endsWith(`/events/${eventTicker}`)) return response({
      event: { event_ticker: eventTicker, series_ticker: "KXBTC15M",
        exchange_index: options.eventExchangeIndex ?? 2,
        // Kalshi currently emits year-one when the event has no override update.
        last_updated_ts: "0001-01-01T00:00:00Z",
        fee_type_override: options.eventType ?? null,
        fee_multiplier_override: options.eventMultiplier ?? null },
    });
    if (url.includes("/series/fee_changes?")) return response({
      series_fee_change_arr: options.seriesChanges ??
        (options.scheduledSeriesMultiplier === undefined ? [] : [{
          id: "series-change-1", series_ticker: "KXBTC15M",
          fee_type: "quadratic", fee_multiplier: options.scheduledSeriesMultiplier,
          scheduled_ts: scheduledAt,
        }]),
    });
    if (url.includes("/events/fee_changes?")) return response({
      event_fee_changes: options.eventChanges ??
        (options.scheduledEventMultiplier === undefined ? [] : [{
          id: "event-change-1", event_ticker: eventTicker, series_ticker: "KXBTC15M",
          fee_type_override: "quadratic",
          fee_multiplier_override: options.scheduledEventMultiplier,
          scheduled_ts: scheduledAt,
        }]), cursor: "",
    });
    throw new Error(`Unexpected fee GET: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function currentVerificationState(approval: {
  id: string;
  digest: string;
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
}) {
  return getFeeVerificationState({
    approvalId: approval.id,
    approvalDigest: approval.digest,
    policyVersion: approval.policyVersion,
    sourceUrl: approval.sourceUrl,
    formulaVersion: approval.formulaVersion,
  });
}

function examplePdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 10 Tf 40 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

const pdf = examplePdf(
  "Effective July 7, 2026. General Trading Fees apply to all markets. " +
  "fees = round up(M x 0.07 x C x P x (1-P)).",
);
async function approveFreshTestPolicy() {
  const view = await reviewFeeSchedulePdf(pdf);
  assert.equal(view.status, "review");
  assert.equal(view.effectiveDate, "2026-07-07");
  assert.match(view.feeRule!, /Applicability is explicitly stated/);
  assert.equal(await approveFeeSchedule(view.reviewId!, "wrong", "test-admin"), null);
  assert.equal((await approveFeeSchedule(view.reviewId!, view.digest!, "test-admin"))?.status,
    "approved");
}

before(async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://kalshi.com/docs/kalshi-fee-schedule.pdf");
    assert.equal(init?.method, "GET");
    assert.equal(
      (init?.headers as Record<string, string> | undefined)?.Accept,
      "application/pdf",
    );
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.length),
      },
    });
  }) as typeof fetch;
  await db.insert(microLiveConfigTable).values({ id: "singleton" });
});

beforeEach(async () => {
  await approveFreshTestPolicy();
});

test("persisted standing approval has no time expiry and is bound to the PDF digest", async (t) => {
  const current = await approvedFeeSession();
  assert.ok(current);
  assert.equal(current.policyVersion, STANDING_FEE_POLICY_VERSION);
  assert.equal(current.maximumExposureMicros, 5_000_000);
  assert.equal(current.approvedBy, "test-admin");
  assert.equal((await feeApprovalView()).expiresAt, null);
  assert.equal((await currentVerificationState(current))?.status, "unavailable",
    "a successful PDF read alone must not produce runtime verified evidence");
  const result = await readCurrentEntryFeeTerms(ticker, fixture().fetchImpl);
  assert.equal(result?.sessionStartedAt, current.approvedAt);
  const gate = await currentVerificationState(current);
  assert.equal(gate?.status, "verified");
  assert.equal(gate?.feeEvidenceFingerprint, result?.fingerprint);
  assert.equal(gate?.checkedAt?.getTime(), result?.verifiedAt);
  const actualNow = Date.now();
  t.mock.method(Date, "now", () => actualNow + 30 * 24 * 60 * 60_000);
  assert.equal((await approvedFeeSession())?.digest, current.digest);
  assert.equal((await feeApprovalView()).status, "approved");
  t.mock.restoreAll();
});

test("PDF 429 preserves the approved digest; fresh live metadata can restore the runtime gate", async () => {
  const current = await approvedFeeSession();
  assert.ok(current);
  assert.equal((await currentVerificationState(current))?.status, "unavailable");
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 429 })) as typeof fetch;
  try {
    assert.equal(await checkApprovedFeeArtifactNow(), false);
    const outage = await currentVerificationState(current);
    assert.equal(outage?.status, "unavailable");
    assert.equal((await approvedFeeSession())?.digest, current.digest,
      "temporary PDF outage must not alter or invalidate the approved digest");
    const config = (await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")))[0]!;
    assert.equal(config.microLiveFeeArtifactStatus, "unavailable");

    const terms = await readCurrentEntryFeeTerms(ticker, fixture().fetchImpl);
    assert.ok(terms, "metadata may be re-verified while the approved PDF is unavailable");
    const refreshed = await currentVerificationState(current);
    assert.equal(refreshed?.status, "verified");
    assert.equal(refreshed?.feeEvidenceFingerprint, terms.fingerprint);
    assert.equal(refreshed?.checkedAt?.getTime(), terms.verifiedAt);
  } finally {
    globalThis.fetch = (async () => new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.length),
      },
    })) as typeof fetch;
  }
});

test("six-decimal quadratic fees bound 100 independent hundredth-contract fills", () => {
  assert.equal(maximumEntryFeePerContractMicros(1, "0.4000"), 16_800);
  assert.equal(maximumEntryFeePerContractMicros(1, "0.5000"), 17_500);
  assert.equal(maximumEntryFeePerContractMicros("0.5", "0.5000"), 8_800);
  assert.equal(maximumEntryFeePerContractMicros(100, "0.4000"), 1_680_000);
  assert.equal(maximumEntryFeePerContractMicros(0, "0.4000"), null);
  assert.equal(maximumEntryFeePerContractMicros("1e2", "0.4000"), null);
  assert.equal(maximumEntryFeePerContractMicros(1, "1.0000"), null);
});

test("signed fills floor to non-direct cents, counting entry cash debit once", () => {
  const parsed = parseScheduleText(
    "Effective July 7, 2026. General Trading Fees apply to all markets. " +
    "Standard quadratic taker fee = 0.07 x contracts x price x 1 - price. " +
    "The fee plus position cost is rounded up to a centicent ($0.0001).",
  );
  assert.match(parsed?.feeRule ?? "", /combined fee and position cost rounded to a centicent \(\$0\.0001\)/);
  const floorToCent = (amount: bigint) => amount >= 0n
    ? amount / 10_000n * 10_000n
    : -((-amount + 9_999n) / 10_000n) * 10_000n;
  const grossFillRevenueMicros = 4_000n; // 0.01 contract at $0.40
  const ceilSixDecimalFeeMicros = 168n; // ceil_6dp(0.07 x 0.01 x 0.4 x 0.6)
  const signedBuyNet = floorToCent(-grossFillRevenueMicros - ceilSixDecimalFeeMicros);
  const signedSellNet = floorToCent(grossFillRevenueMicros - ceilSixDecimalFeeMicros);
  assert.equal(signedBuyNet, -10_000n);
  assert.equal(signedSellNet, 0n);
  assert.equal(grossFillRevenueMicros - signedSellNet, 4_000n);
  assert.equal(entryCashDebitMicrosForContracts("0.4000", 1), 1_000_000);
  // Each of 100 possible 0.01 fills independently debits a cent, including
  // its $0.000168 model fee; the fee is not added again to the cash debit.
  assert.equal(maximumEntryFeePerContractMicros(1, "0.4000"), 16_800);
  assert.equal(maximumExitFeePerContractMicros(1), 999_900);
  assert.equal(1_000_000 + 999_900, 1_999_900,
    "withheld proceeds are distinct from additional starting cash");
  assert.equal(maximumEntryCashDebitPerContractMicros(
    1, "0.4000", taperedPriceRanges, "yes",
  ), 1_000_000);
  assert.equal(maximumExitLossOnMarketGridPerContractMicros(
    1, taperedPriceRanges, "no",
  ), 999_000);
  assert.equal(maximumExitLossAtLimitOnMarketGridPerContractMicros(
    1, "0.9900", taperedPriceRanges, "yes",
  ), 999_000);
  assert.equal(maximumEntryCashDebitPerContractMicros(
    1, "0.4050", taperedPriceRanges, "yes",
  ), null);
});

test("exact active market binds tapered valid prices and counts cash debit and exit loss", async () => {
  const first = fixture();
  const base = await readCurrentEntryFeeTerms(ticker, first.fetchImpl);
  assert.equal(base?.feePerContractMicrosAtLimit("0.4000"), 16_800);
  assert.equal(base?.entryCashDebitPerContractMicrosAtLimit?.("0.4000", "yes"), 1_000_000);
  assert.equal(base?.entryCashDebitPerContractMicrosAtLimit?.("0.4000", "no"), 1_000_000);
  assert.equal(base?.exitFeePerContractMicrosAtLimit("0.9900"), 999_000);
  assert.equal(base?.maximumExitLossPerContractMicros?.("yes"), 999_000);
  assert.equal(base?.maximumExitLossPerContractMicros?.("no"), 999_000);
  assert.equal(base?.entryCashDebitPerContractMicrosAtLimit?.("0.4050", "yes"), null,
    "a four-decimal quote is not necessarily on the selected market grid");
  assert.equal(base?.feePerContractMicrosAtLimit("0.4050"), null);
  assert.equal(base?.exitFeePerContractMicrosAtLimit("0.9901"), null);
  assert.deepEqual(base?.validMarketPriceRanges, taperedPriceRanges);
  assert.equal(base?.eventTicker, eventTicker);
  assert.ok(first.seen.some((url) => url.includes("/events/fee_changes?event_ticker=")));
  const narrowerGrid = [
    { start: "0.0000", end: "0.1000", step: "0.0020" },
    { start: "0.1000", end: "0.9000", step: "0.0200" },
    { start: "0.9000", end: "1.0000", step: "0.0020" },
  ];
  const changedGrid = await readCurrentEntryFeeTerms(ticker, fixture({
    listingPriceRanges: narrowerGrid,
    marketPriceRanges: narrowerGrid,
  }).fetchImpl);
  assert.notEqual(changedGrid?.fingerprint, base?.fingerprint,
    "the selected market's exact price grid is part of fee evidence");
  assert.equal(changedGrid?.entryCashDebitPerContractMicrosAtLimit?.("0.4000", "yes"),
    1_000_000);
  const changedSeries = await readCurrentEntryFeeTerms(ticker, fixture({
    seriesMultiplier: 2,
  }).fetchImpl);
  assert.equal(changedSeries?.feePerContractMicrosAtLimit("0.4000"), 33_600);
  assert.equal(changedSeries?.entryCashDebitPerContractMicrosAtLimit?.("0.4000", "yes"), 1_000_000);
  assert.equal(changedSeries?.exitFeePerContractMicrosAtLimit("0.9900"), 999_000);
  assert.notEqual(changedSeries?.fingerprint, base?.fingerprint);
  const overridden = await readCurrentEntryFeeTerms(ticker, fixture({
    eventMultiplier: 3, eventType: "quadratic",
  }).fetchImpl);
  assert.equal(overridden?.feePerContractMicrosAtLimit("0.4000"), 50_400);
  assert.equal(overridden?.exitFeePerContractMicrosAtLimit("0.9900"), 999_000);
  assert.notEqual(overridden?.fingerprint, base?.fingerprint);
});

test("series metadata supplies the inherited model and the live event timestamp sentinel is missing", async () => {
  const evidence = fixture();
  const terms = await readCurrentEntryFeeTerms(ticker, evidence.fetchImpl);
  assert.ok(terms);
  assert.ok(evidence.seen.includes("https://external-api.kalshi.com/trade-api/v2/series/KXBTC15M"));
  assert.ok(evidence.seen.includes(
    `https://external-api.kalshi.com/trade-api/v2/events/${eventTicker}`,
  ));
  assert.equal(terms.feePerContractMicrosAtLimit("0.4000"), 16_800,
    "KXBTC15M quadratic series multiplier 1 is used when event overrides are null");
});

test("scheduled series multiplier before/during the market lifecycle raises the fee bound", async () => {
  const terms = await readCurrentEntryFeeTerms(ticker, fixture({
    scheduledSeriesMultiplier: 2,
    scheduledAt: Date.now() + 6 * 60 * 60_000,
  }).fetchImpl);
  assert.equal(terms?.feePerContractMicrosAtLimit("0.4000"), 33_600);
  assert.equal(terms?.entryCashDebitPerContractMicrosAtLimit?.("0.4000", "yes"), 1_000_000);
});

test("scheduled event override has precedence and scheduled clearing inherits series changes", async () => {
  const at = Date.now() + 24 * 60 * 60_000;
  const terms = await readCurrentEntryFeeTerms(ticker, fixture({
    seriesMultiplier: 1,
    eventMultiplier: 1,
    eventType: "quadratic",
    scheduledAt: at,
    scheduledSeriesMultiplier: 2,
    eventChanges: [{
      id: "event-clear", event_ticker: eventTicker, series_ticker: "KXBTC15M",
      fee_type_override: null, fee_multiplier_override: null,
      scheduled_ts: new Date(at).toISOString(),
    }],
  }).fetchImpl);
  assert.equal(terms?.feePerContractMicrosAtLimit("0.4000"), 33_600,
    "after the scheduled event override is cleared, the new series multiplier applies");
});

test("distant scheduled event override beats a higher series change", async () => {
  const at = Date.now() + 48 * 60 * 60_000;
  const terms = await readCurrentEntryFeeTerms(ticker, fixture({
    scheduledAt: at,
    scheduledSeriesMultiplier: 100,
    eventChanges: [{
      id: "event-override-1", event_ticker: eventTicker, series_ticker: "KXBTC15M",
      fee_type_override: "quadratic", fee_multiplier_override: 3,
      scheduled_ts: new Date(at).toISOString(),
    }],
  }).fetchImpl);
  assert.equal(terms?.feePerContractMicrosAtLimit("0.4000"), 50_400,
    "the future event override remains effective over the simultaneous series change");
});

test("scheduled multiplier uses worst lifecycle debit and the $5 cap blocks excess risk", async () => {
  const terms = await readCurrentEntryFeeTerms(ticker, fixture({
    scheduledSeriesMultiplier: 100,
    scheduledAt: Date.now() + 6 * 24 * 60 * 60_000,
  }).fetchImpl);
  const perContractDebit = terms?.entryCashDebitPerContractMicrosAtLimit?.("0.4000", "yes");
  assert.equal(perContractDebit, 3_000_000);
  assert.equal(withinAllInLiveTestCap(
    0, feeBoundForContracts(perContractDebit!, 2)!, 0, BOUNDED_RUN_TEST_CAP_MICROS,
  ), false);
});

test("a target that is no longer the unique earliest open market is definitively invalid", async () => {
  for (const additionalOpenMarket of ["earlier", "tied"] as const) {
    await approveFreshTestPolicy();
    const approval = await approvedFeeSession();
    assert.ok(approval);
    assert.equal(await readCurrentEntryFeeTerms(ticker, fixture({
      additionalOpenMarket,
    }).fetchImpl), null);
    assert.equal((await currentVerificationState(approval))?.status, "invalid");
    assert.equal((await currentVerificationState(approval))?.reason,
      "target_market_not_unique_earliest_open_market");
  }
});

test("stale completed GET evidence is invalid while transport failures remain retryable", async (t) => {
  await approveFreshTestPolicy();
  const staleApproval = await approvedFeeSession();
  assert.ok(staleApproval);
  const evidence = fixture();
  const actualNow = Date.now;
  const delayedClockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const result = await evidence.fetchImpl(input, init);
    if (String(input).includes("/events/fee_changes?")) {
      t.mock.method(Date, "now", () => actualNow() + 15_001);
    }
    return result;
  }) as typeof fetch;
  assert.equal(await readCurrentEntryFeeTerms(ticker, delayedClockFetch), null);
  t.mock.restoreAll();
  assert.equal((await currentVerificationState(staleApproval))?.status, "invalid");
  assert.equal((await currentVerificationState(staleApproval))?.reason,
    "fee_evidence_stale_or_expired");

  await approveFreshTestPolicy();
  const approval = await approvedFeeSession();
  assert.ok(approval);
  assert.equal(await readCurrentEntryFeeTerms(ticker, (async () => {
    throw new Error("temporary network failure");
  }) as typeof fetch), null);
  assert.equal((await currentVerificationState(approval))?.status, "unavailable");
});

test("multiplier fees enter signed cash debits before cent rounding", async () => {
  const highMultiplier = await readCurrentEntryFeeTerms(ticker, fixture({
    seriesMultiplier: 100,
  }).fetchImpl);
  // At a $0.40 buy, each 0.01 fill costs $0.004 gross plus $0.0168
  // rounded model fee: the resulting $0.0208 debit floors to $0.03.
  assert.equal(highMultiplier?.entryCashDebitPerContractMicrosAtLimit?.("0.4000", "yes"),
    3_000_000);
  assert.equal(highMultiplier?.feePerContractMicrosAtLimit("0.4000"), 1_680_000);
});

test("malformed, mismatched, and absent valid-price grids fail closed", async () => {
  const cases = [
    { marketPriceRanges: [{ start: "0.0000", end: "0.1000", step: "0.0000" }] },
    { marketPriceRanges: [
      { start: "0.0000", end: "0.1000", step: "0.0030" },
    ] },
    { marketPriceRanges: null },
    { listingPriceRanges: null },
    { listingPriceRanges: [
      ...taperedPriceRanges.slice(0, 2),
      { ...taperedPriceRanges[2], step: "0.0020" },
    ] },
  ];
  for (const options of cases) {
    await approveFreshTestPolicy();
    assert.equal(await readCurrentEntryFeeTerms(ticker, fixture(options).fetchImpl), null);
  }
});

test("cash policy reserves negative sell cash, never withheld proceeds", async () => {
  for (const side of ["yes", "no"] as const) {
    assert.equal(maximumExitCashDebitOnMarketGridPerContractMicros(1, taperedPriceRanges, side), 0);
    assert.equal(maximumExitCashDebitOnMarketGridPerContractMicros(1, taperedPriceRanges, side, "0.3900"), 0);
    assert.equal(maximumExitCashDebitOnMarketGridPerContractMicros(100, taperedPriceRanges, side), 2_000_000);
    assert.equal(maximumExitCashDebitOnMarketGridPerContractMicros(1, taperedPriceRanges, side, "0.4050"), null);
  }
  const terms = await readCurrentEntryFeeTerms(ticker, fixture().fetchImpl);
  assert.equal(terms?.maximumExitCashDebitPerContractMicros?.("yes"), 0);
  assert.equal(terms?.exitCashDebitPerContractMicrosAtLimit?.("0.3900", "no"), 0);
  assert.equal(feeEvidenceMatchesApproval(terms!.fingerprint, await approvedFeeSession()), true);
  assert.equal(feeEvidenceMatchesApproval(terms!.fingerprint, null), false);
  assert.equal(feeEvidenceMatchesApproval(terms!.fingerprint, { id: "wrong", digest: "wrong" }), false);
  assert.equal(feeEvidenceMatchesApproval(
    terms!.fingerprint.replace("cash-risk-v2", "v1"), await approvedFeeSession(),
  ), false);
  for (const invalid of [null, 0, -1, NaN, "1e2"]) {
    assert.equal(maximumExitCashDebitOnMarketGridPerContractMicros(invalid, taperedPriceRanges), null);
  }
  assert.equal(maximumExitCashDebitOnMarketGridPerContractMicros(1, null), null);
});

test("wrong market, fee fields, or ambiguous scheduled fee changes block entry", async () => {
  for (const options of [
    { selectedTicker: "KXBTC15M-OTHER" },
    { seriesChanges: [{ scheduled_ts: new Date().toISOString() }] },
    { eventChanges: [{ scheduled_ts: new Date().toISOString() }] },
    { seriesType: "flat" },
    { eventType: "flat" },
    { eventType: "quadratic", eventMultiplier: null },
    { marketFeeFields: { fee_type: "quadratic", fee_multiplier: 2 } },
  ]) {
    await approveFreshTestPolicy();
    assert.equal(await readCurrentEntryFeeTerms(ticker, fixture(options).fetchImpl), null);
  }
  await approveFreshTestPolicy();
  assert.equal(await readCurrentEntryFeeTerms(ticker, (async () =>
    ({ ok: false, status: 429 }) as Response) as typeof fetch), null);
  await revokeFeeApproval();
  assert.equal(await readCurrentEntryFeeTerms(ticker, fixture().fetchImpl), null);
});

test("version mismatch and upward cap edits cannot reuse an approved policy", async () => {
  const view = await reviewFeeSchedulePdf(pdf);
  assert.equal((await approveFeeSchedule(view.reviewId!, view.digest!, "test-admin"))?.status,
    "approved");
  await assert.rejects(db.update(microLiveConfigTable).set({
    microLiveRunCapMicros: 5_000_000,
  }).where(eq(microLiveConfigTable.id, "singleton")));
  await assert.rejects(db.update(microLiveConfigTable).set({
    microLiveFeePolicyVersion: "unknown-version",
  }).where(eq(microLiveConfigTable.id, "singleton")));
  assert.ok(await approvedFeeSession(),
    "the database must reject an unsupported policy version while approved");
  await revokeFeeApproval();
  await db.update(microLiveConfigTable).set({
    microLiveRunCapMicros: 5_000_000,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal(await approvedFeeSession(), null);
  assert.equal((await feeApprovalView()).status, "none");
});
test("rejects wrong exchange index for live market, series, or event fee terms", async () => {
  for (const options of [
    {marketExchangeIndex: 0},
    {seriesExchangeIndex: 0},
    {eventExchangeIndex: 0},
  ]) {
    const value = await readCurrentEntryFeeTerms(ticker, fixture(options).fetchImpl);
    assert.equal(value, null, "cannot use another exchange's fee schedule");
  }
});
