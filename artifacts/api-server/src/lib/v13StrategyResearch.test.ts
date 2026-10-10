import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, v13StrategyParameterSetTable } from "@workspace/db";
import {
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
  V13_RESEARCH_PRESETS,
  assertV13HistoricalTuningCandidate,
  canonicalV13StrategyParameters,
  evaluateV13Strategy,
  type V13StrategyParameters,
} from "@workspace/v13-strategy";
import {
  V13_BUILT_IN_RESEARCH_CHALLENGERS,
  activateV13ResearchShadow,
  buildV13ShadowOpportunity,
  createV13ResearchDraft,
  ensureV13BuiltInResearchChallengers,
  hashV13StrategyParameters,
  V13_BALANCED_RESEARCH_SIZING_PROFILE,
  rankV13ResearchSummaries,
  replayV13CounterfactualMarket,
  retireV13ResearchParameterSet,
  simulateV13ResearchSizing,
  summarizeV13CounterfactualReplays,
  summarizeV13ResearchOutcomes,
  v13ResearchSizingMultiplier,
} from "./v13StrategyResearch";

const source = (offer: number, separation: number) => ({
  id: "paper-source",
  evaluatedAt: new Date("2026-10-07T12:00:00.000Z"),
  marketTicker: "KXBTC15M-TEST",
  btcPrice: 100_000 + separation,
  target: 100_000,
  signedBuffer: separation,
  velocity: 40,
  upBid: Math.max(0.01, offer - 0.01),
  upOffer: offer,
  downBid: 0.4,
  downOffer: 0.41,
  secondsRemaining: 600,
  feedFreshness: "current",
  freshCross: true,
  crossingKey: "KXBTC15M-TEST:first",
  evaluationSource: "paper",
});

const previous = {
  signedBuffer: -1,
  crossingKey: null,
};

function shadowSet(
  id: string,
  parameters: V13StrategyParameters,
  overrides: Partial<{
    state: string;
    classifierVersion: string;
    parameterHash: string;
    executionAuthority: boolean;
  }> = {},
) {
  return {
    id,
    state: overrides.state ?? "SHADOW",
    classifierVersion: overrides.classifierVersion ?? "V1.3",
    parameterHash: overrides.parameterHash ?? hashV13StrategyParameters(parameters),
    executionAuthority: overrides.executionAuthority ?? false,
    ...parameters,
  };
}

test("champion parameter identity is immutable and hash-stable", () => {
  assert.equal(Object.isFrozen(V13_CHAMPION_PARAMETER_SET), true);
  assert.equal(Object.isFrozen(V13_CHAMPION_PARAMETER_SET.parameters), true);
  const actual = createHash("sha256")
    .update(canonicalV13StrategyParameters(V13_CHAMPION_PARAMETER_SET.parameters))
    .digest("hex");
  assert.equal(actual, V13_CHAMPION_PARAMETER_HASH);
  assert.equal(hashV13StrategyParameters(V13_CHAMPION_PARAMETER_SET.parameters), actual);
});

test("C52/53 launch champion rejects 55c Scout while legacy 60/68 accepts in shadow", () => {
  const observation = source(0.55, 10);
  const champion = evaluateV13Strategy({
    marketTicker: observation.marketTicker,
    btcPrice: observation.btcPrice,
    target: observation.target,
    previousBuffer: previous.signedBuffer,
    velocity: observation.velocity,
    upOffer: observation.upOffer,
    downOffer: observation.downOffer,
    freshness: "current",
    position: null,
  });
  assert.equal(champion.signal, "PASS");
  assert.equal(champion.qualifyingTrigger, false);

  const legacy = buildV13ShadowOpportunity(
    observation,
    previous,
    shadowSet("legacy-60-68", V13_RESEARCH_PRESETS.LEGACY_60_68),
  );
  assert.equal(legacy.signal, "SCOUT");
  assert.equal(legacy.wouldEnter, true);
});

test("bounded adaptive presets only tighten the C52/53 launch champion", () => {
  for (const parameters of [
    V13_RESEARCH_PRESETS.C52_CONFIRM53,
    V13_RESEARCH_PRESETS.C51_CONFIRM53,
    V13_RESEARCH_PRESETS.C50,
    V13_RESEARCH_PRESETS.C50_CONFIRM22,
  ]) {
    assert.equal(assertV13HistoricalTuningCandidate(parameters), parameters);
    assert.equal(parameters.wrongSideRecrossSeparation, 8);
    assert.equal(parameters.exitOnMomentumInvalidation, true);
  }
  assert.throws(
    () => assertV13HistoricalTuningCandidate(V13_RESEARCH_PRESETS.C57_CONFIRM56),
    /outside the bounded entry-tuning envelope/,
  );
  assert.throws(
    () => assertV13HistoricalTuningCandidate(V13_RESEARCH_PRESETS.LEGACY_60_68),
    /outside the bounded entry-tuning envelope/,
  );
  assert.throws(() => assertV13HistoricalTuningCandidate({
    ...V13_RESEARCH_PRESETS.C52_CONFIRM53,
    wrongSideRecrossSeparation: 10,
  }), /outside the bounded entry-tuning envelope/);
});

test("C52/53 launch champion enforces 52c Scout and 53c Confirm ceilings", () => {
  const classify = (offer: number, separation: number) => {
    const observation = source(offer, separation);
    return evaluateV13Strategy({
      marketTicker: observation.marketTicker,
      btcPrice: observation.btcPrice,
      target: observation.target,
      previousBuffer: previous.signedBuffer,
      velocity: observation.velocity,
      upOffer: observation.upOffer,
      downOffer: observation.downOffer,
      freshness: "current",
      position: null,
    });
  };

  assert.equal(classify(0.53, 10).qualifyingTrigger, false);
  assert.equal(classify(0.52, 10).signal, "SCOUT");
  assert.equal(classify(0.54, 21).qualifyingTrigger, false);
  assert.equal(classify(0.53, 21).signal, "CONFIRM");
});

test("C50 accepts the same first-cross Scout at 49c", () => {
  const challenger = buildV13ShadowOpportunity(
    source(0.49, 10),
    previous,
    shadowSet("c50", V13_RESEARCH_PRESETS.C50),
  );
  assert.equal(challenger.signal, "SCOUT");
  assert.equal(challenger.wouldEnter, true);
  assert.equal(challenger.entryOffer, 0.49);
});

test("Confirm-22 challenger rejects a $21 separation champion Confirm", () => {
  const observation = source(0.40, 21);
  const champion = evaluateV13Strategy({
    marketTicker: observation.marketTicker,
    btcPrice: observation.btcPrice,
    target: observation.target,
    previousBuffer: previous.signedBuffer,
    velocity: observation.velocity,
    upOffer: observation.upOffer,
    downOffer: observation.downOffer,
    freshness: "current",
    position: null,
  });
  assert.equal(champion.signal, "CONFIRM");
  assert.equal(champion.qualifyingTrigger, true);

  const challenger = buildV13ShadowOpportunity(
    observation,
    previous,
    shadowSet("c50-confirm22", V13_RESEARCH_PRESETS.C50_CONFIRM22),
  );
  assert.equal(challenger.wouldEnter, false);
});

test("later recrosses never manufacture another challenger entry", () => {
  const challenger = buildV13ShadowOpportunity(
    source(0.40, 10),
    { signedBuffer: -1, crossingKey: "KXBTC15M-TEST:first" },
    shadowSet("c50", V13_RESEARCH_PRESETS.C50),
  );
  assert.equal(challenger.qualifyingTrigger, true);
  assert.equal(challenger.firstCross, false);
  assert.equal(challenger.wouldEnter, false);
});

test("research parameter hash mismatch fails closed", () => {
  assert.throws(() => buildV13ShadowOpportunity(
    source(0.40, 10),
    previous,
    shadowSet("c50", V13_RESEARCH_PRESETS.C50, {
      parameterHash: "0".repeat(64),
    }),
  ), /hash mismatch/);
});

test("research rows claiming execution authority are refused", () => {
  assert.throws(() => buildV13ShadowOpportunity(
    source(0.40, 10),
    previous,
    shadowSet("c50", V13_RESEARCH_PRESETS.C50, {
      executionAuthority: true,
    }),
  ), /zero-authority shadow set/);
});




test("built-in adaptive shortlist seeds only zero-authority shadow rows", async () => {
  const seeded = await ensureV13BuiltInResearchChallengers("ci-adaptive-research");
  assert.equal(seeded.total, V13_BUILT_IN_RESEARCH_CHALLENGERS.length);
  assert.equal(seeded.active, V13_BUILT_IN_RESEARCH_CHALLENGERS.length);

  for (const candidate of V13_BUILT_IN_RESEARCH_CHALLENGERS) {
    const [row] = await db.select().from(v13StrategyParameterSetTable)
      .where(eq(v13StrategyParameterSetTable.id, candidate.id)).limit(1);
    assert.ok(row);
    assert.equal(row?.state, "SHADOW");
    assert.equal(row?.executionAuthority, false);
    assert.equal(row?.parameterHash, hashV13StrategyParameters(candidate.parameters));
    assert.notEqual(row?.parameterHash, V13_CHAMPION_PARAMETER_HASH);
    await db.delete(v13StrategyParameterSetTable)
      .where(eq(v13StrategyParameterSetTable.id, candidate.id));
  }
});

test("research lifecycle is versioned, audited, and permanently zero-authority", async () => {
  const version = 9_000_000 + process.pid;
  const id = "research-c50-test-" + process.pid;
  const draft = await createV13ResearchDraft({
    id,
    version,
    label: "CI C50 research draft",
    parameters: { ...V13_RESEARCH_PRESETS.C50 },
    createdBy: "ci-test",
  });
  assert.equal(draft.state, "DRAFT");
  assert.equal(draft.executionAuthority, false);
  assert.equal(draft.parameterHash, hashV13StrategyParameters(V13_RESEARCH_PRESETS.C50));

  const active = await activateV13ResearchShadow(id, "ci-activator");
  assert.equal(active.state, "SHADOW");
  assert.equal(active.executionAuthority, false);
  assert.equal(active.activatedBy, "ci-activator");
  assert.ok(active.activatedAt instanceof Date);

  const retired = await retireV13ResearchParameterSet(id);
  assert.equal(retired.state, "RETIRED");
  assert.equal(retired.executionAuthority, false);

  await db.delete(v13StrategyParameterSetTable)
    .where(eq(v13StrategyParameterSetTable.id, id));
});

test("prospective outcome summary requires time and sample before review", () => {
  const activatedAt = new Date("2026-10-01T00:00:00.000Z");
  const now = new Date("2026-10-09T00:00:00.000Z");
  const champion = Array.from({ length: 60 }, (_, index) => ({
    pnl: index % 4 === 0 ? -0.05 : 1.00,
    stake: 5,
    enteredAt: new Date(activatedAt.getTime() + index * 60_000),
  }));
  const candidate = champion.filter((_, index) => index % 10 !== 0);
  const summary = summarizeV13ResearchOutcomes(
    "candidate",
    activatedAt,
    now,
    champion,
    candidate,
  );
  assert.equal(summary.championTrades, 60);
  assert.equal(summary.candidateTrades, 54);
  assert.equal(summary.avoidedTrades, 6);
  assert.equal(summary.reviewEligible, true);
  assert.ok((summary.candidateHitRate ?? 0) > (summary.championHitRate ?? 0));

  const early = summarizeV13ResearchOutcomes(
    "candidate",
    activatedAt,
    new Date("2026-10-05T00:00:00.000Z"),
    champion,
    candidate,
  );
  assert.equal(early.reviewEligible, false);
});

test("advisory ranker never promotes before the evidence gate", () => {
  const baseSummary = {
    parameterSetId: "a",
    activatedAt: "2026-10-01T00:00:00.000Z",
    elapsedDays: 8,
    championTrades: 60,
    candidateTrades: 54,
    avoidedTrades: 6,
    championPnl: 100,
    candidatePnl: 101,
    pnlRetention: 1.01,
    championHitRate: 0.75,
    candidateHitRate: 0.80,
    championAveragePnl: 1.67,
    candidateAveragePnl: 1.87,
    reviewEligible: true,
  };
  const collecting = rankV13ResearchSummaries([
    { ...baseSummary, parameterSetId: "too-early", reviewEligible: false },
  ]);
  assert.equal(collecting.status, "COLLECTING");
  assert.equal(collecting.leader, null);

  const ready = rankV13ResearchSummaries([
    { ...baseSummary, parameterSetId: "lower", pnlRetention: 0.99 },
    { ...baseSummary, parameterSetId: "leader", pnlRetention: 1.01 },
  ]);
  assert.equal(ready.status, "REVIEW_READY");
  assert.equal(ready.leader?.parameterSetId, "leader");
});

test("counterfactual replay uses executable bid and can measure rejected champion opportunities", () => {
  const observations = [
    {
      id: "r0",
      evaluatedAt: new Date("2026-10-07T12:00:00.000Z"),
      marketTicker: "KXBTC15M-REPLAY",
      btcPrice: 99_999,
      target: 100_000,
      signedBuffer: -1,
      velocity: -5,
      upBid: 0.44,
      upOffer: 0.45,
      downBid: 0.54,
      downOffer: 0.55,
      feedFreshness: "current" as const,
    },
    {
      id: "r1",
      evaluatedAt: new Date("2026-10-07T12:00:01.000Z"),
      marketTicker: "KXBTC15M-REPLAY",
      btcPrice: 100_010,
      target: 100_000,
      signedBuffer: 10,
      velocity: 20,
      upBid: 0.54,
      upOffer: 0.55,
      downBid: 0.44,
      downOffer: 0.45,
      feedFreshness: "current" as const,
    },
    {
      id: "r2",
      evaluatedAt: new Date("2026-10-07T12:00:02.000Z"),
      marketTicker: "KXBTC15M-REPLAY",
      btcPrice: 100_009,
      target: 100_000,
      signedBuffer: 9,
      velocity: -1,
      upBid: 0.50,
      upOffer: 0.90,
      downBid: 0.09,
      downOffer: 0.10,
      feedFreshness: "current" as const,
    },
  ];

  const legacy = replayV13CounterfactualMarket(
    observations,
    V13_RESEARCH_PRESETS.LEGACY_60_68,
    5,
  );
  assert.equal(legacy.status, "CLOSED");
  if (legacy.status === "CLOSED") {
    assert.equal(legacy.trigger, "SCOUT");
    assert.equal(legacy.entryOffer, 0.55);
    assert.equal(legacy.exitBid, 0.50);
    assert.equal(legacy.contracts, 9);
    assert.ok(Math.abs(legacy.pnl - (-0.45)) < 1e-12);
    assert.equal(legacy.closeReason, "Momentum invalidated");
  }

  const champion = replayV13CounterfactualMarket(
    observations,
    V13_CHAMPION_PARAMETER_SET.parameters,
    5,
  );
  assert.equal(champion.status, "NO_ENTRY");
});

test("counterfactual replay refuses to invent an exit when no executable exit evidence exists", () => {
  const observations = [
    {
      id: "u0",
      evaluatedAt: new Date("2026-10-07T12:00:00.000Z"),
      marketTicker: "KXBTC15M-UNRESOLVED",
      btcPrice: 99_999,
      target: 100_000,
      signedBuffer: -1,
      velocity: -5,
      upBid: 0.39,
      upOffer: 0.40,
      downBid: 0.59,
      downOffer: 0.60,
      feedFreshness: "current" as const,
    },
    {
      id: "u1",
      evaluatedAt: new Date("2026-10-07T12:00:01.000Z"),
      marketTicker: "KXBTC15M-UNRESOLVED",
      btcPrice: 100_010,
      target: 100_000,
      signedBuffer: 10,
      velocity: 20,
      upBid: 0.39,
      upOffer: 0.40,
      downBid: 0.59,
      downOffer: 0.60,
      feedFreshness: "current" as const,
    },
    {
      id: "u2",
      evaluatedAt: new Date("2026-10-07T12:00:02.000Z"),
      marketTicker: "KXBTC15M-UNRESOLVED",
      btcPrice: 100_009,
      target: 100_000,
      signedBuffer: 9,
      velocity: -1,
      upBid: null,
      upOffer: 0.80,
      downBid: 0.19,
      downOffer: 0.20,
      feedFreshness: "current" as const,
    },
  ];

  const replay = replayV13CounterfactualMarket(
    observations,
    V13_CHAMPION_PARAMETER_SET.parameters,
    5,
  );
  assert.equal(replay.status, "UNRESOLVED");
});

test("counterfactual replay summary keeps unresolved markets out of hit-rate and PnL", () => {
  const hash = V13_CHAMPION_PARAMETER_HASH;
  const summary = summarizeV13CounterfactualReplays([
    { status: "NO_ENTRY", marketTicker: "A", parameterHash: hash },
    {
      status: "UNRESOLVED",
      marketTicker: "B",
      parameterHash: hash,
      trigger: "SCOUT",
      direction: "UP",
      entryAt: new Date("2026-10-07T12:00:00Z"),
      entryOffer: 0.40,
      contracts: 12,
      entryCost: 4.8,
    },
    {
      status: "CLOSED",
      marketTicker: "C",
      parameterHash: hash,
      trigger: "CONFIRM",
      direction: "DOWN",
      entryAt: new Date("2026-10-07T12:00:00Z"),
      exitAt: new Date("2026-10-07T12:00:10Z"),
      entryOffer: 0.40,
      exitBid: 0.50,
      contracts: 12,
      entryCost: 4.8,
      payout: 6,
      pnl: 1.2,
      closeReason: "Momentum invalidated",
    },
  ]);
  assert.equal(summary.markets, 3);
  assert.equal(summary.entries, 2);
  assert.equal(summary.closed, 1);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.positive, 1);
  assert.equal(summary.hitRate, 1);
  assert.equal(summary.pnl, 1.2);
});

test("balanced sizing profile is research-only and rewards historically stronger quality buckets", () => {
  assert.equal(v13ResearchSizingMultiplier("SCOUT", 0.40), 1.25);
  assert.equal(v13ResearchSizingMultiplier("CONFIRM", 0.40), 1.25);
  assert.equal(v13ResearchSizingMultiplier("CONFIRM", 0.50), 1.00);
  assert.equal(v13ResearchSizingMultiplier("SCOUT", 0.50), 0.75);
  assert.equal(V13_BALANCED_RESEARCH_SIZING_PROFILE.maxMultiplier, 1.25);

  const summary = simulateV13ResearchSizing([
    { pnl: 4, stake: 5, trigger: "SCOUT", entryOffer: 0.30 },
    { pnl: 2, stake: 5, trigger: "CONFIRM", entryOffer: 0.45 },
    { pnl: -0.10, stake: 5, trigger: "SCOUT", entryOffer: 0.50 },
  ]);
  assert.equal(summary.trades, 3);
  assert.equal(summary.baselineStake, 15);
  assert.equal(summary.weightedStake, 15);
  assert.equal(summary.baselinePnl, 5.9);
  assert.equal(summary.weightedPnl, 6.93);
  assert.ok((summary.weightedReturnOnStake ?? 0) >
    (summary.baselineReturnOnStake ?? 0));
});

test("database refuses execution authority on a research parameter row", async () => {
  const id = "research-authority-reject-" + process.pid;
  const parameters = { ...V13_RESEARCH_PRESETS.C50 };
  await assert.rejects(
    db.insert(v13StrategyParameterSetTable).values({
      id,
      version: 9_100_000 + process.pid,
      label: "must fail",
      state: "DRAFT",
      classifierVersion: "V1.3",
      ...parameters,
      parameterHash: hashV13StrategyParameters(parameters),
      executionAuthority: true,
      createdBy: "ci-test",
    }),
  );
});

after(async () => {
  await pool.end();
});
