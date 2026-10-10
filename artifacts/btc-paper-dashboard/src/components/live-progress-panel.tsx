import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/react';
import { getGetForwardTestStatusQueryKey, useGetForwardTestStatus } from '@workspace/api-client-react';
import type { PaperTradingState } from '@/lib/usePaperTrading';

function formatTime(val: number | null) {
  if (val === null) return '—';
  return new Date(val).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(ms: number | null, now: number) {
  if (ms === null) return '—';
  const diff = Math.max(0, Math.floor((now - ms) / 1000));
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s}s ago`;
}

function formatDuration(ms: number) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function signedBuffer(value: number) {
  return `${value < 0 ? '-' : '+'}$${Math.abs(value).toFixed(2)}`;
}

export default function LiveProgressPanel({
  market,
  completedTests,
  isSignedIn,
}: {
  market: PaperTradingState;
  completedTests: number | null;
  isSignedIn: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const { userId } = useAuth();
  const server = useGetForwardTestStatus({
    query: { queryKey: [...getGetForwardTestStatusQueryKey(), userId], enabled: isSignedIn && !!userId, staleTime: 5000, refetchInterval: 5000, retry: false },
  });
  
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { progress, market: kalshiMarket } = market;
  const polls = progress.marketPolls;
  const evals = progress.evaluations;
  const windows = progress.windowsObserved;
  const passes = progress.passCount;
  const watches = progress.watchCount;
  const scouts = progress.scoutTriggers;
  const confirms = progress.confirmTriggers;
  const lastQual = progress.lastQualifyingTriggerAt;
  const recentLog = progress.recentEvaluations;

  const target = kalshiMarket?.target ?? null;
  
  const isHealthy = !market.marketError && market.coinbaseStatus === 'open' &&
    market.marketUpdatedAt !== null && now - market.marketUpdatedAt < 15_000;
  const evalAge = market.lastEvaluationAt ? now - market.lastEvaluationAt : null;
  const isEvaluatingNormally = isHealthy && evalAge !== null && evalAge < 15000;
  
  const directionalSide = market.strategy.direction?.toUpperCase();
  const rawBuyOffer = directionalSide === 'UP' ? kalshiMarket?.yesAsk : directionalSide === 'DOWN' ? kalshiMarket?.noAsk : null;
  const currentBuyOffer = typeof rawBuyOffer === 'number' ? rawBuyOffer * 100 : null;
  
  const closeTime = kalshiMarket?.closeTime ? Date.parse(kalshiMarket.closeTime) : null;
  const timeRemaining = closeTime !== null && Number.isFinite(closeTime) ? closeTime - now : null;

  const buffer = market.strategy.dataError ? null : market.strategy.buffer;
  const activePosition = market.activePosition;
  const noTradeReason = market.marketError
    ? 'Market feed unavailable — waiting for a fresh Kalshi quote.'
    : market.coinbaseStatus !== 'open'
      ? 'BTC feed is not live — waiting for a fresh tick.'
      : market.strategy.note || 'Waiting for a qualifying condition.';

  return (
    <section className="mb-5 rounded-[16px] border border-[#d6d0c1] bg-[#f8f5ed] p-4" data-testid="live-progress-panel">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-[#ded8cb] pb-3">
        <div>
          <h2 className="text-[12px] font-extrabold uppercase tracking-[.13em] text-[#303b4e]">Live Progress / Forward Test Activity</h2>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[.1em] text-[#747c86]">This browser session · separate from the server forward test below</p>
        </div>
        {isEvaluatingNormally ? (
          <div className="inline-flex w-max items-center gap-1.5 rounded-full bg-[#e5efae] px-2.5 py-1 text-[10px] font-bold tracking-[.09em] text-[#40520c]" data-testid="heartbeat-normal" role="status" aria-label="Model evaluating normally">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#73930f]" />
            Model evaluating normally · {formatTime(market.lastEvaluationAt)}
          </div>
        ) : (
          <div className="inline-flex w-max items-center gap-1.5 rounded-full bg-[#f6e7c4] px-2.5 py-1 text-[10px] font-bold tracking-[.09em] text-[#765014]" data-testid="heartbeat-stale" role="status" aria-label="Paused or stale">
            <span className="h-1.5 w-1.5 rounded-full bg-[#c98c22]" />
            Paused / Stale (Last: {formatTime(market.lastEvaluationAt)})
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
        <Metric label="Market polls · this page session" value={polls} testId="metric-polls" />
        <Metric label="Strategy evaluations · this page session" value={evals} testId="metric-evaluations" />
        <Metric label="15-min windows observed" value={windows} testId="metric-windows" />
        <Metric label="Completed forward tests" value={completedTests !== null ? completedTests : isSignedIn ? 'Connecting private ledger' : 'Sign in to view'} testId="metric-completed-tests" />
        
        <Metric label="PASS evaluations" value={passes} testId="metric-pass" />
        <Metric label="WATCH evaluations" value={watches} testId="metric-watch" />
        <Metric label="SCOUT triggers" value={scouts} testId="metric-scout" />
        <Metric label="CONFIRM triggers" value={confirms} testId="metric-confirm" />
        
        <Metric label="Since last qualifying trigger" value={lastQual === null ? 'None this session' : timeAgo(lastQual, now)} testId="metric-last-qualifying" />
        <Metric label="Current window remaining" value={timeRemaining !== null ? formatDuration(timeRemaining) : '—'} testId="metric-window-remaining" />
        <Metric label="Current target" value={target !== null ? `$${target.toFixed(2)}` : '—'} testId="metric-target" />
        <Metric label="Signed BTC − target buffer" value={buffer !== null ? signedBuffer(buffer) : '—'} testId="metric-buffer" />
        <Metric label="Favored side" value={market.strategy.dataError ? '—' : directionalSide ?? '—'} testId="metric-side" />
        <Metric label="Favored side buy offer" value={!market.strategy.dataError && currentBuyOffer !== null ? `${currentBuyOffer.toFixed(1)}¢` : '—'} testId="metric-offer" />
      </dl>

      <div className="mt-5 rounded-[10px] border border-[#ded8cb] bg-[#eeeade] p-3" data-testid="trade-status">
        <span className="mono mb-1 block text-[9px] uppercase tracking-[.11em] text-[#858a92]">{activePosition ? 'Current forward test' : 'Why no trade is active'}</span>
        <span className="text-[12px] font-semibold text-[#303b4e]">
          {activePosition 
            ? `Active trade in progress (${activePosition.direction.toUpperCase()} at ${typeof activePosition.entryPrice === 'number' ? `${Math.round(activePosition.entryPrice * 100)}¢` : 'unknown'})`
            : noTradeReason}
        </span>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-[#747c86]">
        <strong className="font-semibold text-[#596271]">Note:</strong> PASS indicates a deliberate no-entry decision based on model constraints. Evaluations run continuously and are completely separate from trades. An idle API does not imply an idle model.
      </p>

      <div className="mt-5 rounded-[10px] border border-[#ded8cb] bg-[#f5f2e9] p-3" data-testid="server-forward-test-status">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#303b4e]">Server forward test</h3>
          <span className="mono text-[9px] uppercase tracking-[.11em] text-[#858a92]">Read only · paper only</span>
        </div>
        <p className="mb-3 text-[11px] font-bold text-[#40520c]">SERVER TESTING — continues when this browser is closed</p>
        {!isSignedIn ? (
          <p className="text-[11px] text-[#596271]">Sign in to inspect server state. The activity above is from this page session.</p>
        ) : server.isPending ? (
          <p className="text-[11px] text-[#596271]">Loading server state…</p>
        ) : server.isError ? (
          <p className="text-[11px] text-[#765014]" role="status">Server status unavailable. No server activity is implied.</p>
        ) : (
          <>
            <p className="mb-3 text-[11px] text-[#596271]" data-testid="server-engine-state">
              <strong className={server.data.lastError ? 'text-[#a3611a]' : server.data.workerRunning ? 'text-[#40520c]' : 'text-[#765014]'}>
                SERVER ENGINE: {server.data.lastError ? 'ERROR' : server.data.workerRunning ? 'RUNNING' : 'STOPPED'}
              </strong>
              {' · '}{server.data.workerRunning ? `Instance ${server.data.workerOwner ?? 'unknown'}` :
                server.data.enabled ? 'No active lease' : 'Disabled'}
              {' · '}Database: {server.data.databaseConnectionStatus}
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
              <Metric label="Last heartbeat" value={server.data.lastHeartbeatAt ? timeAgo(Date.parse(server.data.lastHeartbeatAt), now) : 'Never'} />
              <Metric label="Last evaluation" value={server.data.lastEvaluationAt ? timeAgo(Date.parse(server.data.lastEvaluationAt), now) : 'Never'} />
              <Metric label="Active window" value={server.data.activeWindow?.ticker ?? '—'} />
              <Metric label="Server evaluations" value={server.data.evaluationCount} />
              <Metric label="Scout triggers" value={server.data.scoutTriggers} />
              <Metric label="Confirm triggers" value={server.data.confirmTriggers} />
              <Metric label="Open paper position" value={server.data.openPaperPosition
                ? `${server.data.openPaperPosition.direction} ${server.data.openPaperPosition.triggerType} · $${server.data.openPaperPosition.stake.toFixed(2)}` : 'None'} />
              <Metric label="Completed tests" value={server.data.completedPaperForwardTests} />
              <Metric label="Server paper P&L" value={`$${server.data.cumulativePaperPnl.toFixed(2)}`} />
              <Metric label="Current V1.3 state" value={`${server.data.signal ?? '—'} · ${server.data.direction ?? '—'}`} />
              <Metric label="Signed BTC buffer" value={server.data.signedBuffer === null ? '—' : signedBuffer(server.data.signedBuffer)} />
              <Metric label="Open unrealized P&L" value={server.data.unrealizedPaperPnl === null ? '—' : `$${server.data.unrealizedPaperPnl.toFixed(2)}`} />
            </dl>
            <p className="mt-3 text-[11px] text-[#596271]">
              {server.data.currentReason ?? 'Awaiting a valid evaluation.'}
              {server.data.lastSettlement && ` · Last settlement: ${server.data.lastSettlement.result ?? '—'} (${server.data.lastSettlement.pnl >= 0 ? '+' : ''}$${server.data.lastSettlement.pnl.toFixed(2)})`}
            </p>
            {server.data.lastError && (
              <p className="mt-3 text-[11px] text-[#765014]" role="status">Last server error: {server.data.lastError}</p>
            )}
          </>
        )}
      </div>

      <div className="mt-5 border-t border-[#ded8cb] pt-4" data-testid="evaluation-log">
        <h3 className="mb-3 text-[11px] font-extrabold uppercase tracking-[.13em] text-[#303b4e]">Latest Evaluations</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="border-b border-[#ded8cb] text-[#858a92]">
                <th className="pb-2 font-mono font-normal uppercase tracking-[.11em]">Time</th>
                <th className="pb-2 font-mono font-normal uppercase tracking-[.11em]">State</th>
                <th className="pb-2 font-mono font-normal uppercase tracking-[.11em]">Buffer</th>
                <th className="pb-2 font-mono font-normal uppercase tracking-[.11em]">Reason</th>
              </tr>
            </thead>
            <tbody>
              {recentLog.length > 0 ? (
                recentLog.map((ev, i) => (
                  <tr key={`${ev.at}-${i}`} className="border-b border-[#ded8cb]/40 last:border-0" data-testid={`log-entry-${i}`}>
                    <td className="whitespace-nowrap py-2 pr-4 font-mono text-[#68717d]">{formatTime(ev.at)}</td>
                    <td className="whitespace-nowrap py-2 pr-4 font-semibold text-[#303b4e]">{ev.state}</td>
                    <td className="whitespace-nowrap py-2 pr-4 font-mono text-[#68717d]">{ev.buffer !== null ? signedBuffer(ev.buffer) : '—'}</td>
                    <td className="min-w-[180px] max-w-[400px] break-words py-2 text-[#596271]">{ev.reason}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="py-3 text-center text-[#858a92]" data-testid="log-empty">No evaluations recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="mono text-[9px] uppercase tracking-[.11em] text-[#858a92]">{label}</dt>
      <dd className="mt-1 truncate text-[12px] font-semibold text-[#303b4e]">{value}</dd>
    </div>
  );
}
