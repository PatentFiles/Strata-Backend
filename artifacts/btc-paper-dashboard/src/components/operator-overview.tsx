import { type ReactNode, useEffect, useState } from 'react';
import { useAuth } from '@clerk/react';
import {
  getGetForwardTestStatusQueryKey,
  getGetMicroLiveStateQueryKey,
  getGetPhase4StateQueryKey,
  useGetForwardTestStatus,
  useGetMicroLiveState,
  useGetPhase4State,
  useHealthCheck,
} from '@workspace/api-client-react';
import type { PaperTradingState } from '@/lib/usePaperTrading';
import type { HistoryStore } from '@/lib/useHistoryStore';
import { BUILD_RELEASE, V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from '@workspace/v13-strategy';
import ServerForwardTestHistory from './server-forward-test-history';
import { observationIsCurrent, observedFlag } from '@/lib/operator-observations';

const champion = V13_CHAMPION_PARAMETER_SET;
const parameters = champion.parameters;
const BTC_STALE_S = 5;
const QUOTE_STALE_S = 15;
const HEARTBEAT_STALE_S = 30;
const QUERY_STALE_S = 15;
const UNAVAILABLE = 'unavailable';

type Tone = 'ok' | 'warn' | 'bad' | 'mute';
const toneCls: Record<Tone, string> = {
  ok: 'border-[#b8cf48] bg-[#e5efae] text-[#40520c]',
  warn: 'border-[#dfb86c] bg-[#f6e7c4] text-[#765014]',
  bad: 'border-[#e2a092] bg-[#fae2dc] text-[#8e3127]',
  mute: 'border-[#d6d0c1] bg-[#e8e3d7] text-[#626a75]',
};

function usd(v: number | null | undefined, signed = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return UNAVAILABLE;
  const s = `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < 0 ? `-${s}` : signed ? `+${s}` : s;
}
function cents(v: number | null | undefined) {
  return v === null || v === undefined ? UNAVAILABLE : `${(v * 100).toFixed(1)}c`;
}
function ageS(now: number, at: number | null | undefined) {
  return at === null || at === undefined || Number.isNaN(at) ? null : Math.max(0, Math.round((now - at) / 1000));
}
function isoAge(now: number, iso: string | null | undefined) {
  return iso ? ageS(now, Date.parse(iso)) : null;
}
function fmtAge(a: number | null) {
  return a === null ? UNAVAILABLE : a < 1 ? 'now' : `${a}s ago`;
}
function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Pill({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return <span data-testid={testId} className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[.1em] ${toneCls[tone]}`}>{children}</span>;
}
function Cell({ label, value, tone, testId, sub }: { label: string; value: ReactNode; tone?: Tone; testId?: string; sub?: string }) {
  const color = tone === 'bad' ? 'text-[#a34032]' : tone === 'warn' ? 'text-[#8a5f14]' : tone === 'ok' ? 'text-[#53730b]' : 'text-[#303b4e]';
  return (
    <div className="min-w-0 rounded-[10px] bg-[#eeeadf] px-3 py-2.5">
      <p className="mono truncate text-[9px] uppercase tracking-[.12em] text-[#92969b]">{label}</p>
      <p data-testid={testId} className={`mono mt-1 break-words text-[14px] ${color}`}>{value}</p>
      {sub && <p className="mono mt-0.5 text-[9px] text-[#92969b]">{sub}</p>}
    </div>
  );
}
function Section({ n, kicker, title, children, testId, dark }: { n: string; kicker: string; title: string; children: ReactNode; testId: string; dark?: boolean }) {
  return (
    <section data-testid={testId} className={`dashboard-enter rounded-[18px] border p-4 sm:p-6 ${dark ? 'border-[#323d53] bg-[#222a3d] text-[#f3f0e7]' : 'border-[#d6d0c1] bg-[#f8f5ed]'}`}>
      <div className="mb-4 flex items-start gap-3">
        <span className={`mono pt-1 text-[10px] ${dark ? 'text-[#c5e438]' : 'text-[#7b8b27]'}`}>{n}</span>
        <div>
          <p className={`mono text-[10px] uppercase tracking-[.16em] ${dark ? 'text-[#a8b0bc]' : 'text-[#888d94]'}`}>{kicker}</p>
          <h2 className="mt-0.5 text-[18px] font-extrabold tracking-[-.04em]">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}
function Warn({ tone = 'warn', children, testId }: { tone?: Tone; children: ReactNode; testId?: string }) {
  return <p data-testid={testId} className={`mb-3 rounded-[10px] border px-3 py-2 text-[11px] font-bold leading-relaxed ${toneCls[tone]}`}>{children}</p>;
}
function DarkCell({ label, value, tone, testId }: { label: string; value: ReactNode; tone?: Tone; testId?: string }) {
  const color = tone === 'bad' ? 'text-[#ef9c82]' : tone === 'warn' ? 'text-[#f0c870]' : tone === 'ok' ? 'text-[#c5e438]' : 'text-[#f3f0e7]';
  return (
    <div className="min-w-0">
      <p className="mono truncate text-[9px] uppercase tracking-[.13em] text-[#9fa8b4]">{label}</p>
      <p data-testid={testId} className={`mono mt-1 break-words text-[15px] ${color}`}>{value}</p>
    </div>
  );
}

export default function OperatorOverview({ market, isSignedIn, history }: { market: PaperTradingState; isSignedIn: boolean; history: HistoryStore }) {
  const { userId, isLoaded } = useAuth();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const enabled = Boolean(isLoaded && isSignedIn && userId);
  const common = { enabled, retry: false, staleTime: 5000, refetchInterval: 5000 } as const;
  const fwd = useGetForwardTestStatus({ query: { ...common, queryKey: [...getGetForwardTestStatusQueryKey(), userId ?? 'anon'] } });
  const micro = useGetMicroLiveState({ query: { ...common, queryKey: [...getGetMicroLiveStateQueryKey(), userId ?? 'anon'] } });
  const p4 = useGetPhase4State({ query: { ...common, queryKey: [...getGetPhase4StateQueryKey(), userId ?? 'anon'] } });
  const health = useHealthCheck({ query: { queryKey: ['/api/healthz'], retry: false, staleTime: 5000, refetchInterval: 5000 } });
  const release = health.data?.release;
  const releaseCurrent = Boolean(release) && !health.isError && (ageS(now, health.dataUpdatedAt) ?? Infinity) <= QUERY_STALE_S;
  const releaseMatches = releaseCurrent && !release?.dirty && !BUILD_RELEASE.dirty &&
    release?.revision === BUILD_RELEASE.revision && release?.revision !== 'unavailable' &&
    release?.tree === BUILD_RELEASE.tree &&
    release?.scoutMaxCents === 52 && release?.confirmMaxCents === 53 &&
    release?.parameterHash === V13_CHAMPION_PARAMETER_HASH && release?.championId === champion.id;

  const authRequired = !isLoaded || !isSignedIn || !userId;
  const fs = fwd.data;
  const ms = micro.data;
  const cfg = p4.data?.config;

  // Query provenance: retrieved-at is the browser fetch time, never source heartbeat.
  const qNote = (q: { isError: boolean; data: unknown; dataUpdatedAt: number; isLoading: boolean }, name: string) => {
    if (authRequired) return { tone: 'mute' as Tone, text: `${name}: auth required` };
    if (q.isLoading && !q.data) return { tone: 'mute' as Tone, text: `${name}: loading` };
    if (!q.data) return { tone: 'bad' as Tone, text: `${name}: unavailable${q.isError ? ' (request failed)' : ''}` };
    const a = ageS(now, q.dataUpdatedAt);
    if (q.isError) return { tone: 'bad' as Tone, text: `${name}: refresh failed, showing cached data retrieved ${fmtAge(a)} (${q.dataUpdatedAt ? clock(q.dataUpdatedAt) : UNAVAILABLE})` };
    if (a !== null && a > QUERY_STALE_S) return { tone: 'warn' as Tone, text: `${name}: stale, retrieved ${fmtAge(a)}` };
    return { tone: 'ok' as Tone, text: `${name}: retrieved ${clock(q.dataUpdatedAt)} (browser fetch time, not source heartbeat)` };
  };
  const nFwd = qNote(fwd, 'Server paper status');
  const nMicro = qNote(micro, 'Execution state');
  const nP4 = qNote(p4, 'Phase 4 config');
  const fwdCached = fwd.isError && Boolean(fs);
  const fwdOld = (ageS(now, fwd.dataUpdatedAt) ?? 0) > QUERY_STALE_S;
  const fwdUsable = Boolean(fs) && !fwdCached && !fwdOld;

  // Live market
  const m = market.market;
  const btc = market.btcPrice;
  const target = m?.target ?? null;
  const signed = btc !== null && target !== null ? btc - target : null;
  const btcAge = ageS(now, market.btcUpdatedAt);
  const quoteAge = ageS(now, market.marketUpdatedAt ?? m?.fetchedAt ?? null);
  const feedOpen = market.coinbaseStatus === 'open';
  const btcStale = !feedOpen || btcAge === null || btcAge > BTC_STALE_S;
   const closeAt = m?.closeTime ? Date.parse(m.closeTime) : NaN;
   const secondsLeft = Number.isFinite(closeAt) ? Math.max(0, Math.ceil((closeAt - now) / 1000)) : null;
   const quoteStale = Boolean(market.marketError) || quoteAge === null || quoteAge > QUOTE_STALE_S || secondsLeft === 0;
  const st = market.strategy;
  const dir = st.direction;
  const bid = dir === 'up' ? m?.yesBid : dir === 'down' ? m?.noBid : null;
  const ask = dir === 'up' ? m?.yesAsk : dir === 'down' ? m?.noAsk : null;
  const spread = bid !== null && bid !== undefined && ask !== null && ask !== undefined ? ask - bid : null;
  const stateLabel = btcStale || quoteStale ? `${st.dataError ? 'DATA ERROR' : st.state} (STALE INPUTS)` : st.dataError ? 'DATA ERROR' : st.state;
  const stateTone: Tone = btcStale || quoteStale || st.dataError ? 'warn' : st.state === 'EXIT' ? 'bad' : st.state === 'CONFIRM' || st.state.startsWith('SCOUT') ? 'ok' : 'mute';
  const pos = market.activePosition;

  // Server health
  const hbAge = isoAge(now, fs?.lastHeartbeatAt);
  const hbStale = hbAge === null || hbAge > HEARTBEAT_STALE_S;
  const workerLabel = !fs ? (authRequired ? 'auth required' : UNAVAILABLE) : !fwdUsable ? 'unverified (stale data)' : fs.workerRunning && !hbStale ? 'running' : fs.workerRunning ? 'running, heartbeat stale' : 'not running';
  const workerTone: Tone = !fs || !fwdUsable ? 'warn' : fs.workerRunning && !hbStale ? 'ok' : 'bad';
  const open = fs?.openPaperPosition ?? null;

  const killLabel = authRequired ? 'auth required' : ms ? `kill switch ${ms.killSwitch}` : cfg ? `manual kill ${cfg.manualKillSwitch ? 'ON' : 'OFF'}` : UNAVAILABLE;
    const microCurrent = observationIsCurrent({ authenticated: !authRequired, hasData: Boolean(ms), isError: micro.isError, updatedAt: micro.dataUpdatedAt, now });
    const p4Current = observationIsCurrent({ authenticated: !authRequired, hasData: Boolean(cfg), isError: p4.isError, updatedAt: p4.dataUpdatedAt, now });
   const reconTone: Tone = !microCurrent ? 'warn' : ms?.reconciliation.status === 'current' ? 'ok' : ms?.reconciliation.status === 'required' ? 'bad' : 'warn';
   const flag = (v: boolean | undefined, current = microCurrent) => observedFlag(v, current);

  return (
    <div data-testid="operator-overview" className="mb-5 space-y-4">
      <section data-testid="op-launch-champion" className="rounded-[12px] border border-[#bccb70] bg-[#e2ebaa] px-4 py-3 text-[#37430f]">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-extrabold">Launch champion configuration · {champion.label}</h2>
          <Pill tone="warn">Display only · no live authority</Pill>
        </div>
        <p className="mono mt-2 text-[11px] leading-relaxed">SCOUT separation ${parameters.scoutMinSeparation}–${parameters.scoutMaxSeparation} inclusive · max offer {parameters.scoutMaxOffer * 100}c<br />CONFIRM separation ${parameters.confirmMinSeparation}+ · max offer {parameters.confirmMaxOffer * 100}c<br />Wrong-side recross ${parameters.wrongSideRecrossSeparation} · momentum-invalidated exit {parameters.exitOnMomentumInvalidation ? 'enabled' : 'disabled'}</p>
        <p data-testid="op-evaluator-diff" className="mt-2 text-[11px] font-bold">Browser evaluator uses the shared {champion.label}. Build-source identity is not proof of running backend identity or live execution approval.</p>
      </section>
      <Section n="01" kicker="live market / strategy state" title="Right now" testId="section-operator-live" dark>
        {(btcStale || quoteStale) && (
          <Warn tone="warn" testId="warn-live-stale">
            {btcStale ? `BTC feed ${feedOpen ? `stale (${fmtAge(btcAge)})` : `not connected (${market.coinbaseStatus})`}. ` : ''}
             {quoteStale ? `Kalshi quote ${secondsLeft === 0 ? 'window expired' : market.marketError ? 'error' : `stale (${fmtAge(quoteAge)})`}. ` : ''}
            Strategy state below is not reliable.
          </Warn>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <DarkCell label="BTC" value={btc === null ? UNAVAILABLE : usd(btc)} tone={btcStale ? 'warn' : undefined} testId="op-btc" />
          <DarkCell label="Target" value={usd(target)} testId="op-target" />
          <DarkCell label="Signed buffer" value={signed === null ? UNAVAILABLE : usd(signed, true)} testId="op-buffer" />
          <DarkCell label="Absolute buffer" value={signed === null ? UNAVAILABLE : usd(Math.abs(signed))} testId="op-abs-buffer" />
          <DarkCell label="Velocity" value={market.velocity === null ? UNAVAILABLE : `${market.velocity >= 0 ? '+' : ''}${market.velocity.toFixed(1)} / min`} tone={btcStale ? 'warn' : undefined} testId="op-velocity" />
          <DarkCell label="Local strategy" value={stateLabel} tone={stateTone} testId="op-strategy-state" />
          <DarkCell label="Direction" value={dir ? dir.toUpperCase() : 'none'} testId="op-direction" />
          <DarkCell label="Remaining" value={secondsLeft === null ? UNAVAILABLE : `${secondsLeft}s`} testId="op-remaining" />
          <DarkCell label={`Selected ${dir ? (dir === 'up' ? 'YES' : 'NO') : 'side'} bid`} value={dir ? cents(bid) : 'no side selected'} tone={quoteStale ? 'warn' : undefined} testId="op-bid" />
          <DarkCell label="Ask" value={dir ? cents(ask) : 'no side selected'} tone={quoteStale ? 'warn' : undefined} testId="op-ask" />
          <DarkCell label="Spread" value={dir ? cents(spread) : 'no side selected'} testId="op-spread" />
          <DarkCell label="Ticker" value={m?.ticker ?? UNAVAILABLE} />
          <DarkCell label="BTC age" value={fmtAge(btcAge)} tone={btcStale ? 'warn' : 'ok'} testId="op-btc-age" />
          <DarkCell label="Quote age" value={fmtAge(quoteAge)} tone={quoteStale ? 'warn' : 'ok'} testId="op-quote-age" />
           <DarkCell label="Feed" value={market.coinbaseStatus} tone={btcStale ? 'warn' : 'ok'} />
          <DarkCell label="Clock" value={clock(now)} />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[#a8b0bc]">{st.note}</p>
        <div data-testid="op-browser-position" className="mt-4 rounded-[12px] border border-[#4a5468] p-3">
          <p className="mono text-[9px] uppercase tracking-[.14em] text-[#9fa8b4]">Browser paper position (this tab only, not the server)</p>
          <p className="mono mt-1 text-[13px]">
            {pos ? `${pos.direction.toUpperCase()} · entry ${cents(pos.entryPrice)} · stake ${usd(pos.stake)} · ${pos.ticker}` : 'none open in this browser'}
          </p>
        </div>
      </Section>

      <Section n="02" kicker="server paper performance" title="Persistent paper engine" testId="section-operator-server">
        <Warn tone={nFwd.tone} testId="op-fwd-note">{nFwd.text}</Warn>
        {fwdCached && <Warn tone="bad">Showing failed-refresh cached values. Do not treat as current.</Warn>}
        {fs && !fwdCached && fwdOld && <Warn tone="warn">Server status is old. Values below may no longer be true.</Warn>}
        {authRequired ? (
          <p className="text-[12px] text-[#68717d]" data-testid="op-server-auth">Auth required. Sign in to read server paper status.</p>
        ) : fs ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Cell label="Realized P&L" value={usd(fs.cumulativePaperPnl, true)} tone={fs.cumulativePaperPnl < 0 ? 'bad' : 'ok'} testId="op-realized" sub={`${fs.wins}W / ${fs.losses}L · ${fs.completedPaperForwardTests} done`} />
              <Cell label="Unrealized P&L" value={open ? usd(fs.unrealizedPaperPnl, true) : 'no open position'} testId="op-unrealized" />
              <Cell label="Worker" value={workerLabel} tone={workerTone} testId="op-worker" />
              <Cell label="Heartbeat age" value={fmtAge(hbAge)} tone={hbStale || !fwdUsable ? 'warn' : 'ok'} testId="op-heartbeat" sub="source: server heartbeat" />
               <Cell label="Evaluation age" value={fmtAge(isoAge(now, fs.lastEvaluationAt))} sub="source: server evaluation" />
              <Cell label="Last error" value={fs.lastError ?? 'none reported'} tone={fs.lastError ? 'bad' : undefined} testId="op-last-error" />
              <Cell label="Cycles" value={String(fs.cycleCount)} />
              <Cell label="Server signal" value={fs.signal ?? UNAVAILABLE} sub={fs.direction ?? undefined} />
              <Cell label="Mode" value={`${fs.engineMode} · ${fs.strategyVersion}`} />
            </div>
            <div data-testid="op-server-position" className="mt-3 rounded-[12px] border border-[#d6d0c1] bg-[#f4f1e8] p-3">
              <p className="mono text-[9px] uppercase tracking-[.14em] text-[#92969b]">Server paper position (persistent worker)</p>
              <p className="mono mt-1 text-[13px] text-[#303b4e]">
                {open ? `${open.direction} · ${open.triggerType} · entry ${cents(open.entryOffer)} · stake ${usd(open.stake)} · ${open.ticker}` : 'none open on server'}
              </p>
            </div>
          </>
        ) : (
          <p className="text-[12px] text-[#68717d]">Server paper status unavailable.</p>
        )}
         <ServerForwardTestHistory />
      </Section>

      <Section n="03" kicker="readiness / risk / reconciliation" title="Authority and safety" testId="section-operator-readiness">
        <Warn tone="mute">Observation only. This panel has no controls and grants no execution authority.</Warn>
        <Warn tone="warn" testId="op-commissioning-boundary">Dedicated-pair commissioning evidence is not exposed by this dashboard API. Current reconciliation or a FROZEN run does not establish live eligibility. Use the read-only readiness verifier and the developer handoff checklist.</Warn>
        <Warn tone={nMicro.tone}>{nMicro.text}</Warn>
        <Warn tone={nP4.tone}>{nP4.text}</Warn>
        <div className="mb-3 flex flex-wrap gap-2">
           <Pill tone={!microCurrent ? 'warn' : killLabel.includes('ON') ? 'bad' : 'mute'} testId="op-kill-switch">{killLabel}{!authRequired && ms && !microCurrent ? ' (STALE / UNVERIFIED)' : ''}</Pill>
           <Pill tone={reconTone} testId="op-reconciliation">reconciliation {authRequired ? 'auth required' : ms ? ms.reconciliation.status.replace('_', ' ') : UNAVAILABLE}{!authRequired && ms && !microCurrent ? ' (STALE / UNVERIFIED)' : ''}</Pill>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
           <Cell label="Micro-live gate" value={authRequired ? 'auth required' : ms ? (microCurrent ? ms.enabled ? 'enabled by server' : 'execution disabled' : 'unverified (stale data)') : UNAVAILABLE} />
          <Cell label="Phase 4 mode" value={authRequired ? 'auth required' : cfg?.mode ?? UNAVAILABLE} testId="op-p4-mode" />
            <Cell label="Phase 4 live exec" value={authRequired ? 'auth required' : flag(cfg?.liveExecutionEnabled, p4Current)} sub="Phase 4 only, not micro-live" />
          <Cell label="DB micro-live prod" value={authRequired ? 'auth required' : ms?.databaseFlags ? flag(ms.databaseFlags.microLiveProductionEnabled) : UNAVAILABLE} testId="op-db-prod" />
          <Cell label="DB live execution" value={authRequired ? 'auth required' : ms?.databaseFlags ? flag(ms.databaseFlags.liveExecutionEnabled) : UNAVAILABLE} testId="op-db-exec" />
          <Cell label="Env micro-live prod" value={authRequired ? 'auth required' : flag(ms?.environmentFlags.microLiveProductionEnabled)} testId="op-env-prod" />
          <Cell label="Env live execution" value={authRequired ? 'auth required' : flag(ms?.environmentFlags.liveExecutionEnabled)} testId="op-env-exec" />
          <Cell label="Accounting" value={authRequired ? 'auth required' : ms ? (ms.accountingUnresolved ? 'UNRESOLVED' : 'resolved') : UNAVAILABLE} tone={ms?.accountingUnresolved ? 'bad' : undefined} sub={ms?.accountingUnresolvedReason ?? undefined} />
          <Cell label="Reconciled at" value={ms?.reconciliation.checkedAt ? clock(Date.parse(ms.reconciliation.checkedAt)) : UNAVAILABLE} />
          <Cell label="Open exposure" value={ms ? usd(ms.openExposureCents / 100) : UNAVAILABLE} />
          <Cell label="Reserved risk" value={ms ? usd(ms.reservedRiskCents / 100) : UNAVAILABLE} />
          <Cell label="Bounded run" value={ms ? ms.boundedRun.phase ?? 'none' : UNAVAILABLE} />
          <Cell label="Blocked reason" value={ms?.latestBlockedReason ?? (ms ? 'none reported' : UNAVAILABLE)} />
            <Cell label="Account paper-history database" value={history.status} tone={history.status === 'ERROR' ? 'bad' : history.status === 'CONNECTED' && (ageS(now, history.syncedAt) ?? Infinity) <= QUERY_STALE_S ? 'ok' : 'warn'} sub="Not the production trading ledger" />
            <Cell label="Paper-history sync age" value={fmtAge(ageS(now, history.syncedAt))} sub="Read-only monitoring; saves retain existing cadence" />
        </div>
      </Section>

      <Section n="04" kicker="strategy and research" title="Strategy and Research" testId="section-operator-research">
          <p className="text-[12px] font-bold">{champion.label} is the shared build-source configuration shown above, not verification of the currently running backend strategy.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
           <Cell label="Shared champion ID (build source)" value={champion.id} sub="Not a running-backend attestation" testId="op-shared-champion-id" />
           <Cell label="Shared champion hash (build source)" value={V13_CHAMPION_PARAMETER_HASH} sub="Not live execution authority" testId="op-shared-champion-hash" />
          <Cell label="Challenger" value="Backend identity unavailable" sub="Not available in this Replit build" testId="op-challenger" />
          <Cell label="Backend champion ID / hash" value={releaseCurrent ? `${release?.championId} / ${release?.parameterHash}` : 'Backend identity unavailable'} sub="Public build identity, not execution clearance" testId="op-champion-id" />
          <Cell label="Frontend revision" value={BUILD_RELEASE.revision} sub={BUILD_RELEASE.dirty ? 'Uncommitted build — not release evidence' : 'Git revision captured at build'} testId="op-frontend-revision" />
          <Cell label="Backend revision" value={releaseCurrent ? release?.revision ?? UNAVAILABLE : UNAVAILABLE} sub={releaseMatches ? 'Frontend/backend revision and champion agree' : 'Agreement unverified or mismatched — no release clearance'} tone={releaseMatches ? 'ok' : 'warn'} testId="op-backend-revision" />
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-[10px] bg-[#eeeadf] p-3" data-testid="op-research-counterfactual">
            <p className="text-[12px] font-extrabold text-[#303b4e]">Counterfactual rejected-opportunity research</p>
            <p className="mono mt-1 text-[10px] text-[#8e3127]">RESEARCH ONLY — NO EXECUTION AUTHORITY</p>
            <p className="mt-1 text-[11px] text-[#68717d]">Research implementation exists in this branch; results are not exposed by the dashboard API.</p>
          </div>
          <div className="rounded-[10px] bg-[#eeeadf] p-3" data-testid="op-research-sizing">
            <p className="text-[12px] font-extrabold text-[#303b4e]">Confidence-weighted sizing research</p>
            <p className="mono mt-1 text-[10px] text-[#8e3127]">RESEARCH ONLY — NO EXECUTION AUTHORITY</p>
            <p className="mt-1 text-[11px] text-[#68717d]">Research implementation exists in this branch; results are not exposed by the dashboard API.</p>
          </div>
        </div>
      </Section>
    </div>
  );
}
