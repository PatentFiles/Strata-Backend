import { readKalshiOrderbook, type KalshiDedicatedPairFundingAnchor } from "../kalshiAccountClient";
import { verifyCurrentFeeArtifact, type FeeArtifactVerification } from "../microLiveFeeArtifact";
import { maximumEntryFeePerContractMicros, maximumExitFeePerContractMicros } from "../microLiveEntryFees";
import { planV13IocEntry } from "../v13ExecutionPlanner";
import { ProductionLedger, identity, decodePolicy } from "./ledger";
import { computeV13LiveMoneyPolicyHash } from "../v13LiveMoneyRisk";
import { KalshiProductionExchange } from "./transport";
import { digest, requireProof, type MarketEvidence, type Request } from "./types";

const PUBLIC = "https://api.elections.kalshi.com/trade-api/v2";
async function publicObject(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${PUBLIC}${path}`, { signal: AbortSignal.timeout(8_000) });
  requireProof(r.ok, "production_market_metadata_unavailable");
  const value: unknown = await r.json();
  requireProof(value && typeof value === "object" && !Array.isArray(value), "production_market_metadata_invalid");
  return value as Record<string, unknown>;
}

/** Existing verified formula helpers are shared; micro-live approval/caps are NOT. */
export async function createProductionExchange(ledger: ProductionLedger, ticker: () => Promise<string>,
  fundingAnchor: KalshiDedicatedPairFundingAnchor): Promise<KalshiProductionExchange> {
  const a = await ledger.readAccount();
  requireProof(a.cash_precision_verified && a.fee_artifact_digest, "production_fee_or_cash_approval_missing");
  let cached: { approval: string; artifact: FeeArtifactVerification } | null = null;
  const market = async (marketTicker: string, side: "YES" | "NO"): Promise<MarketEvidence> => {
    const account = await ledger.readAccount();
    const row = (await ledger.query("SELECT * FROM v13_live_money_policy WHERE id=$1", [account.policy_id])).rows[0];
    requireProof(row, "production_policy_missing");
    const policy = decodePolicy(row);
    requireProof(policy.state === "APPROVED" && policy.policyHash === computeV13LiveMoneyPolicyHash(policy),
      "production_policy_changed");
    const approval = { policy, artifact: account.fee_artifact_digest };
    requireProof(approval.artifact && approval.policy.feePolicyVersion &&
      approval.policy.feeSourceUrl && approval.policy.feeFormulaVersion, "production_fee_artifact_missing");
    const bound = digest({ policyHash: approval.policy.policyHash, artifact: approval.artifact });
    if (!cached || cached.approval !== bound || Date.now() - (cached.artifact.verifiedAt ?? 0) > 10_000) {
      cached = { approval: bound, artifact: await verifyCurrentFeeArtifact({
        digest: approval.artifact, policyVersion: approval.policy.feePolicyVersion!,
        sourceUrl: approval.policy.feeSourceUrl!, formulaVersion: approval.policy.feeFormulaVersion!,
      }) };
    }
    requireProof(cached.artifact.valid && cached.artifact.digest === approval.artifact, "production_fee_artifact_changed");
    const [book, seriesBody, marketBody] = await Promise.all([
      readKalshiOrderbook(marketTicker), publicObject("/series/KXBTC15M"),
      publicObject(`/markets/${encodeURIComponent(marketTicker)}`),
    ]);
    const series = seriesBody.series as Record<string, unknown> | undefined;
    const metadata = marketBody.market as Record<string, unknown> | undefined;
    requireProof(series?.ticker === "KXBTC15M" && series.fee_type === "quadratic" &&
      String(series.fee_multiplier) === "1" && metadata?.ticker === marketTicker &&
      metadata.exchange_index === 2 && metadata.status === "active" &&
      metadata.price_level_structure === "deci_cent", "production_fee_or_market_grid_unproven");
    const asks = side === "YES" ? book.yesAskLevels : book.noAskLevels;
    const bids = side === "YES" ? book.yesBidLevels : book.noBidLevels;
    const ask = side === "YES" ? book.yesAskDollars : book.noAskDollars;
    const bid = side === "YES" ? book.yesBidDollars : book.noBidDollars;
    requireProof(asks && bids && ask && bid, "production_full_book_unavailable");
    const plan = planV13IocEntry({ signal: Number(ask) <= 0.52 ? "SCOUT" : "CONFIRM",
      direction: side === "YES" ? "UP" : "DOWN", referenceOffer: Number(ask),
      maxStakeCents: approval.policy.maxEntryStakeCents, bestAskDollars: ask, askLevels: asks });
    // An exit must remain possible above C53's entry ceiling. Entry eligibility
    // is enforced by prepareEntry; this reader also serves owned reduce-only exits.
    const count = plan.ok ? plan.plan.contracts : 1;
    const limit = plan.ok ? plan.plan.limitPrice : Number(ask);
    const entry = maximumEntryFeePerContractMicros(1, limit.toFixed(4), undefined, side.toLowerCase() as "yes" | "no");
    const exit = maximumExitFeePerContractMicros(1, undefined, side.toLowerCase() as "yes" | "no");
    requireProof(entry !== null && exit !== null && cached.artifact.verifiedAt, "production_fee_bounds_unavailable");
    const fingerprint = digest({ bound, series, grid: metadata.price_level_structure,
      count, limit, entry, exit });
    return { observedAtMs: Date.parse(book.observedAt), bestAskDollars: ask, asks, bestBidDollars: bid, bids,
      fee: { policyVersion: approval.policy.feePolicyVersion!, sourceUrl: approval.policy.feeSourceUrl!,
        formulaVersion: approval.policy.feeFormulaVersion!, fingerprint,
        verifiedAtMs: cached.artifact.verifiedAt, contracts: count, limitPrice: limit,
        reservedEntryFeeCents: Math.ceil(entry * count / 10_000),
        reservedExitFeeCents: Math.ceil(exit * count / 10_000) } };
  };
  // Dedicated secrets only. This does not replace shared bot credentials.
  const keyId = process.env.KALSHI_INDEX2_API_KEY_ID, privateKey = process.env.KALSHI_INDEX2_PRIVATE_KEY;
  requireProof(keyId && privateKey, "production_dedicated_signer_missing");
  return new KalshiProductionExchange({ keyId, privateKey, identity: identity(a), fundingAnchor, ticker, market,
    requests: async () => (await ledger.query<{ request: Request }>(
      "SELECT request FROM v13_production_intent WHERE account_id=$1 AND state<>'PREPARED'", [a.id])).rows.map(r => r.request),
    orderMarket: async orderId => (await ledger.query(
      "SELECT market FROM v13_production_intent WHERE account_id=$1 AND exchange_order_id=$2", [a.id, orderId])).rows[0]?.market ?? null,
  });
}
