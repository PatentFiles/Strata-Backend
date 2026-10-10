import type { KalshiMarket } from './marketData';
import { calculateSignedBuffer, evaluateV13Strategy } from '@workspace/v13-strategy';
export { calculateSignedBuffer } from '@workspace/v13-strategy';

export const PAPER_STAKE = 5;

export type ModelState =
  | 'PASS'
  | 'WATCH'
  | 'SCOUT UP'
  | 'SCOUT DOWN'
  | 'CONFIRM'
  | 'EXIT';

export type Direction = 'up' | 'down';

export type PricePoint = {
  price: number;
  time: number;
};

export type PaperPosition = {
  id: string;
  direction: Direction;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  entryPrice: number;
  exitPrice: number | null;
  stake: number;
  pnl: number | null;
  reason: string | null;
  ticker: string;
  target: number | null;
  entrySignal?: ModelState | null;
  entryBtcPrice?: number | null;
  entryBuffer?: number | null;
  entryVelocity?: number | null;
};

export type StrategySnapshot = {
  state: ModelState;
  direction: Direction | null;
  buffer: number | null;
  dataError?: boolean;
  sourceTicker?: string | null;
  sourceTarget?: number | null;
  sourceBtcPrice?: number | null;
  velocity: number | null;
  marketPrice: number | null;
  position: PaperPosition | null;
  crossId: number;
  note: string;
};

const markPriceForDirection = (market: KalshiMarket, direction: Direction) =>
  direction === 'up' ? market.yesPrice : market.noPrice;

const executableExitPriceForDirection = (
  market: KalshiMarket,
  direction: Direction,
) => direction === 'up' ? market.yesBid : market.noBid;

export const hasSignedBufferMismatch = (
  btcPrice: number | null,
  target: number | null,
  buffer: number | null,
) => {
  if (btcPrice === null || target === null || buffer === null) return false;
  return (
    (btcPrice < target && buffer > 0) ||
    (btcPrice > target && buffer < 0)
  );
};

// A strategy snapshot must describe the same raw BTC tick and market currently
// displayed. In-flight Kalshi refreshes must never expose an old entry signal.
export const hasStrategyDataError = (
  strategy: StrategySnapshot,
  btcPrice: number | null,
  market: KalshiMarket | null,
) => {
  const target = market?.target ?? null;
  if (hasSignedBufferMismatch(btcPrice, target, strategy.buffer)) return true;
  if (strategy.dataError) return true;
  if (btcPrice === null || target === null || !market) return false;
  return (
    strategy.buffer === null ||
    strategy.sourceTicker !== market.ticker ||
    strategy.sourceTarget !== target ||
    strategy.sourceBtcPrice !== btcPrice ||
    !Number.isFinite(strategy.buffer) ||
    Math.abs(strategy.buffer - calculateSignedBuffer(btcPrice, target)) > 1e-6
  );
};

export const safeStrategyForDisplay = (
  strategy: StrategySnapshot,
  btcPrice: number | null,
  market: KalshiMarket | null,
): StrategySnapshot =>
  hasStrategyDataError(strategy, btcPrice, market)
    ? {
        ...strategy,
        state: 'PASS',
        direction: null,
        dataError: true,
        marketPrice: null,
        note: 'DATA ERROR — raw BTC price, target, and signed buffer disagree',
      }
    : strategy;

export const calculateVelocity = (points: PricePoint[], windowMs = 30_000) => {
  if (points.length < 2) return null;
  const newest = points[points.length - 1];
  const cutoff = newest.time - windowMs;
  const oldest = points.find((point) => point.time >= cutoff) ?? points[0];
  const elapsedMinutes = (newest.time - oldest.time) / 60_000;
  if (elapsedMinutes <= 0) return null;
  return (newest.price - oldest.price) / elapsedMinutes;
};

export const formatPnl = (pnl: number | null) =>
  pnl === null ? null : Math.round(pnl * 100) / 100;

export const closePosition = (
  position: PaperPosition,
  exitPrice: number,
  closedAt: number,
  reason: string,
): PaperPosition => {
  const contracts = position.stake / position.entryPrice;
  const payout = contracts * exitPrice;
  return {
    ...position,
    status: 'closed',
    closedAt,
    exitPrice,
    pnl: formatPnl(payout - position.stake),
    reason,
  };
};

const makePosition = (
  direction: Direction,
  entryPrice: number,
  market: KalshiMarket,
  now: number,
  btcPrice: number,
  buffer: number,
  velocity: number | null,
  signal: ModelState,
): PaperPosition => {
  const contracts = Math.floor(PAPER_STAKE / entryPrice);
  if (!Number.isSafeInteger(contracts) || contracts < 1) {
    throw new Error('Paper entry cannot buy one whole contract within the stake cap');
  }
  return {
  id: `${market.ticker}-${now}`,
  direction,
  status: 'open',
  openedAt: now,
  closedAt: null,
  entryPrice,
  exitPrice: null,
  stake: contracts * entryPrice,
  pnl: null,
  reason: null,
  ticker: market.ticker,
  target: market.target,
  entrySignal: signal,
  entryBtcPrice: btcPrice,
  entryBuffer: buffer,
  entryVelocity: velocity,
  };
};

export function evaluateStrategy(args: {
  market: KalshiMarket | null;
  latestPrice: number | null;
  previousPrice: number | null;
  velocity: number | null;
  previousBuffer: number | null;
  position: PaperPosition | null;
  crossId: number;
  now?: number;
}): StrategySnapshot {
  const {
    market,
    latestPrice,
    velocity,
    previousBuffer,
    position,
    crossId,
    now = Date.now(),
  } = args;
  const buffer =
    market?.target !== null && market?.target !== undefined && latestPrice !== null
      ? calculateSignedBuffer(latestPrice, market.target)
      : null;
  const dataError = hasSignedBufferMismatch(latestPrice, market?.target ?? null, buffer);
  const decision = evaluateV13Strategy({
    marketTicker: market?.ticker ?? null,
    btcPrice: latestPrice,
    target: market?.target ?? null,
    previousBuffer,
    velocity,
    upOffer: market?.yesAsk ?? null,
    downOffer: market?.noAsk ?? null,
    freshness: dataError ? 'data-error' : 'current',
    position,
  });
  const decisionDirection: Direction | null =
    decision.direction === 'UP' ? 'up' : decision.direction === 'DOWN' ? 'down' : null;
  if (decision.signal === 'SCOUT' && !decisionDirection) {
    throw new Error('V1.3 SCOUT decision is missing its direction');
  }
  const decisionState: ModelState = decision.signal === 'SCOUT'
    ? decisionDirection === 'up' ? 'SCOUT UP' : 'SCOUT DOWN'
    : decision.signal;

  if (!market || market.target === null || latestPrice === null) {
    return {
      state: decisionState,
      direction: decisionDirection,
      buffer: decision.buffer,
      sourceTicker: market?.ticker ?? null,
      sourceTarget: market?.target ?? null,
      sourceBtcPrice: latestPrice,
      velocity,
      marketPrice: null,
      position,
      crossId,
      note: decision.reason,
    };
  }

  const source = {
    sourceTicker: market.ticker,
    sourceTarget: market.target,
    sourceBtcPrice: latestPrice,
  };
  if (dataError) {
    return {
      state: decisionState,
      direction: decisionDirection,
      buffer,
      ...source,
      dataError: true,
      velocity,
      marketPrice: null,
      position,
      crossId,
      note: decision.reason,
    };
  }
  const resolvedBuffer = decision.buffer;
  if (resolvedBuffer === null) {
    throw new Error('V1.3 decision is missing a signed BTC buffer');
  }
  const candidatePrice = decision.candidateOffer;

  if (position?.status === 'open') {
    const resolvedResult =
      market.result === 'yes' || market.result === 'no'
        ? market.result === (position.direction === 'up' ? 'yes' : 'no')
          ? 1
          : 0
        : null;
    if (resolvedResult !== null) {
      return {
        state: 'PASS',
        direction: position.direction,
        buffer: resolvedBuffer,
        ...source,
        velocity,
        marketPrice: candidatePrice,
        position: closePosition(
          position,
          resolvedResult,
          now,
          'Kalshi settled',
        ),
        crossId,
        note: 'Settlement recorded locally',
      };
    }

    if (decision.signal === 'EXIT') {
      if (!decision.positionExitReason) {
        throw new Error('V1.3 EXIT decision is missing its position exit reason');
      }
      const exitPrice = executableExitPriceForDirection(market, position.direction);
      if (
        exitPrice === null ||
        !Number.isFinite(exitPrice) ||
        exitPrice <= 0 ||
        exitPrice > 1
      ) {
        return {
          state: 'EXIT',
          direction: position.direction,
          buffer: resolvedBuffer,
          ...source,
          velocity,
          marketPrice: null,
          position,
          crossId,
          note: 'EXIT blocked — executable sell bid unavailable',
        };
      }
      return {
        state: 'EXIT',
        direction: position.direction,
        buffer: resolvedBuffer,
        ...source,
        velocity,
        marketPrice: exitPrice,
        position: closePosition(
          position,
          exitPrice,
          now,
          decision.positionExitReason,
        ),
        crossId,
        note: decision.reason,
      };
    }

    return {
      state: decisionState,
      direction: position.direction,
      buffer: resolvedBuffer,
      ...source,
      velocity,
      marketPrice: markPriceForDirection(market, position.direction),
      position,
      crossId,
      note: decision.reason,
    };
  }

  if (decision.qualifyingTrigger && decisionDirection && decision.entrySideOffer !== null) {
    return {
      state: decisionState,
      direction: decisionDirection,
      buffer: resolvedBuffer,
      ...source,
      velocity,
      marketPrice: decision.entrySideOffer,
      position: makePosition(
        decisionDirection, decision.entrySideOffer, market, now, latestPrice, resolvedBuffer, velocity,
        decisionState,
      ),
      crossId: decision.advanceCrossId ? crossId + 1 : crossId,
      note: decision.reason,
    };
  }

  return {
    state: decisionState,
    direction: decisionDirection,
    buffer: resolvedBuffer,
    ...source,
    velocity,
    marketPrice: candidatePrice,
    position,
    crossId: decision.advanceCrossId ? crossId + 1 : crossId,
    note: decision.reason,
  };
}