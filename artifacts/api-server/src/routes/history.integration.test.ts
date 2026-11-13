import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  liveEventsTable,
  liveTradesTable,
  paperHistoryTable,
  pool,
} from "@workspace/db";
import type { LiveEvent, LiveTrade, PaperPosition } from "@workspace/api-zod";
import {
  HistoryActionError,
  importHistoryData,
  loadHistoryForUser,
  persistLiveAction,
  type HistoryTransaction,
} from "./history.js";

after(async () => {
  await pool.end();
});

const makePaper = (
  id: string,
  openedAt: number,
  overrides: Partial<PaperPosition> = {},
): PaperPosition => ({
  id,
  direction: "up",
  status: "closed",
  openedAt,
  closedAt: openedAt + 10,
  entryPrice: 0.5,
  exitPrice: 0.6,
  stake: 5,
  pnl: 1,
  reason: "test close",
  ticker: "TEST-TICKER",
  target: 100_000,
  entrySignal: null,
  entryBtcPrice: 100_001,
  entryBuffer: 1,
  entryVelocity: 2,
  ...overrides,
});

const makeTrade = (
  id: string,
  overrides: Partial<LiveTrade> = {},
): LiveTrade => ({
  id,
  ticker: "TEST-TICKER",
  direction: "up",
  scoutStake: 2.5,
  scoutEntryPrice: 0.5,
  addStake: 0,
  addEntryPrice: null,
  exitPrice: null,
  fees: 0,
  pnl: null,
  status: "open",
  openedAt: 100,
  closedAt: null,
  closeReason: null,
  ...overrides,
});

const makeEvent = (
  id: string,
  action: LiveEvent["action"],
  createdAt = 100,
): LiveEvent => ({
  id,
  action,
  ticker: "TEST-TICKER",
  direction: "up",
  signal: "TEST",
  createdAt,
  note: "test event",
});

async function rollbackTestData(
  userIds: string[],
  action: (tx: HistoryTransaction) => Promise<void>,
) {
  const rollback = new Error("rollback synthetic history test data");
  try {
    await db.transaction(async (tx) => {
      await action(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  for (const userId of userIds) {
    const [paper] = await db
      .select({ id: paperHistoryTable.id })
      .from(paperHistoryTable)
      .where(eq(paperHistoryTable.userId, userId));
    const [trade] = await db
      .select({ id: liveTradesTable.id })
      .from(liveTradesTable)
      .where(eq(liveTradesTable.userId, userId));
    const [event] = await db
      .select({ id: liveEventsTable.id })
      .from(liveEventsTable)
      .where(eq(liveEventsTable.userId, userId));
    assert.equal(paper, undefined, "test paper data must roll back");
    assert.equal(trade, undefined, "test live trade data must roll back");
    assert.equal(event, undefined, "test event data must roll back");
  }
}

test("duplicate event replay never overwrites the current live trade", async () => {
  const userId = `history-test-${randomUUID()}`;
  await rollbackTestData([userId], async (tx) => {
    const openTrade = makeTrade("trade-replay");
    const scout = makeEvent("event-replay", "scout");
    await persistLiveAction(tx, userId, openTrade, scout);

    const staleClosedSnapshot = makeTrade("trade-replay", {
      status: "closed",
      exitPrice: 0.8,
      pnl: 1.5,
      closedAt: 200,
      closeReason: "stale close",
    });
    await persistLiveAction(tx, userId, staleClosedSnapshot, scout);

    const [stored] = await tx
      .select()
      .from(liveTradesTable)
      .where(eq(liveTradesTable.userId, userId));
    assert.equal(stored.status, "open");
    assert.equal(stored.payload.status, "open");
    assert.equal(stored.exitPrice, null);
  });
});

test("live actions enforce owner and trade transition boundaries", async () => {
  const ownerId = `history-test-${randomUUID()}`;
  const otherUserId = `history-test-${randomUUID()}`;
  await rollbackTestData([ownerId, otherUserId], async (tx) => {
    const openTrade = makeTrade("shared-trade-id");
    await persistLiveAction(tx, ownerId, openTrade, makeEvent("owner-scout", "scout"));

    const addSnapshot = makeTrade("shared-trade-id", {
      addStake: 2.5,
      addEntryPrice: 0.4,
    });
    await assert.rejects(
      persistLiveAction(tx, otherUserId, addSnapshot, makeEvent("foreign-add", "add")),
      (error: unknown) =>
        error instanceof HistoryActionError && error.statusCode === 409,
    );

    await persistLiveAction(tx, ownerId, addSnapshot, makeEvent("owner-add", "add"));
    const changedAdd = makeTrade("shared-trade-id", {
      addStake: 2.5,
      addEntryPrice: 0.4,
      fees: 0.25,
    });
    await assert.rejects(
      persistLiveAction(tx, ownerId, changedAdd, makeEvent("second-add", "add")),
      (error: unknown) =>
        error instanceof HistoryActionError && error.statusCode === 409,
    );

    const [ownerTrade] = await tx
      .select()
      .from(liveTradesTable)
      .where(eq(liveTradesTable.userId, ownerId));
    assert.equal(ownerTrade.addStake, 2.5);
    assert.equal(ownerTrade.fees, 0);
    const [foreignTrade] = await tx
      .select()
      .from(liveTradesTable)
      .where(eq(liveTradesTable.userId, otherUserId));
    assert.equal(foreignTrade, undefined);
  });
});

test("imports deduplicate by owner ID and reject malformed paper atomically", async () => {
  const userId = `history-test-${randomUUID()}`;
  await rollbackTestData([userId], async (tx) => {
    const original = makePaper("paper-import", 100);
    const changedDuplicate = makePaper("paper-import", 100, {
      reason: "must not overwrite",
    });
    const closedTrade = makeTrade("live-import", {
      status: "closed",
      exitPrice: 0.6,
      pnl: 0.4,
      closedAt: 120,
      closeReason: "test close",
    });
    const event = makeEvent("event-import", "skip");
    const first = await importHistoryData(
      tx,
      userId,
      [original, changedDuplicate],
      [closedTrade, closedTrade],
      [event, event],
    );
    assert.deepEqual(first, {
      paperImported: 1,
      liveImported: 1,
      eventsImported: 1,
    });

    const duplicate = await importHistoryData(
      tx,
      userId,
      [changedDuplicate],
      [closedTrade],
      [event],
    );
    assert.deepEqual(duplicate, {
      paperImported: 0,
      liveImported: 0,
      eventsImported: 0,
    });
    const [storedPaper] = await tx
      .select()
      .from(paperHistoryTable)
      .where(eq(paperHistoryTable.userId, userId));
    assert.equal(storedPaper.reason, "test close");

    await assert.rejects(
      importHistoryData(
        tx,
        userId,
        [makePaper("valid-but-rejected", 200), makePaper("legacy-open", 210, {
          status: "open",
          closedAt: null,
          exitPrice: null,
          pnl: null,
        })],
        [],
        [],
      ),
      (error: unknown) =>
        error instanceof HistoryActionError && error.statusCode === 400,
    );
    const allPaper = await tx
      .select({ id: paperHistoryTable.id })
      .from(paperHistoryTable)
      .where(eq(paperHistoryTable.userId, userId));
    assert.equal(allPaper.length, 1, "invalid import must not partially insert");
  });
});

test("refresh snapshot reads and orders persisted account history", async () => {
  const userId = `history-test-${randomUUID()}`;
  await rollbackTestData([userId], async (tx) => {
    await importHistoryData(
      tx,
      userId,
      [makePaper("paper-late", 200), makePaper("paper-early", 100)],
      [
        makeTrade("live-early", {
          status: "closed",
          exitPrice: 0.6,
          pnl: 0.4,
          closedAt: 130,
          openedAt: 100,
          closeReason: "test close",
        }),
        makeTrade("live-late", {
          status: "closed",
          exitPrice: 0.6,
          pnl: 0.4,
          closedAt: 230,
          openedAt: 200,
          closeReason: "test close",
        }),
      ],
      [
        makeEvent("event-old", "skip", 100),
        makeEvent("event-new", "skip", 200),
      ],
    );
    const snapshot = await loadHistoryForUser(tx, userId);
    assert.deepEqual(snapshot.paper.map((position) => position.id), [
      "paper-early",
      "paper-late",
    ]);
    assert.deepEqual(snapshot.liveTrades.map((trade) => trade.id), [
      "live-late",
      "live-early",
    ]);
    assert.deepEqual(snapshot.liveEvents.map((event) => event.id), [
      "event-new",
      "event-old",
    ]);
    assert.equal(snapshot.metrics.paper.completed, 2);
    assert.equal(snapshot.metrics.live.completedTrades, 2);
  });
});
