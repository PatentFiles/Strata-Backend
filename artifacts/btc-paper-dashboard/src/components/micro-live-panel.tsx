import { useState } from 'react';
import { useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpRight, Clock3, LockKeyhole, RefreshCw, Shield, ShieldOff, X } from 'lucide-react';
import {
  getGetPhase4AccountQueryKey,
  getGetMicroLiveStateQueryKey,
  useEmergencyStopMicroLive,
  useGetPhase4Account,
  useGetMicroLiveState,
  type MicroLiveDecision,
  type MicroLiveFlags,
} from '@workspace/api-client-react';
import MicroLiveFeeApproval from './micro-live-fee-approval';
import MicroLiveBoundedRun from './micro-live-bounded-run';
import StaleAccountingResolution from './stale-accounting-resolution';

const cents = (value: number | null | undefined) =>
  value == null ? '—' : `${value < 0 ? '−' : ''}$${(Math.abs(value) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const exactDollars = (value: number | null | undefined) => {
  if (value == null) return '—';
  const absolute = BigInt(Math.abs(value));
  const whole = (absolute / 1_000_000n).toLocaleString('en-US');
  return `${value < 0 ? '−' : ''}$${whole}.${(absolute % 1_000_000n).toString().padStart(6, '0')}`;
};

const stamp = (value: string | null | undefined) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

function Metric({ label, value, note, emphasis = false }: { label: string; value: string; note?: string; emphasis?: boolean }) {
  return (
    <div className="min-w-0 border-l border-[#d6d0c1] pl-4 first:border-l-0 first:pl-0">
      <p className="mono text-[9px] uppercase tracking-[.13em] text-[#858a92]">{label}</p>
      <p className={`mono mt-2 break-words text-[19px] font-medium tracking-[-.055em] ${emphasis ? 'text-[#a34032]' : 'text-[#303b4e]'}`}>{value}</p>
      {note && <p className="mt-1 text-[10px] text-[#858a92]">{note}</p>}
    </div>
  );
}

function Flag({ label, on }: { label: string; on: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#e3ded3] py-2.5 last:border-b-0">
      <span className="text-[11px] text-[#596271]">{label}</span>
      <span className={`mono shrink-0 rounded px-2 py-1 text-[9px] font-bold tracking-[.1em] ${on === null ? 'bg-[#e8e3d7] text-[#757d87]' : on ? 'bg-[#e5efae] text-[#40520c]' : 'bg-[#fae2dc] text-[#8e3127]'}`}>{on === null ? 'UNAVAILABLE' : on ? 'ON' : 'OFF'}</span>
    </div>
  );
}

function FlagGroup({ title, flags }: { title: string; flags: MicroLiveFlags | null }) {
  return (
    <div className="rounded-[12px] border border-[#d6d0c1] bg-[#f8f5ed] px-4 py-3">
      <p className="mono mb-1 text-[9px] font-bold uppercase tracking-[.14em] text-[#888d94]">{title}</p>
      <Flag label="Micro-live production" on={flags?.microLiveProductionEnabled ?? null} />
      <Flag label="Live execution" on={flags?.liveExecutionEnabled ?? null} />
    </div>
  );
}

function Decision({ label, decision }: { label: string; decision: MicroLiveDecision | null }) {
  return (
    <div className="border-b border-[#e3ded3] py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono text-[9px] uppercase tracking-[.12em] text-[#858a92]">{label}</span>
        <span className="mono text-[9px] text-[#858a92]">{decision ? stamp(decision.decidedAt) : '—'}</span>
      </div>
      {decision ? (
        <>
          <p className="mt-1.5 text-[11px] font-extrabold uppercase text-[#303b4e]">{decision.status}</p>
          <p className="mt-1 break-words text-[11px] leading-relaxed text-[#596271]">{decision.reason || 'No reason supplied.'}</p>
          {(decision.evaluationId || decision.orderId) && <p className="mono mt-1.5 break-all text-[9px] text-[#92969b]">{decision.evaluationId && `Evaluation ${decision.evaluationId}`}{decision.evaluationId && decision.orderId && ' · '}{decision.orderId && `Order ${decision.orderId}`}</p>}
        </>
      ) : <p className="mt-1 text-[11px] text-[#92969b]">No decision recorded.</p>}
    </div>
  );
}

function LedgerList({ title, count, list }: { title: string; count: number; list: Record<string, unknown>[] }) {
  return (
    <div>
      <div className="flex items-center justify-between border-b border-[#d6d0c1] pb-2">
        <h3 className="text-[12px] font-extrabold text-[#303b4e]">{title}</h3>
        <span className="mono text-[11px] text-[#596271]">{count}</span>
      </div>
      {list.length === 0 ? (
        <p className="py-5 text-[11px] text-[#92969b]">{count === 0 ? `No ${title.toLowerCase()} recorded.` : 'No records included in this snapshot.'}</p>
      ) : (
        <div className="max-h-[220px] divide-y divide-[#e3ded3] overflow-y-auto">
          {list.map((item, index) => (
            <div key={typeof item.id === 'string' ? item.id : index} className="py-2.5">
              <p className="mono break-all text-[10px] font-bold text-[#303b4e]">{String(item.ticker ?? item.marketTicker ?? item.id ?? `Record ${index + 1}`)}</p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#757d87]">
                {Object.entries(item).filter(([key]) => !['ticker', 'marketTicker', 'id'].includes(key)).map(([key, value]) => (
                  <span key={key} className="break-all"><span className="text-[#92969b]">{key}: </span>{value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function errorStatus(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}

export default function MicroLivePanel() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopSuccess, setStopSuccess] = useState(false);
  const queryKey = [...getGetMicroLiveStateQueryKey(), userId];
  const { data: state, error, isLoading, isFetching, refetch } = useGetMicroLiveState({
    query: { enabled: !!isLoaded && !!isSignedIn && !!userId, queryKey, staleTime: 5000, refetchInterval: 5000, retry: false },
  });
  const {
    data: phase4Account,
    error: accountError,
    dataUpdatedAt: accountFetchedAt,
    refetch: refetchAccount,
  } = useGetPhase4Account({
    query: {
      enabled: !!isLoaded && !!isSignedIn && !!userId,
      queryKey: [...getGetPhase4AccountQueryKey(), userId],
      staleTime: 5000,
      refetchInterval: 5000,
      retry: false,
    },
  });
  const emergencyStop = useEmergencyStopMicroLive();

  if (!isLoaded || !isSignedIn || !userId || errorStatus(error) === 401 || errorStatus(error) === 403 ||
      errorStatus(accountError) === 401 || errorStatus(accountError) === 403) return null;

  const shell = 'dashboard-enter mt-8 overflow-hidden rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed]';
  if (isLoading) return (
    <section className={`${shell} p-5 sm:p-6`} aria-label="Loading Phase 5 micro-live state">
      <div className="h-3 w-32 animate-pulse rounded bg-[#ded8cb]" />
      <div className="mt-4 h-7 w-64 animate-pulse rounded bg-[#ded8cb]" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse rounded-[10px] bg-[#eeeadf]" />)}</div>
    </section>
  );
  if (error || !state) return (
    <section className={`${shell} flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6`} role="alert">
      <div><h2 className="text-[15px] font-extrabold">Phase 5 state unavailable</h2><p className="mt-1 text-[11px] text-[#757d87]">The private micro-live readout could not be loaded. No status is being inferred.</p></div>
      <button type="button" data-testid="button-retry-micro-live" onClick={() => void refetch()} className="flex items-center gap-2 rounded-[8px] border border-[#d6d0c1] px-3 py-2 text-[11px] font-bold hover:bg-[#eeeadf]"><RefreshCw size={13} /> Retry</button>
    </section>
  );

  const reasons: string[] = [];
  if (!state.configurationExists) reasons.push('No micro-live configuration row has been initialized. The schema’s $25 maximum is only a default for a future row, not an active bankroll. Database execution flags do not exist until that row is created; PDF approval does not create it.');
  else if (state.databaseFlags === null) reasons.push('Database execution flags could not be read.');
  else {
    if (!state.databaseFlags.microLiveProductionEnabled) reasons.push('Database micro-live production flag is off.');
    if (!state.databaseFlags.liveExecutionEnabled) reasons.push('Database live-execution flag is off.');
  }
  if (!state.environmentFlags.microLiveProductionEnabled) reasons.push('Environment micro-live production flag is off.');
  if (!state.environmentFlags.liveExecutionEnabled) reasons.push('Environment live-execution flag is off.');
  if (state.killSwitch === 'ON') reasons.push('Persistent kill switch is on.');
  if (state.accountingUnresolved) reasons.push(`Accounting unresolved: ${state.accountingUnresolvedReason ?? 'reason unavailable'}.`);
  if (state.reconciliation.status !== 'current') reasons.push(`Reconciliation is ${state.reconciliation.status.replaceAll('_', ' ')}.`);
  if (!state.enabled && reasons.length === 0) reasons.push('Execution is disabled by the server; no further reason was supplied.');
  const stopEngaged = state.killSwitch === 'ON' && !state.enabled && state.databaseFlags !== null &&
    !state.databaseFlags.microLiveProductionEnabled && !state.databaseFlags.liveExecutionEnabled &&
    !state.environmentFlags.microLiveProductionEnabled && !state.environmentFlags.liveExecutionEnabled;
  const accountCash = !accountError && phase4Account?.status === 'CONNECTED'
    ? phase4Account.balance?.availableCashDollars
    : null;
  const cashValue = accountCash != null ? Number(accountCash) : null;
  const kalshiCash = cashValue !== null && Number.isFinite(cashValue)
    ? `${cashValue < 0 ? '−' : ''}$${Math.abs(cashValue).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : state.availableKalshiBalance ? cents(state.availableKalshiBalance.cents) : '—';
  const kalshiCashNote = cashValue !== null && Number.isFinite(cashValue)
    ? `Phase 4 account fetched ${stamp(new Date(accountFetchedAt).toISOString())} · not a live quote`
    : state.availableKalshiBalance
      ? `Persisted snapshot observed ${stamp(state.availableKalshiBalance.observedAt)}`
      : 'No available account balance or persisted snapshot';

  async function stop() {
    setStopError(null);
    try {
      await emergencyStop.mutateAsync({ data: { disable: true } });
      setConfirming(false);
      setStopSuccess(true);
      await queryClient.invalidateQueries({ queryKey: getGetMicroLiveStateQueryKey() });
    } catch (cause) {
      if (errorStatus(cause) === 401 || errorStatus(cause) === 403) {
        setConfirming(false);
        await queryClient.invalidateQueries({ queryKey: getGetMicroLiveStateQueryKey() });
      } else {
        setStopError(cause instanceof Error ? cause.message : 'The stop request failed. Verify the server state before proceeding.');
      }
    }
  }

  return (
    <section data-testid="panel-micro-live" className={shell} aria-label="Phase 5 micro-live administrator state">
      <div className="flex flex-col gap-5 border-b border-[#d6d0c1] bg-[#eeeadf] p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div>
          <p className="mono flex items-center gap-2 text-[10px] uppercase tracking-[.16em] text-[#858a92]"><Shield size={13} /> Private execution / Phase 05</p>
          <h2 className="mt-2 text-[23px] font-extrabold tracking-[-.055em] text-[#222a3d]">Micro-live oversight<span className="text-[#92969b]">.</span></h2>
          <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-[#68717d]">Administrator readout of the server’s execution gates and ledger. The guarded development run control below can arm one entry window; this panel does not place orders.</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span data-testid="status-micro-live-enabled" className={`mono rounded-full border px-3 py-1.5 text-[10px] font-bold tracking-[.09em] ${state.enabled ? 'border-[#b8cf48] bg-[#e5efae] text-[#40520c]' : 'border-[#dfb86c] bg-[#f6e7c4] text-[#765014]'}`}>{state.enabled ? 'ENABLED BY SERVER' : 'EXECUTION DISABLED'}</span>
          <button type="button" data-testid="button-refresh-micro-live" aria-label="Refresh micro-live state" onClick={() => { void refetch(); void refetchAccount(); }} disabled={isFetching} className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-[#d6d0c1] bg-[#f8f5ed] text-[#596271] hover:bg-[#e7e1d3] disabled:opacity-50"><RefreshCw size={14} /></button>
        </div>
      </div>

      <div className="space-y-7 p-5 sm:p-6">
        <MicroLiveFeeApproval />
        {state.boundedRun
          ? <MicroLiveBoundedRun run={state.boundedRun} />
          : <p className="rounded border border-[#dfb86c] bg-[#f6e7c4] p-4 text-[11px] text-[#765014]">
              Bounded-run controls are unavailable until the development API is restarted with the new code.
            </p>}
        {import.meta.env.DEV && (
          <StaleAccountingResolution
            state={state}
            onRefresh={() => queryClient.invalidateQueries({ queryKey: getGetMicroLiveStateQueryKey() })}
          />
        )}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,.6fr)]">
          <div className={`rounded-[12px] border p-4 sm:p-5 ${state.enabled ? 'border-[#b8cf48] bg-[#f1f4d9]' : 'border-[#dfb86c] bg-[#fbf3df]'}`}>
            <p className="mono text-[9px] font-bold uppercase tracking-[.15em] text-[#765014]">{state.enabled ? 'Execution gates' : 'Why execution is held'}</p>
            {reasons.length ? <ul data-testid="list-micro-live-blockers" className="mt-3 space-y-2">{reasons.map(reason => <li key={reason} className="flex gap-2 text-[11px] leading-relaxed text-[#634f35]"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#c98c22]" />{reason}</li>)}</ul> : <p className="mt-3 text-[11px] text-[#40520c]">Server reports execution enabled. This is observation only.</p>}
            {state.latestBlockedReason && <div className="mt-4 border-t border-[#d7c99e] pt-3 text-[11px] leading-relaxed text-[#765014]"><span className="font-extrabold">Latest blocked reason: </span><span data-testid="text-micro-live-blocked-reason">{state.latestBlockedReason}</span></div>}
          </div>
          <div className="rounded-[12px] border border-[#d6d0c1] bg-[#222a3d] p-4 text-[#f3f0e7] sm:p-5">
            <p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#a8b0bc]">Emergency control</p>
            <p className="mt-3 text-[12px] leading-relaxed text-[#d4d8dc]">Persist the kill switch and disable both micro-live execution flags. This action cannot be reversed here.</p>
            <button type="button" data-testid="button-emergency-stop-micro-live" onClick={() => { setConfirming(true); setStopError(null); setStopSuccess(false); }} disabled={stopEngaged || emergencyStop.isPending} className="mt-4 flex w-full items-center justify-center gap-2 rounded-[8px] bg-[#c75a48] px-4 py-2.5 text-[11px] font-extrabold text-[#fff5f0] transition hover:bg-[#a34032] disabled:cursor-not-allowed disabled:bg-[#535c69] disabled:text-[#c2c7ce]"><ShieldOff size={14} />{stopEngaged ? 'Stop already engaged' : 'Emergency stop'}</button>
            {stopSuccess && <p role="status" className="mt-3 text-[10px] text-[#c5e438]">Stop request accepted. State refreshed.</p>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-5 rounded-[12px] border border-[#d6d0c1] bg-[#f2eee5] p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Available bankroll" value={cents(state.availableBankrollCents)} />
          <Metric label="Configured live bankroll cap" value={state.configurationExists ? cents(state.maxLiveBankrollCents) : 'Not initialized'} />
          <Metric label="Kalshi cash" value={kalshiCash} note={kalshiCashNote} />
          <Metric label="Open exposure" value={cents(state.openExposureCents)} />
          <Metric label="Reserved risk" value={cents(state.reservedRiskCents)} emphasis={state.reservedRiskCents > 0} />
          <Metric label="Open positions" value={String(state.openPositionCount)} />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr_1fr]">
          <FlagGroup title="Database gates" flags={state.databaseFlags} />
          <FlagGroup title="Environment gates" flags={state.environmentFlags} />
          <div className="rounded-[12px] border border-[#d6d0c1] bg-[#f8f5ed] px-4 py-3">
            <p className="mono mb-1 text-[9px] font-bold uppercase tracking-[.14em] text-[#888d94]">Safety interlocks</p>
            <div className="flex justify-between gap-3 border-b border-[#e3ded3] py-2.5 text-[11px]"><span>Kill switch</span><strong className={state.killSwitch === 'ON' ? 'text-[#a34032]' : 'text-[#53730b]'}>{state.killSwitch}</strong></div>
            <div className="flex justify-between gap-3 border-b border-[#e3ded3] py-2.5 text-[11px]"><span>Reconciliation</span><strong className="text-right uppercase text-[#303b4e]">{state.reconciliation.status}</strong></div>
            <p className="mono py-2 text-[9px] text-[#858a92]">Execution readiness checked {stamp(state.reconciliation.checkedAt)}</p>
            <div className="flex justify-between gap-3 border-t border-[#e3ded3] py-2.5 text-[11px]"><span>GET-only startup audit</span><strong className="text-right uppercase text-[#303b4e]">{state.readOnlyAudit.status.replaceAll('_', ' ')}</strong></div>
            <p className="break-words text-[10px] leading-relaxed text-[#596271]">{state.readOnlyAudit.reason?.replaceAll('_', ' ') ?? 'Not run'} · Checked {stamp(state.readOnlyAudit.checkedAt)}.</p>
            <div className="space-y-1 border-t border-[#e3ded3] py-2 text-[10px] text-[#596271]">
              <p className="flex justify-between gap-2"><span>Fills on known bot order IDs</span><strong>{state.readOnlyAudit.knownBotFills ?? '—'}</strong></p>
              <p className="flex justify-between gap-2"><span>Historical, unattributed account fills</span><strong>{state.readOnlyAudit.historicalUnattributedFills ?? '—'}</strong></p>
              <p className="flex justify-between gap-2"><span>New or undated unexplained fills</span><strong>{state.readOnlyAudit.unexplainedFills ?? '—'}</strong></p>
              <p className="flex justify-between gap-2"><span>Position discrepancies</span><strong>{state.readOnlyAudit.positionDiscrepancies ?? '—'}</strong></p>
              <p className="pt-1">Historical means before {stamp(state.readOnlyAudit.boundaryAt)} (earlier of config creation and first known bot order). Unattributed fills are not verified bot activity. This audit cannot complete execution reconciliation or permit trading.</p>
            </div>
            <div className="flex justify-between gap-3 border-t border-[#e3ded3] py-2.5 text-[11px]"><span>Lease</span><strong className="text-[#303b4e]">{state.lease.held ? 'HELD' : 'NOT HELD'}</strong></div>
            <p className="mono break-all text-[9px] text-[#858a92]">Owner {state.lease.owner ?? '—'} · Expires {stamp(state.lease.expiresAt)}</p>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[.85fr_1.15fr]">
          <div className="rounded-[12px] border border-[#d6d0c1] bg-[#eeeadf] p-4">
            <p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#858a92]">Realized / unrealized</p>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Metric label="Realized net P&L" value={exactDollars(state.realizedPnlMicros)}
                note="Exact to $0.000001; — means trade or fee evidence is missing." />
              <Metric label="Unrealized P&L" value={cents(state.unrealizedPnlCents)} />
              <Metric label="Wins" value={state.wins == null ? '—' : String(state.wins)} />
              <Metric label="Losses" value={state.losses == null ? '—' : String(state.losses)} />
            </div>
          </div>
          <div className="rounded-[12px] border border-[#d6d0c1] bg-[#f8f5ed] p-4">
            <p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#858a92]">Current observation</p>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[17px] font-extrabold text-[#303b4e]">{state.currentV13Signal ? `${state.currentV13Signal.signal} / ${state.currentV13Signal.direction}` : 'No current v1.3 signal'}</p>
                <p className="mono mt-1 text-[10px] text-[#858a92]">{state.currentV13Signal ? `${state.currentV13Signal.ticker ?? 'Ticker unavailable'} · ${stamp(state.currentV13Signal.evaluatedAt)}` : 'Waiting for a server evaluation'}</p>
              </div>
              <ArrowUpRight size={17} className="text-[#858a92]" />
            </div>
            <div className="mt-4 border-t border-[#e3ded3] pt-3">
              <p className="mono text-[9px] uppercase tracking-[.14em] text-[#858a92]">Current position</p>
              {state.currentPosition ? <div className="mt-2 space-y-1">{Object.entries(state.currentPosition).map(([key, value]) => <div key={key} className="flex flex-wrap justify-between gap-x-4 text-[10px]"><span className="text-[#858a92]">{key}</span><span className="mono max-w-full break-all text-[#303b4e]">{value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}</span></div>)}</div> : <p className="mt-2 text-[11px] text-[#92969b]">No current position.</p>}
            </div>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <LedgerList title="Pending orders" count={state.pendingOrders.count} list={state.pendingOrders.list} />
          <LedgerList title="Fills" count={state.fills.count} list={state.fills.list} />
        </div>
        <div className="border-t border-[#d6d0c1] pt-5">
          <div className="mb-2 flex items-center gap-2"><Clock3 size={14} className="text-[#858a92]" /><h3 className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#858a92]">Decision trail</h3></div>
          <div className="grid gap-x-6 lg:grid-cols-4">
            <Decision label="Recent decision" decision={state.recentDecision} />
            <Decision label="Last attempted" decision={state.lastAttempted} />
            <Decision label="Last accepted" decision={state.lastAccepted} />
            <Decision label="Last rejection" decision={state.lastRejection} />
          </div>
        </div>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#222a3d]/70 p-4" role="presentation">
          <div role="dialog" aria-modal="true" aria-labelledby="micro-live-stop-title" className="w-full max-w-[430px] rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-6 shadow-[0_22px_60px_rgba(22,29,43,.28)]">
            <div className="flex items-start justify-between gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#fae2dc] text-[#a34032]"><AlertTriangle size={19} /></div>
              <button type="button" data-testid="button-cancel-emergency-stop-icon" aria-label="Close confirmation" onClick={() => setConfirming(false)} disabled={emergencyStop.isPending} className="text-[#858a92] hover:text-[#222a3d] disabled:opacity-50"><X size={18} /></button>
            </div>
            <p className="mono mt-5 text-[9px] font-bold uppercase tracking-[.16em] text-[#a34032]"><LockKeyhole size={11} className="mr-1 inline" /> Irreversible from this panel</p>
            <h3 id="micro-live-stop-title" className="mt-1 text-[21px] font-extrabold tracking-[-.04em] text-[#222a3d]">Engage emergency stop?</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-[#596271]">This sends a disable-only request to the server. It persists the kill switch ON and disables the execution flags. There is no activation control here.</p>
            {stopError && <p role="alert" data-testid="status-emergency-stop-error" className="mt-4 rounded-[8px] bg-[#fae2dc] p-3 text-[11px] text-[#8e3127]">{stopError}</p>}
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" data-testid="button-cancel-emergency-stop" disabled={emergencyStop.isPending} onClick={() => setConfirming(false)} className="rounded-[8px] border border-[#d6d0c1] px-4 py-2.5 text-[11px] font-bold text-[#303b4e] hover:bg-[#eeeadf] disabled:opacity-50">Keep current state</button>
              <button type="button" data-testid="button-confirm-emergency-stop" disabled={emergencyStop.isPending} onClick={() => void stop()} className="rounded-[8px] bg-[#a34032] px-4 py-2.5 text-[11px] font-extrabold text-[#fff5f0] hover:bg-[#832e26] disabled:opacity-50">{emergencyStop.isPending ? 'Sending stop request…' : 'Confirm emergency stop'}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}