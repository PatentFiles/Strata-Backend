import { useState } from 'react';
import { useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Lock, AlertTriangle, Play, ShieldAlert, PauseCircle, Activity, Crosshair, ArrowUpRight, ArrowDownRight, Target, Clock, AlertCircle, Info, ScanSearch } from 'lucide-react';
import {
  useGetPhase4Account,
  getGetPhase4AccountQueryKey,
  useGetPhase4State,
  getGetPhase4StateQueryKey,
  useSetPhase4ShadowMode,
  useSetPhase4ShadowLimits,
  useScanPhase4Shadow
} from '@workspace/api-client-react';

function money(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '—';
  return `${num < 0 ? '−' : ''}$${Math.abs(num).toFixed(2)}`;
}

function time(value: string | null) {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

function fullTime(value: string | null) {
  return value ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : '—';
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mono text-[10px] font-bold uppercase tracking-[.1em] text-[#858a92] mb-3">{children}</h3>;
}

export default function Phase4AccountPanel() {
  const { isSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const { data: account, error: accountError, isLoading: accountLoading, refetch: refetchAccount } = useGetPhase4Account({
    query: { enabled: !!isSignedIn && !!userId, queryKey: [...getGetPhase4AccountQueryKey(), userId], staleTime: 5000, refetchInterval: 5000, retry: false }
  });

  const { data: state, error: stateError, isLoading: stateLoading, refetch: refetchState } = useGetPhase4State({
    query: { enabled: !!isSignedIn && !!userId, queryKey: [...getGetPhase4StateQueryKey(), userId], staleTime: 5000, refetchInterval: 5000, retry: false }
  });

  const setMode = useSetPhase4ShadowMode();
  const setLimits = useSetPhase4ShadowLimits();
  const scanShadow = useScanPhase4Shadow();

  if (!isSignedIn) return null;

  const isLocked = (accountError as any)?.status === 401 || (accountError as any)?.status === 403 ||
                   (stateError as any)?.status === 401 || (stateError as any)?.status === 403;
  const isForbidden = (accountError as any)?.status === 403 || (stateError as any)?.status === 403;
  const isDevPreview = import.meta.env.DEV;

  async function copyCurrentAccountId() {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }

  if (isLocked) {
    return (
      <section className="dashboard-enter rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-5 sm:p-6 mt-8">
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#eeeadf] text-[#a2a6ab] mb-3">
            <Lock size={18} />
          </div>
          <h2 className="text-[14px] font-extrabold text-[#303b4e]">Private Ledger Access Required</h2>
          <p className="mt-1 text-[11px] text-[#757d87] max-w-xs">Phase 4 shadow execution controls are limited to the configured administrator identity.</p>
          {isForbidden && userId && (
            <div className="mt-5 max-w-sm border-t border-[#d6d0c1] pt-4">
              <p className="text-[11px] text-[#596271]">
                {isDevPreview
                  ? 'This signed-in development account does not match the configured administrator. Sign out and use the configured development admin account, or, if you explicitly want this account to be the development admin, copy its ID and update PHASE4_ADMIN_USER_ID in the workspace Secrets tool. Do not change Publishing secrets or republish.'
                  : 'If this is your administrator account, copy its production Clerk ID and paste it directly into the Production PHASE4_ADMIN_USER_ID secret, then republish. The ID is never displayed here.'}
              </p>
              <button
                type="button"
                data-testid="button-copy-phase4-account-id"
                onClick={copyCurrentAccountId}
                className="mt-3 rounded border border-[#d6d0c1] bg-white px-3 py-1.5 text-[11px] font-bold text-[#303b4e] transition hover:bg-[#f3f0e7]"
              >
                Copy my account ID
              </button>
              {copyStatus === 'copied' && (
                <p role="status" data-testid="status-phase4-account-id-copy" className="mt-2 text-[11px] text-[#596271]">
                  {isDevPreview
                    ? 'Copied. If you choose to make this the development admin, update PHASE4_ADMIN_USER_ID in the workspace Secrets tool. Do not change Publishing secrets or share the ID in chat.'
                    : 'Copied. Paste it directly into the Production secret; do not share it in chat.'}
                </p>
              )}
              {copyStatus === 'error' && (
                <p role="alert" data-testid="status-phase4-account-id-copy" className="mt-2 text-[11px] text-[#a34032]">
                  Clipboard access was blocked. Allow clipboard access and try again.
                </p>
              )}
            </div>
          )}
        </div>
      </section>
    );
  }

  const isLoading = accountLoading || stateLoading;

  if (isLoading) {
    return (
      <section className="dashboard-enter rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-5 sm:p-6 mt-8">
        <div className="flex items-center gap-3 text-[#858a92]">
          <RefreshCw className="animate-spin" size={16} />
          <span className="mono text-[11px] uppercase tracking-[.1em]">Loading shadow execution environment...</span>
        </div>
      </section>
    );
  }

  const error = (!isLocked && accountError) || stateError;
  if (error) {
    return (
      <section className="dashboard-enter rounded-[18px] border border-[#e2a092] bg-[#fae2dc] p-5 sm:p-6 mt-8">
        <div className="flex items-start justify-between">
          <div className="flex gap-3">
            <AlertTriangle className="text-[#a34032]" size={18} />
            <div>
              <h2 className="text-[14px] font-extrabold text-[#8e3127]">Connection Failed</h2>
              <p className="mt-1 text-[11px] text-[#8e3127] opacity-80">Unable to retrieve shadow execution state from the server.</p>
            </div>
          </div>
          <button onClick={() => { refetchAccount(); refetchState(); }} className="rounded bg-[#c75a48] px-3 py-1.5 text-[10px] font-bold text-white transition hover:bg-[#a34032]">
            Retry Connection
          </button>
        </div>
      </section>
    );
  }

  if (account?.status === 'NOT_CONFIGURED') {
    return (
      <section className="dashboard-enter rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-5 sm:p-6 mt-8">
        <div className="flex items-start justify-between">
          <div className="flex gap-3">
            <ShieldAlert className="text-[#a2a6ab]" size={18} />
            <div>
              <h2 className="text-[14px] font-extrabold text-[#303b4e]">Configuration Required</h2>
              <p className="mt-1 text-[11px] text-[#757d87]">Administrator identity has not configured a valid Kalshi connection.</p>
            </div>
          </div>
          <button onClick={() => { refetchAccount(); refetchState(); }} className="flex items-center gap-1.5 rounded border border-[#d6d0c1] bg-white px-3 py-1.5 text-[10px] font-bold text-[#596271] transition hover:bg-[#f3f0e7]">
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      </section>
    );
  }

  if (!account || !state) return null;

  const mode = state.config.mode;
  const killSwitch = state.config.manualKillSwitch;
  const executionEnabled = state.config.liveExecutionEnabled;

  const isLivePaused = mode !== 'PAPER_ONLY' && (killSwitch || !executionEnabled);
    const activeStatusText = mode === 'PAPER_ONLY' ? 'PAPER ONLY' :
                           mode === 'SHADOW_LIVE' ? 'SHADOW LIVE · EXECUTION LOCKED' :
                           (mode as string) === 'MICRO_LIVE' ? 'MICRO LIVE (UNAVAILABLE)' : mode;

  const activeStatusColor = mode === 'PAPER_ONLY' ? 'border-[#d6d0c1] bg-[#e8e3d7] text-[#596271]' :
                           isLivePaused ? 'border-[#dfb86c] bg-[#f6e7c4] text-[#765014]' :
                           'border-[#b8cf48] bg-[#e5efae] text-[#40520c]';

  const dotColor = mode === 'PAPER_ONLY' ? 'bg-[#89909a]' :
                   isLivePaused ? 'bg-[#c98c22]' :
                   'bg-[#73930f]';

  const handleScan = async () => {
    try {
      await scanShadow.mutateAsync();
      queryClient.invalidateQueries({ queryKey: getGetPhase4AccountQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPhase4StateQueryKey() });
    } catch (e) {
      console.error('Scan failed', e);
    }
  };

  return (
    <section className="dashboard-enter rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] mt-8 overflow-hidden">
      {/* Header */}
      <div className="border-b border-[#d6d0c1] p-5 sm:p-6 bg-[#eeeadf]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="mono text-[10px] uppercase tracking-[.16em] text-[#888d94]">kalshi integration</p>
            <h2 className="mt-1 text-[20px] font-extrabold tracking-[-.045em] text-[#303b4e]">Phase 4: Shadow Execution</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-[#757d87] max-w-lg">
              Simulated proposals use the real orderbook. The kill switch blocks real execution, not shadow recording. No orders are submitted to the exchange.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start">
            <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-bold tracking-[.09em] ${activeStatusColor}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${mode === 'SHADOW_LIVE' && !isLivePaused ? 'live-dot' : ''} ${dotColor}`} />
              {activeStatusText}
            </div>
          </div>
        </div>
      </div>

      <div className="p-5 sm:p-6 space-y-8">
        {/* Balances & Caps */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          <div className="rounded-[10px] bg-white p-3 border border-[#d6d0c1]">
            <p className="mono text-[9px] uppercase tracking-[.12em] text-[#858a92]">Kalshi Cash · Read Only</p>
            <p className="mono mt-1 text-[16px] font-bold text-[#303b4e]">{money(account.balance?.availableCashDollars)}</p>
          </div>
          <div className="rounded-[10px] bg-white p-3 border border-[#d6d0c1]">
            <p className="mono text-[9px] uppercase tracking-[.12em] text-[#858a92]">Portfolio Value</p>
            <p className="mono mt-1 text-[16px] font-bold text-[#303b4e]">{money(account.balance?.portfolioValueDollars)}</p>
          </div>
          <div className="rounded-[10px] bg-white p-3 border border-[#d6d0c1]">
            <p className="mono text-[9px] uppercase tracking-[.12em] text-[#858a92]">Shadow Max Stake / Trade</p>
            <p className="mono mt-1 text-[16px] font-bold text-[#303b4e]">{money(state.config.shadowMaxStakePerTrade)}</p>
          </div>
          <div className="rounded-[10px] bg-white p-3 border border-[#d6d0c1]">
            <p className="mono text-[9px] uppercase tracking-[.12em] text-[#858a92]">Shadow Capital Remaining</p>
            <p className="mono mt-1 text-[16px] font-bold text-[#303b4e]">{money(state.config.shadowCapitalRemaining)}</p>
          </div>
          <div className="rounded-[10px] bg-white p-3 border border-[#d6d0c1] hidden lg:block">
            <p className="mono text-[9px] uppercase tracking-[.12em] text-[#858a92]">Shadow Max Positions</p>
            <p className="mono mt-1 text-[16px] font-bold text-[#303b4e]">{state.config.shadowMaxOpenPositions}</p>
          </div>
        </div>
        <p className="text-[11px] text-[#757d87]">Simulated budget: {money(state.config.shadowCapitalLimit)} · Maximum reserved loss: {money(state.config.shadowMaxTotalLoss)}. These limits do not change real-money settings.</p>

        {/* Orders & Positions */}
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <SectionHeading>Open Orders {account.truncated.openOrders && '(Truncated)'}</SectionHeading>
            {account.openOrders.length === 0 ? (
              <div className="rounded-[10px] border border-dashed border-[#d6d0c1] py-6 text-center text-[#92969b]">
                <p className="text-[11px]">No active open orders.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {account.openOrders.map(order => (
                  <div key={order.id} className="rounded-[10px] border border-[#d6d0c1] bg-white p-3 flex justify-between items-center text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className={`font-bold ${order.side.toUpperCase() === 'YES' ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{order.action.toUpperCase()} {order.side.toUpperCase()}</span>
                      <span className="mono text-[#596271]">{order.ticker}</span>
                    </div>
                    <div className="mono text-right text-[#303b4e]">
                      {order.remainingCount} @ {money(order.priceDollars)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <SectionHeading>Current Positions {account.truncated.positions && '(Truncated)'}</SectionHeading>
            {account.positions.length === 0 ? (
              <div className="rounded-[10px] border border-dashed border-[#d6d0c1] py-6 text-center text-[#92969b]">
                <p className="text-[11px]">No active positions.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {account.positions.map(pos => (
                  <div key={pos.ticker} className="rounded-[10px] border border-[#d6d0c1] bg-white p-3 flex justify-between items-center text-[11px]">
                    <span className="mono font-bold text-[#303b4e]">{pos.ticker}</span>
                    <div className="flex gap-4 mono text-right">
                      <span><span className="text-[#858a92] mr-1">POS</span>{pos.positionFp}</span>
                      <span><span className="text-[#858a92] mr-1">PNL</span><span className={(parseFloat(pos.realizedPnlDollars || '0') >= 0) ? 'text-[#53730b]' : 'text-[#a34032]'}>{money(pos.realizedPnlDollars)}</span></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Fills & Proposed Orders */}
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <SectionHeading>Recent Fills {account.truncated.fills && '(Truncated)'}</SectionHeading>
            {account.fills.length === 0 ? (
              <div className="rounded-[10px] border border-dashed border-[#d6d0c1] py-6 text-center text-[#92969b]">
                <p className="text-[11px]">No recent fills.</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                {account.fills.map(fill => (
                  <div key={fill.id} className="rounded-[10px] border border-[#d6d0c1] bg-white p-3 flex justify-between items-center text-[11px]">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`font-bold ${fill.side.toUpperCase() === 'YES' ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{fill.action.toUpperCase()} {fill.side.toUpperCase()}</span>
                        <span className="mono text-[#596271]">{fill.ticker}</span>
                      </div>
                      <div className="mono text-[9px] text-[#92969b] mt-1">{time(fill.createdAt)}</div>
                    </div>
                    <div className="mono text-right font-bold text-[#303b4e]">
                      {fill.countFp} @ {money(fill.priceDollars)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <SectionHeading>Proposed Shadow Orders</SectionHeading>
            {state.proposedOrders.length === 0 ? (
              <div className="rounded-[10px] border border-dashed border-[#d6d0c1] py-6 text-center text-[#92969b]">
                <p className="text-[11px]">No pending shadow orders.</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                {state.proposedOrders.map(order => (
                  <div key={order.id} className="rounded-[10px] border border-[#d6d0c1] bg-white p-3 text-[11px]">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`flex items-center gap-1 font-bold ${order.direction === 'UP' ? 'text-[#53730b]' : 'text-[#a34032]'}`}>
                          {order.direction === 'UP' ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                          {order.direction}
                        </span>
                        <span className="mono text-[#303b4e]">{order.marketTicker}</span>
                        <span className="rounded bg-[#eeeadf] px-1.5 py-0.5 mono text-[9px] text-[#596271]">{order.triggerType}</span>
                      </div>
                      <div className="text-right text-[#303b4e]">
                        <div className="mono font-bold">Quote {money(order.quotePrice)} · Limit {money(order.proposedLimitPrice)}</div>
                        <div className="mono text-[10px]">{order.contracts} contracts · {money(order.intendedStake)} stake · {money(order.simulatedRemainingCapital)} shadow remaining</div>
                      </div>
                    </div>
                    <div className="flex justify-between items-end border-t border-[#f0ece1] pt-2">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-[4px] text-[9px] font-extrabold tracking-[.08em] uppercase ${order.riskVerdict === 'ALLOW' ? 'bg-[#dce9a0] text-[#52650e]' : 'bg-[#fae2dc] text-[#8e3127]'}`}>{order.riskVerdict}</span>
                        <span className="text-[#757d87] truncate max-w-[140px]">{order.riskReason}</span>
                      </div>
                      <div className="mono text-[9px] text-[#92969b]">{time(order.recordedAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Notifications */}
        <div>
          <SectionHeading>System Events & Notifications</SectionHeading>
          {state.notifications.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-[#d6d0c1] py-6 text-center text-[#92969b]">
              <p className="text-[11px]">No recent events.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[250px] overflow-y-auto pr-2">
              {state.notifications.map(notif => {
                const isError = notif.severity === 'ERROR';
                const isWarn = notif.severity === 'WARN';
                return (
                  <div key={notif.id} className={`rounded-[10px] border p-3 flex gap-3 text-[11px] ${isError ? 'bg-[#fff5f3] border-[#f5d9d3]' : isWarn ? 'bg-[#fffbf0] border-[#ece4cd]' : 'bg-white border-[#d6d0c1]'}`}>
                    <div className="mt-0.5">
                      {isError ? <AlertTriangle size={14} className="text-[#a34032]" /> :
                       isWarn ? <AlertCircle size={14} className="text-[#c98c22]" /> :
                       <Info size={14} className="text-[#596271]" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className={`font-bold ${isError ? 'text-[#8e3127]' : isWarn ? 'text-[#765014]' : 'text-[#303b4e]'}`}>{notif.eventType}</span>
                          {notif.details?.marketTicker && <span className="mono text-[9px] bg-black/5 px-1.5 py-0.5 rounded">{notif.details.marketTicker}</span>}
                        </div>
                        <span className="mono text-[9px] text-[#92969b]">{fullTime(notif.createdAt)}</span>
                      </div>
                      <p className={`leading-relaxed ${isError ? 'text-[#a34032]' : isWarn ? 'text-[#9c6a1d]' : 'text-[#596271]'}`}>{notif.message}</p>
                      {notif.details?.reasons && notif.details.reasons.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5 pl-4 list-disc text-[10px] text-[#757d87] opacity-80">
                          {notif.details.reasons.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Development Controls */}
        {import.meta.env.DEV && (
          <div className="mt-8 border-t border-[#d6d0c1] pt-6">
            <div className="mb-4 flex items-center justify-between">
              <SectionHeading>Development Admin Controls</SectionHeading>
              <span className="rounded bg-[#222a3d] px-2 py-0.5 text-[9px] font-bold text-white uppercase tracking-[.1em]">Local Env Only</span>
            </div>
            <AdminControls config={state.config} setMode={setMode} setLimits={setLimits} scanShadow={scanShadow} onScan={handleScan} />
          </div>
        )}
      </div>
    </section>
  );
}

function AdminControls({ config, setMode, setLimits, scanShadow, onScan }: any) {
  const queryClient = useQueryClient();
  const [isUpdating, setIsUpdating] = useState(false);
  const [limitsForm, setLimitsForm] = useState({
    liveCapitalLimit: config.liveCapitalLimit ?? 0,
    liveCapitalRemaining: config.liveCapitalRemaining ?? 0,
    maxStakePerTrade: config.maxStakePerTrade ?? 0,
    maxDailyLoss: config.maxDailyLoss ?? 0,
    maxTotalExperimentLoss: config.maxTotalExperimentLoss ?? 0,
    maxOpenPositions: config.maxOpenPositions ?? 0,
    maxEntryPrice: config.maxEntryPrice ?? 0,
    maxSlippage: config.maxSlippage ?? 0,
    manualKillSwitch: config.manualKillSwitch ?? false
  });

  const handleModeChange = async (mode: 'PAPER_ONLY' | 'SHADOW_LIVE') => {
    try {
      setIsUpdating(true);
      await setMode.mutateAsync({ data: { mode } });
      queryClient.invalidateQueries({ queryKey: getGetPhase4StateQueryKey() });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleLimitsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsUpdating(true);
      await setLimits.mutateAsync({ data: limitsForm });
      queryClient.invalidateQueries({ queryKey: getGetPhase4StateQueryKey() });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setLimitsForm(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : parseFloat(value) || 0
    }));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
      {/* Mode & Actions */}
      <div className="space-y-4">
        <div className="rounded-[10px] border border-[#d6d0c1] bg-white p-4">
          <p className="text-[11px] font-bold text-[#303b4e] mb-3">Engine Mode</p>
          <div className="flex gap-2">
            <button
              onClick={() => handleModeChange('PAPER_ONLY')}
              disabled={isUpdating}
              className={`flex-1 rounded-[6px] py-1.5 text-[10px] font-bold tracking-[.05em] transition ${config.mode === 'PAPER_ONLY' ? 'bg-[#222a3d] text-white' : 'bg-[#eeeadf] text-[#596271] hover:bg-[#e4dfd3]'}`}
            >
              PAPER ONLY
            </button>
            <button
              onClick={() => handleModeChange('SHADOW_LIVE')}
              disabled={isUpdating}
              className={`flex-1 rounded-[6px] py-1.5 text-[10px] font-bold tracking-[.05em] transition ${config.mode === 'SHADOW_LIVE' ? 'bg-[#73930f] text-white' : 'bg-[#eeeadf] text-[#596271] hover:bg-[#e4dfd3]'}`}
            >
              SHADOW LIVE
            </button>
          </div>
        </div>

        <div className="rounded-[10px] border border-[#d6d0c1] bg-white p-4">
          <p className="text-[11px] font-bold text-[#303b4e] mb-3">Manual Actions</p>
          <button
            onClick={onScan}
            disabled={scanShadow.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-[6px] border border-[#d6d0c1] bg-[#f8f5ed] py-2 text-[11px] font-bold text-[#303b4e] transition hover:bg-[#eeeadf]"
          >
            {scanShadow.isPending ? <RefreshCw className="animate-spin" size={14} /> : <ScanSearch size={14} />}
            Trigger Shadow Scan
          </button>
        </div>
      </div>

      {/* Limits Form */}
      <form onSubmit={handleLimitsSubmit} className="rounded-[10px] border border-[#d6d0c1] bg-white p-4">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[11px] font-bold text-[#303b4e]">Future execution limits (not used for shadow) & Kill Switch</p>
          <label className="flex items-center gap-2 text-[11px] font-bold text-[#a34032] cursor-pointer">
            <input type="checkbox" name="manualKillSwitch" checked={limitsForm.manualKillSwitch} onChange={handleInput} className="accent-[#a34032]" />
            KILL SWITCH ACTIVE
          </label>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <label className="block">
            <span className="mono text-[9px] uppercase text-[#858a92] block mb-1">Capital Limit ($)</span>
            <input type="number" name="liveCapitalLimit" value={limitsForm.liveCapitalLimit} onChange={handleInput} step="1" className="w-full rounded border border-[#d6d0c1] bg-[#f8f5ed] px-2 py-1 text-[11px] mono" />
          </label>
          <label className="block">
            <span className="mono text-[9px] uppercase text-[#858a92] block mb-1">Capital Remain ($)</span>
            <input type="number" name="liveCapitalRemaining" value={limitsForm.liveCapitalRemaining} onChange={handleInput} step="0.01" className="w-full rounded border border-[#d6d0c1] bg-[#f8f5ed] px-2 py-1 text-[11px] mono" />
          </label>
          <label className="block">
            <span className="mono text-[9px] uppercase text-[#858a92] block mb-1">Max Stake/Trade ($)</span>
            <input type="number" name="maxStakePerTrade" value={limitsForm.maxStakePerTrade} onChange={handleInput} step="1" className="w-full rounded border border-[#d6d0c1] bg-[#f8f5ed] px-2 py-1 text-[11px] mono" />
          </label>
          <label className="block">
            <span className="mono text-[9px] uppercase text-[#858a92] block mb-1">Max Open Pos</span>
            <input type="number" name="maxOpenPositions" value={limitsForm.maxOpenPositions} onChange={handleInput} step="1" className="w-full rounded border border-[#d6d0c1] bg-[#f8f5ed] px-2 py-1 text-[11px] mono" />
          </label>
          <label className="block">
            <span className="mono text-[9px] uppercase text-[#858a92] block mb-1">Max Daily Loss ($)</span>
            <input type="number" name="maxDailyLoss" value={limitsForm.maxDailyLoss} onChange={handleInput} step="1" className="w-full rounded border border-[#d6d0c1] bg-[#f8f5ed] px-2 py-1 text-[11px] mono" />
          </label>
          <label className="block">
            <span className="mono text-[9px] uppercase text-[#858a92] block mb-1">Max Exp Loss ($)</span>
            <input type="number" name="maxTotalExperimentLoss" value={limitsForm.maxTotalExperimentLoss} onChange={handleInput} step="1" className="w-full rounded border border-[#d6d0c1] bg-[#f8f5ed] px-2 py-1 text-[11px] mono" />
          </label>
          <label className="block">
            <span className="mono text-[9px] uppercase text-[#858a92] block mb-1">Max Entry (0-1)</span>
            <input type="number" name="maxEntryPrice" value={limitsForm.maxEntryPrice} onChange={handleInput} step="0.01" className="w-full rounded border border-[#d6d0c1] bg-[#f8f5ed] px-2 py-1 text-[11px] mono" />
          </label>
          <label className="block">
            <span className="mono text-[9px] uppercase text-[#858a92] block mb-1">Max Slippage (0-1)</span>
            <input type="number" name="maxSlippage" value={limitsForm.maxSlippage} onChange={handleInput} step="0.01" className="w-full rounded border border-[#d6d0c1] bg-[#f8f5ed] px-2 py-1 text-[11px] mono" />
          </label>
        </div>
        
        <div className="flex justify-end">
          <button type="submit" disabled={isUpdating} className="rounded-[6px] bg-[#222a3d] px-4 py-1.5 text-[11px] font-bold text-white transition hover:bg-[#303b4e]">
            {isUpdating ? 'Saving...' : 'Save Limits'}
          </button>
        </div>
      </form>
    </div>
  );
}
