/**
 * Research-only, quote-level execution sensitivity for C52/53 and SHADOW subsets.
 *
 * NO trade, account, configuration, fee-source approval or strategy promotion authority.
 * Missing depth is NEVER interpreted as a validated fill. A reported positive return
 * is an assumption-based quote simulation, not an executable/verified P&L estimate.
 *
 * Monetary arithmetic is in bigint microdollars; 1 price tick = $0.0001 = 100 microdollars.
 * The quadratic fee coefficient here is an explicitly illustrative stress assumption,
 * NOT Kalshi's currently provider-verified tariff; use the real venue fee reader for orders.
 */
export interface ResearchQuoteRoundTrip {
  id: string;
  marketTicker: string;
  entryOfferTicks: number; // integer units of $0.0001, positive
  exitBidTicks: number; // integer units of $0.0001, zero permitted
  /** Whole contracts available at the entry limit. Null = NOT OBSERVED. */
  entryDepthContracts: number | null;
  /** Whole contracts available at the exit limit. Null = NOT OBSERVED. */
  exitDepthContracts: number | null;
}
export interface ResearchExecutionStress {
  stakeCents: number;
  adverseEntryTicks: number;
  adverseExitTicks: number;
  /** Assumed coefficient in bps; 700 = 0.07 of q*p*(1-p). Not official fee evidence. */
  assumedQuadraticCoefficientBps: number;
  /** Research-only assumed max per IOC, NOT observed book depth. */
  maxContractsPerTrade?: number;
  /** Reserve simulated entry taker fees inside the total cash budget. */
  feeInclusiveEntryBudget?: boolean;
}
export interface ResearchExecutionStressResult {
  mode: "SHADOW_ONLY";
  executionAuthority: false;
  pnlProvenByExchangeFills: false;
  feeScheduleProviderVerified: false;
  quoteModelOnly: true;
  inputTrades: number;
  modeledTrades: number;
  incompleteDepthTrades: number;
  knownResidualContracts: number;
  modeledContracts: number;
  modeledNetMicros: string;
  modeledNetExLargestWinnerMicros: string;
  largestSinglePositiveNetMicros: string;
  observedDepthCoverage: number;
  warnings: string[];
}

const TICKS_PER_DOLLAR = 10_000n;
const MICROS_PER_TICK = 100n;
const MICROS_PER_CENT = 10_000n;

function ceilDiv(nonnegative: bigint, divisor: bigint): bigint {
  return (nonnegative + divisor - 1n) / divisor;
}
function whole(n: number, lower: number, upper: number): boolean {
  return Number.isSafeInteger(n) && n >= lower && n <= upper;
}

/** Fee in whole cents, rounded UP per order, with deliberately exposed assumptions. */
export function illustrativeQuadraticFeeCents(
  quantity: number, priceTicks: number, coefficientBps = 700,
): bigint {
  if (!whole(quantity, 0, 25_000_000) || !whole(priceTicks, 0, 10_000) ||
      !whole(coefficientBps, 0, 10_000)) {
    throw new Error("invalid_research_fee_input");
  }
  // coefficientBps/10000 * q * p(1-p) DOLLARS; multiply by 100 for cents.
  const numerator = BigInt(coefficientBps) * BigInt(quantity) *
    BigInt(priceTicks) * (TICKS_PER_DOLLAR - BigInt(priceTicks)) * 100n;
  return ceilDiv(numerator, TICKS_PER_DOLLAR ** 3n);
}

export function stressV13ResearchQuotes(
  rows: readonly ResearchQuoteRoundTrip[],
  assumptions: ResearchExecutionStress,
): ResearchExecutionStressResult {
  if (!whole(assumptions.stakeCents, 1, 250_000) ||
      !whole(assumptions.adverseEntryTicks, 0, 9_999) ||
      !whole(assumptions.adverseExitTicks, 0, 9_999) ||
      !whole(assumptions.assumedQuadraticCoefficientBps, 0, 10_000) ||
      (assumptions.maxContractsPerTrade!==undefined && !whole(assumptions.maxContractsPerTrade,1,25_000_000)) ||
      rows.length > 100_000) {
    throw new Error("invalid_research_stress_assumptions");
  }
  const seen = new Set<string>();
  let modeledNet = 0n;
  let largestPositive = 0n;
  let modeledTrades = 0;
  let incompleteDepthTrades = 0;
  let knownResidualContracts = 0;
  let modeledContracts = 0;
  let completeDepthTrades = 0;
  for (const r of rows) {
    if (!r.id.trim() || !r.marketTicker.trim() || seen.has(r.id) ||
        !whole(r.entryOfferTicks, 1, 9_999) || !whole(r.exitBidTicks, 0, 9_999) ||
        (r.entryDepthContracts !== null && !whole(r.entryDepthContracts, 0, 25_000_000)) ||
        (r.exitDepthContracts !== null && !whole(r.exitDepthContracts, 0, 25_000_000))) {
      throw new Error("invalid_or_duplicate_research_quote");
    }
    seen.add(r.id);
    const completeDepth = r.entryDepthContracts !== null && r.exitDepthContracts !== null;
    if (completeDepth) completeDepthTrades++;
    else incompleteDepthTrades++;
    const entryTicks = r.entryOfferTicks + assumptions.adverseEntryTicks;
    if (entryTicks >= 10_000) continue; // no acceptable executable entry at the stress price
    const maxContractsByStake = Math.floor(assumptions.stakeCents * 100 / entryTicks);
    let entries = Math.min(maxContractsByStake,
      assumptions.maxContractsPerTrade ?? maxContractsByStake,
      r.entryDepthContracts ?? maxContractsByStake);
    if(assumptions.feeInclusiveEntryBudget){
      // Monotonic cash debit; bounded binary search, not O(contract count).
      // Price and assumed taker fees share fixed-point microdollar arithmetic.
      const cashBudget=BigInt(assumptions.stakeCents)*MICROS_PER_CENT;
      let lo=0,hi=entries;
      while(lo<hi){
        const candidate=Math.floor((lo+hi+1)/2);
        const debit=BigInt(candidate)*BigInt(entryTicks)*MICROS_PER_TICK+
          illustrativeQuadraticFeeCents(candidate,entryTicks,
            assumptions.assumedQuadraticCoefficientBps)*MICROS_PER_CENT;
        if(debit<=cashBudget)lo=candidate;
        else hi=candidate-1;
      }
      entries=lo;
    }
    if (entries === 0) continue;
    const exitTicks = Math.max(0, r.exitBidTicks - assumptions.adverseExitTicks);
    const exited = Math.min(entries, r.exitDepthContracts ?? entries);
    const residual = entries - exited;
    // A known unfilled residual receives zero immediate proceeds. Never book
    // it as sold at the top bid or silently assert an eventual settlement.
    const grossMicros = BigInt(exited) * BigInt(exitTicks) * MICROS_PER_TICK -
      BigInt(entries) * BigInt(entryTicks) * MICROS_PER_TICK;
    const feesMicros = (
      illustrativeQuadraticFeeCents(entries, entryTicks,
        assumptions.assumedQuadraticCoefficientBps) +
      illustrativeQuadraticFeeCents(exited, exitTicks,
        assumptions.assumedQuadraticCoefficientBps)
    ) * MICROS_PER_CENT;
    const net = grossMicros - feesMicros;
    modeledTrades++;
    modeledContracts += entries;
    knownResidualContracts += residual;
    modeledNet += net;
    if (net > largestPositive) largestPositive = net;
  }
  const warnings = [
    "Model-only quotes; no exchange execution, fill probability, market impact or BRTI settlement verification",
    "Quadratic rate is an illustrative stress parameter, not an authorized current fee schedule",
  ];
  if (incompleteDepthTrades > 0)
    warnings.push("Absent entry/exit depth is not evidence of executable size; modeled P&L is hypothetical");
  if (knownResidualContracts > 0)
    warnings.push("Known insufficient exit depth leaves residual positions with zero assumed recovery");
  if (rows.length < 100)
    warnings.push("Small sample: do not promote champion or increase stake based on this result");
  return {
    mode: "SHADOW_ONLY",
    executionAuthority: false,
    pnlProvenByExchangeFills: false,
    feeScheduleProviderVerified: false,
    quoteModelOnly: true,
    inputTrades: rows.length,
    modeledTrades,
    incompleteDepthTrades,
    knownResidualContracts,
    modeledContracts,
    modeledNetMicros: modeledNet.toString(),
    modeledNetExLargestWinnerMicros: (modeledNet - largestPositive).toString(),
    largestSinglePositiveNetMicros: largestPositive.toString(),
    observedDepthCoverage: rows.length ? completeDepthTrades / rows.length : 0,
    warnings,
  };
}
