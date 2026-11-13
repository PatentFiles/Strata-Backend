import { useEffect, useState } from 'react';
import type { PaperTradingState } from '@/lib/usePaperTrading';
import type { HistoryStore, SavedRecord } from '@/lib/useHistoryStore';

function time(value: number | null) {
  return value === null ? '—' : new Date(value).toLocaleString();
}

function RecordDetails({ record, emptyLabel = 'No saved record yet' }: { record: SavedRecord | null; emptyLabel?: string }) {
  if (!record) return <span>{emptyLabel}</span>;
  return (
    <span className="break-words">
      {record.type} · {record.side ?? 'no side'}
      {record.pnl !== null ? ` · ${record.pnl >= 0 ? '+' : ''}$${record.pnl.toFixed(2)} P&L` : ' · no P&L'}
    </span>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="mono text-[9px] uppercase tracking-[.11em] text-[#858a92]">{label}</dt><dd className="mt-1 break-words text-[12px] font-semibold text-[#303b4e]">{children}</dd></div>;
}

export default function DiagnosticsPanel({ market, store }: { market: PaperTradingState; store: HistoryStore }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [testing, setTesting] = useState(false);
  const feedStatus = market.marketError || market.coinbaseStatus === 'error'
    ? 'error'
    : market.coinbaseStatus !== 'open' || !market.marketUpdatedAt || !market.btcUpdatedAt ||
      now - market.marketUpdatedAt > 15_000 || now - market.btcUpdatedAt > 15_000
      ? 'stale' : 'running';
  const write = store.writeDiagnostic;
  const runTest = async () => {
    setTesting(true);
    try { await store.testPersistence(); }
    catch { /* The independent API and readback results below show the error. */ }
    finally { setTesting(false); }
  };
  return (
    <details className="mb-5 rounded-[16px] border border-[#d6d0c1] bg-[#f8f5ed] p-4" data-testid="diagnostics-panel">
      <summary className="cursor-pointer text-[12px] font-extrabold uppercase tracking-[.13em] text-[#303b4e]">
        Diagnostics / Trigger status
        <span className="ml-2 normal-case tracking-normal text-[#68717d]">· feed {feedStatus} · {market.strategy.state} · API {write.api}</span>
      </summary>
      <p className="mt-2 text-[11px] text-[#747c86]">Observed in this browser session. Polls and strategy evaluations are separate; a signal does not mean a record was saved.</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
        <Item label="Feed status"><span data-testid="diag-feed-status">{feedStatus}</span></Item>
        <Item label="Last market poll attempted">{time(market.lastPollAttemptAt)}</Item>
        <Item label="Last successful market poll">{time(market.marketUpdatedAt)}</Item>
        <Item label="Last strategy evaluation">{time(market.lastEvaluationAt)}</Item>
        <Item label="Current signal">{market.strategy.dataError ? 'DATA ERROR' : market.strategy.state}</Item>
        <Item label="Latest cycle triggered">{market.lastEvaluationAt === null ? 'Awaiting evaluation' : market.triggerLatestCycle && !market.strategy.dataError ? 'Yes' : 'No'}</Item>
        <Item label="Last trigger fired">{market.lastTriggerAt === null ? 'No trigger fired yet' : time(market.lastTriggerAt)}</Item>
        <Item label="Last API write attempt">{write.api === 'idle' ? 'No write attempted this session' : `${write.api} · ${time(write.attemptedAt)}`}</Item>
        <Item label="Database write confirmation">{time(write.confirmedAt)}</Item>
        <Item label="Server readback">{write.readback === 'idle' ? 'Not checked' : `${write.readback}${write.verifiedAt ? ` · ${time(write.verifiedAt)}` : ''}`}</Item>
        <Item label="Last saved record ID">{store.latestSaved?.id ?? '—'}</Item>
        <Item label="Last saved record time">{time(store.latestSaved?.timestamp ?? null)}</Item>
        <Item label="Latest saved record"><RecordDetails record={store.latestSaved} /></Item>
        <Item label="Last verified write"><RecordDetails record={write.record} emptyLabel="No write verified this session" /></Item>
      </dl>
      {market.lastEvaluationAt !== null && !market.triggerLatestCycle && feedStatus === 'running' &&
        <p className="mt-4 text-[11px] text-[#596271]">Feed active; no qualifying trigger condition on the latest cycle.</p>}
      {market.marketError && <p role="alert" className="mt-3 text-[11px] text-[#a34032]">Market poll error: {market.marketError}</p>}
      {write.error && <p role="alert" data-testid="diag-write-error" className="mt-3 text-[11px] font-bold text-[#a34032]">{write.api === 'failed' ? 'API write failed' : 'API write succeeded, but readback failed'}: {write.error}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[#ded8cb] pt-4">
        <button type="button" data-testid="button-test-persistence" onClick={() => void runTest()} disabled={store.status !== 'CONNECTED' || testing || write.api === 'writing'} className="rounded-[9px] bg-[#222a3d] px-4 py-2 text-[11px] font-bold text-white disabled:opacity-50">Test persistence</button>
        <span className="text-[11px] text-[#747c86]">{store.status === 'SIGN IN' ? 'Sign in to test your private ledger.' : store.status !== 'CONNECTED' ? 'Wait for the private ledger to connect.' : 'Writes one labeled diagnostic-only event, then reads it back. No trade, stake, order, or P&L.'}</span>
      </div>
    </details>
  );
}