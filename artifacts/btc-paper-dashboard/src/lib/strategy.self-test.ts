import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveTestPanel } from '../components/live-test-panel';
import type { KalshiMarket } from './marketData';
import {
  directionForLiveSignal,
  liveSignalFor,
  scoutDirectionForStrategy,
  type LiveTestingState,
} from './liveTesting';
import {
  calculateSignedBuffer,
  evaluateStrategy,
  hasSignedBufferMismatch,
  hasStrategyDataError,
  safeStrategyForDisplay,
  type StrategySnapshot,
} from './strategy';

const market = (
  target: number,
  yesPrice: number,
  noPrice = 1 - yesPrice,
): KalshiMarket => ({
  ticker: 'KXBTC15M-SELF-TEST',
  title: 'Synthetic BTC market',
  target,
  closeTime: new Date(Date.now() + 15 * 60_000).toISOString(),
  yesBid: yesPrice,
  yesAsk: yesPrice,
  noBid: noPrice,
  noAsk: noPrice,
  yesPrice,
  noPrice,
  result: null,
  status: 'open',
  fetchedAt: Date.now(),
});

const evaluate = (
  latestPrice: number,
  target: number,
  previousBuffer: number | null,
  velocity: number,
  yesPrice: number,
) =>
  evaluateStrategy({
    market: market(target, yesPrice),
    latestPrice,
    previousPrice: null,
    velocity,
    previousBuffer,
    position: null,
    crossId: 0,
  });

const exampleBuffer = calculateSignedBuffer(84_281.69, 84_372.17);
assert.equal(exampleBuffer.toFixed(2), '-90.48');
assert.equal(hasSignedBufferMismatch(84_281.69, 84_372.17, exampleBuffer), false);
assert.equal(hasSignedBufferMismatch(84_281.69, 84_372.17, 90.48), true);
assert.equal(hasSignedBufferMismatch(84_462.65, 84_372.17, -90.48), true);
assert.equal(hasSignedBufferMismatch(84_372.17, 84_372.17, 0), false);

const scoutUp = evaluate(84_382.17, 84_372.17, -1, 20, 0.52);
assert.equal(scoutUp.buffer, 10);
assert.equal(scoutUp.direction, 'up');
assert.equal(scoutUp.state, 'SCOUT UP');
assert.equal(scoutDirectionForStrategy(scoutUp), 'up');
assert.equal(directionForLiveSignal(scoutUp), 'up');
assert.equal(liveSignalFor(scoutUp, false), 'ENTER UP — SCOUT $2.50');

const scoutDown = evaluate(84_362.17, 84_372.17, 1, -20, 0.49);
assert.equal(scoutDown.buffer, -10);
assert.equal(scoutDown.direction, 'down');
assert.equal(scoutDown.state, 'SCOUT DOWN');
assert.equal(scoutDirectionForStrategy(scoutDown), 'down');
assert.equal(directionForLiveSignal(scoutDown), 'down');
assert.equal(liveSignalFor(scoutDown, false), 'ENTER DOWN — SCOUT $2.50');

const tooExpensiveScout = evaluate(84_382.17, 84_372.17, -1, 20, 0.65);
assert.equal(tooExpensiveScout.state, 'PASS');
assert.match(tooExpensiveScout.note, /TOO EXPENSIVE/);
assert.equal(scoutDirectionForStrategy(tooExpensiveScout), null);
const tooExpensiveDown = evaluate(84_362.17, 84_372.17, 1, -20, 0.35);
assert.equal(tooExpensiveDown.state, 'PASS');
assert.match(tooExpensiveDown.note, /TOO EXPENSIVE/);
const expensiveBetweenBands = evaluate(84_390.17, 84_372.17, 17, 20, 0.65);
assert.equal(expensiveBetweenBands.state, 'PASS');
// A large buffer does not make a 65% offer a Scout or a WATCH; a fresh
// directional cross can still qualify as Confirm only at or below the 53% launch cap.
const expensiveWithoutConfirm = evaluate(84_397.17, 84_372.17, 22, 20, 0.65);
assert.equal(expensiveWithoutConfirm.state, 'PASS');
assert.match(expensiveWithoutConfirm.note, /already repriced/);
assert.doesNotMatch(expensiveWithoutConfirm.note, /near the target/);
const expensiveDownWithoutConfirm = evaluate(84_347.17, 84_372.17, -22, -20, 0.35);
assert.equal(expensiveDownWithoutConfirm.state, 'PASS');
assert.match(expensiveDownWithoutConfirm.note, /already repriced/);

// The quote used for Scout eligibility is the side's buy offer, not its midpoint.
const wideSpreadMarket = {
  ...market(84_372.17, 0.59),
  yesAsk: 0.62,
};
const wideSpread = evaluateStrategy({
  market: wideSpreadMarket,
  latestPrice: 84_382.17,
  previousPrice: null,
  previousBuffer: -1,
  velocity: 20,
  position: null,
  crossId: 0,
});
assert.equal(wideSpread.state, 'PASS');
assert.match(wideSpread.note, /TOO EXPENSIVE/);

// Realized paper exits must use the executable sell bid, never the midpoint.
const exitMarket: KalshiMarket = {
  ...market(84_372.17, 0.5),
  yesBid: 0.4,
  yesAsk: 0.6,
  noBid: 0.4,
  noAsk: 0.6,
  yesPrice: 0.5,
  noPrice: 0.5,
};
const executableExit = evaluateStrategy({
  market: exitMarket,
  latestPrice: 84_382.17,
  previousPrice: null,
  previousBuffer: 10,
  velocity: -1,
  position: scoutUp.position,
  crossId: scoutUp.crossId,
});
assert.equal(executableExit.state, 'EXIT');
assert.equal(executableExit.position?.status, 'closed');
assert.equal(executableExit.position?.exitPrice, 0.4);
assert.equal(executableExit.marketPrice, 0.4);

const unavailableExit = evaluateStrategy({
  market: { ...exitMarket, yesBid: null },
  latestPrice: 84_382.17,
  previousPrice: null,
  previousBuffer: 10,
  velocity: -1,
  position: scoutUp.position,
  crossId: scoutUp.crossId,
});
assert.equal(unavailableExit.state, 'EXIT');
assert.equal(unavailableExit.position?.status, 'open');
assert.equal(unavailableExit.position?.exitPrice, null);
assert.equal(unavailableExit.marketPrice, null);
assert.match(unavailableExit.note, /executable sell bid unavailable/);

const expiredWithoutResult = evaluateStrategy({
  market: {
    ...exitMarket,
    closeTime: new Date(Date.now() - 1_000).toISOString(),
    result: null,
  },
  latestPrice: 84_382.17,
  previousPrice: null,
  previousBuffer: 10,
  velocity: 1,
  position: scoutUp.position,
  crossId: scoutUp.crossId,
});
assert.equal(expiredWithoutResult.position?.status, 'open');
assert.equal(expiredWithoutResult.position?.exitPrice, null);

const watch = evaluate(84_390.17, 84_372.17, 17, 20, 0.52);
assert.equal(watch.state, 'WATCH');
assert.equal(scoutDirectionForStrategy(watch), null);
assert.equal(directionForLiveSignal(watch), 'up');
assert.equal(evaluate(84_382.17, 84_372.17, -1, -20, 0.52).state, 'WATCH');
assert.equal(evaluate(84_362.17, 84_372.17, 1, 20, 0.48).state, 'WATCH');

const confirm = evaluate(84_397.17, 84_372.17, -1, 20, 0.53);
assert.equal(confirm.state, 'CONFIRM');
assert.equal(confirm.direction, 'up');
assert.equal(scoutDirectionForStrategy(confirm), null);
assert.equal(directionForLiveSignal(confirm), 'up');
const confirmDown = evaluate(84_347.17, 84_372.17, 1, -20, 0.47);
assert.equal(confirmDown.state, 'CONFIRM');
assert.equal(confirmDown.direction, 'down');
assert.equal(confirmDown.buffer, -25);
assert.equal(directionForLiveSignal(confirmDown), 'down');

const repricedConfirm = evaluate(84_397.17, 84_372.17, -1, 20, 0.7);
assert.equal(repricedConfirm.state, 'PASS');
assert.equal(
  repricedConfirm.note,
  'Move confirmed but market already repriced — PASS',
);
const repricedDown = evaluate(84_347.17, 84_372.17, 1, -20, 0.3);
assert.equal(repricedDown.state, 'PASS');
assert.equal(repricedDown.note, 'Move confirmed but market already repriced — PASS');

const nearTarget = evaluate(84_375.17, 84_372.17, 2, 2, 0.51);
assert.equal(nearTarget.state, 'PASS');
assert.match(nearTarget.note, /near the target/);
assert.doesNotMatch(watch.note, /near the target/);
assert.doesNotMatch(repricedConfirm.note, /near the target/);

const corruptedBelowStrike: StrategySnapshot = {
  ...scoutUp,
  buffer: 90.48,
  sourceBtcPrice: 84_281.69,
};
const belowStrikeMarket = market(84_372.17, 0.4);
assert.equal(
  hasStrategyDataError(corruptedBelowStrike, 84_281.69, belowStrikeMarket),
  true,
);
const safeBelow = safeStrategyForDisplay(
  corruptedBelowStrike,
  84_281.69,
  belowStrikeMarket,
);
assert.equal(safeBelow.dataError, true);
assert.equal(safeBelow.state, 'PASS');
assert.equal(safeBelow.direction, null);
assert.equal(liveSignalFor(safeBelow, false), 'DATA ERROR');
assert.equal(scoutDirectionForStrategy(safeBelow), null);
assert.equal(directionForLiveSignal(safeBelow), null);

const corruptedAboveStrike: StrategySnapshot = {
  ...scoutUp,
  buffer: -10,
};
assert.equal(
  safeStrategyForDisplay(corruptedAboveStrike, 84_382.17, wideSpreadMarket).dataError,
  true,
);
// Even a same-sign stale buffer or a refreshed market with a different target
// cannot leave an older Scout signal available.
assert.equal(
  safeStrategyForDisplay({ ...scoutUp, buffer: 9 }, 84_382.17, market(84_372.17, 0.55)).dataError,
  true,
);
assert.equal(
  safeStrategyForDisplay(scoutUp, 84_382.17, market(84_375.17, 0.55)).dataError,
  true,
);
assert.equal(hasStrategyDataError(scoutUp, 84_382.17, market(84_372.17, 0.55)), false);

const live: LiveTestingState = {
  trades: [],
  events: [],
  activeTrade: null,
  budgetExhausted: false,
  entryBlocked: false,
  livePnl: 0,
  currentBankroll: 25,
  remainingBankroll: 25,
  exposure: 0,
  completedTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  averageWin: 0,
  averageLoss: 0,
  expectancy: 0,
  maxDrawdown: 0,
  recordScout: async () => null,
  recordAdd: async () => null,
  recordExit: async () => null,
  recordSettlement: async () => null,
  recordSkip: async () => null,
};
const panel = (strategy: StrategySnapshot) =>
  renderToStaticMarkup(
    createElement(LiveTestPanel, {
      strategy,
      ticker: 'KXBTC15M-SELF-TEST',
      live,
    }),
  );
const selectedSide = (markup: string) =>
  markup.match(/data-testid="input-live-side"[^>]*>(.*?)<\/select>/)?.[1] ?? '';
const scoutButton = (markup: string) =>
  markup.match(/data-testid="button-live-entered-scout"[^>]*>/)?.[0] ?? '';
const upMarkup = panel(scoutUp);
assert.match(selectedSide(upMarkup), /<option value="up" selected=""/);
assert.doesNotMatch(scoutButton(upMarkup), /\sdisabled(?:=""|\s|>)/);
const downMarkup = panel(scoutDown);
assert.match(selectedSide(downMarkup), /<option value="down" selected=""/);
assert.doesNotMatch(scoutButton(downMarkup), /\sdisabled(?:=""|\s|>)/);
const watchMarkup = panel(watch);
assert.match(selectedSide(watchMarkup), /<option value="up" selected=""/);
assert.match(scoutButton(watchMarkup), /\sdisabled(?:=""|\s|>)/);
const confirmMarkup = panel(confirmDown);
assert.match(selectedSide(confirmMarkup), /<option value="down" selected=""/);
assert.match(scoutButton(confirmMarkup), /\sdisabled(?:=""|\s|>)/);
for (const noEntry of [tooExpensiveScout, safeBelow]) {
  const markup = panel(noEntry);
  assert.match(selectedSide(markup), /<option value="" selected=""/);
  assert.match(scoutButton(markup), /\sdisabled(?:=""|\s|>)/);
}
for (const testId of [
  'input-live-entry-percent',
  'input-live-add-percent',
  'input-live-exit-percent',
  'input-live-settlement-percent',
]) {
  assert.match(upMarkup, new RegExp(`data-testid="${testId}"[^>]*value=""`));
}

console.log(
  'Strategy self-test passed: signed buffer, UP/DOWN PASS/WATCH/SCOUT/CONFIRM, offer cap, manual form sides/blank prices, and DATA ERROR fail-safe.',
);