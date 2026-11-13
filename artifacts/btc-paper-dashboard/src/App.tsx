import { type ReactNode, useState } from 'react';
import { ClerkProvider, SignIn, SignUp, UserButton, useAuth } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Activity, ArrowDownRight, ArrowUpRight, BookOpen, Check, ChevronRight, CircleAlert, CircleHelp, Clock3, Crosshair, History, Info, RefreshCw, Signal, Target, TrendingDown, TrendingUp, Wifi, Zap } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import LiveTestPanel from '@/components/live-test-panel';
import DiagnosticsPanel from '@/components/diagnostics-panel';
import LiveProgressPanel from '@/components/live-progress-panel';
import Phase4AccountPanel from '@/components/phase4-account-panel';
import KeyProvisioningLink from '@/components/key-provisioning-link';
import MicroLivePanel from '@/components/micro-live-panel';
import OperatorOverview from '@/components/operator-overview';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useLiveTesting } from '@/lib/liveTesting';
import { usePaperTrading } from '@/lib/usePaperTrading';
import { useHistoryStore, type HistoryStore } from '@/lib/useHistoryStore';
import { calculateSignedBuffer, type PaperPosition } from '@/lib/strategy';
import { V13_CHAMPION_PARAMETER_SET } from '@workspace/v13-strategy';
import NotFound from '@/pages/not-found';
import { Link, Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import '@/index.css';

const queryClient = new QueryClient();
const championParameters = V13_CHAMPION_PARAMETER_SET.parameters;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY');
function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}
type SignalState = 'PASS' | 'WATCH' | 'SCOUT UP' | 'SCOUT DOWN' | 'CONFIRM' | 'EXIT';
type Side = 'UP' | 'DOWN';
type ConnectionState = 'live' | 'connecting' | 'stale' | 'offline';

function money(value: number, digits = 2) {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function price(value: number) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function displayPrice(value: number | null) {
  return value === null ? '—' : price(value);
}

function compactTime(value: number | string | null) {
  return value === null ? '—' : new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function signalTone(state: SignalState) {
  if (state === 'CONFIRM' || state === 'SCOUT UP' || state === 'SCOUT DOWN') return 'signal';
  if (state === 'EXIT') return 'danger';
  if (state === 'WATCH') return 'watch';
  return 'quiet';
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <AuthenticatedRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function AuthenticatedRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={{
        options: {
          logoPlacement: 'inside',
          logoLinkUrl: basePath || '/',
          logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
        },
        variables: {
          colorPrimary: '#34460b',
          colorForeground: '#222a3d',
          colorMutedForeground: '#596271',
          colorBackground: '#f8f5ed',
          colorInput: '#eeeadf',
          colorInputForeground: '#222a3d',
          colorDanger: '#a34032',
          colorNeutral: '#d6d0c1',
          fontFamily: 'Inter, system-ui, sans-serif',
          borderRadius: '12px',
        },
        elements: {
          cardBox: { width: 'min(440px, 100%)', background: '#f8f5ed', border: '1px solid #d6d0c1', boxShadow: '0 18px 40px rgba(34,42,61,.14)' },
          headerTitle: { fontWeight: 800, color: '#222a3d' },
          headerSubtitle: { color: '#596271' },
        },
      }}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to your private test ledger' } },
        signUp: { start: { title: 'Create your account', subtitle: 'Keep your paper and live-test history across devices' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <Router />
    </ClerkProvider>
  );
}

function HomeRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && isSignedIn ? <Redirect to="/dashboard" /> : <Home />;
}

function DashboardRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && !isSignedIn ? <Redirect to="/" /> : <Home />;
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/sign-in/*?">
          <div className="flex min-h-[100dvh] items-center justify-center bg-[#eeeade] px-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} fallbackRedirectUrl={`${basePath}/dashboard`} /></div>
        </Route>
        <Route path="/sign-up/*?">
          <div className="flex min-h-[100dvh] items-center justify-center bg-[#eeeade] px-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/dashboard`} /></div>
        </Route>
        <Route path="/dashboard" component={DashboardRoute} />
        <Route path="/" component={HomeRoute} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Home() {
  const { isSignedIn } = useAuth();
  const store = useHistoryStore();
  const paper = usePaperTrading(store);
  const {
    market,
    btcPrice,
    btcUpdatedAt,
    velocity,
    strategy,
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
  } = paper;
  const live = useLiveTesting(strategy, store);
  const historyReady = isSignedIn && store.status === 'CONNECTED';
  const [activeView, setActiveView] = useState<'cockpit' | 'history'>('cockpit');
  const [showMethod, setShowMethod] = useState(false);
  const priceNow = btcPrice;
  const target = market?.target ?? null;
  const buffer = btcPrice === null || target === null ? null : calculateSignedBuffer(btcPrice, target);
  const absoluteBuffer = buffer === null ? null : Math.abs(buffer);
  const directionalSide: Side | null = strategy.direction ? strategy.direction.toUpperCase() as Side : null;
  const marketUp = market?.yesAsk === null || market?.yesAsk === undefined ? null : market.yesAsk * 100;
  const marketDown = market?.noAsk === null || market?.noAsk === undefined ? null : market.noAsk * 100;
  const directionalChance = directionalSide === 'UP' ? marketUp : directionalSide === 'DOWN' ? marketDown : null;
  const secondsLeft = market?.closeTime ? Math.max(0, Math.round((Date.parse(market.closeTime) - Date.now()) / 1000)) : null;
  const freshnessAge = btcUpdatedAt ? Math.max(0, Math.round((Date.now() - btcUpdatedAt) / 1000)) : null;
  const freshnessLabel = freshnessAge === null ? 'waiting' : freshnessAge < 2 ? 'now' : `${freshnessAge}s ago`;
  const connection: ConnectionState = coinbaseStatus === 'open' ? 'live' : coinbaseStatus === 'error' ? 'offline' : coinbaseStatus === 'closed' ? 'stale' : 'connecting';
  const signalState = strategy.state;
  const remainingMinutes = secondsLeft === null ? '—' : `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const markPrice = activePosition ? (activePosition.direction === 'up' ? market?.yesPrice : market?.noPrice) ?? null : null;
  const markPnl = activePosition && markPrice !== null ? (markPrice / activePosition.entryPrice - 1) * 5 : null;
  const statusLabel = marketLoading ? 'LOADING MARKET' : connection === 'live' ? 'COINBASE LIVE' : connection === 'stale' ? 'STALE FEED' : connection === 'offline' ? 'FEED OFFLINE' : 'CONNECTING';
  const dataError = Boolean(strategy.dataError);
  const modelStateLabel = dataError
    ? 'DATA ERROR'
    : strategy.note.startsWith('TOO EXPENSIVE')
      ? 'PASS / TOO EXPENSIVE'
      : signalState;
  const tone = signalTone(signalState);

  return (
    <main className="grain min-h-[100dvh] bg-[#eeeade] text-[#222a3d]">
      <div className="mx-auto min-h-[100dvh] max-w-[1440px] px-4 pb-8 sm:px-6 lg:px-10">
        <header className="flex h-[72px] items-center justify-between border-b border-[#d6d0c1]">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#222a3d] text-[#c5e438] shadow-[3px_3px_0_#c5e438]">
              <Crosshair size={19} strokeWidth={2.3} />
            </div>
            <div>
              <p className="text-[15px] font-extrabold tracking-[-.03em]">FIFTEEN / <span className="text-[#727a86]">PAPER</span></p>
              <p className="mono text-[9px] uppercase tracking-[.18em] text-[#727a86]">BTC repricing observation</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div data-testid="status-connection" className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-bold tracking-[.09em] sm:flex ${connection === 'live' ? 'border-[#b8cf48] bg-[#e5efae] text-[#40520c]' : connection === 'stale' ? 'border-[#dfb86c] bg-[#f6e7c4] text-[#765014]' : 'border-[#d6d0c1] bg-[#e8e3d7] text-[#727a86]'}`}>
              <span className={`live-dot h-1.5 w-1.5 rounded-full ${connection === 'live' ? 'bg-[#73930f]' : connection === 'stale' ? 'bg-[#c98c22]' : 'bg-[#89909a]'}`} />
              {statusLabel}
            </div>
            <button type="button" data-testid="button-refresh-feed" onClick={() => window.location.reload()} className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#d6d0c1] bg-[#f5f2e9] text-[#525d6e] transition hover:bg-[#e7e1d3]" aria-label="Reconnect feed">
              <RefreshCw size={16} />
            </button>
            {isSignedIn
              ? <UserButton />
              : <Link href="/sign-in" className="rounded-[9px] bg-[#222a3d] px-3 py-2 text-[11px] font-bold text-[#f3f0e7]">Sign in</Link>}
          </div>
        </header>

        <section className="flex items-end justify-between gap-4 pb-5 pt-6">
          <div>
            <p className="mono mb-2 text-[10px] uppercase tracking-[.18em] text-[#858a92]">KXBTC15M · observation window</p>
            <h1 className="text-[clamp(28px,8vw,48px)] font-extrabold leading-[.98] tracking-[-.065em]">Operator overview.</h1>
          </div>
          <div className="hidden max-w-[280px] text-right text-[12px] leading-relaxed text-[#747b83] sm:block">Live observations and server paper monitoring. Displayed launch configuration grants no execution authority.</div>
        </section>

        <OperatorOverview market={paper} isSignedIn={Boolean(isSignedIn)} history={store} />
        <details className="mb-5 rounded-[16px] border border-[#d6d0c1] bg-[#f8f5ed] p-4">
          <summary className="cursor-pointer text-[12px] font-extrabold uppercase tracking-[.1em]">Browser-session evaluation activity</summary>
          <p className="my-3 text-[11px] text-[#68717d]">Browser-session evaluations and private account history are separate from the server forward-test ledger.</p>
          <LiveProgressPanel market={paper} completedTests={historyReady ? completedTests : null} isSignedIn={Boolean(isSignedIn)} />
        </details>
        <details className="mb-5 rounded-[16px] border border-[#d6d0c1] bg-[#f8f5ed] p-4" data-testid="legacy-manual-section">
          <summary className="cursor-pointer text-[12px] font-extrabold uppercase tracking-[.1em]">Legacy / manual bookkeeping & browser cockpit</summary>
          <p className="my-3 text-[11px] text-[#68717d]">Manual live records reflect actions you recorded, not the server execution ledger. The browser cockpit retains its existing local evaluator.</p>
        <section data-testid="summary-live-paper" className="mb-5 grid grid-cols-2 gap-2 rounded-[16px] border border-[#d6d0c1] bg-[#f8f5ed] p-3 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryMetric label="PLANNED LIVE START" value="$25.00" />
          <SummaryMetric label="CURRENT BANKROLL" value={historyReady ? money(live.currentBankroll) : '—'} tone={historyReady && live.currentBankroll <= 0 ? 'danger' : undefined} testId="value-summary-current-bankroll" />
          <SummaryMetric label="LIVE P&L" value={historyReady ? `${live.livePnl >= 0 ? '+' : ''}${money(live.livePnl)}` : '—'} tone={historyReady ? (live.livePnl >= 0 ? 'positive' : 'danger') : undefined} testId="value-summary-live-pnl" />
          <SummaryMetric label="PAPER P&L" value={historyReady ? `${cumulativePnl >= 0 ? '+' : ''}${money(cumulativePnl)}` : '—'} tone={historyReady ? (cumulativePnl >= 0 ? 'positive' : 'danger') : undefined} testId="value-summary-paper-pnl" />
          <SummaryMetric label="LIVE TRADES" value={historyReady ? String(live.completedTrades) : '—'} testId="value-summary-live-trades" />
          <SummaryMetric label="EXPECTANCY / TRADE" value={historyReady ? `${live.expectancy >= 0 ? '+' : ''}${money(live.expectancy)}` : '—'} tone={historyReady ? (live.expectancy >= 0 ? 'positive' : 'danger') : undefined} testId="value-summary-expectancy" />
        </section>

        <nav className="mb-5 flex items-center gap-1 border-b border-[#d6d0c1]">
          <button type="button" data-testid="tab-cockpit" onClick={() => setActiveView('cockpit')} className={`relative px-1 pb-3 pt-1 text-[11px] font-extrabold uppercase tracking-[.13em] ${activeView === 'cockpit' ? 'text-[#222a3d]' : 'text-[#8c9197]'}`}>
            Cockpit {activeView === 'cockpit' && <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] bg-[#c5e438]" />}
          </button>
          <button type="button" data-testid="tab-history" onClick={() => setActiveView('history')} className={`relative ml-5 px-1 pb-3 pt-1 text-[11px] font-extrabold uppercase tracking-[.13em] ${activeView === 'history' ? 'text-[#222a3d]' : 'text-[#8c9197]'}`}>
            Saved history <span className="ml-1 rounded-full bg-[#dcd7ca] px-1.5 py-0.5 text-[9px]">{historyReady ? completedTests : '—'}</span>
            {activeView === 'history' && <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] bg-[#c5e438]" />}
          </button>
        </nav>

        {activeView === 'cockpit' ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(310px,.6fr)]">
            <div className="space-y-5">
              <section className="dashboard-enter instrument-grid relative overflow-hidden rounded-[18px] border border-[#323d53] bg-[#222a3d] p-5 text-[#f3f0e7] shadow-[0_18px_40px_rgba(34,42,61,.16)] sm:p-7">
                <div className="absolute inset-x-0 top-0 h-px bg-[#c5e438]" />
                <div className="absolute left-0 right-0 top-1/3 h-px bg-[#c5e438] opacity-10" />
                <div className="absolute left-0 right-0 top-1/3 h-16 bg-gradient-to-b from-[#c5e438]/10 to-transparent opacity-30" />
                <div className="relative flex items-start justify-between">
                  <div>
                    <div className="mb-6 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.16em] text-[#a8b0bc]"><Activity size={13} className="text-[#c5e438]" /> live instrument</div>
                    <p className="mono text-[10px] uppercase tracking-[.16em] text-[#a8b0bc]">BTC / USD spot</p>
                    <p data-testid="value-btc-price" className="mono mt-1 text-[clamp(34px,10vw,62px)] font-medium leading-none tracking-[-.08em]">{displayPrice(priceNow)}</p>
                    <p data-testid="value-btc-velocity" className={`mono mt-3 flex items-center gap-1 text-[12px] ${velocity !== null && velocity >= 0 ? 'text-[#c5e438]' : 'text-[#ef9c82]'}`}>
                      {velocity !== null && velocity >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />} {velocity !== null && velocity >= 0 ? '+' : ''}{velocity === null ? '—' : velocity.toFixed(1)} / min
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="mono text-[10px] uppercase tracking-[.16em] text-[#a8b0bc]">freshness</p>
                    <p data-testid="value-feed-freshness" className="mono mt-1 text-[13px] text-[#f3f0e7]">{freshnessLabel}</p>
                    <p className="mono mt-10 text-[10px] uppercase tracking-[.16em] text-[#a8b0bc]">window ends</p>
                    <p data-testid="value-time-remaining" className="mono mt-1 text-[20px] tracking-[-.04em] text-[#c5e438]">{remainingMinutes}</p>
                  </div>
                </div>
                <div className="relative mt-8 grid grid-cols-2 gap-3 border-t border-[#4a5468] pt-5 sm:grid-cols-4">
                  <Metric label="KALSHI TARGET" value={displayPrice(target)} testId="value-kalshi-target" />
                  <Metric label="SIGNED BUFFER" value={buffer === null ? '—' : `${buffer > 0 ? '+' : buffer < 0 ? '-' : ''}${price(Math.abs(buffer))}`} accent={absoluteBuffer !== null && absoluteBuffer >= 8} testId="value-buffer" />
                  <Metric label="UP OFFER" value={marketUp === null ? '—' : `${marketUp.toFixed(1)}%`} accent={marketUp !== null && marketUp >= 50} testId="value-up-market" />
                  <Metric label="DOWN OFFER" value={marketDown === null ? '—' : `${marketDown.toFixed(1)}%`} testId="value-down-market" />
                </div>
                <div data-testid="line-diagnostics" className={`relative mt-4 border-t pt-3 mono text-[9px] leading-relaxed ${dataError ? 'border-[#c75a48] text-[#ffae9c]' : 'border-[#4a5468] text-[#9fa8b4]'}`}>
                  BTC {priceNow === null ? '—' : priceNow.toFixed(2)} · TARGET {target === null ? '—' : target.toFixed(2)} · SIGNED {buffer === null ? '—' : `${buffer >= 0 ? '+' : ''}${buffer.toFixed(2)}`} · ABS {absoluteBuffer === null ? '—' : absoluteBuffer.toFixed(2)} · VELOCITY {velocity === null ? '—' : `${velocity >= 0 ? '+' : ''}${velocity.toFixed(2)}/min`} · UP OFFER {market?.yesAsk === null || market?.yesAsk === undefined ? '—' : `${(market.yesAsk * 100).toFixed(1)}%`} · DOWN OFFER {market?.noAsk === null || market?.noAsk === undefined ? '—' : `${(market.noAsk * 100).toFixed(1)}%`} · BTC TS {compactTime(btcUpdatedAt)} · KALSHI TS {compactTime(marketUpdatedAt)}
                </div>
              </section>

              <section className="dashboard-enter dashboard-enter-delay-1 rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-5 sm:p-6">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <p className="mono text-[10px] uppercase tracking-[.16em] text-[#888d94]">model readout</p>
                    <h2 className="mt-1 text-[20px] font-extrabold tracking-[-.04em]">Is the move real?</h2>
                  </div>
                  <div data-testid="status-model-state" className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-extrabold tracking-[.12em] ${dataError ? 'border-[#e2a092] bg-[#fae2dc] text-[#8e3127]' : tone === 'signal' ? 'border-[#bbd147] bg-[#e5efae] text-[#40520c]' : tone === 'watch' ? 'border-[#e1c179] bg-[#faedcf] text-[#765014]' : tone === 'danger' ? 'border-[#e2a092] bg-[#fae2dc] text-[#8e3127]' : 'border-[#d6d0c1] bg-[#e9e5db] text-[#626a75]'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${tone === 'signal' ? 'bg-[#779412]' : tone === 'watch' ? 'bg-[#cc8f27]' : tone === 'danger' ? 'bg-[#c75a48]' : 'bg-[#89909a]'}`} />
                    {modelStateLabel}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-[1fr_190px]">
                  <div className="rounded-[12px] bg-[#eeeadf] p-4">
                    <p data-testid="text-model-explanation" className="text-[13px] leading-relaxed text-[#596271]">{explanation(signalState, absoluteBuffer, directionalSide, connection, strategy.note, dataError)}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <RulePill icon={<Target size={12} />} text={absoluteBuffer === null ? 'no buffer' : `${absoluteBuffer.toFixed(1)} buffer`} active={absoluteBuffer !== null && absoluteBuffer >= 8} />
                      <RulePill icon={<Zap size={12} />} text={directionalChance === null ? 'no side' : `${directionalChance.toFixed(1)}% side`} active={directionalChance !== null && directionalChance <= championParameters.confirmMaxOffer * 100} />
                      <RulePill icon={<Clock3 size={12} />} text={secondsLeft === null ? 'no expiry' : `${Math.floor(secondsLeft / 60)}m left`} active={secondsLeft !== null && secondsLeft > 0} />
                    </div>
                  </div>
                  <div className="flex flex-col justify-between rounded-[12px] border border-[#d6d0c1] bg-[#f4f1e8] p-4">
                    <div>
                      <p className="mono text-[9px] uppercase tracking-[.14em] text-[#92969b]">directional read</p>
                      <p data-testid="value-directional-read" className={`mt-1 text-[24px] font-extrabold tracking-[-.05em] ${directionalSide === 'UP' ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{directionalSide ?? '—'}</p>
                    </div>
                    <p className="mono mt-3 text-[10px] text-[#92969b]">{directionalChance === null ? 'waiting for quote' : `${directionalChance.toFixed(1)}% buy offer`}</p>
                  </div>
                </div>
              </section>

              <PositionPanel position={activePosition} lastTrade={history[history.length - 1] ?? null} markPnl={markPnl} markPrice={markPrice} />
              {historyReady
                ? <LiveTestPanel strategy={strategy} ticker={market?.ticker ?? 'KXBTC15M'} live={live} />
                : <section className="rounded-[18px] border border-[#cbbf9b] bg-[#fbf8ee] p-5"><h2 className="text-[20px] font-extrabold">Manual live-test records</h2><p className="mt-2 text-[12px] text-[#68717d]">{isSignedIn ? 'Your private database ledger is connecting or unavailable. Recording is paused until it reconnects.' : 'Sign in to record actions in your private ledger. The public market dashboard remains available.'}</p>{!isSignedIn && <Link href="/sign-in" className="mt-4 inline-block rounded-[9px] bg-[#222a3d] px-4 py-2 text-[11px] font-bold text-white">Sign in to save history</Link>}</section>}
            </div>

            <aside className="space-y-5">
              <section className="dashboard-enter dashboard-enter-delay-2 rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="mono text-[10px] uppercase tracking-[.16em] text-[#888d94]">paper ledger</p>
                    <h2 className="mt-1 text-[20px] font-extrabold tracking-[-.045em]">Forward tests</h2>
                  </div>
                  <BookOpen size={19} className="text-[#7f8994]" />
                </div>
                <div className="mt-5 flex items-end justify-between">
                  <div>
                    <p className="mono text-[10px] uppercase tracking-[.12em] text-[#92969b]">cumulative P&L</p>
                    <p data-testid="value-cumulative-pnl" className={`mono mt-1 text-[30px] font-medium tracking-[-.07em] ${cumulativePnl >= 0 ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{historyReady ? `${cumulativePnl >= 0 ? '+' : ''}${money(cumulativePnl)}` : '—'}</p>
                  </div>
                  <p data-testid="value-win-loss" className="mono pb-1 text-[11px] text-[#757d87]">{historyReady ? <><span className="text-[#53730b]">{wins}W</span> / <span className="text-[#a34032]">{losses}L</span></> : '—'}</p>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <StatCell label="COMPLETED" value={historyReady ? String(completedTests) : '—'} testId="value-completed-tests" />
                  <StatCell label="PAPER STAKE" value="$5.00" testId="value-paper-stake" />
                </div>
                <button type="button" data-testid="button-view-history" onClick={() => setActiveView('history')} className="mt-4 flex w-full items-center justify-between border-t border-[#ded8cb] pt-4 text-left text-[11px] font-extrabold uppercase tracking-[.1em] text-[#596271] transition hover:text-[#222a3d]">
                  <span className="flex items-center gap-2"><History size={14} /> review saved history</span><ChevronRight size={14} />
                </button>
              </section>

              <section className="dashboard-enter dashboard-enter-delay-3 overflow-hidden rounded-[18px] border border-[#d6d0c1] bg-[#e2ebaa]">
                <button type="button" data-testid="button-toggle-method" onClick={() => setShowMethod((value) => !value)} className="flex w-full items-start justify-between p-5 text-left">
                  <div>
                    <p className="mono text-[10px] uppercase tracking-[.16em] text-[#66741d]">{V13_CHAMPION_PARAMETER_SET.label}</p>
                    <h2 className="mt-1 text-[20px] font-extrabold tracking-[-.045em] text-[#2e3910]">Signal rules</h2>
                  </div>
                  <Info size={18} className="mt-1 text-[#66741d]" />
                </button>
                <div className="space-y-3 px-5 pb-5">
                  <RuleRow marker="01" title="Fresh crossing" body="Only the first clean strike counts." />
                  <RuleRow marker="02" title="Scout" body={`$${championParameters.scoutMinSeparation}–$${championParameters.scoutMaxSeparation} separation inclusive, max offer ${championParameters.scoutMaxOffer * 100}c.`} />
                  <RuleRow marker="03" title="Confirm" body={`$${championParameters.confirmMinSeparation}+ separation, max offer ${championParameters.confirmMaxOffer * 100}c.`} />
                  {showMethod && <div data-testid="text-method-detail" className="border-t border-[#bccb70] pt-3 text-[11px] leading-relaxed text-[#56621a]">Wrong-side recross ${championParameters.wrongSideRecrossSeparation}; momentum-invalidated exit {championParameters.exitOnMomentumInvalidation ? 'enabled' : 'disabled'}. This display grants no execution authority.</div>}
                </div>
              </section>

              <section className="rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-5">
                <div className="flex items-center justify-between">
                  <p className="mono text-[10px] uppercase tracking-[.16em] text-[#888d94]">market link</p>
                  <Signal size={16} className={connection === 'live' ? 'text-[#71900f]' : 'text-[#a28756]'} />
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-[#68717d]">{marketError ? 'The public Kalshi feed is unavailable. BTC remains visible, but the model is safely held in WATCH.' : 'Watching Coinbase BTC-USD spot against the public KXBTC15M target. Prices are indicative and paper-only.'}</p>
                <div data-testid="status-market-link" className="mt-4 flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#626a75]"><Wifi size={13} /> {statusLabel.toLowerCase()} <span className="ml-auto mono font-normal normal-case tracking-normal text-[#92969b]">{freshnessAge === null ? 'waiting' : freshnessAge < 2 ? 'synced' : `age ${freshnessAge}s`}</span></div>
              </section>
            </aside>
          </div>
        ) : (
          <HistoryView store={store} trades={history} cumulativePnl={cumulativePnl} winRate={winRate} averageWin={averageWin} averageLoss={averageLoss} expectancy={expectancy} />
        )}
        </details>
        <section className="mb-5 space-y-5" aria-label="Existing administrator and safety controls">
          <div className="rounded-[16px] border border-[#d6d0c1] bg-[#f8f5ed] p-4">
            <h2 className="text-[12px] font-extrabold uppercase tracking-[.1em]">Advanced / administrator & safety controls</h2>
            <p className="mt-2 text-[11px] text-[#68717d]">Existing controls are unchanged. These are separate from the read-only operator overview above.</p>
          </div>
          <MicroLivePanel />
          <Phase4AccountPanel />
          <DiagnosticsPanel market={paper} store={store} />
          {import.meta.env.DEV && <KeyProvisioningLink />}
        </section>
        <footer className="mt-8 flex flex-col gap-2 border-t border-[#d6d0c1] pt-5 text-[10px] leading-relaxed text-[#92969b] sm:flex-row sm:items-center sm:justify-between">
          <span className="mono uppercase tracking-[.13em]">private saved ledger · no orders</span>
          <span>Paper observations can be wrong. Keep the position hypothetical.</span>
        </footer>
      </div>
    </main>
  );
}

function Metric({ label, value, accent, testId }: { label: string; value: string; accent?: boolean; testId: string }) {
  return <div><p className="mono text-[9px] uppercase tracking-[.13em] text-[#9fa8b4]">{label}</p><p data-testid={testId} className={`mono mt-1 text-[15px] ${accent ? 'text-[#c5e438]' : 'text-[#f3f0e7]'}`}>{value}</p></div>;
}

function RulePill({ icon, text, active }: { icon: React.ReactNode; text: string; active: boolean }) {
  return <span className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-bold ${active ? 'bg-[#dfeab0] text-[#51640e]' : 'bg-[#e2ded3] text-[#858a92]'}`}>{icon}{text}</span>;
}

function StatCell({ label, value, testId }: { label: string; value: string; testId: string }) {
  return <div className="rounded-[10px] bg-[#eeeadf] px-3 py-2.5"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#92969b]">{label}</p><p data-testid={testId} className="mono mt-1 text-[16px] text-[#303b4e]">{value}</p></div>;
}

function SummaryMetric({ label, value, tone = 'default', testId }: { label: string; value: string; tone?: 'default' | 'positive' | 'danger'; testId?: string }) {
  const color = tone === 'positive' ? 'text-[#53730b]' : tone === 'danger' ? 'text-[#a34032]' : 'text-[#303b4e]';
  return <div className="min-w-0 rounded-[10px] bg-[#eeeadf] px-3 py-2.5"><p className="mono truncate text-[8px] uppercase tracking-[.1em] text-[#92969b]">{label}</p><p data-testid={testId} className={`mono mt-1 truncate text-[15px] ${color}`}>{value}</p></div>;
}

function RuleRow({ marker, title, body }: { marker: string; title: string; body: string }) {
  return <div className="flex gap-3"><span className="mono pt-0.5 text-[10px] text-[#7b8b27]">{marker}</span><div><p className="text-[11px] font-extrabold text-[#37430f]">{title}</p><p className="mt-0.5 text-[11px] leading-relaxed text-[#66711f]">{body}</p></div></div>;
}

function PositionPanel({ position, lastTrade, markPnl, markPrice }: { position: PaperPosition | null; lastTrade: PaperPosition | null; markPnl: number | null; markPrice: number | null }) {
  return (
    <section className={`dashboard-enter dashboard-enter-delay-2 rounded-[18px] border p-5 sm:p-6 ${position ? 'border-[#aebf42] bg-[#f1f4d9]' : 'border-[#d6d0c1] bg-[#f8f5ed]'}`}>
      <div className="flex items-start justify-between gap-3">
        <div><p className="mono text-[10px] uppercase tracking-[.16em] text-[#888d94]">paper position</p><h2 className="mt-1 text-[20px] font-extrabold tracking-[-.045em]">{position ? `${position.direction.toUpperCase()} · $5.00 notional` : 'Stand by or test it'}</h2></div>
        {position ? <span data-testid="status-position-open" className="flex items-center gap-1.5 rounded-full bg-[#dce9a0] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#52650e]"><span className="live-dot h-1.5 w-1.5 rounded-full bg-[#779412]" /> open</span> : <CircleHelp size={18} className="text-[#9399a0]" />}
      </div>
      {position ? (
        <>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <div><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8a929c]">entry</p><p data-testid="value-entry-price" className="mono mt-1 text-[15px]">{position.entryPrice.toFixed(2)}</p></div>
            <div><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8a929c]">market mark</p><p data-testid="value-mark-price" className="mono mt-1 text-[15px]">{markPrice === null ? '—' : `${(markPrice * 100).toFixed(1)}¢`}</p></div>
            <div><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8a929c]">unrealized</p><p data-testid="value-unrealized-pnl" className={`mono mt-1 text-[15px] ${markPnl !== null && markPnl >= 0 ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{markPnl === null ? '—' : `${markPnl >= 0 ? '+' : ''}${money(markPnl)}`}</p></div>
          </div>
          <div data-testid="text-position-policy" className="mt-5 flex items-center gap-2 border-t border-[#cdd79b] pt-4 text-[11px] leading-relaxed text-[#687326]"><Zap size={14} /> Auto-exit is recorded by the live V1.3 strategy on wrong-side recross or momentum loss.</div>
        </>
      ) : (
        <>
          {lastTrade ? (
            <div data-testid="card-last-completed-test" className="mt-4 rounded-[12px] bg-[#eeeadf] p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="mono text-[9px] uppercase tracking-[.13em] text-[#92969b]">last completed test · {lastTrade.direction.toUpperCase()}</p>
                <p className={`mono text-[15px] font-bold ${(lastTrade.pnl ?? 0) >= 0 ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{(lastTrade.pnl ?? 0) >= 0 ? '+' : ''}{money(lastTrade.pnl ?? 0)}</p>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div><p className="mono text-[9px] uppercase tracking-[.12em] text-[#92969b]">entry</p><p data-testid="value-last-entry-price" className="mono mt-1 text-[14px]">{(lastTrade.entryPrice * 100).toFixed(1)}¢</p></div>
                <div><p className="mono text-[9px] uppercase tracking-[.12em] text-[#92969b]">exit / settlement</p><p data-testid="value-last-exit-price" className="mono mt-1 text-[14px]">{lastTrade.exitPrice === null ? '—' : `${(lastTrade.exitPrice * 100).toFixed(1)}¢`}</p></div>
              </div>
            </div>
          ) : null}
          <p className={`${lastTrade ? 'mt-4' : 'mt-3'} max-w-[520px] text-[12px] leading-relaxed text-[#69727e]`}>A $5 hypothetical position arms automatically when the live strategy detects a fresh scout or confirm. Nothing is submitted to a venue.</p>
          <div data-testid="text-position-armed" className="mt-5 flex items-center gap-2 rounded-[10px] bg-[#eeeadf] px-3 py-3 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#858a92]"><CircleHelp size={14} /> waiting for a valid crossing</div>
        </>
      )}
    </section>
  );
}

function HistoryView({
  store, trades, cumulativePnl, winRate, averageWin, averageLoss, expectancy,
}: {
  store: HistoryStore; trades: PaperPosition[]; cumulativePnl: number;
  winRate: number; averageWin: number; averageLoss: number; expectancy: number;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const connected = store.status === 'CONNECTED';
  const importMessage = (result: { paperImported: number; liveImported: number; eventsImported: number }) =>
    `Import complete: ${result.paperImported} paper tests, ${result.liveImported} live trades, ${result.eventsImported} events added. Existing records were skipped; browser data was not deleted.`;
  const run = async (action: 'import' | 'export' | 'refresh') => {
    setBusy(true);
    setMessage(null);
    try {
      if (action === 'import') {
        const result = await store.importLegacy();
        setMessage(importMessage(result));
      } else if (action === 'export') {
        await store.exportHistory();
        setMessage('Your complete saved history was downloaded as JSON.');
      } else {
        await store.refresh();
        setMessage('Database connection refreshed.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Database action failed.');
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(importMessage(await store.importBackup(file)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'JSON backup import failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    <section className="dashboard-enter rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-5 sm:p-7">
      <div className="flex flex-col justify-between gap-4 border-b border-[#ded8cb] pb-5 sm:flex-row sm:items-end">
        <div><p className="mono text-[10px] uppercase tracking-[.16em] text-[#888d94]">private database · available across devices</p><h2 className="mt-1 text-[28px] font-extrabold tracking-[-.06em]">Paper history</h2><p className="mt-2 text-[12px] text-[#747c86]">Completed tests and manual records are saved to your account, not just this browser.</p></div>
        <p className={`mono text-[18px] ${cumulativePnl >= 0 ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{connected ? `${cumulativePnl >= 0 ? '+' : ''}${money(cumulativePnl)}` : '—'}</p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
        <span data-testid="status-database" className={`mono rounded-full border px-3 py-1.5 font-bold ${connected ? 'border-[#b8cf48] bg-[#e5efae] text-[#40520c]' : 'border-[#dfb86c] bg-[#f6e7c4] text-[#765014]'}`}>DATABASE: {store.status}</span>
        <span className="mono text-[#747c86]">saved paper tests: {connected ? store.metrics?.paper.completed : '—'} · last sync: {store.syncedAt && connected ? new Date(store.syncedAt).toLocaleString() : '—'}</span>
        <button type="button" onClick={() => void run('refresh')} disabled={busy || store.status === 'SIGN IN'} className="rounded-[9px] border border-[#d6d0c1] px-3 py-1.5 font-bold disabled:opacity-50">Retry connection</button>
      </div>
      {connected && <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCell label="WIN RATE" value={`${(winRate * 100).toFixed(1)}%`} testId="value-paper-win-rate" />
        <StatCell label="AVG WIN" value={money(averageWin)} testId="value-paper-avg-win" />
        <StatCell label="AVG LOSS" value={money(averageLoss)} testId="value-paper-avg-loss" />
        <StatCell label="EXPECTANCY" value={money(expectancy)} testId="value-paper-expectancy" />
      </div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void run('import')} disabled={busy || !connected} className="rounded-[9px] bg-[#222a3d] px-4 py-2 text-[11px] font-bold text-white disabled:opacity-50">Import legacy browser history</button>
        <label className={`cursor-pointer rounded-[9px] border border-[#d6d0c1] px-4 py-2 text-[11px] font-bold ${busy || !connected ? 'opacity-50' : ''}`}>
          Import JSON backup
          <input type="file" accept=".json,application/json" disabled={busy || !connected} className="sr-only" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = '';
          }} />
        </label>
        <button type="button" onClick={() => void run('export')} disabled={busy || !connected} className="rounded-[9px] border border-[#d6d0c1] px-4 py-2 text-[11px] font-bold disabled:opacity-50">Export all history (JSON)</button>
        <button type="button" onClick={() => {
          try { store.exportLegacy(); setMessage('Legacy browser backup downloaded. The original browser data remains unchanged.'); }
          catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to read legacy browser history.'); }
        }} className="rounded-[9px] border border-[#d6d0c1] px-4 py-2 text-[11px] font-bold">Download legacy browser backup</button>
      </div>
      <p className="mt-2 text-[11px] text-[#747c86]">Import is optional and safe to repeat. Matching IDs are skipped; old browser records remain untouched. If your old records are only in the preview browser, download its legacy backup here and import that JSON after publishing and signing in there.</p>
      {message && <p role="status" className="mt-3 rounded-[9px] bg-[#eeeadf] p-3 text-[11px] text-[#4c5665]">{message}</p>}
      {!connected ? <div className="flex min-h-[160px] items-center justify-center text-center text-[12px] text-[#68717d]">{store.status === 'SIGN IN' ? <span>Sign in to load your private history. <Link href="/sign-in" className="font-bold underline">Sign in</Link></span> : store.status === 'ERROR' ? 'Unable to load your private history. No local records are being shown as synchronized.' : 'Loading your saved history…'}</div> : trades.length === 0 ? <div data-testid="state-history-empty" className="flex min-h-[220px] flex-col items-center justify-center text-center"><History size={27} className="text-[#aaa89d]" /><p className="mt-3 text-[13px] font-bold text-[#636b76]">No completed tests yet.</p><p className="mt-1 text-[11px] text-[#92969b]">Import previous browser history here, or your next paper exit will appear here.</p></div> : (
        <div className="mt-4 overflow-x-auto">
          <div className="min-w-[660px]">
            <div className="grid grid-cols-[1.05fr_1fr_1.2fr_1fr_1fr_1.3fr] gap-3 px-3 py-2 mono text-[9px] uppercase tracking-[.12em] text-[#959a9d]"><span>side</span><span>opened</span><span>entry → exit</span><span>result</span><span>P&L</span><span>reason</span></div>
            {trades.map((trade) => <div key={trade.id} data-testid={`row-trade-${trade.id}`} className="grid grid-cols-[1.05fr_1fr_1.2fr_1fr_1fr_1.3fr] items-center gap-3 rounded-[10px] border border-[#e0dbcf] bg-[#f2eee5] px-3 py-3 text-[11px] text-[#4c5665]"><span className={`flex items-center gap-1 font-extrabold ${trade.direction === 'up' ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{trade.direction === 'up' ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{trade.direction.toUpperCase()}</span><span className="mono text-[10px]">{compactTime(trade.closedAt)}</span><span className="mono text-[10px]">{trade.entryPrice.toFixed(2)} <span className="text-[#a3a5a4]">→</span> {trade.exitPrice === null ? '—' : trade.exitPrice.toFixed(2)}</span><span>{(trade.pnl ?? 0) > 0 ? <span className="flex items-center gap-1 text-[#53730b]"><Check size={13} /> win</span> : <span className="flex items-center gap-1 text-[#a34032]"><CircleAlert size={13} /> loss</span>}</span><span className={`mono font-bold ${(trade.pnl ?? 0) >= 0 ? 'text-[#53730b]' : 'text-[#a34032]'}`}>{(trade.pnl ?? 0) >= 0 ? '+' : ''}{money(trade.pnl ?? 0)}</span><span className="text-[#7c838d]">{trade.reason ?? '—'}</span></div>)}
          </div>
        </div>
      )}
    </section>
    </>
  );
}

function explanation(state: SignalState, distance: number | null, side: Side | null, connection: ConnectionState, note: string, dataError: boolean) {
  if (dataError) return 'DATA ERROR — the signed buffer does not match the raw BTC price and Kalshi target. Scout and Confirm signals are disabled.';
  if (connection === 'offline') return 'The spot feed is offline. Hold the model in a safe WATCH state until a fresh tick returns.';
  if (connection === 'stale') return 'No fresh spot tick. The instrument is deliberately holding WATCH rather than acting on an old move.';
  if (state === 'CONFIRM') return `A ${(distance ?? 0).toFixed(1)} point ${(side ?? 'unknown').toLowerCase()} move cleared the confirmation band. The shared champion requires a selected-side offer at or below ${championParameters.confirmMaxOffer * 100}c; this display grants no execution authority.`;
  if (state === 'SCOUT UP' || state === 'SCOUT DOWN') return `Fresh ${(side ?? 'unknown').toLowerCase()} pressure sits inside the $8–$15 scout band. This is an early observation, not a conviction call.`;
  if (state === 'EXIT') return 'The move has recrossed the quick-exit buffer. If momentum does not recover, record the paper exit.';
  if (state === 'WATCH') return distance !== null && distance < 8 ? 'BTC is near the target. Wait for a clean crossing before creating a paper test.' : note;
  return note;
}

export default App;