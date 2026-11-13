import { getAuth } from "@clerk/express";
import {
  GetHistoryResponse,
  ImportHistoryResponse,
  ImportHistoryBody,
  SaveLiveActionBody,
  SaveLiveActionResponse,
  SavePaperPositionBody,
  SavePaperPositionResponse,
  type LiveEvent,
  type LiveTrade,
  type PaperPosition,
} from "@workspace/api-zod";
import {
  db,
  liveEventsTable,
  liveTradesTable,
  paperHistoryTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type RequestHandler } from "express";

const router: IRouter = Router();
const LIVE_STARTING_BANKROLL = 25;

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export class HistoryActionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function validateCompletedPaper(position: PaperPosition): string | null {
  if (
    position.status !== "closed" ||
    position.closedAt === null ||
    position.exitPrice === null ||
    position.pnl === null
  ) {
    return "Paper history accepts only completed positions.";
  }
  if (
    !Number.isFinite(position.openedAt) ||
    !Number.isFinite(position.closedAt) ||
    position.openedAt < 0 ||
    position.closedAt < position.openedAt
  ) {
    return "Paper position times must be finite, non-negative, and ordered.";
  }
  if (
    !Number.isFinite(position.entryPrice) ||
    position.entryPrice <= 0 ||
    position.entryPrice > 1 ||
    !Number.isFinite(position.exitPrice) ||
    position.exitPrice < 0 ||
    position.exitPrice > 1
  ) {
    return "Paper entry and exit prices must be valid Kalshi fractions.";
  }
  if (!Number.isFinite(position.stake) || position.stake <= 0) {
    return "Paper stake must be a finite positive amount.";
  }
  if (!Number.isFinite(position.pnl)) {
    return "Paper PnL must be finite.";
  }
  const expectedPnl = roundMoney(
    (position.stake / position.entryPrice) * position.exitPrice -
      position.stake,
  );
  if (Math.abs(expectedPnl - position.pnl) > 0.01) {
    return "Paper PnL does not match its stake and entry/exit prices.";
  }
  if (
    (position.target !== null &&
      (!Number.isFinite(position.target) || position.target <= 0)) ||
    (position.entryBtcPrice !== undefined &&
      position.entryBtcPrice !== null &&
      (!Number.isFinite(position.entryBtcPrice) ||
        position.entryBtcPrice <= 0)) ||
    (position.entryBuffer !== undefined &&
      position.entryBuffer !== null &&
      !Number.isFinite(position.entryBuffer)) ||
    (position.entryVelocity !== undefined &&
      position.entryVelocity !== null &&
      !Number.isFinite(position.entryVelocity))
  ) {
    return "Paper market metadata must contain finite sensible values.";
  }
  return null;
}

function validateLiveTrade(trade: LiveTrade): string | null {
  if (
    !Number.isFinite(trade.scoutStake) ||
    trade.scoutStake <= 0 ||
    !Number.isFinite(trade.scoutEntryPrice) ||
    trade.scoutEntryPrice <= 0 ||
    trade.scoutEntryPrice > 1 ||
    !Number.isFinite(trade.addStake) ||
    trade.addStake < 0 ||
    !Number.isFinite(trade.fees) ||
    trade.fees < 0 ||
    !Number.isFinite(trade.openedAt) ||
    trade.openedAt < 0
  ) {
    return "Live trade amounts, prices, fees, and openedAt must be valid.";
  }
  if (
    (trade.addStake === 0 && trade.addEntryPrice !== null) ||
    (trade.addStake > 0 &&
      (trade.addEntryPrice === null ||
        !Number.isFinite(trade.addEntryPrice) ||
        trade.addEntryPrice <= 0 ||
        trade.addEntryPrice > 1))
  ) {
    return "Live add stake and add entry price must agree.";
  }
  if (
    trade.exitPrice !== null &&
    (!Number.isFinite(trade.exitPrice) ||
      trade.exitPrice < 0 ||
      trade.exitPrice > 1)
  ) {
    return "Live exit price must be a valid Kalshi fraction.";
  }
  if (trade.pnl !== null && !Number.isFinite(trade.pnl)) {
    return "Live PnL must be finite.";
  }
  if (trade.status === "open") {
    if (
      trade.closedAt !== null ||
      trade.exitPrice !== null ||
      trade.pnl !== null ||
      trade.closeReason !== null
    ) {
      return "Open live trades cannot contain closing values.";
    }
  } else if (
    trade.closedAt === null ||
    !Number.isFinite(trade.closedAt) ||
    trade.closedAt < trade.openedAt ||
    trade.exitPrice === null ||
    trade.pnl === null
  ) {
    return "Closed live trades must have finite closing values.";
  }
  return null;
}

function liveTradeValues(userId: string, trade: LiveTrade) {
  return {
    userId,
    id: trade.id,
    ticker: trade.ticker,
    direction: trade.direction,
    scoutStake: trade.scoutStake,
    scoutEntryPrice: trade.scoutEntryPrice,
    addStake: trade.addStake,
    addEntryPrice: trade.addEntryPrice,
    exitPrice: trade.exitPrice,
    fees: trade.fees,
    pnl: trade.pnl,
    status: trade.status,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    closeReason: trade.closeReason,
    payload: { ...trade },
  };
}

function liveTradeUpdateValues(trade: LiveTrade) {
  const {
    ticker,
    direction,
    scoutStake,
    scoutEntryPrice,
    addStake,
    addEntryPrice,
    exitPrice,
    fees,
    pnl,
    status,
    openedAt,
    closedAt,
    closeReason,
  } = trade;
  return {
    ticker,
    direction,
    scoutStake,
    scoutEntryPrice,
    addStake,
    addEntryPrice,
    exitPrice,
    fees,
    pnl,
    status,
    openedAt,
    closedAt,
    closeReason,
    payload: { ...trade },
  };
}

function paperPositionValues(userId: string, position: PaperPosition) {
  return {
    userId,
    id: position.id,
    direction: position.direction,
    status: position.status,
    openedAt: position.openedAt,
    closedAt: position.closedAt,
    entryPrice: position.entryPrice,
    exitPrice: position.exitPrice,
    stake: position.stake,
    pnl: position.pnl,
    reason: position.reason,
    ticker: position.ticker,
    target: position.target,
    entrySignal: position.entrySignal ?? null,
    entryTime: position.openedAt,
    entryBtcPrice: position.entryBtcPrice ?? null,
    entryKalshiPrice: position.entryPrice,
    entryBuffer: position.entryBuffer ?? null,
    entryVelocity: position.entryVelocity ?? null,
    outcome:
      position.pnl === null
        ? null
        : position.pnl > 0
          ? "win"
          : position.pnl < 0
            ? "loss"
            : "breakeven",
    payload: { ...position },
  };
}

function liveEventValues(userId: string, event: LiveEvent) {
  return {
    userId,
    id: event.id,
    action: event.action,
    ticker: event.ticker,
    direction: event.direction,
    signal: event.signal,
    createdAt: event.createdAt,
    note: event.note,
    payload: { ...event },
  };
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    if (!byId.has(value.id)) byId.set(value.id, value);
  }
  return [...byId.values()];
}

function liveTradeFromRow(row: typeof liveTradesTable.$inferSelect): LiveTrade {
  return {
    id: row.id,
    ticker: row.ticker,
    direction: row.direction as LiveTrade["direction"],
    scoutStake: row.scoutStake,
    scoutEntryPrice: row.scoutEntryPrice,
    addStake: row.addStake,
    addEntryPrice: row.addEntryPrice,
    exitPrice: row.exitPrice,
    fees: row.fees,
    pnl: row.pnl,
    status: row.status as LiveTrade["status"],
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closeReason: row.closeReason,
  };
}

function hasSameEntry(existing: LiveTrade, next: LiveTrade) {
  return (
    existing.id === next.id &&
    existing.ticker === next.ticker &&
    existing.direction === next.direction &&
    existing.scoutStake === next.scoutStake &&
    existing.scoutEntryPrice === next.scoutEntryPrice &&
    existing.openedAt === next.openedAt
  );
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function paperMetrics(positions: PaperPosition[]) {
  const completed = positions.length;
  const wins = positions.filter((position) => (position.pnl ?? 0) > 0);
  const losses = positions.filter((position) => (position.pnl ?? 0) <= 0);
  const cumulativePnl = roundMoney(
    positions.reduce((total, position) => total + (position.pnl ?? 0), 0),
  );
  return {
    completed,
    wins: wins.length,
    losses: losses.length,
    cumulativePnl,
    winRate: completed ? wins.length / completed : 0,
    averageWin: wins.length
      ? roundMoney(
          wins.reduce((sum, position) => sum + (position.pnl ?? 0), 0) /
            wins.length,
        )
      : 0,
    averageLoss: losses.length
      ? roundMoney(
          losses.reduce((sum, position) => sum + (position.pnl ?? 0), 0) /
            losses.length,
        )
      : 0,
    expectancy: completed ? roundMoney(cumulativePnl / completed) : 0,
  };
}

function liveMetrics(trades: LiveTrade[]) {
  const completed = trades.filter(
    (trade): trade is LiveTrade & { pnl: number; closedAt: number } =>
      trade.status === "closed" && trade.pnl !== null && trade.closedAt !== null,
  );
  const livePnl = roundMoney(
    completed.reduce((total, trade) => total + (trade.pnl ?? 0), 0),
  );
  const wins = completed.filter((trade) => trade.pnl > 0);
  const losses = completed.filter((trade) => trade.pnl < 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of [...completed].sort((a, b) => a.closedAt - b.closedAt)) {
    equity = roundMoney(equity + trade.pnl);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const active = trades.find((trade) => trade.status === "open") ?? null;
  const exposure = active ? active.scoutStake + active.addStake : 0;
  const currentBankroll = roundMoney(
    LIVE_STARTING_BANKROLL + livePnl - exposure,
  );
  return {
    livePnl,
    currentBankroll,
    remainingBankroll: currentBankroll,
    exposure,
    completedTrades: completed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: completed.length ? wins.length / completed.length : 0,
    averageWin: wins.length
      ? roundMoney(wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length)
      : 0,
    averageLoss: losses.length
      ? roundMoney(
          losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length,
        )
      : 0,
    expectancy: completed.length ? roundMoney(livePnl / completed.length) : 0,
    maxDrawdown: roundMoney(maxDrawdown),
  };
}

const requireUser: RequestHandler = (req, res, next) => {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.locals.userId = userId;
  next();
};

router.use("/history", requireUser);

router.get("/history", async (_req, res, next) => {
  try {
    const userId = res.locals.userId as string;
    const response = await db.transaction((tx) =>
      loadHistoryForUser(tx, userId),
    );
    res.json(response);
  } catch (error) {
    next(error);
  }
});

router.post("/history/paper", async (req, res, next) => {
  try {
    const parsed = SavePaperPositionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid paper position", details: parsed.error.issues });
      return;
    }
    const position = parsed.data;
    const validationError = validateCompletedPaper(position);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    const userId = res.locals.userId as string;
    const inserted = await db
      .insert(paperHistoryTable)
      .values(paperPositionValues(userId, position))
      .onConflictDoNothing()
      .returning({ id: paperHistoryTable.id });
    res.json(SavePaperPositionResponse.parse({ inserted: inserted.length > 0 }));
  } catch (error) {
    next(error);
  }
});

export type HistoryTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export async function loadHistoryForUser(
  tx: HistoryTransaction,
  userId: string,
) {
  const paperRows = await tx
    .select()
    .from(paperHistoryTable)
    .where(eq(paperHistoryTable.userId, userId))
    .orderBy(asc(paperHistoryTable.openedAt));
  const tradeRows = await tx
    .select()
    .from(liveTradesTable)
    .where(eq(liveTradesTable.userId, userId))
    .orderBy(desc(liveTradesTable.openedAt));
  const eventRows = await tx
    .select()
    .from(liveEventsTable)
    .where(eq(liveEventsTable.userId, userId))
    .orderBy(desc(liveEventsTable.createdAt));
  const paper = paperRows.map((row) => row.payload as unknown as PaperPosition);
  const liveTrades = tradeRows.map(
    (row) => row.payload as unknown as LiveTrade,
  );
  return GetHistoryResponse.parse({
    paper,
    liveTrades,
    liveEvents: eventRows.map((row) => row.payload as unknown as LiveEvent),
    syncedAt: Date.now(),
    metrics: {
      paper: paperMetrics(paper),
      live: liveMetrics(liveTrades),
    },
  });
}

export async function persistLiveAction(
  tx: HistoryTransaction,
  userId: string,
  trade: LiveTrade | null,
  event: LiveEvent,
): Promise<void> {
  if (!Number.isFinite(event.createdAt) || event.createdAt < 0) {
    throw new HistoryActionError(
      "Live event time must be finite and non-negative.",
      400,
    );
  }
  const insertedEvent = await tx
    .insert(liveEventsTable)
    .values(liveEventValues(userId, event))
    .onConflictDoNothing({
      target: [liveEventsTable.userId, liveEventsTable.id],
    })
    .returning({ id: liveEventsTable.id });

  // Event identity makes retries safe. In particular, a delayed stale retry
  // after a close must not overwrite the closed trade snapshot.
  if (insertedEvent.length === 0) return;

  if (event.action === "skip") {
    if (trade !== null) {
      throw new HistoryActionError("Skip events cannot include a trade.", 400);
    }
    return;
  }
  if (trade === null) {
    throw new HistoryActionError(
      `${event.action} events require a trade snapshot.`,
      400,
    );
  }
  const tradeError = validateLiveTrade(trade);
  if (tradeError) throw new HistoryActionError(tradeError, 400);
  if (event.ticker !== trade.ticker || event.direction !== trade.direction) {
    throw new HistoryActionError(
      "Live event market and direction must match its trade.",
      400,
    );
  }

  if (event.action === "scout") {
    if (
      trade.status !== "open" ||
      trade.addStake !== 0 ||
      trade.addEntryPrice !== null
    ) {
      throw new HistoryActionError(
        "Scout must create a new open trade without an add leg.",
        400,
      );
    }
    const [sameId] = await tx
      .select({ id: liveTradesTable.id })
      .from(liveTradesTable)
      .where(
        and(
          eq(liveTradesTable.userId, userId),
          eq(liveTradesTable.id, trade.id),
        ),
      )
      .for("update");
    if (sameId) {
      throw new HistoryActionError("Trade ID already exists.", 409);
    }
    const [openTrade] = await tx
      .select({ id: liveTradesTable.id })
      .from(liveTradesTable)
      .where(
        and(
          eq(liveTradesTable.userId, userId),
          eq(liveTradesTable.status, "open"),
        ),
      )
      .for("update");
    if (openTrade) {
      throw new HistoryActionError(
        "Close the current live trade before opening another.",
        409,
      );
    }
    const created = await tx
      .insert(liveTradesTable)
      .values(liveTradeValues(userId, trade))
      .onConflictDoNothing({
        target: [liveTradesTable.userId, liveTradesTable.id],
      })
      .returning({ id: liveTradesTable.id });
    if (created.length === 0) {
      throw new HistoryActionError("Trade ID already exists.", 409);
    }
    return;
  }

  const [row] = await tx
    .select()
    .from(liveTradesTable)
    .where(
      and(
        eq(liveTradesTable.userId, userId),
        eq(liveTradesTable.id, trade.id),
      ),
    )
    .for("update");
  if (!row) {
    throw new HistoryActionError(
      "Live trade does not belong to this account or does not exist.",
      409,
    );
  }
  const current = liveTradeFromRow(row);
  if (current.status !== "open") {
    throw new HistoryActionError("Closed live trades cannot be changed.", 409);
  }
  if (!hasSameEntry(current, trade)) {
    throw new HistoryActionError("Live trade entry fields cannot be changed.", 400);
  }

  if (event.action === "add") {
    if (
      current.addStake !== 0 ||
      current.addEntryPrice !== null ||
      trade.status !== "open" ||
      trade.addStake <= 0 ||
      trade.addEntryPrice === null ||
      trade.fees < current.fees
    ) {
      throw new HistoryActionError(
        "Add requires an open trade with no prior add leg.",
        409,
      );
    }
  } else if (event.action === "exit" || event.action === "settlement") {
    if (
      trade.status !== "closed" ||
      trade.addStake !== current.addStake ||
      trade.addEntryPrice !== current.addEntryPrice ||
      trade.fees < current.fees
    ) {
      throw new HistoryActionError(
        "Exit and settlement must close the current open trade.",
        409,
      );
    }
  } else {
    throw new HistoryActionError("Unsupported live action.", 400);
  }

  const updated = await tx
    .update(liveTradesTable)
    .set(liveTradeUpdateValues(trade))
    .where(
      and(
        eq(liveTradesTable.userId, userId),
        eq(liveTradesTable.id, trade.id),
        eq(liveTradesTable.status, "open"),
      ),
    )
    .returning({ id: liveTradesTable.id });
  if (updated.length === 0) {
    throw new HistoryActionError(
      "Live trade changed before this action could be saved.",
      409,
    );
  }
}

export async function importHistoryData(
  tx: HistoryTransaction,
  userId: string,
  paper: PaperPosition[],
  liveTrades: LiveTrade[],
  liveEvents: LiveEvent[],
) {
  for (const [index, position] of paper.entries()) {
    const validationError = validateCompletedPaper(position);
    if (validationError) {
      throw new HistoryActionError(
        `Invalid completed paper history at index ${index}: ${validationError}`,
        400,
      );
    }
  }
  for (const [index, trade] of liveTrades.entries()) {
    const validationError = validateLiveTrade(trade);
    if (validationError) {
      throw new HistoryActionError(
        `Invalid live trade history at index ${index}: ${validationError}`,
        400,
      );
    }
  }
  for (const [index, event] of liveEvents.entries()) {
    if (!Number.isFinite(event.createdAt) || event.createdAt < 0) {
      throw new HistoryActionError(
        `Invalid live event history at index ${index}: event time must be finite and non-negative.`,
        400,
      );
    }
  }

  let paperImported = 0;
  let liveImported = 0;
  let eventsImported = 0;
  const importPaper = uniqueById(paper);
  const importTrades = uniqueById(liveTrades);
  const importEvents = uniqueById(liveEvents);

  if (importPaper.length) {
    const result = await tx
      .insert(paperHistoryTable)
      .values(importPaper.map((position) => paperPositionValues(userId, position)))
      .onConflictDoNothing({
        target: [paperHistoryTable.userId, paperHistoryTable.id],
      })
      .returning({ id: paperHistoryTable.id });
    paperImported = result.length;
  }

  if (importTrades.length) {
    const ids = importTrades.map((trade) => trade.id);
    const knownRows = await tx
      .select({ id: liveTradesTable.id })
      .from(liveTradesTable)
      .where(
        and(
          eq(liveTradesTable.userId, userId),
          inArray(liveTradesTable.id, ids),
        ),
      )
      .for("update");
    const knownIds = new Set(knownRows.map((row) => row.id));
    const newOpenTrades = importTrades.filter(
      (trade) => trade.status === "open" && !knownIds.has(trade.id),
    );
    const existingOpenTrades = await tx
      .select({ id: liveTradesTable.id })
      .from(liveTradesTable)
      .where(
        and(
          eq(liveTradesTable.userId, userId),
          eq(liveTradesTable.status, "open"),
        ),
      )
      .for("update");
    if (
      newOpenTrades.length > 1 ||
      (newOpenTrades.length > 0 && existingOpenTrades.length > 0)
    ) {
      throw new HistoryActionError(
        "Import would create more than one open live trade for this account.",
        409,
      );
    }
    const result = await tx
      .insert(liveTradesTable)
      .values(importTrades.map((trade) => liveTradeValues(userId, trade)))
      .onConflictDoNothing({
        target: [liveTradesTable.userId, liveTradesTable.id],
      })
      .returning({ id: liveTradesTable.id });
    liveImported = result.length;
  }

  if (importEvents.length) {
    const result = await tx
      .insert(liveEventsTable)
      .values(importEvents.map((event) => liveEventValues(userId, event)))
      .onConflictDoNothing({
        target: [liveEventsTable.userId, liveEventsTable.id],
      })
      .returning({ id: liveEventsTable.id });
    eventsImported = result.length;
  }

  return { paperImported, liveImported, eventsImported };
}

router.post("/history/live", async (req, res, next) => {
  try {
    const parsed = SaveLiveActionBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid live action", details: parsed.error.issues });
      return;
    }
    const { trade, event } = parsed.data;
    const userId = res.locals.userId as string;
    await db.transaction((tx) => persistLiveAction(tx, userId, trade, event));
    res.json(SaveLiveActionResponse.parse({ saved: true }));
  } catch (error) {
    if (error instanceof HistoryActionError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "A live trade is already open for this account." });
      return;
    }
    next(error);
  }
});

router.post("/history/import", async (req, res, next) => {
  try {
    const parsed = ImportHistoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid history import", details: parsed.error.issues });
      return;
    }
    const { paper, liveTrades, liveEvents } = parsed.data;
    const userId = res.locals.userId as string;
    const counts = await db.transaction((tx) =>
      importHistoryData(tx, userId, paper, liveTrades, liveEvents),
    );

    res.json(ImportHistoryResponse.parse(counts));
  } catch (error) {
    if (error instanceof HistoryActionError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (isUniqueViolation(error)) {
      res.status(409).json({
        error: "Import conflicts with the account's existing open live trade.",
      });
      return;
    }
    next(error);
  }
});

export default router;