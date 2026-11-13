import * as React from 'react';
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, CircleDollarSign, Clock3, History, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  LIVE_ADD_SIZE,
  LIVE_MAX_EXPOSURE,
  LIVE_SCOUT_SIZE,
  LIVE_STARTING_BANKROLL,
  directionForLiveSignal,
  liveSignalFor,
  scoutDirectionForStrategy,
} from '@/lib/liveTesting';
import type { LiveAction, LiveTestingState } from '@/lib/liveTesting';
import type { Direction, StrategySnapshot } from '@/lib/strategy';

type ManualForm = {
  side: Direction | '';
  dollars: string;
  entryPrice: string;
  addPrice: string;
  exitPrice: string;
  settlementPrice: string;
  fees: string;
};

type LiveTestPanelProps = {
  strategy: StrategySnapshot;
  ticker: string;
  live: LiveTestingState;
};

const signalLabels = [
  '⚪ PASS',
  '🟡 WATCH UP',
  '🟡 WATCH DOWN',
  '🟢 ENTER UP — SCOUT $2.50',
  '🔴 ENTER DOWN — SCOUT $2.50',
  '✅ ADD UP — $2.50',
  '✅ ADD DOWN — $2.50',
  '🚨 EXIT UP',
  '🚨 EXIT DOWN',
  'DATA ERROR',
  'LIVE TEST BUDGET EXHAUSTED',
];

const actionLabel: Record<LiveAction, string> = {
  scout: 'I Entered Scout',
  add: 'I Added',
  exit: 'I Exited',
  settlement: 'Held to Settlement',
  skip: 'Skip Trade',
};

const money = (value: number, signed = false) => {
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
};

const percentToPrice = (value: string) => Number(value) / 100;
const numberOrZero = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function eventTime(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function metricTone(value: number) {
  return value > 0 ? 'text-[#53730b]' : value < 0 ? 'text-[#a34032]' : 'text-[#68717d]';
}

function displaySignal(signal: string) {
  if (signal === 'PASS') return '⚪ PASS';
  if (signal === 'WATCH UP') return '🟡 WATCH UP';
  if (signal === 'WATCH DOWN') return '🟡 WATCH DOWN';
  if (signal === 'ENTER UP — SCOUT $2.50') return '🟢 ENTER UP — SCOUT $2.50';
  if (signal === 'ENTER DOWN — SCOUT $2.50') return '🔴 ENTER DOWN — SCOUT $2.50';
  if (signal === 'ADD UP — $2.50') return '✅ ADD UP — $2.50';
  if (signal === 'ADD DOWN — $2.50') return '✅ ADD DOWN — $2.50';
  if (signal === 'EXIT UP') return '🚨 EXIT UP';
  if (signal === 'EXIT DOWN') return '🚨 EXIT DOWN';
  return signal;
}

export function LiveTestPanel({ strategy, ticker, live }: LiveTestPanelProps) {
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const signal = liveSignalFor(strategy, live.budgetExhausted);
  const signalDisplay = displaySignal(signal);
  const scoutDirection = scoutDirectionForStrategy(strategy);
  const modelDirection = directionForLiveSignal(strategy);
  const form = useForm<ManualForm>({
    defaultValues: {
      side: '',
      dollars: LIVE_SCOUT_SIZE.toFixed(2),
      entryPrice: '',
      addPrice: '',
      exitPrice: '',
      settlementPrice: '',
      fees: '0.00',
    },
  });

  const currentSignalIndex = useMemo(
    () => signalLabels.indexOf(signalDisplay),
    [signalDisplay],
  );
  const canAdd = Boolean(
    !strategy.dataError &&
    strategy.state === 'CONFIRM' &&
    live.activeTrade &&
    strategy.direction === live.activeTrade.direction &&
    live.activeTrade.addStake === 0,
  );
  const canClose = Boolean(live.activeTrade);
  const canRecordScout =
    scoutDirection !== null && !strategy.dataError && !live.entryBlocked;

  const record = async (action: LiveAction) => {
    if (pending) return;
    const values = form.getValues();
    const fees = numberOrZero(values.fees);
    const direction = modelDirection;
    let result: Promise<string | null>;

    if (action === 'scout') {
      if (!scoutDirection) {
        setMessage({
          tone: 'error',
          text: 'A live Scout can only be recorded while the model shows an ENTER / SCOUT signal.',
        });
        return;
      }
      result = live.recordScout({
        direction: scoutDirection,
        stake: numberOrZero(values.dollars),
        entryPrice: percentToPrice(values.entryPrice),
        ticker,
        signal,
        fees,
      });
    } else if (action === 'add') {
      if (!canAdd) {
        setMessage({ tone: 'error', text: 'A matching ADD / CONFIRM signal is required to record an add.' });
        return;
      }
      result = live.recordAdd({
        stake: numberOrZero(values.dollars),
        entryPrice: percentToPrice(values.addPrice),
        ticker,
        signal,
        fees,
      });
    } else if (action === 'exit') {
      result = live.recordExit({
        exitPrice: percentToPrice(values.exitPrice),
        ticker,
        signal,
        fees,
        reason: 'Manual live test exit',
      });
    } else if (action === 'settlement') {
      result = live.recordSettlement({
        exitPrice: percentToPrice(values.settlementPrice),
        ticker,
        signal,
        fees,
      });
    } else {
      result = live.recordSkip({
        ticker,
        direction,
        signal,
      });
    }

    setPending(true);
    try {
      const error = await result;
      if (error) {
        setMessage({ tone: 'error', text: error });
        return;
      }
      setMessage({
        tone: 'success',
        text: `${actionLabel[action]} saved to your private ledger. No order was submitted.`,
      });
      form.setValue('fees', '0.00');
      if (action === 'exit' || action === 'settlement') {
        form.setValue('exitPrice', '');
        form.setValue('settlementPrice', '');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      aria-labelledby="live-test-panel-title"
      data-testid="live-test-panel"
      className="dashboard-enter mt-5 overflow-hidden rounded-[18px] border border-[#cbbf9b] bg-[#fbf8ee] shadow-[0_14px_32px_rgba(72,65,38,.08)]"
    >
      <div className="border-b border-[#ded5ba] bg-[#283247] px-4 py-4 text-[#f4f0e2] sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[9px] font-extrabold uppercase tracking-[.16em] text-[#c5e438]">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-[#c5e438]" />
              manual live test mode
            </div>
            <h2 id="live-test-panel-title" className="mt-1 text-[22px] font-extrabold tracking-[-.05em]">
              What did you actually do?
            </h2>
            <p className="mt-1 max-w-[540px] text-[11px] leading-relaxed text-[#b8bfca]">
              Record your action in Kalshi after it happened. This panel never submits orders, connects an account, or trades automatically.
            </p>
          </div>
          <ShieldCheck aria-hidden="true" size={20} className="mt-1 shrink-0 text-[#c5e438]" />
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-[10px] border border-[#536078] bg-[#20293b] px-3 py-2.5">
          <div>
            <p className="mono text-[9px] uppercase tracking-[.14em] text-[#9fa8b4]">explicit model signal</p>
            <p data-testid="value-live-signal" aria-live="polite" className="mt-0.5 text-[15px] font-extrabold tracking-[-.02em] text-[#c5e438]">
              {signalDisplay}
            </p>
          </div>
          <span className="mono shrink-0 text-[10px] text-[#9fa8b4]">{ticker}</span>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div className="rounded-[12px] border border-[#ded5ba] bg-[#f2eddd] p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="mono text-[9px] font-medium uppercase tracking-[.15em] text-[#777e84]">risk rules · fixed</p>
            <p data-testid="value-live-exposure" className="mono text-[10px] text-[#636b76]">
              exposure {money(live.exposure)}
            </p>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px] text-[#4f5968] sm:grid-cols-4">
            <span><strong className="text-[#283247]">${LIVE_STARTING_BANKROLL.toFixed(2)}</strong> starting bankroll</span>
            <span><strong className="text-[#283247]">${LIVE_SCOUT_SIZE.toFixed(2)}</strong> scout</span>
            <span><strong className="text-[#283247]">${LIVE_ADD_SIZE.toFixed(2)}</strong> add</span>
            <span><strong className="text-[#283247]">${LIVE_MAX_EXPOSURE.toFixed(2)}</strong> max exposure · no martingale</span>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="mono text-[9px] uppercase tracking-[.15em] text-[#858a92]">live action log</p>
            <p className="text-[10px] text-[#8b8b83]">{live.activeTrade ? 'one trade open' : 'no trade open'}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <button
              type="button"
              data-testid="button-live-entered-scout"
              onClick={() => record('scout')}
              disabled={!canRecordScout || pending}
              className="min-h-[44px] rounded-[9px] bg-[#c5e438] px-2 py-2 text-[10px] font-extrabold leading-tight text-[#283247] transition hover:bg-[#d5ed61] disabled:cursor-not-allowed disabled:bg-[#ddd9c9] disabled:text-[#8e928e]"
            >
              I Entered Scout
            </button>
            <button
              type="button"
              data-testid="button-live-added"
              onClick={() => record('add')}
              disabled={!canAdd || pending}
              className="min-h-[44px] rounded-[9px] border border-[#aebf42] bg-[#eff4d5] px-2 py-2 text-[10px] font-extrabold leading-tight text-[#4e640d] transition hover:bg-[#e3edb5] disabled:cursor-not-allowed disabled:border-[#ded9cb] disabled:bg-[#f0ede4] disabled:text-[#9a9b94]"
            >
              I Added
            </button>
            <button
              type="button"
              data-testid="button-live-exited"
              onClick={() => record('exit')}
              disabled={!canClose || pending}
              className="min-h-[44px] rounded-[9px] border border-[#d7a79b] bg-[#f8e9e3] px-2 py-2 text-[10px] font-extrabold leading-tight text-[#953c30] transition hover:bg-[#f3dcd4] disabled:cursor-not-allowed disabled:border-[#ded9cb] disabled:bg-[#f0ede4] disabled:text-[#9a9b94]"
            >
              I Exited
            </button>
            <button
              type="button"
              data-testid="button-live-settlement"
              onClick={() => record('settlement')}
              disabled={!canClose || pending}
              className="min-h-[44px] rounded-[9px] border border-[#c9bea1] bg-[#f6f1e4] px-2 py-2 text-[10px] font-extrabold leading-tight text-[#596271] transition hover:bg-[#ebe3d0] disabled:cursor-not-allowed disabled:border-[#ded9cb] disabled:bg-[#f0ede4] disabled:text-[#9a9b94]"
            >
              Held to Settlement
            </button>
            <button
              type="button"
              data-testid="button-live-skip-trade"
              onClick={() => record('skip')}
              disabled={pending}
              className="min-h-[44px] rounded-[9px] border border-[#c9bea1] bg-[#f6f1e4] px-2 py-2 text-[10px] font-extrabold leading-tight text-[#596271] transition hover:bg-[#ebe3d0]"
            >
              Skip Trade
            </button>
          </div>
        </div>

        <Form {...form}>
          <form aria-label="Manual live test details" className="rounded-[12px] border border-[#ded5ba] bg-[#f8f5ed] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="mono text-[9px] uppercase tracking-[.15em] text-[#858a92]">manual details</p>
                <p className="mt-1 text-[11px] text-[#69727e]">Enter the exact Kalshi percentage shown for the action you recorded.</p>
              </div>
              <CircleDollarSign aria-hidden="true" size={18} className="text-[#8b9650]" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <FormField
                control={form.control}
                name="side"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="mono text-[9px] uppercase tracking-[.1em] text-[#777e84]">side</FormLabel>
                    <FormControl>
                      <select
                        {...field}
                        value={modelDirection ?? ''}
                        data-testid="input-live-side"
                        aria-label="Live test side"
                        disabled
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-[#283247] shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="">—</option>
                        <option value="up">UP</option>
                        <option value="down">DOWN</option>
                      </select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dollars"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="mono text-[9px] uppercase tracking-[.1em] text-[#777e84]">dollars</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-live-dollars" inputMode="decimal" placeholder="2.50" aria-label="Live test dollars" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="entryPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="mono text-[9px] uppercase tracking-[.1em] text-[#777e84]">entry %</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-live-entry-percent" inputMode="decimal" aria-label="Live test entry percentage" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="addPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="mono text-[9px] uppercase tracking-[.1em] text-[#777e84]">add %</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-live-add-percent" inputMode="decimal" aria-label="Live test add percentage" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="exitPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="mono text-[9px] uppercase tracking-[.1em] text-[#777e84]">exit %</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-live-exit-percent" inputMode="decimal" aria-label="Live test exit percentage" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="settlementPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="mono text-[9px] uppercase tracking-[.1em] text-[#777e84]">settlement %</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-live-settlement-percent" inputMode="decimal" aria-label="Live test settlement percentage" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="fees"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="mono text-[9px] uppercase tracking-[.1em] text-[#777e84]">fees</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-live-fees" inputMode="decimal" placeholder="0.00" aria-label="Live test fees" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-[#8a8d88]">
              Use entry % for the scout, add % for the add, exit % for I Exited, and settlement % for Held to Settlement. Fees are applied to the close.
            </p>
          </form>
        </Form>

        {message ? (
          <div
            data-testid={`status-live-action-${message.tone}`}
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2 rounded-[10px] px-3 py-2.5 text-[11px] leading-relaxed ${message.tone === 'error' ? 'bg-[#f8e3dc] text-[#8e3127]' : 'bg-[#e7efbd] text-[#51640e]'}`}
          >
            {message.tone === 'error' ? <AlertTriangle aria-hidden="true" size={15} className="mt-0.5 shrink-0" /> : <Check aria-hidden="true" size={15} className="mt-0.5 shrink-0" />}
            {message.text}
          </div>
        ) : null}

        <section aria-labelledby="live-results-title" data-testid="live-results" className="border-t border-[#ded5ba] pt-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="mono text-[9px] font-extrabold uppercase tracking-[.16em] text-[#8b9650]">LIVE RESULTS</p>
              <h3 id="live-results-title" className="mt-1 text-[19px] font-extrabold tracking-[-.045em] text-[#283247]">Manual ledger</h3>
              <p className="mt-1 text-[10px] text-[#7c838d]">Separate from paper results. Stored on this device only.</p>
            </div>
            <p className="mono text-right text-[10px] text-[#7c838d]">
              {live.completedTrades} completed<br />
              {live.activeTrade ? 'open trade' : 'flat'}
            </p>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="CURRENT BANKROLL" value={money(live.currentBankroll)} testId="value-live-current-bankroll" />
            <Metric label="LIVE P&L" value={money(live.livePnl, true)} tone={metricTone(live.livePnl)} testId="value-live-pnl" />
            <Metric label="WIN / LOSS" value={`${live.wins} / ${live.losses}`} testId="value-live-wins-losses" />
            <Metric label="WIN RATE" value={`${(live.winRate * 100).toFixed(1)}%`} testId="value-live-win-rate" />
            <Metric label="COMPLETED" value={String(live.completedTrades)} testId="value-live-completed-trades" />
            <Metric label="AVG WIN" value={money(live.averageWin, true)} tone={metricTone(live.averageWin)} testId="value-live-average-win" />
            <Metric label="AVG LOSS" value={money(live.averageLoss, true)} tone={metricTone(live.averageLoss)} testId="value-live-average-loss" />
            <Metric label="EXPECTANCY" value={money(live.expectancy, true)} tone={metricTone(live.expectancy)} testId="value-live-expectancy" />
            <Metric label="MAX DRAWDOWN" value={money(-live.maxDrawdown)} tone={live.maxDrawdown > 0 ? 'text-[#a34032]' : 'text-[#68717d]'} testId="value-live-max-drawdown" />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1.15fr]">
            <div className="rounded-[10px] bg-[#f1eddf] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="mono text-[9px] uppercase tracking-[.13em] text-[#858a92]">signal labels</p>
                <TrendingUp aria-hidden="true" size={14} className="text-[#8b9650]" />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Supported live signal labels">
                {signalLabels.map((label, index) => (
                  <span
                    key={label}
                    data-testid={`signal-label-${index}`}
                    className={`rounded-full px-2 py-1 text-[9px] font-bold leading-tight ${index === currentSignalIndex ? 'bg-[#dce9a0] text-[#4e640d]' : 'bg-[#e4dfd1] text-[#7d827f]'}`}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-[10px] bg-[#f1eddf] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="mono text-[9px] uppercase tracking-[.13em] text-[#858a92]">recent manual events</p>
                <History aria-hidden="true" size={14} className="text-[#8b9650]" />
              </div>
              {live.events.length === 0 ? (
                <div data-testid="state-live-events-empty" className="mt-3 flex items-center gap-2 text-[11px] text-[#8b8f89]">
                  <Clock3 aria-hidden="true" size={14} />
                  No live actions recorded yet.
                </div>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {live.events.slice(0, 4).map((event) => (
                    <li key={event.id} data-testid={`live-event-${event.id}`} className="flex items-start justify-between gap-2 rounded-[7px] bg-[#e8e3d5] px-2 py-1.5 text-[10px] text-[#5c6674]">
                      <span className="min-w-0">
                        <strong className="font-extrabold text-[#374254]">{actionLabel[event.action]}</strong>
                        <span className="ml-1.5 text-[#7f8589]">{event.direction ? event.direction.toUpperCase() : '—'} · {event.note}</span>
                      </span>
                      <time className="mono shrink-0 text-[9px] text-[#969993]" dateTime={new Date(event.createdAt).toISOString()}>
                        {eventTime(event.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {live.budgetExhausted ? (
            <div data-testid="status-live-budget-exhausted" className="mt-3 flex items-start gap-2 rounded-[10px] border border-[#d9ae9f] bg-[#f8e4dc] px-3 py-2.5 text-[11px] leading-relaxed text-[#8e3127]">
              <TrendingDown aria-hidden="true" size={15} className="mt-0.5 shrink-0" />
              LIVE TEST BUDGET EXHAUSTED. No new scout can be recorded.
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function Metric({ label, value, tone = 'text-[#283247]', testId }: { label: string; value: string; tone?: string; testId: string }) {
  return (
    <div className="rounded-[9px] bg-[#f1eddf] px-2.5 py-2.5">
      <p className="mono text-[8px] uppercase tracking-[.1em] text-[#92969b]">{label}</p>
      <p data-testid={testId} className={`mono mt-1 text-[14px] font-medium ${tone}`}>{value}</p>
    </div>
  );
}

export default LiveTestPanel;