export * from "./entryPolicy";
import {
  V13_CHAMPION_PARAMETER_SET,
  assertV13StrategyParameters,
  type V13StrategyParameters,
} from "./parameters";
export * from "./parameters";
export * from "./release";

export type V13Direction = 'up' | 'down';
export type V13Side = 'UP' | 'DOWN' | 'NONE';
export type V13Signal = 'PASS' | 'WATCH' | 'SCOUT' | 'CONFIRM' | 'EXIT';

export type V13Input = {
  marketTicker: string | null;
  btcPrice: number | null;
  target: number | null;
  previousBuffer: number | null;
  velocity: number | null;
  upOffer: number | null;
  downOffer: number | null;
  // The caller validates the market/BTC snapshot. This is the existing
  // signed-buffer mismatch gate, not a new quote-age or market-data rule.
  freshness: 'current' | 'data-error';
  position: { status: 'open' | 'closed'; direction: V13Direction } | null;
};

export type V13Decision = {
  signal: V13Signal;
  direction: V13Side;
  reason: string;
  qualifyingTrigger: boolean;
  entrySideOffer: number | null;
  candidateOffer: number | null;
  buffer: number | null;
  separation: number | null;
  freshCross: boolean;
  crossedDirection: V13Direction | null;
  advanceCrossId: boolean;
  positionExitReason: 'Wrong-side recross' | 'Momentum invalidated' | null;
};

export const calculateSignedBuffer = (btcPrice: number, target: number) =>
  btcPrice - target;

const sideFor = (direction: V13Direction | null): V13Side =>
  direction === 'up' ? 'UP' : direction === 'down' ? 'DOWN' : 'NONE';

/** Shared price-independent structure. This is a read-budget predicate, never
 * a signal or order authority; the full classifier must still run with real quotes. */
function entryStructure(input: Pick<V13Input, "btcPrice"|"target"|"previousBuffer"|"velocity">,
  parameters: V13StrategyParameters) {
  const buffer = input.btcPrice! - input.target!;
  const crossedUp = input.previousBuffer !== null && input.previousBuffer <= 0 && buffer > 0;
  const crossedDown = input.previousBuffer !== null && input.previousBuffer >= 0 && buffer < 0;
  const freshCross = crossedUp || crossedDown;
  const crossedDirection: V13Direction | null = crossedUp ? "up" : crossedDown ? "down" : null;
  const currentDirection: V13Direction | null = buffer > 0 ? "up" : buffer < 0 ? "down" : null;
  const candidateDirection = crossedDirection ?? currentDirection;
  const directionalVelocity = input.velocity !== null &&
    ((input.velocity > 0 && crossedDirection === "up") || (input.velocity < 0 && crossedDirection === "down"));
  const currentVelocitySupports = input.velocity !== null &&
    ((currentDirection === "up" && input.velocity > 0) || (currentDirection === "down" && input.velocity < 0));
  const separation = Math.abs(buffer);
  return {freshCross, crossedDirection, currentDirection, candidateDirection, separation,
    scout: Boolean(candidateDirection) && separation >= parameters.scoutMinSeparation &&
      separation <= parameters.scoutMaxSeparation && directionalVelocity,
    confirm: freshCross && Boolean(candidateDirection) && separation >= parameters.confirmMinSeparation && currentVelocitySupports};
}

export function needsV13EntryPrice(input: Omit<V13Input, "upOffer"|"downOffer">): boolean {
  if (input.freshness !== "current" || input.position?.status === "open" || !input.marketTicker ||
      input.btcPrice === null || input.target === null || !Number.isFinite(input.btcPrice) ||
      !Number.isFinite(input.target) || input.previousBuffer === null || !Number.isFinite(input.previousBuffer) ||
      input.velocity === null || !Number.isFinite(input.velocity)) return false;
  const structure = entryStructure(input, V13_CHAMPION_PARAMETER_SET.parameters);
  return structure.freshCross && (structure.scout || structure.confirm);
}

// Pure V1.3 signal classification. The browser/worker owns feed acquisition,
// per-market crossing history, paper position creation and settlement/P&L.
export function evaluateV13StrategyWithParameters(
  input: V13Input,
  rawParameters: V13StrategyParameters,
): V13Decision {
  const parameters = assertV13StrategyParameters(rawParameters);
  const {
    marketTicker, btcPrice, target, previousBuffer, velocity,
    upOffer, downOffer, freshness, position,
  } = input;
  const waiting: V13Decision = {
    signal: 'WATCH',
    direction: 'NONE',
    reason: 'Waiting for target and BTC feed',
    qualifyingTrigger: false,
    entrySideOffer: null,
    candidateOffer: null,
    buffer: null,
    separation: null,
    freshCross: false,
    crossedDirection: null,
    advanceCrossId: false,
    positionExitReason: null,
  };
  if (marketTicker === null || target === null || btcPrice === null) return waiting;

  const buffer = calculateSignedBuffer(btcPrice, target);
  const initial = {
    ...waiting,
    buffer,
    separation: Math.abs(buffer),
  };
  if (freshness === 'data-error') {
    return {
      ...initial,
      signal: 'PASS',
      reason: 'DATA ERROR — signed BTC buffer does not match the raw prices',
    };
  }

  const structure = entryStructure(input, parameters);
  const {freshCross, crossedDirection, currentDirection, candidateDirection, separation} = structure;
  const candidateOffer = candidateDirection
    ? candidateDirection === 'up' ? upOffer : downOffer
    : null;
  const canScout = structure.scout && candidateOffer !== null && candidateOffer <= parameters.scoutMaxOffer;
  const canConfirm = structure.confirm && candidateOffer !== null && candidateOffer <= parameters.confirmMaxOffer;
  const confirmTooExpensive =
    separation >= parameters.confirmMinSeparation &&
    candidateOffer !== null &&
    candidateOffer > parameters.confirmMaxOffer;
  const scoutTooExpensive =
    separation >= parameters.scoutMinSeparation &&
    candidateOffer !== null &&
    candidateOffer > parameters.scoutMaxOffer;
  const diagnostics = {
    ...initial,
    candidateOffer,
    freshCross,
    crossedDirection,
    advanceCrossId: freshCross && position?.status !== 'open',
  };

  if (position?.status === 'open') {
    const wrongSideRecross =
      (position.direction === 'up' && buffer <= -parameters.wrongSideRecrossSeparation) ||
      (position.direction === 'down' && buffer >= parameters.wrongSideRecrossSeparation);
    const momentumInvalidated =
      parameters.exitOnMomentumInvalidation &&
      velocity !== null &&
      ((position.direction === 'up' && velocity <= 0) ||
        (position.direction === 'down' && velocity >= 0));
    if (wrongSideRecross || momentumInvalidated) {
      return {
        ...diagnostics,
        advanceCrossId: false,
        signal: 'EXIT',
        direction: sideFor(position.direction),
        reason: wrongSideRecross
          ? `Exited on approximately $${parameters.wrongSideRecrossSeparation} wrong-side recross`
          : 'Exited because directional velocity faded',
        positionExitReason: wrongSideRecross ? 'Wrong-side recross' : 'Momentum invalidated',
      };
    }
    return {
      ...diagnostics,
      advanceCrossId: false,
      signal: canConfirm ? 'CONFIRM' : 'WATCH',
      direction: sideFor(position.direction),
      qualifyingTrigger: canConfirm,
      reason: canConfirm
        ? `Separation is $${parameters.confirmMinSeparation}+ with repricing still behind BTC`
        : 'Paper position is being monitored',
    };
  }

  if (canConfirm || canScout) {
    const direction = candidateDirection as V13Direction;
    return {
      ...diagnostics,
      signal: canConfirm ? 'CONFIRM' : 'SCOUT',
      direction: sideFor(direction),
      qualifyingTrigger: true,
      entrySideOffer: candidateOffer,
      reason: canConfirm
        ? `Confirmed at $${parameters.confirmMinSeparation}+ separation`
        : `Fresh ${direction.toUpperCase()} cross in the $${parameters.scoutMinSeparation}–$${parameters.scoutMaxSeparation} scout band`,
    };
  }

  if (confirmTooExpensive) {
    return {
      ...diagnostics,
      signal: 'PASS',
      direction: sideFor(currentDirection),
      reason: 'Move confirmed but market already repriced — PASS',
    };
  }
  if (scoutTooExpensive) {
    return {
      ...diagnostics,
      signal: 'PASS',
      direction: sideFor(currentDirection),
      reason: `TOO EXPENSIVE — favored side is above the ${Math.round(parameters.scoutMaxOffer * 100)}% Scout maximum`,
    };
  }
  return {
    ...diagnostics,
    signal: separation < 8 ? 'PASS' : 'WATCH',
    direction: sideFor(currentDirection),
    reason: separation < 8
      ? 'BTC is near the target; no fresh edge is active'
      : 'Watching for directional repricing lag',
  };
}

/**
 * Execution-compatible V1.3 classifier. This wrapper is intentionally locked
 * to the immutable champion parameter set. Live/micro-live callers should use
 * this function, never evaluateV13StrategyWithParameters().
 */
export function evaluateV13Strategy(input: V13Input): V13Decision {
  return evaluateV13StrategyWithParameters(input, V13_CHAMPION_PARAMETER_SET.parameters);
}
