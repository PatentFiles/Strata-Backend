import { useAuth } from '@clerk/react';
import { useEffect, useState } from 'react';
import { getGetForwardTestHistoryQueryKey, useGetForwardTestHistory } from '@workspace/api-client-react';

function money(value: number | null) {
  if (value === null) return '—';
  return `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
}

function pnl(value: number | null) {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${money(value)}`;
}

function time(value: string | null) {
  return value ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : '—';
}

function offer(value: number | null) {
  return value === null ? '—' : `${(value * 100).toFixed(1)}¢`;
}

function price(value: number | null) {
  return value === null ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="mono text-[9px] font-bold uppercase tracking-[.1em] text-[#858a92]">{label}</dt>
      <dd className="mt-1 break-words text-[11px] font-semibold text-[#303b4e]">{value}</dd>
    </div>
  );
}

export default function ServerForwardTestHistory() {
  const { isSignedIn, userId } = useAuth();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const history = useGetForwardTestHistory({
    query: {
      queryKey: [...getGetForwardTestHistoryQueryKey(), userId],
      enabled: Boolean(isSignedIn && userId),
      staleTime: 5000,
      refetchInterval: 5000,
      retry: false,
      refetchOnMount: 'always',
    },
  });

  return (
    <section className="dashboard-enter mt-5 rounded-[18px] border border-[#c6cfb0] bg-[#f4f6ed] p-5 sm:p-7" aria-labelledby="server-history-title" data-testid="server-forward-test-history">
      <div className="border-b border-[#d7dec8] pb-4">
        <p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#647346]">Separate, shared server ledger · read only</p>
        <h2 id="server-history-title" className="mt-1 text-[23px] font-extrabold tracking-[-.04em] text-[#303b4e]">Server Forward-Test History</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-[#596271]">
          V1.3 server-generated paper positions. These are not your account’s saved Paper history and no real orders are placed.
        </p>
      </div>
      {isSignedIn && history.dataUpdatedAt > 0 && (
        <p role="status" className="mt-3 text-[11px] text-[#765014]">
          Retrieved {new Date(history.dataUpdatedAt).toLocaleTimeString()} · {Math.max(0, Math.floor((now - history.dataUpdatedAt) / 1000))}s ago · read-only refresh every 5s
          {now - history.dataUpdatedAt > 15_000 ? ' · STALE — saved values may no longer be current' : ''}
        </p>
      )}

      {!isSignedIn ? (
        <p className="py-6 text-[12px] text-[#596271]" role="status" data-testid="status-server-history-auth">Sign in to view server forward-test history.</p>
      ) : history.isPending ? (
        <p className="py-6 text-[12px] text-[#596271]" role="status" data-testid="status-server-history-loading">Loading server positions…</p>
      ) : history.isError ? (
        <div className="py-6 text-[12px] text-[#765014]" role="alert" data-testid="status-server-history-error">
          Server history is unavailable. No server activity is implied.
          <button type="button" className="ml-3 rounded-md border border-[#c8b37c] px-2 py-1 font-bold" onClick={() => void history.refetch()} data-testid="button-retry-server-history">Retry</button>
        </div>
      ) : (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="summary-server-history">
            {[
              ['Completed', String(history.data.summary.completed)],
              ['Wins', String(history.data.summary.wins)],
              ['Losses', String(history.data.summary.losses)],
              ['Total stake', money(history.data.summary.totalStake)],
              ['Server paper P&L', pnl(history.data.summary.totalPnl)],
              ['Open positions', String(history.data.summary.openPositionCount)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[10px] border border-[#d7dec8] bg-white/70 p-3">
                <dt className="text-[10px] font-bold text-[#68717d]">{label}</dt>
                <dd className="mono mt-1 text-[16px] font-extrabold text-[#303b4e]" data-testid={`value-server-history-${label.toLowerCase().replaceAll(' ', '-')}`}>{value}</dd>
              </div>
            ))}
          </dl>

          {history.data.positions.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-[#68717d]" data-testid="status-server-history-empty">No server forward-test positions yet.</p>
          ) : (
            <div className="mt-5 space-y-3" data-testid="list-server-history">
              {history.data.positions.map((position) => (
                <article key={position.id} className="rounded-[12px] border border-[#d7dec8] bg-white/80 p-4" data-testid={`record-server-history-${position.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e4e8db] pb-3">
                    <div className="min-w-0">
                      <p className="mono text-[9px] font-extrabold uppercase tracking-[.12em] text-[#53730b]">SERVER · PAPER_ONLY</p>
                      <h3 className="mt-1 break-all text-[12px] font-extrabold text-[#303b4e]">{position.marketTicker}</h3>
                      <p className="mt-1 text-[11px] text-[#68717d]">{position.strategyVersion} · {position.triggerType} · {position.direction}</p>
                    </div>
                    <div className="text-right">
                      <span className={`inline-block rounded-md px-2 py-1 text-[10px] font-extrabold ${position.status === 'SETTLED' ? 'bg-[#e5efae] text-[#40520c]' : position.status === 'CLOSED' ? 'bg-[#eeeade] text-[#596271]' : 'bg-[#f6e7c4] text-[#765014]'}`}>{position.status}</span>
                      <p className="mono mt-2 text-[14px] font-extrabold text-[#303b4e]" data-testid={`value-server-pnl-${position.id}`}>{pnl(position.pnl)}</p>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
                    <Detail label="Entry time" value={time(position.enteredAt)} />
                    <Detail label="Entry BTC" value={price(position.entryBtcPrice)} />
                    <Detail label="Target" value={price(position.target)} />
                    <Detail label="Entry offer" value={offer(position.entryOffer)} />
                    <Detail label="Stake" value={money(position.stake)} />
                    <Detail label="Contracts" value={position.contracts.toFixed(6)} />
                    <Detail label="Closed time" value={time(position.closedAt)} />
                    <Detail label="Exit price" value={offer(position.exitPrice)} />
                    <Detail label="Payout" value={money(position.payout)} />
                    <Detail label="Close reason" value={position.closeReason ?? '—'} />
                    <Detail label="Settlement result" value={position.settlementResult ?? (position.status === 'CLOSED' ? 'None · not market-settled' : '—')} />
                  </dl>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}