import { useAuth } from '@clerk/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent, LiveTrade } from './liveTesting';
import type { LiveMetrics } from './liveTesting';
import type { PaperPosition } from './strategy';

const PAPER_LEGACY_KEY = 'btc-paper-testing-history-v1';
const LIVE_LEGACY_KEY = 'btc-paper-testing-live-trades-v1';
const EVENTS_LEGACY_KEY = 'btc-paper-testing-live-events-v1';

export type HistorySnapshot = {
  paper: PaperPosition[];
  liveTrades: LiveTrade[];
  liveEvents: LiveEvent[];
  syncedAt: number;
  metrics: {
    paper: {
      completed: number; wins: number; losses: number; cumulativePnl: number;
      winRate: number; averageWin: number; averageLoss: number; expectancy: number;
    };
    live: LiveMetrics;
  };
};

export type SavedRecord = {
  id: string;
  timestamp: number;
  type: 'Paper test' | 'Manual live trade' | 'Manual live event' | 'Diagnostic test';
  side: 'UP' | 'DOWN' | null;
  pnl: number | null;
};

export type WriteDiagnostic = {
  api: 'idle' | 'writing' | 'success' | 'failed';
  readback: 'idle' | 'checking' | 'verified' | 'failed';
  attemptedAt: number | null;
  confirmedAt: number | null;
  verifiedAt: number | null;
  record: SavedRecord | null;
  error: string | null;
};

const idleWrite: WriteDiagnostic = {
  api: 'idle', readback: 'idle', attemptedAt: null,
  confirmedAt: null, verifiedAt: null, record: null, error: null,
};

function eventRecord(event: LiveEvent): SavedRecord {
  return {
    id: event.id,
    timestamp: event.createdAt,
    type: event.signal === 'DIAGNOSTIC PERSISTENCE TEST' ? 'Diagnostic test' : 'Manual live event',
    side: event.direction ? event.direction.toUpperCase() as 'UP' | 'DOWN' : null,
    pnl: null,
  };
}

function latestRecord(data: HistorySnapshot): SavedRecord | null {
  const records: SavedRecord[] = [
    ...data.paper.map((position) => ({
      id: position.id, timestamp: position.closedAt ?? position.openedAt,
      type: 'Paper test' as const,
      side: position.direction.toUpperCase() as 'UP' | 'DOWN',
      pnl: position.pnl,
    })),
    ...data.liveTrades.map((trade) => ({
      id: trade.id, timestamp: trade.closedAt ?? trade.openedAt,
      type: 'Manual live trade' as const,
      side: trade.direction.toUpperCase() as 'UP' | 'DOWN',
      pnl: trade.pnl,
    })),
    ...data.liveEvents.map(eventRecord),
  ];
  return records.sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
}

export type HistoryStore = {
  status: 'SIGN IN' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
  paper: PaperPosition[];
  liveTrades: LiveTrade[];
  liveEvents: LiveEvent[];
  syncedAt: number | null;
  metrics: HistorySnapshot['metrics'] | null;
  latestSaved: SavedRecord | null;
  writeDiagnostic: WriteDiagnostic;
  refresh: () => Promise<void>;
  savePaper: (trade: PaperPosition) => Promise<void>;
  saveLive: (trade: LiveTrade | null, event: LiveEvent) => Promise<void>;
  testPersistence: () => Promise<void>;
  importLegacy: () => Promise<{ paperImported: number; liveImported: number; eventsImported: number }>;
  importBackup: (file: File) => Promise<{ paperImported: number; liveImported: number; eventsImported: number }>;
  exportLegacy: () => void;
  exportHistory: () => Promise<void>;
};

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readLegacy<T>(key: string): T[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    throw new Error(`Browser storage could not be read (${key}). No records were imported.`);
  }
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new Error(`Browser history is not valid JSON (${key}). No records were imported.`); }
  if (!Array.isArray(value)) throw new Error(`Browser history is not a list (${key}). No records were imported.`);
  return value as T[];
}

async function historyRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/history${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? { Accept: 'application/json' } : {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(response.status === 401
      ? 'Sign in to save and load your private history.'
      : `Database request failed (${response.status}). Your saved history was not changed.`);
  }
  return response.json() as Promise<T>;
}

const pendingKey = (userId: string) => `btc-paper-pending:${userId}`;

export function useHistoryStore(): HistoryStore {
  const { isLoaded, userId } = useAuth();
  const activeUserRef = useRef(userId);
  activeUserRef.current = userId;
  const flushRunningRef = useRef(false);
  const [snapshot, setSnapshot] = useState<{ userId: string; data: HistorySnapshot } | null>(null);
  const [status, setStatus] = useState<HistoryStore['status']>('CONNECTING');
  const [write, setWrite] = useState<{ userId: string; data: WriteDiagnostic } | null>(null);

  const reload = useCallback(async (): Promise<HistorySnapshot> => {
    if (!userId) throw new Error('Sign in to load your private history.');
    const data = await historyRequest<HistorySnapshot>('');
    if (activeUserRef.current === userId) {
      setSnapshot({ userId, data });
      setStatus('CONNECTED');
    }
    return data;
  }, [userId]);

  const writeAndVerify = useCallback(async (
    path: '/paper' | '/live',
    body: unknown,
    expected: { paperId: string } | { eventId: string; tradeId: string | null },
  ) => {
    if (!userId) throw new Error('Sign in to write to your private ledger.');
    const started: WriteDiagnostic = { ...idleWrite, api: 'writing', attemptedAt: Date.now() };
    if (activeUserRef.current === userId) setWrite({ userId, data: started });
    let apiSucceeded = false;
    let confirmedAt: number | null = null;
    try {
      await historyRequest(path, body);
      apiSucceeded = true;
      confirmedAt = Date.now();
      if (activeUserRef.current === userId) {
        setWrite({ userId, data: { ...started, api: 'success', readback: 'checking', confirmedAt } });
      }
      // A second request must read the record back from the account's ledger.
      // A successful POST alone does not count as persistence verification.
      const data = await reload();
      let record: SavedRecord | null = null;
      if ('paperId' in expected) {
        const saved = data.paper.find((item) => item.id === expected.paperId);
        if (saved) record = {
          id: saved.id, timestamp: saved.closedAt ?? saved.openedAt,
          type: 'Paper test', side: saved.direction.toUpperCase() as 'UP' | 'DOWN', pnl: saved.pnl,
        };
      } else {
        const savedEvent = data.liveEvents.find((item) => item.id === expected.eventId);
        const savedTrade = expected.tradeId
          ? data.liveTrades.find((item) => item.id === expected.tradeId)
          : null;
        if (savedEvent && (!expected.tradeId || savedTrade)) {
          record = savedTrade ? {
            id: savedTrade.id, timestamp: savedEvent.createdAt,
            type: 'Manual live trade', side: savedTrade.direction.toUpperCase() as 'UP' | 'DOWN',
            pnl: savedTrade.pnl,
          } : eventRecord(savedEvent);
        }
      }
      if (!record) throw new Error('API write succeeded, but the saved record was not found in the server readback.');
      if (activeUserRef.current === userId) {
        setWrite({
          userId, data: {
            ...started, api: 'success', readback: 'verified',
            confirmedAt, verifiedAt: Date.now(), record,
          },
        });
      }
    } catch (error) {
      if (activeUserRef.current === userId) {
        setWrite({
          userId, data: {
            ...started, api: apiSucceeded ? 'success' : 'failed',
            readback: apiSucceeded ? 'failed' : 'idle', confirmedAt,
            error: error instanceof Error ? error.message : 'Unknown database error.',
          },
        });
      }
      throw error;
    }
  }, [userId, reload]);

  const flushPending = useCallback(async () => {
    if (!userId || flushRunningRef.current) return;
    flushRunningRef.current = true;
    try {
      const key = pendingKey(userId);
      const pending = readLegacy<PaperPosition>(key);
      for (const trade of pending) {
        await writeAndVerify('/paper', trade, { paperId: trade.id });
        const remaining = readLegacy<PaperPosition>(key).filter((item) => item.id !== trade.id);
        window.localStorage.setItem(key, JSON.stringify(remaining));
      }
      if (pending.length) await reload();
    } catch {
      if (activeUserRef.current === userId) setStatus('ERROR');
    } finally {
      flushRunningRef.current = false;
    }
  }, [userId, reload, writeAndVerify]);

  useEffect(() => {
    if (!isLoaded || !userId) {
      setSnapshot(null);
      setWrite(null);
      setStatus(isLoaded ? 'SIGN IN' : 'CONNECTING');
      return;
    }
    setSnapshot(null);
    setWrite(null);
    setStatus('CONNECTING');
    void reload().then(flushPending).catch(() => {
      if (activeUserRef.current === userId) setStatus('ERROR');
    });
    const timer = window.setInterval(() => {
      void reload().then(flushPending).catch(() => {
        if (activeUserRef.current === userId) setStatus('ERROR');
      });
    }, 15_000);
    // Faster diagnostics are GET-only. Keep pending-save retries on their
    // existing cadence rather than increasing mutation frequency.
    const readTimer = window.setInterval(() => {
      void reload().catch(() => {
        if (activeUserRef.current === userId) setStatus('ERROR');
      });
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(readTimer);
    };
  }, [isLoaded, userId, reload, flushPending]);

  const savePaper = useCallback(async (trade: PaperPosition) => {
    if (!userId) throw new Error('Sign in to save paper tests.');
    try {
      await writeAndVerify('/paper', trade, { paperId: trade.id });
    } catch (error) {
      try {
        const key = pendingKey(userId);
        const pending = readLegacy<PaperPosition>(key);
        if (!pending.some((item) => item.id === trade.id)) {
          window.localStorage.setItem(key, JSON.stringify([...pending, trade]));
        }
      } catch {
        // The error remains visible; never claim an unsaved record was persisted.
      }
      if (activeUserRef.current === userId) setStatus('ERROR');
      throw error;
    }
  }, [userId, writeAndVerify]);

  const saveLive = useCallback(async (trade: LiveTrade | null, event: LiveEvent) => {
    if (!userId) throw new Error('Sign in to save manual records.');
    try {
      await writeAndVerify('/live', { trade, event }, { eventId: event.id, tradeId: trade?.id ?? null });
    } catch (error) {
      // A lost response can follow a successful write. Re-read before another
      // action so the UI cannot create a second trade from a stale empty state.
      try { await reload(); } catch { if (activeUserRef.current === userId) setStatus('ERROR'); }
      throw error;
    }
  }, [userId, reload, writeAndVerify]);

  const testPersistence = useCallback(async () => {
    if (!userId) throw new Error('Sign in to test private ledger persistence.');
    const event: LiveEvent = {
      id: `diagnostic-${crypto.randomUUID()}`,
      action: 'skip',
      ticker: 'DIAGNOSTIC-ONLY',
      direction: null,
      signal: 'DIAGNOSTIC PERSISTENCE TEST',
      createdAt: Date.now(),
      note: 'Synthetic diagnostics-only ledger check. No position, order, stake, or P&L.',
    };
    await writeAndVerify('/live', { trade: null, event }, { eventId: event.id, tradeId: null });
  }, [userId, writeAndVerify]);

  const importLegacy = useCallback(async () => {
    if (!userId) throw new Error('Sign in before importing legacy history.');
    const result = await historyRequest<{
      paperImported: number;
      liveImported: number;
      eventsImported: number;
    }>('/import', {
      paper: readLegacy<PaperPosition>(PAPER_LEGACY_KEY),
      liveTrades: readLegacy<LiveTrade>(LIVE_LEGACY_KEY),
      liveEvents: readLegacy<LiveEvent>(EVENTS_LEGACY_KEY),
    });
    await reload();
    return result;
  }, [userId, reload]);

  const exportLegacy = useCallback(() => {
    downloadJson({
      paper: readLegacy<PaperPosition>(PAPER_LEGACY_KEY),
      liveTrades: readLegacy<LiveTrade>(LIVE_LEGACY_KEY),
      liveEvents: readLegacy<LiveEvent>(EVENTS_LEGACY_KEY),
    }, 'btc-legacy-browser-history.json');
  }, []);

  const importBackup = useCallback(async (file: File) => {
    if (!userId) throw new Error('Sign in before importing a backup.');
    if (file.size > 5_000_000) throw new Error('JSON backup is too large (5 MB limit).');
    let data: unknown;
    try { data = JSON.parse(await file.text()) as unknown; }
    catch { throw new Error('The selected file is not valid JSON.'); }
    if (
      !data || typeof data !== 'object' ||
      !('paper' in data) || !Array.isArray(data.paper) ||
      !('liveTrades' in data) || !Array.isArray(data.liveTrades) ||
      !('liveEvents' in data) || !Array.isArray(data.liveEvents)
    ) throw new Error('The backup must contain paper, liveTrades, and liveEvents arrays.');
    const result = await historyRequest<{
      paperImported: number; liveImported: number; eventsImported: number;
    }>('/import', { paper: data.paper, liveTrades: data.liveTrades, liveEvents: data.liveEvents });
    await reload();
    return result;
  }, [userId, reload]);

  const exportHistory = useCallback(async () => {
    const data = await reload();
    downloadJson(data, 'btc-paper-test-history.json');
  }, [reload]);

  const current = snapshot && snapshot.userId === userId ? snapshot.data : null;
  return {
    status: !isLoaded ? 'CONNECTING' : !userId ? 'SIGN IN' : !current && status === 'CONNECTED' ? 'CONNECTING' : status,
    paper: current?.paper ?? [],
    liveTrades: current?.liveTrades ?? [],
    liveEvents: current?.liveEvents ?? [],
    syncedAt: current?.syncedAt ?? null,
    metrics: current?.metrics ?? null,
    latestSaved: current ? latestRecord(current) : null,
    writeDiagnostic: write && write.userId === userId ? write.data : idleWrite,
    refresh: async () => {
      try { await reload(); } catch (error) { setStatus('ERROR'); throw error; }
    },
    savePaper,
    saveLive,
    testPersistence,
    importLegacy,
    importBackup,
    exportLegacy,
    exportHistory,
  };
}