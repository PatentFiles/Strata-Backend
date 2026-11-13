import { useCallback } from 'react';
import type { Direction, StrategySnapshot } from './strategy';
import type { HistoryStore } from './useHistoryStore';

export const LIVE_STARTING_BANKROLL = 25;
export const LIVE_SCOUT_SIZE = 2.5;
export const LIVE_ADD_SIZE = 2.5;
export const LIVE_MAX_EXPOSURE = 5;

export type LiveAction = 'scout' | 'add' | 'exit' | 'settlement' | 'skip';
export type LiveTradeStatus = 'open' | 'closed';

export type LiveTrade = {
  id: string;
  ticker: string;
  direction: Direction;
  scoutStake: number;
  scoutEntryPrice: number;
  addStake: number;
  addEntryPrice: number | null;
  exitPrice: number | null;
  fees: number;
  pnl: number | null;
  status: LiveTradeStatus;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
};

export type LiveEvent = {
  id: string;
  action: LiveAction;
  ticker: string;
  direction: Direction | null;
  signal: string;
  createdAt: number;
  note: string;
};

export type LiveMetrics = {
  livePnl: number;
  currentBankroll: number;
  remainingBankroll: number;
  exposure: number;
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  maxDrawdown: number;
};

export type LiveTestingState = LiveMetrics & {
  trades: LiveTrade[];
  events: LiveEvent[];
  activeTrade: LiveTrade | null;
  budgetExhausted: boolean;
  entryBlocked: boolean;
  recordScout: (input: {
    direction: Direction;
    stake: number;
    entryPrice: number;
    ticker: string;
    signal: string;
    fees: number;
  }) => Promise<string | null>;
  recordAdd: (input: {
    stake: number;
    entryPrice: number;
    ticker: string;
    signal: string;
    fees: number;
  }) => Promise<string | null>;
  recordExit: (input: {
    exitPrice: number;
    ticker: string;
    signal: string;
    fees: number;
    reason: string;
  }) => Promise<string | null>;
  recordSettlement: (input: {
    exitPrice: number;
    ticker: string;
    signal: string;
    fees: number;
  }) => Promise<string | null>;
  recordSkip: (input: {
    ticker: string;
    direction: Direction | null;
    signal: string;
  }) => Promise<string | null>;
};

export const scoutDirectionForStrategy = (
  strategy: StrategySnapshot,
): Direction | null =>
  strategy.dataError
    ? null
    : strategy.state === 'SCOUT UP'
      ? 'up'
      : strategy.state === 'SCOUT DOWN'
        ? 'down'
        : null;

export const directionForLiveSignal = (
  strategy: StrategySnapshot,
): Direction | null =>
  strategy.dataError || strategy.state === 'PASS'
    ? null
    : scoutDirectionForStrategy(strategy) ?? strategy.direction;

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const priceIsValid = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= 1;

const positiveMoney = (value: number) =>
  Number.isFinite(value) && value > 0 && value <= LIVE_SCOUT_SIZE;

const getExposure = (trade: LiveTrade | null) =>
  trade ? trade.scoutStake + trade.addStake : 0;

const legPnl = (stake: number, entryPrice: number, exitPrice: number) =>
  stake / entryPrice * exitPrice - stake;

const calculatePnl = (
  trade: Pick<
    LiveTrade,
    'scoutStake' | 'scoutEntryPrice' | 'addStake' | 'addEntryPrice' | 'fees'
  >,
  exitPrice: number,
) =>
  roundMoney(
    legPnl(trade.scoutStake, trade.scoutEntryPrice, exitPrice) +
      (trade.addEntryPrice === null
        ? 0
        : legPnl(trade.addStake, trade.addEntryPrice, exitPrice)) -
      trade.fees,
  );

const livePnlFor = (trades: LiveTrade[]) =>
  roundMoney(
    trades.reduce((total, trade) => total + (trade.pnl ?? 0), 0),
  );

const createEvent = (
  action: LiveAction,
  ticker: string,
  direction: Direction | null,
  signal: string,
  note: string,
): LiveEvent => ({
  id: `live-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  action,
  ticker,
  direction,
  signal,
  createdAt: Date.now(),
  note,
});

const buildMetrics = (trades: LiveTrade[]): LiveMetrics => {
  const completed = trades.filter(
    (trade): trade is LiveTrade & { pnl: number; closedAt: number } =>
      trade.status === 'closed' && trade.pnl !== null && trade.closedAt !== null,
  );
  const livePnl = livePnlFor(completed);
  const wins = completed.filter((trade) => trade.pnl > 0);
  const losses = completed.filter((trade) => trade.pnl < 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of [...completed].sort(
    (a, b) => a.closedAt - b.closedAt,
  )) {
    equity = roundMoney(equity + trade.pnl);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const active = trades.find((trade) => trade.status === 'open') ?? null;
  const exposure = getExposure(active);
  const currentBankroll = roundMoney(
    LIVE_STARTING_BANKROLL + livePnl - exposure,
  );

  return {
    livePnl,
    currentBankroll,
    remainingBankroll: currentBankroll,
    exposure,
    completedTrades: completed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: completed.length ? wins.length / completed.length : 0,
    averageWin: wins.length
      ? roundMoney(wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length)
      : 0,
    averageLoss: losses.length
      ? roundMoney(
          losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length,
        )
      : 0,
    expectancy: completed.length ? roundMoney(livePnl / completed.length) : 0,
    maxDrawdown: roundMoney(maxDrawdown),
  };
};

export function liveSignalFor(
  strategy: StrategySnapshot,
  budgetExhausted: boolean,
): string {
  if (strategy.dataError) return 'DATA ERROR';
  if (budgetExhausted) return 'LIVE TEST BUDGET EXHAUSTED';
  if (strategy.state === 'SCOUT UP') return 'ENTER UP — SCOUT $2.50';
  if (strategy.state === 'SCOUT DOWN') return 'ENTER DOWN — SCOUT $2.50';
  if (strategy.state === 'CONFIRM' && strategy.direction === 'up') {
    return 'ADD UP — $2.50';
  }
  if (strategy.state === 'CONFIRM' && strategy.direction === 'down') {
    return 'ADD DOWN — $2.50';
  }
  if (strategy.state === 'EXIT' && strategy.direction === 'up') {
    return 'EXIT UP';
  }
  if (strategy.state === 'EXIT' && strategy.direction === 'down') {
    return 'EXIT DOWN';
  }
  if (strategy.state === 'WATCH' && strategy.direction === 'up') {
    return 'WATCH UP';
  }
  if (strategy.state === 'WATCH' && strategy.direction === 'down') {
    return 'WATCH DOWN';
  }
  return 'PASS';
}

export function useLiveTesting(strategy: StrategySnapshot, store: HistoryStore): LiveTestingState {
  const trades = store.liveTrades;
  const events = store.liveEvents;
  const saveLive = store.saveLive;

  const activeTrade = trades.find((trade) => trade.status === 'open') ?? null;
  const metrics = store.metrics?.live ?? buildMetrics([]);
  const budgetExhausted = metrics.remainingBankroll <= 0;
  const entryBlocked =
    Boolean(strategy.dataError) ||
    store.status !== 'CONNECTED' ||
    budgetExhausted ||
    activeTrade !== null ||
    metrics.remainingBankroll < LIVE_SCOUT_SIZE;

  const update = useCallback(async (trade: LiveTrade | null, event: LiveEvent) => {
    try {
      await saveLive(trade, event);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Unable to save this record to the database.';
    }
  }, [saveLive]);

  const recordScout = useCallback(
    async (input: {
      direction: Direction;
      stake: number;
      entryPrice: number;
      ticker: string;
      signal: string;
      fees: number;
    }) => {
      if (store.status !== 'CONNECTED') return 'Database unavailable. No manual record was saved.';
      if (
        scoutDirectionForStrategy(strategy) !== input.direction
      ) return 'A matching ENTER / SCOUT signal is required.';
      if (budgetExhausted) return 'LIVE TEST BUDGET EXHAUSTED.';
      if (activeTrade) return 'Close the current live trade before entering another.';
      if (!positiveMoney(input.stake)) {
        return 'Scout wager must be greater than $0 and no more than $2.50.';
      }
      if (!priceIsValid(input.entryPrice) || input.entryPrice <= 0) {
        return 'Enter a Kalshi price from 0.1% to 100%.';
      }
      if (input.stake > metrics.remainingBankroll) {
        return 'This wager would exceed the remaining $25 test bankroll.';
      }
      const now = Date.now();
      const trade: LiveTrade = {
        id: `live-trade-${crypto.randomUUID()}`,
        ticker: input.ticker,
        direction: input.direction,
        scoutStake: roundMoney(input.stake),
        scoutEntryPrice: input.entryPrice,
        addStake: 0,
        addEntryPrice: null,
        exitPrice: null,
        fees: roundMoney(Math.max(0, input.fees)),
        pnl: null,
        status: 'open',
        openedAt: now,
        closedAt: null,
        closeReason: null,
      };
      return update(trade,
        createEvent(
          'scout',
          input.ticker,
          input.direction,
          input.signal,
          `Recorded ${input.stake.toFixed(2)} scout`,
        ),
      );
    },
    [activeTrade, budgetExhausted, metrics.remainingBankroll, strategy, store.status, update],
  );

  const recordAdd = useCallback(
    async (input: {
      stake: number;
      entryPrice: number;
      ticker: string;
      signal: string;
      fees: number;
    }) => {
      if (store.status !== 'CONNECTED') return 'Database unavailable. No manual record was saved.';
      if (
        strategy.dataError ||
        strategy.state !== 'CONFIRM' ||
        strategy.direction !== activeTrade?.direction
      ) return 'A matching ADD / CONFIRM signal is required.';
      if (!activeTrade) return 'Record a scout before recording an add.';
      if (input.ticker !== activeTrade.ticker) return 'The open trade belongs to a different market.';
      if (activeTrade.addStake > 0) {
        return 'This live trade already has a confirm/add leg.';
      }
      if (!positiveMoney(input.stake)) {
        return 'Add wager must be greater than $0 and no more than $2.50.';
      }
      if (getExposure(activeTrade) + input.stake > LIVE_MAX_EXPOSURE) {
        return 'Maximum exposure per contract is $5.00.';
      }
      if (input.stake > metrics.remainingBankroll) {
        return 'This add would exceed the remaining $25 test bankroll.';
      }
      if (!priceIsValid(input.entryPrice) || input.entryPrice <= 0) {
        return 'Enter an add price from 0.1% to 100%.';
      }
      const nextTrade: LiveTrade = {
        ...activeTrade,
        addStake: roundMoney(input.stake),
        addEntryPrice: input.entryPrice,
        fees: roundMoney(activeTrade.fees + Math.max(0, input.fees)),
      };
      return update(nextTrade,
        createEvent(
          'add',
          input.ticker,
          activeTrade.direction,
          input.signal,
          `Recorded ${input.stake.toFixed(2)} add`,
        ),
      );
    },
    [activeTrade, metrics.remainingBankroll, strategy, store.status, update],
  );

  const close = useCallback(
    async (
      input: {
        exitPrice: number;
        ticker: string;
        signal: string;
        fees: number;
        reason: string;
      },
      action: 'exit' | 'settlement',
    ) => {
      if (store.status !== 'CONNECTED') return 'Database unavailable. No manual record was saved.';
      if (!activeTrade) return 'There is no open live trade to close.';
      if (!priceIsValid(input.exitPrice)) {
        return 'Enter an exit or settlement price from 0% to 100%.';
      }
      const pnl = calculatePnl(
        {
          ...activeTrade,
          fees: roundMoney(activeTrade.fees + Math.max(0, input.fees)),
        },
        input.exitPrice,
      );
      const nextTrade: LiveTrade = {
        ...activeTrade,
        exitPrice: input.exitPrice,
        fees: roundMoney(activeTrade.fees + Math.max(0, input.fees)),
        pnl,
        status: 'closed',
        closedAt: Date.now(),
        closeReason: input.reason,
      };
      return update(nextTrade,
        createEvent(
          action,
          input.ticker,
          activeTrade.direction,
          input.signal,
          `${action === 'settlement' ? 'Held to settlement' : 'Recorded manual exit'} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        ),
      );
    },
    [activeTrade, store.status, update],
  );

  const recordExit = useCallback(
    async (input: {
      exitPrice: number;
      ticker: string;
      signal: string;
      fees: number;
      reason: string;
    }) => close(input, 'exit'),
    [close],
  );

  const recordSettlement = useCallback(
    (input: {
      exitPrice: number;
      ticker: string;
      signal: string;
      fees: number;
    }) => close({ ...input, reason: 'Held to settlement' }, 'settlement'),
    [close],
  );

  const recordSkip = useCallback(
    async (input: {
      ticker: string;
      direction: Direction | null;
      signal: string;
    }) => {
      if (store.status !== 'CONNECTED') return 'Database unavailable. No manual record was saved.';
      const event = createEvent(
        'skip',
        input.ticker,
        input.direction,
        input.signal,
        'Trade skipped manually',
      );
      return update(null, event);
    },
    [store.status, update],
  );

  return {
    ...metrics,
    trades,
    events,
    activeTrade,
    budgetExhausted,
    entryBlocked,
    recordScout,
    recordAdd,
    recordExit,
    recordSettlement,
    recordSkip,
  };
}