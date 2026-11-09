import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {db, pool, forwardTestBookSnapshotTable} from '@workspace/db';
import {readPaperBookCaptureCoverage} from './forwardTestBookCapture';

// The existing runner creates a fresh loopback-only cluster and strips credentials.
// Fail before any query when invoked outside that disposable runner.
assert.match(process.env.DATABASE_URL ?? '', /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL, process.env.V13_DISPOSABLE_DATABASE_URL);
after(() => pool.end());

async function insert(engineId: string, positions: string[], phases = ['ENTRY'], captured = false,
 createdAt = new Date()) {
 const rows = positions.flatMap(paperPositionId => phases.map(phase => ({
  id: `${paperPositionId}:${phase}`, engineId, paperPositionId, phase,
  marketTicker: 'KXBTC15M-COVERAGE-TEST', positionDirection: 'UP', requestedContracts: 1,
  eventAt: createdAt, startedAt: createdAt, createdAt,
  receivedAt: captured ? createdAt : null, status: captured ? 'CAPTURED' : 'UNAVAILABLE',
  bidLevels: captured ? {yes: [], no: []} : null,
  capacity: captured ? {requestedContracts: 1, modeledFilledContracts: 0,
   modeledUnfilledContracts: 1, modeledCashMicros: '0', modeledAveragePriceTicks: null,
   bestPriceTicks: null, usedPriceLevels: 0, interpretation: 'BOOK_CAPACITY_ONLY_NOT_EXECUTION' as const} : null,
  errorCode: captured ? null : 'synthetic_unavailable',
 })));
 for (let i = 0; i < rows.length; i += 400)
  await db.insert(forwardTestBookSnapshotTable).values(rows.slice(i, i + 400));
}

test('actual keyed query includes all 2000 receipts at the 1000-position boundary', async () => {
 const engine = randomUUID();
 const positions = Array.from({length: 1001}, (_, i) => ({id: `${engine}-${i}`, status: 'CLOSED'}));
 await insert(engine, positions.map(p => p.id), ['ENTRY', 'EXIT'], true);
 const result = await readPaperBookCaptureCoverage(engine, positions);
 const coverage = result.expectedEventCoverage!;
 assert.equal(coverage.sampledPositions, 1000);
 assert.equal(coverage.positionsTruncated, true);
 assert.equal(coverage.expectedEvents, 2000);
 assert.equal(coverage.recordedReceipts, 2000);
 assert.equal(coverage.capturedReceipts, 2000);
 assert.equal(coverage.absentReceipts, 0);
});

test('old matched receipt is retained outside the latest 2500 receipt window', async () => {
 const engine = randomUUID(), id = `${engine}-old`;
 await insert(engine, [id], ['ENTRY'], true, new Date('2020-01-01T00:00:00Z'));
 await insert(engine, Array.from({length: 2501}, (_, i) => `${engine}-new-${i}`));
 const result = await readPaperBookCaptureCoverage(engine, [{id, status: 'OPEN'}]);
 assert.equal(result.receipts, 2500);
 assert.equal(result.captured, 0); // The independent recent window contains only unavailable receipts.
 assert.equal(result.expectedEventCoverage!.capturedReceipts, 1);
 assert.equal(result.expectedEventCoverage!.absentReceipts, 0);
});

test('actual SQL engine predicate excludes another engine receipt for a supplied position ID', async () => {
 const engine = randomUUID(), other = randomUUID(), id = randomUUID();
 await insert(other, [id], ['ENTRY'], true);
 const result = await readPaperBookCaptureCoverage(engine, [{id, status: 'OPEN'}]);
 assert.equal(result.receipts, 0);
 assert.equal(result.expectedEventCoverage!.recordedReceipts, 0);
 assert.equal(result.expectedEventCoverage!.absentReceipts, 1);
});

test('pending receipt becomes recorded unavailable without implying an EXIT for SETTLED', async () => {
 const engine = randomUUID(), id = randomUUID(), positions = [{id, status: 'SETTLED'}];
 const first = await readPaperBookCaptureCoverage(engine, positions);
 assert.equal(first.expectedEventCoverage!.expectedEvents, 1);
 assert.equal(first.expectedEventCoverage!.absentReceipts, 1);
 await insert(engine, [id]);
 const later = await readPaperBookCaptureCoverage(engine, positions);
 assert.equal(later.expectedEventCoverage!.absentReceipts, 0);
 assert.equal(later.expectedEventCoverage!.unavailableReceipts, 1);
 assert.equal(later.expectedEventCoverage!.missingOrUnavailable, 1);
 assert.equal(later.expectedEventCoverage!.absentMayBePending, true);
 assert.equal(later.expectedEventCoverage!.consistency, 'POINT_IN_TIME_NON_ATOMIC');
 assert.equal(later.proofOfActualExecution, false);
 assert.equal(later.unavailableRecordedReceipts, later.missing);
 // Exercise the DB invariants on which the bounded query relies.
 await assert.rejects(insert(engine, [id]), (error: any) => error.cause?.code === '23505' || error.code === '23505');
 await assert.rejects(insert(engine, [randomUUID()], ['OTHER']),
  (error: any) => error.cause?.code === '23514' || error.code === '23514');
});
