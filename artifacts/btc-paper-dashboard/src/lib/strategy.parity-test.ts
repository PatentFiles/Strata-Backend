import assert from 'node:assert/strict';
import { evaluateV13Strategy, type V13Input } from '@workspace/v13-strategy';
import type { KalshiMarket } from './marketData';
import { evaluateStrategy, safeStrategyForDisplay, type PaperPosition } from './strategy';

const now = 1_700_000_000_000;
const target = 84_000;
const market: KalshiMarket = {
  ticker: 'KXBTC15M-PARITY',
  title: 'Parity fixture',
  target,
  closeTime: new Date(now + 60_000).toISOString(),
  yesBid: 0.5,
  yesAsk: 0.52,
  noBid: 0.5,
  noAsk: 0.45,
  yesPrice: 0.51,
  noPrice: 0.44,
  result: null,
  status: 'open',
  fetchedAt: now,
};

const openPosition: PaperPosition = {
  id: 'existing',
  direction: 'up',
  status: 'open',
  openedAt: now - 10_000,
  closedAt: null,
  entryPrice: 0.52,
  exitPrice: null,
  stake: 5,
  pnl: null,
  reason: null,
  ticker: market.ticker,
  target,
};

type Input = Parameters<typeof evaluateStrategy>[0];
const base: Input = {
  market,
  latestPrice: target + 10,
  previousPrice: target - 1,
  previousBuffer: -1,
  velocity: 20,
  position: null,
  crossId: 3,
  now,
};

const cases: [string, Partial<Input>][] = [
  ['missing market', { market: null }],
  ['missing target', { market: { ...market, target: null } }],
  ['missing BTC', { latestPrice: null }],
  ['scout up at 8', { latestPrice: target + 8 }],
  ['scout up at 15', { latestPrice: target + 15 }],
  ['watch above scout band', { latestPrice: target + 16 }],
  ['scout down', { latestPrice: target - 10, previousBuffer: 1, velocity: -20 }],
  ['not fresh cross', { previousBuffer: 2 }],
  ['velocity opposite cross', { velocity: -20 }],
  ['scout at 52 percent', { market: { ...market, yesAsk: 0.52 } }],
  ['scout above 52 percent', { market: { ...market, yesAsk: 0.53 } }],
  ['confirm up at 20', { latestPrice: target + 20, market: { ...market, yesAsk: 0.53 } }],
  ['confirm above 53 percent', { latestPrice: target + 20, market: { ...market, yesAsk: 0.54 } }],
  ['confirm down', { latestPrice: target - 21, previousBuffer: 1, velocity: -20, market: { ...market, noAsk: 0.53 } }],
  ['no fresh confirm', { latestPrice: target + 21, previousBuffer: 1, market: { ...market, yesAsk: 0.53 } }],
  ['near target', { latestPrice: target + 7 }],
  ['zero buffer', { latestPrice: target }],
  ['held position', { position: openPosition, previousBuffer: 1 }],
  ['held confirm', { position: openPosition, latestPrice: target + 22 }],
  ['wrong side recross', { position: openPosition, latestPrice: target - 8, velocity: -20 }],
  ['momentum invalidated', { position: openPosition, previousBuffer: 2, velocity: 0 }],
  ['explicit settlement', { position: openPosition, market: { ...market, result: 'yes' } }],
  ['inferred expiry', { position: openPosition, market: { ...market, closeTime: new Date(now - 1).toISOString() } }],
];

const actual = cases.map(([name, overrides]) => {
  const result = evaluateStrategy({ ...base, ...overrides });
  return {
    name,
    state: result.state,
    direction: result.direction,
    buffer: result.buffer,
    marketPrice: result.marketPrice,
    crossId: result.crossId,
    note: result.note,
    position: result.position
      ? {
          status: result.position.status,
          direction: result.position.direction,
          entryPrice: result.position.entryPrice,
          exitPrice: result.position.exitPrice,
          pnl: result.position.pnl,
          reason: result.position.reason,
          entrySignal: result.position.entrySignal ?? null,
        }
      : null,
  };
});

if (process.env.PRINT_BASELINE === '1') {
  console.log(JSON.stringify(actual, null, 2));
} else {
  // Fixed regression baseline using executable bids for discretionary exits
  // and explicit Kalshi results as the only settlement authority.
  const expected = [
    'missing market|WATCH|-|-|-|3|Waiting for target and BTC feed|-',
    'missing target|WATCH|-|-|-|3|Waiting for target and BTC feed|-',
    'missing BTC|WATCH|-|-|-|3|Waiting for target and BTC feed|-',
    'scout up at 8|SCOUT UP|up|8|0.52|4|Fresh UP cross in the $8–$15 scout band|open,up,0.52,-,-,-,SCOUT UP',
    'scout up at 15|SCOUT UP|up|15|0.52|4|Fresh UP cross in the $8–$15 scout band|open,up,0.52,-,-,-,SCOUT UP',
    'watch above scout band|WATCH|up|16|0.52|4|Watching for directional repricing lag|-',
    'scout down|SCOUT DOWN|down|-10|0.45|4|Fresh DOWN cross in the $8–$15 scout band|open,down,0.45,-,-,-,SCOUT DOWN',
    'not fresh cross|WATCH|up|10|0.52|3|Watching for directional repricing lag|-',
    'velocity opposite cross|WATCH|up|10|0.52|4|Watching for directional repricing lag|-',
    'scout at 52 percent|SCOUT UP|up|10|0.52|4|Fresh UP cross in the $8–$15 scout band|open,up,0.52,-,-,-,SCOUT UP',
    'scout above 52 percent|PASS|up|10|0.53|4|TOO EXPENSIVE — favored side is above the 52% Scout maximum|-',
    'confirm up at 20|CONFIRM|up|20|0.53|4|Confirmed at $20+ separation|open,up,0.53,-,-,-,CONFIRM',
    'confirm above 53 percent|PASS|up|20|0.54|4|Move confirmed but market already repriced — PASS|-',
    'confirm down|CONFIRM|down|-21|0.53|4|Confirmed at $20+ separation|open,down,0.53,-,-,-,CONFIRM',
    'no fresh confirm|PASS|up|21|0.53|3|TOO EXPENSIVE — favored side is above the 52% Scout maximum|-',
    'near target|PASS|up|7|0.52|4|BTC is near the target; no fresh edge is active|-',
    'zero buffer|PASS|-|0|-|3|BTC is near the target; no fresh edge is active|-',
    'held position|WATCH|up|10|0.51|3|Paper position is being monitored|open,up,0.52,-,-,-,-',
    'held confirm|CONFIRM|up|22|0.51|3|Separation is $20+ with repricing still behind BTC|open,up,0.52,-,-,-,-',
    'wrong side recross|EXIT|up|-8|0.5|3|Exited on approximately $8 wrong-side recross|closed,up,0.52,0.5,-0.19,Wrong-side recross,-',
    'momentum invalidated|EXIT|up|10|0.5|3|Exited because directional velocity faded|closed,up,0.52,0.5,-0.19,Momentum invalidated,-',
    'explicit settlement|PASS|up|10|0.52|3|Settlement recorded locally|closed,up,0.52,1,4.62,Kalshi settled,-',
    'inferred expiry|WATCH|up|10|0.51|3|Paper position is being monitored|open,up,0.52,-,-,-,-',
  ];
  const text = actual.map((item) => {
    const position = item.position
      ? [
          item.position.status, item.position.direction, item.position.entryPrice,
          item.position.exitPrice ?? '-', item.position.pnl ?? '-',
          item.position.reason ?? '-', item.position.entrySignal ?? '-',
        ].join(',')
      : '-';
    return [
      item.name, item.state, item.direction ?? '-', item.buffer ?? '-',
      item.marketPrice ?? '-', item.crossId, item.note, position,
    ].join('|');
  });
  assert.deepEqual(text, expected);
  const sharedInput: V13Input = {
    marketTicker: market.ticker,
    btcPrice: target + 10,
    target,
    previousBuffer: -1,
    velocity: 20,
    upOffer: 0.52,
    downOffer: 0.45,
    freshness: 'current',
    position: null,
  };
  const scout = evaluateV13Strategy(sharedInput);
  assert.equal(scout.signal, 'SCOUT');
  assert.equal(scout.direction, 'UP');
  assert.equal(scout.qualifyingTrigger, true);
  assert.equal(scout.entrySideOffer, 0.52);
  assert.equal(scout.buffer, 10);
  assert.equal(scout.freshCross, true);
  // Once the previous buffer is already on the new side of the strike, the
  // original V1.3 logic does not create another crossing or entry.
  const consumedCross = evaluateV13Strategy({ ...sharedInput, previousBuffer: 10 });
  assert.equal(consumedCross.signal, 'WATCH');
  assert.equal(consumedCross.freshCross, false);
  assert.equal(consumedCross.qualifyingTrigger, false);
  assert.equal(consumedCross.entrySideOffer, null);
  assert.equal(consumedCross.advanceCrossId, false);
  assert.equal(evaluateV13Strategy({ ...sharedInput, upOffer: 0.53 }).signal, 'PASS');
  assert.equal(evaluateV13Strategy({ ...sharedInput, btcPrice: target + 20, upOffer: 0.53 }).signal, 'CONFIRM');
  assert.equal(evaluateV13Strategy({ ...sharedInput, freshness: 'data-error' }).qualifyingTrigger, false);
  // Existing freshness protection is snapshot coherence, not a new
  // quote-age threshold: a result from the old ticker cannot remain actionable.
  const staleSnapshot = safeStrategyForDisplay(
    evaluateStrategy(base),
    target + 10,
    { ...market, ticker: 'KXBTC15M-NEXT' },
  );
  assert.equal(staleSnapshot.state, 'PASS');
  assert.equal(staleSnapshot.direction, null);
  assert.equal(staleSnapshot.marketPrice, null);
  assert.equal(staleSnapshot.dataError, true);
  const staleShared = evaluateV13Strategy({ ...sharedInput, freshness: 'data-error' });
  assert.equal(staleShared.signal, 'PASS');
  assert.equal(staleShared.direction, 'NONE');
  assert.equal(staleShared.qualifyingTrigger, false);
  assert.equal(staleShared.entrySideOffer, null);
  assert.equal(evaluateV13Strategy({
    ...sharedInput, btcPrice: target - 8, velocity: -20,
    position: { status: 'open', direction: 'up' },
  }).positionExitReason, 'Wrong-side recross');
  console.log(`V1.3 parity passed: ${actual.length} baseline cases`);
}