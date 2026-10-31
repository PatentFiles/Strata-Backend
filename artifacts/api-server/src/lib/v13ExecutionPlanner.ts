export type V13ExecutionSignal = "SCOUT" | "CONFIRM";
export type V13ExecutionDirection = "UP" | "DOWN";

export type V13DepthLevel = {
  priceDollars: string;
  availableContracts: string;
};

export type V13IocEntryPlan = {
  contracts: number;
  bestAsk: number;
  limitPrice: number;
  expectedVwap: number;
  expectedGrossCents: number;
  worstCaseGrossCents: number;
  worstCaseEntryCashDebitCents: number | null;
  visibleContractsAtLimit: number;
  maximumPrice: number;
};

export type V13IocEntryPlanResult =
  | { ok: true; plan: V13IocEntryPlan }
  | {
      ok: false;
      reason:
        | "invalid_input"
        | "best_ask_above_signal_ceiling"
        | "depth_unavailable_or_invalid"
        | "cash_debit_model_invalid"
        | "no_whole_contract_executable";
    };

export function signalCap(signal: V13ExecutionSignal): number {
  return signal === "CONFIRM" ? 0.68 : 0.60;
}

function parseDepth(levels: V13DepthLevel[]): Array<{ price: number; available: number }> | null {
  const parsed = levels.map((level) => ({
    price: Number(level.priceDollars),
    available: Number(level.availableContracts),
  }));
  if (parsed.some((level) =>
      !Number.isFinite(level.price) || level.price <= 0 || level.price >= 1 ||
      !Number.isFinite(level.available) || level.available < 0)) return null;
  return parsed.sort((a, b) => a.price - b.price);
}

function expectedCostForContracts(
  levels: Array<{ price: number; available: number }>,
  contracts: number,
  maximumPrice: number,
): number | null {
  let remaining = contracts;
  let dollars = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    if (level.price > maximumPrice + 1e-12) break;
    const taken = Math.min(remaining, level.available);
    dollars += taken * level.price;
    remaining -= taken;
  }
  return remaining <= 1e-9 ? dollars : null;
}

/**
 * Plans a single IOC V13 entry from executable ask depth.
 *
 * The signal's persisted entry offer is the maximum strategy-approved price.
 * The planner may walk visible depth only up to min(entryOffer, V13 cap).
 * It never assumes liquidity above that price and never requires the full
 * requested stake to be deployed.
 *
 * maxStakeCents is treated as a worst-case gross order ceiling. Fees and
 * account-level risk checks are intentionally layered after this planner.
 */
export function planV13IocEntry(input: {
  signal: V13ExecutionSignal;
  direction: V13ExecutionDirection;
  referenceOffer: number;
  maxStakeCents: number;
  bestAskDollars: string | null;
  askLevels: V13DepthLevel[];
  /** Optional fee-inclusive production cash ceiling. Supply both fields or neither. */
  maxAllInCashDebitCents?: number;
  cashDebitMicrosPerContractAtLimit?: (
    priceDollars: string,
    direction: V13ExecutionDirection,
  ) => number | null;
}): V13IocEntryPlanResult {
  if (!Number.isSafeInteger(input.maxStakeCents) || input.maxStakeCents <= 0 ||
      !Number.isFinite(input.referenceOffer) || input.referenceOffer <= 0 ||
      input.referenceOffer >= 1) {
    return { ok: false, reason: "invalid_input" };
  }
  const cashModelConfigured = input.maxAllInCashDebitCents !== undefined ||
    input.cashDebitMicrosPerContractAtLimit !== undefined;
  if (cashModelConfigured && (
      typeof input.maxAllInCashDebitCents !== "number" ||
      !Number.isSafeInteger(input.maxAllInCashDebitCents) ||
      input.maxAllInCashDebitCents <= 0 ||
      typeof input.cashDebitMicrosPerContractAtLimit !== "function")) {
    return { ok: false, reason: "cash_debit_model_invalid" };
  }
  const bestAsk = Number(input.bestAskDollars);
  const maximumPrice = Math.min(signalCap(input.signal), input.referenceOffer);
  if (!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1) {
    return { ok: false, reason: "invalid_input" };
  }
  if (bestAsk > maximumPrice + 1e-12) {
    return { ok: false, reason: "best_ask_above_signal_ceiling" };
  }

  const levels = parseDepth(input.askLevels);
  if (!levels || levels.length === 0 ||
      Math.abs(levels[0]!.price - bestAsk) > 0.00005) {
    return { ok: false, reason: "depth_unavailable_or_invalid" };
  }

  let cumulativeAvailable = 0;
  let selected: {
    contracts: number;
    limitPrice: number;
    visible: number;
    cashDebitPerContractMicros: number | null;
  } | null = null;
  for (const level of levels) {
    if (level.price > maximumPrice + 1e-12) break;
    cumulativeAvailable += level.available;
    const visible = Math.floor(cumulativeAvailable + 1e-9);
    const grossBudget = Math.floor(input.maxStakeCents / 100 / level.price + 1e-9);
    let cashBudget = Number.MAX_SAFE_INTEGER;
    let cashDebitPerContractMicros: number | null = null;
    if (cashModelConfigured) {
      cashDebitPerContractMicros = input.cashDebitMicrosPerContractAtLimit!(
        level.price.toFixed(4), input.direction,
      );
      if (!Number.isSafeInteger(cashDebitPerContractMicros) ||
          cashDebitPerContractMicros! <= 0) {
        return { ok: false, reason: "cash_debit_model_invalid" };
      }
      cashBudget = Math.floor(
        input.maxAllInCashDebitCents! * 10_000 / cashDebitPerContractMicros!,
      );
    }
    const contracts = Math.min(visible, grossBudget, cashBudget);
    if (contracts >= 1 && (selected === null || contracts > selected.contracts)) {
      selected = { contracts, limitPrice: level.price, visible, cashDebitPerContractMicros };
    }
  }
  if (!selected) return { ok: false, reason: "no_whole_contract_executable" };

  const expectedDollars = expectedCostForContracts(
    levels, selected.contracts, selected.limitPrice,
  );
  if (expectedDollars === null) {
    return { ok: false, reason: "depth_unavailable_or_invalid" };
  }
  const expectedGrossCents = Math.ceil(expectedDollars * 100 - 1e-8);
  const worstCaseGrossCents = Math.ceil(
    selected.contracts * selected.limitPrice * 100 - 1e-8,
  );
  const worstCaseEntryCashDebitCents = selected.cashDebitPerContractMicros === null
    ? null
    : Math.ceil(
        selected.contracts * selected.cashDebitPerContractMicros / 10_000 - 1e-8,
      );
  if (worstCaseGrossCents > input.maxStakeCents ||
      (worstCaseEntryCashDebitCents !== null &&
       worstCaseEntryCashDebitCents > input.maxAllInCashDebitCents!)) {
    return { ok: false, reason: "invalid_input" };
  }

  return {
    ok: true,
    plan: {
      contracts: selected.contracts,
      bestAsk,
      limitPrice: selected.limitPrice,
      expectedVwap: expectedDollars / selected.contracts,
      expectedGrossCents,
      worstCaseGrossCents,
      worstCaseEntryCashDebitCents,
      visibleContractsAtLimit: selected.visible,
      maximumPrice,
    },
  };
}


export type V13IocExitPlan = {
  requestedContracts: number;
  plannedContracts: number;
  residualContracts: number;
  bestBid: number;
  limitPrice: number;
  expectedVwap: number;
  expectedGrossProceedsCents: number;
  visibleContractsAtLimit: number;
  minimumExitPrice: number;
};

export type V13IocExitPlanResult =
  | { ok: true; plan: V13IocExitPlan }
  | {
      ok: false;
      reason:
        | "invalid_input"
        | "depth_unavailable_or_invalid"
        | "no_whole_contract_executable";
    };

/**
 * Plans one reduce-only IOC exit against visible bid depth.
 *
 * The caller supplies the minimum acceptable exit price. The planner never
 * silently chooses a slippage tolerance and never assumes the full position
 * can exit at the top bid. residualContracts must be explicitly reconciled by
 * the caller after the IOC result.
 */
export function planV13IocExit(input: {
  ownedContracts: number;
  bestBidDollars: string | null;
  bidLevels: V13DepthLevel[];
  minimumExitPrice: number;
}): V13IocExitPlanResult {
  if (!Number.isSafeInteger(input.ownedContracts) || input.ownedContracts <= 0 ||
      !Number.isFinite(input.minimumExitPrice) || input.minimumExitPrice <= 0 ||
      input.minimumExitPrice >= 1) {
    return { ok: false, reason: "invalid_input" };
  }
  const bestBid = Number(input.bestBidDollars);
  if (!Number.isFinite(bestBid) || bestBid <= 0 || bestBid >= 1 ||
      bestBid < input.minimumExitPrice) {
    return { ok: false, reason: "invalid_input" };
  }
  const levels = parseDepth(input.bidLevels);
  if (!levels || levels.length === 0) {
    return { ok: false, reason: "depth_unavailable_or_invalid" };
  }
  levels.sort((a, b) => b.price - a.price);
  if (Math.abs(levels[0]!.price - bestBid) > 0.00005) {
    return { ok: false, reason: "depth_unavailable_or_invalid" };
  }

  let visible = 0;
  let selectedLimit = bestBid;
  let plannedContracts = 0;
  for (const level of levels) {
    if (level.price + 1e-12 < input.minimumExitPrice) break;
    visible += level.available;
    const wholeVisible = Math.floor(visible + 1e-9);
    const possible = Math.min(input.ownedContracts, wholeVisible);
    if (possible > plannedContracts) {
      plannedContracts = possible;
      selectedLimit = level.price;
    }
    if (plannedContracts === input.ownedContracts) break;
  }
  if (plannedContracts < 1) {
    return { ok: false, reason: "no_whole_contract_executable" };
  }

  let remaining = plannedContracts;
  let proceedsDollars = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    if (level.price + 1e-12 < selectedLimit) break;
    const taken = Math.min(remaining, level.available);
    proceedsDollars += taken * level.price;
    remaining -= taken;
  }
  if (remaining > 1e-9) {
    return { ok: false, reason: "depth_unavailable_or_invalid" };
  }

  return {
    ok: true,
    plan: {
      requestedContracts: input.ownedContracts,
      plannedContracts,
      residualContracts: input.ownedContracts - plannedContracts,
      bestBid,
      limitPrice: selectedLimit,
      expectedVwap: proceedsDollars / plannedContracts,
      expectedGrossProceedsCents: Math.floor(proceedsDollars * 100 + 1e-8),
      visibleContractsAtLimit: Math.floor(visible + 1e-9),
      minimumExitPrice: input.minimumExitPrice,
    },
  };
}
