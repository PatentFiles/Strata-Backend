import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createCoinbaseSocket,
  fetchKxbtc15mMarketByTicker,
  fetchOpenKxbtc15mMarket,
  type BtcTick,
  type KalshiMarket,
} from './marketData';
import {
  calculateVelocity,
  evaluateStrategy,
  safeStrategyForDisplay,
  type ModelState,
  type PaperPosition,
  type PricePoint,
  type StrategySnapshot,
} from './strategy';
import type { HistoryStore } from './useHistoryStore';

const MAX_POINTS = 180;

export type EvaluationActivity = {
  at: number;
  state: ModelState | 'DATA ERROR';
  reason: string;
  buffer: number | null;
};

export type ForwardProgress = {
  marketPolls: number;
  evaluations: number;
  windowsObserved: number;
  passCount: number;
  watchCount: number;
  scoutTriggers: number;
  confirmTriggers: number;
  lastQualifyingTriggerAt: number | null;
  recentEvaluations: EvaluationActivity[];
};

export type PaperTradingState = {
  market: KalshiMarket | null;
  btcPrice: number | null;
  btcUpdatedAt: number | null;
  velocity: number | null;
  strategy: StrategySnapshot;
  history: PaperPosition[];
  activePosition: PaperPosition | null;
  completedTests: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  cumulativePnl: number;
  coinbaseStatus: 'connecting' | 'open' | 'closed' | 'error';
  marketLoading: boolean;
  marketError: string | null;
  marketUpdatedAt: number | null;
  lastPollAttemptAt: number | null;
  lastEvaluationAt: number | null;
  triggerLatestCycle: boolean;
  lastTriggerAt: number | null;
  progress: ForwardProgress;
};

const emptyStrategy: StrategySnapshot = {
  state: 'WATCH',
  direction: null,
  buffer: null,
  velocity: null,
  marketPrice: null,
  position: null,
  crossId: 0,
  note: 'Connecting to public market data',
};

const emptyProgress: ForwardProgress = {
  marketPolls: 0,
  evaluations: 0,
  windowsObserved: 0,
  passCount: 0,
  watchCount: 0,
  scoutTriggers: 0,
  confirmTriggers: 0,
  lastQualifyingTriggerAt: null,
  recentEvaluations: [],
};

export function usePaperTrading(store: HistoryStore): PaperTradingState {
  const [market, setMarket] = useState<KalshiMarket | null>(null);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [btcUpdatedAt, setBtcUpdatedAt] = useState<number | null>(null);
  const [velocity, setVelocity] = useState<number | null>(null);
  const [strategy, setStrategy] = useState<StrategySnapshot>(emptyStrategy);
  const history = store.paper;
  const savePaper = store.savePaper;
  const [activePosition, setActivePosition] = useState<PaperPosition | null>(
    null,
  );
  const [coinbaseStatus, setCoinbaseStatus] =
    useState<PaperTradingState['coinbaseStatus']>('connecting');
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketUpdatedAt, setMarketUpdatedAt] = useState<number | null>(null);
  const [lastPollAttemptAt, setLastPollAttemptAt] = useState<number | null>(null);
  const [lastEvaluationAt, setLastEvaluationAt] = useState<number | null>(null);
  const [triggerLatestCycle, setTriggerLatestCycle] = useState(false);
  const [lastTriggerAt, setLastTriggerAt] = useState<number | null>(null);
  const lastTriggerSignatureRef = useRef<string | null>(null);
  const [progress, setProgress] = useState<ForwardProgress>(emptyProgress);
  const observedWindowTickersRef = useRef(new Set<string>());

  const marketRef = useRef<KalshiMarket | null>(null);
  const activePositionRef = useRef<PaperPosition | null>(null);
  const previousBufferRef = useRef<number | null>(null);
  const previousMarketKeyRef = useRef<string | null>(null);
  const crossIdRef = useRef(0);
  const pointsRef = useRef<PricePoint[]>([]);
  const reconnectTimerRef = useRef<number | null>(null);
  const marketFetchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    marketRef.current = market;
  }, [market]);

  useEffect(() => {
    activePositionRef.current = activePosition;
  }, [activePosition]);

  const recordObservedWindow = useCallback((ticker: string) => {
    if (observedWindowTickersRef.current.has(ticker)) return;
    observedWindowTickersRef.current.add(ticker);
    setProgress((current) => ({
      ...current,
      windowsObserved: current.windowsObserved + 1,
    }));
  }, []);

  const applyTick = useCallback(
    (tick: BtcTick) => {
      const nextPoints = [
        ...pointsRef.current,
        { price: tick.price, time: tick.time },
      ].filter((point) => point.time >= tick.time - 120_000);
      pointsRef.current = nextPoints.slice(-MAX_POINTS);
      const nextVelocity = calculateVelocity(pointsRef.current);
      const currentMarket = marketRef.current;
      const currentPosition = activePositionRef.current;
      const marketKey = currentMarket
        ? `${currentMarket.ticker}:${currentMarket.target ?? 'unknown'}`
        : null;
      // A new strike is not a crossing caused by a new BTC tick.
      if (marketKey !== previousMarketKeyRef.current) {
        previousBufferRef.current = null;
        previousMarketKeyRef.current = marketKey;
      }
      const nextStrategy = evaluateStrategy({
        market: currentMarket,
        latestPrice: tick.price,
        previousPrice:
          pointsRef.current.length > 1
            ? pointsRef.current[pointsRef.current.length - 2].price
            : null,
        velocity: nextVelocity,
        previousBuffer: previousBufferRef.current,
        position: currentPosition,
        crossId: crossIdRef.current,
        now: tick.time,
      });
      const evaluatedAt = Date.now();
      setLastEvaluationAt(evaluatedAt);
      const safeState = safeStrategyForDisplay(nextStrategy, tick.price, currentMarket);
      const triggered = !safeState.dataError && (
        safeState.state === 'SCOUT UP' ||
        safeState.state === 'SCOUT DOWN' ||
        safeState.state === 'CONFIRM' ||
        safeState.state === 'EXIT' ||
        nextStrategy.position?.status === 'closed'
      );
      setTriggerLatestCycle(triggered);
      const signature = triggered
        ? `${safeState.state}:${safeState.crossId}:${nextStrategy.position?.id ?? ''}:${nextStrategy.position?.status ?? ''}`
        : null;
      const newTrigger = Boolean(signature && signature !== lastTriggerSignatureRef.current);
      if (newTrigger) setLastTriggerAt(evaluatedAt);
      lastTriggerSignatureRef.current = signature;
      const scout = safeState.state === 'SCOUT UP' || safeState.state === 'SCOUT DOWN';
      const confirm = safeState.state === 'CONFIRM';
      const activity: EvaluationActivity = {
        at: evaluatedAt,
        state: safeState.dataError ? 'DATA ERROR' : safeState.state,
        reason: safeState.note,
        buffer: safeState.dataError ? null : safeState.buffer,
      };
      setProgress((current) => ({
        ...current,
        evaluations: current.evaluations + 1,
        passCount: current.passCount + Number(!safeState.dataError && safeState.state === 'PASS'),
        watchCount: current.watchCount + Number(!safeState.dataError && safeState.state === 'WATCH'),
        scoutTriggers: current.scoutTriggers + Number(newTrigger && scout),
        confirmTriggers: current.confirmTriggers + Number(newTrigger && confirm),
        lastQualifyingTriggerAt: newTrigger && (scout || confirm)
          ? evaluatedAt : current.lastQualifyingTriggerAt,
        recentEvaluations: [activity, ...current.recentEvaluations].slice(0, 10),
      }));

      previousBufferRef.current = nextStrategy.buffer;
      crossIdRef.current = nextStrategy.crossId;
      setBtcPrice(tick.price);
      setBtcUpdatedAt(tick.time);
      setVelocity(nextVelocity);
      setStrategy(nextStrategy);

      const nextPosition = nextStrategy.position;
      if (nextPosition?.status === 'closed') {
        // Completed results appear in the ledger only after the server saves
        // them. Failed writes are retained by the history store for retry.
        void savePaper(nextPosition).catch(() => {});
        activePositionRef.current = null;
        setActivePosition(null);
      } else if (
        nextPosition?.status === 'open' &&
        nextPosition.id !== currentPosition?.id
      ) {
        activePositionRef.current = nextPosition;
        setActivePosition(nextPosition);
      } else if (nextPosition?.status === 'open') {
        activePositionRef.current = nextPosition;
        setActivePosition(nextPosition);
      }
    },
    [savePaper],
  );

  const refreshMarket = useCallback(async () => {
    marketFetchAbortRef.current?.abort();
    setLastPollAttemptAt(Date.now());
    setProgress((current) => ({ ...current, marketPolls: current.marketPolls + 1 }));
    const controller = new AbortController();
    marketFetchAbortRef.current = controller;
    try {
      const current = marketRef.current;
      const currentExpired =
        current?.closeTime !== null &&
        current?.closeTime !== undefined &&
        Date.parse(current.closeTime) <= Date.now();
      if (currentExpired && activePositionRef.current) {
        try {
          const settled = await fetchKxbtc15mMarketByTicker(
            current.ticker,
            controller.signal,
          );
          setMarket(settled);
          marketRef.current = settled;
          setMarketUpdatedAt(settled.fetchedAt);
          recordObservedWindow(settled.ticker);
          setMarketError(null);
          return;
        } catch {
          // The next open market is still useful; expiry fallback is handled by the strategy.
        }
      }
      const nextMarket = await fetchOpenKxbtc15mMarket(controller.signal);
      setMarket(nextMarket);
      marketRef.current = nextMarket;
      setMarketUpdatedAt(nextMarket.fetchedAt);
      recordObservedWindow(nextMarket.ticker);
      setMarketError(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      setMarketError(
        error instanceof Error ? error.message : 'Unable to read Kalshi market data',
      );
    } finally {
      if (!controller.signal.aborted) setMarketLoading(false);
    }
  }, [recordObservedWindow]);

  useEffect(() => {
    void refreshMarket();
    const timer = window.setInterval(() => void refreshMarket(), 5_000);
    return () => {
      window.clearInterval(timer);
      marketFetchAbortRef.current?.abort();
    };
  }, [refreshMarket]);

  useEffect(() => {
    let disposed = false;
    let closeSocket = () => {};

    const connect = () => {
      if (disposed) return;
      closeSocket = createCoinbaseSocket(applyTick, (status) => {
        setCoinbaseStatus(status);
        if (
          (status === 'closed' || status === 'error') &&
          !disposed &&
          reconnectTimerRef.current === null
        ) {
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, 3_000);
        }
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      closeSocket();
    };
  }, [applyTick]);

  const completedTests = store.metrics?.paper.completed ?? 0;
  const wins = store.metrics?.paper.wins ?? 0;
  const losses = store.metrics?.paper.losses ?? 0;
  const cumulativePnl = store.metrics?.paper.cumulativePnl ?? 0;
  const winRate = store.metrics?.paper.winRate ?? 0;
  const averageWin = store.metrics?.paper.averageWin ?? 0;
  const averageLoss = store.metrics?.paper.averageLoss ?? 0;
  const expectancy = store.metrics?.paper.expectancy ?? 0;

  return {
    market,
    btcPrice,
    btcUpdatedAt,
    velocity,
    strategy: safeStrategyForDisplay(strategy, btcPrice, market),
    history,
    activePosition,
    completedTests,
    wins,
    losses,
    winRate,
    averageWin,
    averageLoss,
    expectancy,
    cumulativePnl,
    coinbaseStatus,
    marketLoading,
    marketError,
    marketUpdatedAt,
    lastPollAttemptAt,
    lastEvaluationAt,
    triggerLatestCycle,
    lastTriggerAt,
    progress,
  };
}

export type { ModelState, PaperPosition };