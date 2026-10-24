import { createHash } from "node:crypto";
import {assessNearExpiryCapShadow, NEAR_EXPIRY_CAP_RESEARCH_ID, NEAR_EXPIRY_CAP_RESEARCH_VERSION} from "./v13NearExpiryCapShadow";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import {
  db,
  forwardTestEvaluationTable,
  forwardTestPositionTable,
  v13StrategyParameterSetTable,
  v13StrategyShadowEvaluationTable,
  type V13StrategyParameterSetRow,
} from "@workspace/db";
import {
  V13_RESEARCH_PRESETS,
  V13_ENTRY_POLICY_VERSION, V13_LEGACY_ENTRY_POLICY,
  V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET,
  assertV13StrategyParameters,
  canonicalV13StrategyParameters,
  evaluateV13StrategyWithParameters,
  type V13StrategyParameters,
} from "@workspace/v13-strategy";

export type V13ShadowOpportunitySource = {
  id: string;
  evaluatedAt: Date;
  marketTicker: string;
  btcPrice: number;
  target: number;
  signedBuffer: number;
  velocity: number | null;
  upBid: number | null;
  upOffer: number | null;
  downBid: number | null;
  downOffer: number | null;
  secondsRemaining: number | null;
  feedFreshness: string;
  freshCross: boolean;
  crossingKey: string | null;
  evaluationSource: string;
  entryPolicyVersion?: string | null;
  qualifyingTrigger?: boolean;
  strategyParameterSetId?: string | null;
  strategyParameterHash?: string | null;
};

export type V13ShadowOpportunityPrevious = {
  signedBuffer: number;
  crossingKey: string | null;
  crossingConsumed?: boolean;
} | null;

export type V13ShadowOpportunity = {
  parameterSetId: string;
  parameterHash: string;
  signal: "PASS" | "WATCH" | "SCOUT" | "CONFIRM" | "EXIT";
  direction: "UP" | "DOWN" | "NONE";
  signedBuffer: number;
  absoluteBuffer: number;
  firstCross: boolean;
  qualifyingTrigger: boolean;
  wouldEnter: boolean;
  entryOffer: number | null;
  reason: string;
};

export function parametersFromResearchRow(
  row: Pick<
    V13StrategyParameterSetRow,
    | "scoutMinSeparation"
    | "scoutMaxSeparation"
    | "confirmMinSeparation"
    | "scoutMaxOffer"
    | "confirmMaxOffer"
    | "wrongSideRecrossSeparation"
    | "exitOnMomentumInvalidation"
  >,
): V13StrategyParameters {
  return {
    scoutMinSeparation: row.scoutMinSeparation,
    scoutMaxSeparation: row.scoutMaxSeparation,
    confirmMinSeparation: row.confirmMinSeparation,
    scoutMaxOffer: row.scoutMaxOffer,
    confirmMaxOffer: row.confirmMaxOffer,
    wrongSideRecrossSeparation: row.wrongSideRecrossSeparation,
    exitOnMomentumInvalidation: row.exitOnMomentumInvalidation,
  };
}

export function hashV13StrategyParameters(parameters: V13StrategyParameters): string {
  return createHash("sha256")
    .update(canonicalV13StrategyParameters(parameters))
    .digest("hex");
}


export type CreateV13ResearchDraftInput = {
  id: string;
  version: number;
  label: string;
  supersedesParameterSetId?: string | null;
  parameters: V13StrategyParameters;
  createdBy: string;
};

function requireAuditText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`V13 research ${field} is required`);
  return normalized;
}

/**
 * Create a new immutable-by-convention research version. There is deliberately
 * no "edit active parameters" service: tuning creates a new row that may point
 * at the parameter set it supersedes.
 */
export async function createV13ResearchDraft(
  input: CreateV13ResearchDraftInput,
): Promise<V13StrategyParameterSetRow> {
  const id = requireAuditText(input.id, "id");
  const label = requireAuditText(input.label, "label");
  const createdBy = requireAuditText(input.createdBy, "createdBy");
  if (id === "v13-champion-1" || id === "v13-champion-2-c52-confirm53") {
    throw new Error("The champion parameter-set id is reserved");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(id)) {
    throw new Error("V13 research id contains unsupported characters");
  }
  if (!Number.isSafeInteger(input.version) || input.version <= 0) {
    throw new Error("V13 research version must be a positive integer");
  }
  const parameters = parametersFromResearchRow(input.parameters);
  const parameterHash = hashV13StrategyParameters(parameters);
  const [created] = await db.insert(v13StrategyParameterSetTable).values({
    id,
    version: input.version,
    supersedesParameterSetId: input.supersedesParameterSetId ?? null,
    label,
    state: "DRAFT",
    classifierVersion: "V1.3",
    ...parameters,
    parameterHash,
    executionAuthority: false,
    createdBy,
    activatedBy: null,
    activatedAt: null,
  }).returning();
  if (!created) throw new Error("V13 research draft was not created");
  return created;
}

export async function activateV13ResearchShadow(
  id: string,
  activatedBy: string,
  now = new Date(),
): Promise<V13StrategyParameterSetRow> {
  const actor = requireAuditText(activatedBy, "activatedBy");
  const [current] = await db.select().from(v13StrategyParameterSetTable)
    .where(eq(v13StrategyParameterSetTable.id, id)).limit(1);
  if (!current || current.state !== "DRAFT" || current.executionAuthority !== false) {
    throw new Error("V13 research parameter set is not an activatable draft");
  }
  const expectedHash = hashV13StrategyParameters(parametersFromResearchRow(current));
  if (current.parameterHash !== expectedHash) {
    throw new Error("V13 research parameter hash mismatch");
  }
  const [activated] = await db.update(v13StrategyParameterSetTable).set({
    state: "SHADOW",
    activatedBy: actor,
    activatedAt: now,
  }).where(and(
    eq(v13StrategyParameterSetTable.id, id),
    eq(v13StrategyParameterSetTable.state, "DRAFT"),
    eq(v13StrategyParameterSetTable.executionAuthority, false),
    eq(v13StrategyParameterSetTable.parameterHash, expectedHash),
  )).returning();
  if (!activated) throw new Error("V13 research draft changed before activation");
  return activated;
}

export const V13_BUILT_IN_RESEARCH_CHALLENGERS = Object.freeze([
  {
    id: "v13-research-c51-confirm53",
    version: 1_300_002,
    label: "C51/53 efficiency challenger",
    parameters: V13_RESEARCH_PRESETS.C51_CONFIRM53,
  },
  {
    id: "v13-research-c50",
    version: 1_300_004,
    label: "C50 strict benchmark",
    parameters: V13_RESEARCH_PRESETS.C50,
  },
  {
    id: "v13-research-c50-confirm22",
    version: 1_300_005,
    label: "C50/Confirm22 strict challenger",
    parameters: V13_RESEARCH_PRESETS.C50_CONFIRM22,
  },
  {
    // Strict prospective entry subset of the PINNED champion. Unlike the
    // price/separation candidates, this adds a 30s expiry and fee-inclusive
    // 20-contract research filter. Quantity is a PROXY, not a simulated fill.
    id: NEAR_EXPIRY_CAP_RESEARCH_ID,
    version: NEAR_EXPIRY_CAP_RESEARCH_VERSION,
    label: "Min 30s / max 20 whole contracts — PAPER SHADOW ONLY",
    parameters: V13_CHAMPION_PARAMETER_SET.parameters,
  },
]);

/**
 * Seed the audited strict-subset shortlist directly into zero-authority SHADOW mode.
 * Broader historical references such as legacy 60/68 and C57/56 are intentionally
 * excluded because the C52/53 champion does not create paper outcomes for entries
 * that only those broader rules would take.
 * Existing rows are never rewritten or reactivated. Research startup failure
 * must be caught by the worker and must never block champion processing.
 */
export async function ensureV13BuiltInResearchChallengers(
  actor = "system:v13-adaptive-research",
  now = new Date(),
): Promise<{ active: number; total: number }> {
  const auditActor = requireAuditText(actor, "actor");
  let active = 0;
  for (const candidate of V13_BUILT_IN_RESEARCH_CHALLENGERS) {
    const parameterHash = hashV13StrategyParameters(candidate.parameters);
    await db.insert(v13StrategyParameterSetTable).values({
      id: candidate.id,
      version: candidate.version,
      supersedesParameterSetId: null,
      label: candidate.label,
      state: "SHADOW",
      classifierVersion: "V1.3",
      ...candidate.parameters,
      parameterHash,
      executionAuthority: false,
      createdBy: auditActor,
      activatedBy: auditActor,
      activatedAt: now,
    }).onConflictDoNothing();

    const [row] = await db.select().from(v13StrategyParameterSetTable)
      .where(eq(v13StrategyParameterSetTable.id, candidate.id)).limit(1);
    if (!row) {
      throw new Error(`Built-in V13 research challenger was not persisted: ${candidate.id}`);
    }
    if (
      row.parameterHash !== parameterHash ||
      row.executionAuthority !== false ||
      row.classifierVersion !== "V1.3"
    ) {
      throw new Error(`Built-in V13 research challenger identity mismatch: ${candidate.id}`);
    }
    if (row.state === "SHADOW") active += 1;
  }
  return { active, total: V13_BUILT_IN_RESEARCH_CHALLENGERS.length };
}

export async function retireV13ResearchParameterSet(
  id: string,
): Promise<V13StrategyParameterSetRow> {
  const [current] = await db.select().from(v13StrategyParameterSetTable)
    .where(eq(v13StrategyParameterSetTable.id, id)).limit(1);
  if (!current || current.executionAuthority !== false) {
    throw new Error("V13 research parameter set is unavailable or invalid");
  }
  if (current.state === "RETIRED") return current;
  const [retired] = await db.update(v13StrategyParameterSetTable).set({
    state: "RETIRED",
  }).where(and(
    eq(v13StrategyParameterSetTable.id, id),
    eq(v13StrategyParameterSetTable.executionAuthority, false),
  )).returning();
  if (!retired) throw new Error("V13 research parameter set changed before retirement");
  return retired;
}

export function buildV13ShadowOpportunity(
  source: V13ShadowOpportunitySource,
  previous: V13ShadowOpportunityPrevious,
  parameterSet: Pick<
    V13StrategyParameterSetRow,
    | "id"
    | "state"
    | "classifierVersion"
    | "parameterHash"
    | "executionAuthority"
    | "scoutMinSeparation"
    | "scoutMaxSeparation"
    | "confirmMinSeparation"
    | "scoutMaxOffer"
    | "confirmMaxOffer"
    | "wrongSideRecrossSeparation"
    | "exitOnMomentumInvalidation"
  >,
): V13ShadowOpportunity {
  if (source.evaluationSource !== "paper" || source.feedFreshness !== "current") {
    throw new Error("V13 shadow evaluation requires a current paper observation");
  }
  if (
    parameterSet.state !== "SHADOW" ||
    parameterSet.classifierVersion !== "V1.3" ||
    parameterSet.executionAuthority !== false
  ) {
    throw new Error("V13 research parameter set is not an active zero-authority shadow set");
  }

  const parameters = parametersFromResearchRow(parameterSet);
  const expectedHash = hashV13StrategyParameters(parameters);
  if (parameterSet.parameterHash !== expectedHash) {
    throw new Error("V13 research parameter hash mismatch");
  }

  const decision = evaluateV13StrategyWithParameters({
    marketTicker: source.marketTicker,
    btcPrice: source.btcPrice,
    target: source.target,
    previousBuffer: previous?.signedBuffer ?? null,
    velocity: source.velocity,
    upOffer: source.upOffer,
    downOffer: source.downOffer,
    freshness: "current",
    // Entry challengers are isolated from position state. The champion exit
    // logic stays frozen while entry filters are compared prospectively.
    position: null,
  }, parameters);

  if (decision.buffer === null || decision.separation === null) {
    throw new Error("V13 shadow classifier did not produce a signed buffer");
  }

  const firstCross = Boolean(source.freshCross && previous?.crossingKey == null);
  // v2 shadows remain subsets of a qualified champion paper entry, never
  // independent authority. Previous consumption survives close/restart.
  const policy = source.entryPolicyVersion ?? V13_LEGACY_ENTRY_POLICY;
  const entryAvailable = policy === V13_ENTRY_POLICY_VERSION
    ? source.qualifyingTrigger === true && previous?.crossingConsumed === false &&
      source.strategyParameterSetId === V13_CHAMPION_PARAMETER_SET.id &&
      source.strategyParameterHash === V13_CHAMPION_PARAMETER_HASH
    : policy === V13_LEGACY_ENTRY_POLICY && firstCross;
  const baseWouldEnter = Boolean(
    entryAvailable && source.freshCross && decision.freshCross &&
    source.secondsRemaining !== null && source.secondsRemaining > 0 &&
    source.upOffer !== null && source.upOffer > 0 && source.upOffer <= 1 &&
    source.downOffer !== null && source.downOffer > 0 && source.downOffer <= 1 &&
    decision.qualifyingTrigger &&
    (decision.signal === "SCOUT" || decision.signal === "CONFIRM") &&
    decision.entrySideOffer !== null &&
    (decision.direction === "UP" || decision.direction === "DOWN"),
  );
  const nearExpiryOverlay =
    parameterSet.id === NEAR_EXPIRY_CAP_RESEARCH_ID && baseWouldEnter
      ? assessNearExpiryCapShadow(source.secondsRemaining,decision.entrySideOffer)
      : null;
  const wouldEnter=baseWouldEnter && (nearExpiryOverlay?.wouldEnter??true);

  return {
    parameterSetId: parameterSet.id,
    parameterHash: expectedHash,
    signal: decision.signal,
    direction: decision.direction,
    signedBuffer: decision.buffer,
    absoluteBuffer: decision.separation,
    firstCross,
    qualifyingTrigger: decision.qualifyingTrigger,
    wouldEnter,
    entryOffer: wouldEnter ? decision.entrySideOffer : null,
    // Capped quantity is an explicitly named RESEARCH proxy carried in the
    // immutable shadow receipt. NEVER book paper or exchange fills from it.
    reason: nearExpiryOverlay
      ? [decision.reason,"PAPER_SHADOW_NO_EXECUTION",nearExpiryOverlay.reason,
         "max20", "min30s",
         "illustrative_qty="+nearExpiryOverlay.modeledContracts,
         "illustrative_entry_fee_cents="+nearExpiryOverlay.illustrativeEntryFeeCents
        ].join("|")
      : decision.reason,
  };
}

/**
 * Persist active research-only challenger classifications for one already-
 * committed champion paper observation.
 *
 * This runs outside the champion transaction. Callers must catch errors; a
 * research failure must never alter champion execution authority.
 */
export async function recordV13ShadowOpportunities(
  sourceEvaluationId: string,
): Promise<{ recorded: number; activeParameterSets: number }> {
  const [source] = await db.select().from(forwardTestEvaluationTable)
    .where(eq(forwardTestEvaluationTable.id, sourceEvaluationId)).limit(1);
  if (!source || source.evaluationSource !== "paper" || source.feedFreshness !== "current") {
    return { recorded: 0, activeParameterSets: 0 };
  }

  const [previous] = await db.select().from(forwardTestEvaluationTable)
    .where(and(
      eq(forwardTestEvaluationTable.marketTicker, source.marketTicker),
      eq(forwardTestEvaluationTable.evaluationSource, "paper"),
      lt(forwardTestEvaluationTable.evaluatedAt, source.evaluatedAt),
    ))
    .orderBy(
      desc(forwardTestEvaluationTable.evaluatedAt),
      desc(forwardTestEvaluationTable.id),
    )
    .limit(1);

  const parameterSets = await db.select().from(v13StrategyParameterSetTable)
    .where(and(
      eq(v13StrategyParameterSetTable.state, "SHADOW"),
      eq(v13StrategyParameterSetTable.executionAuthority, false),
    ));

  let recorded = 0;
  for (const parameterSet of parameterSets) {
    const opportunity = buildV13ShadowOpportunity(
      {
        id: source.id,
        evaluatedAt: source.evaluatedAt,
        marketTicker: source.marketTicker,
        btcPrice: source.btcPrice,
        target: source.target,
        signedBuffer: source.signedBuffer,
        velocity: source.velocity,
        upBid: source.upBid,
        upOffer: source.upOffer,
        downBid: source.downBid,
        downOffer: source.downOffer,
        secondsRemaining: source.secondsRemaining,
        feedFreshness: source.feedFreshness,
        freshCross: source.freshCross,
        crossingKey: source.crossingKey,
        evaluationSource: source.evaluationSource,
        entryPolicyVersion: source.entryPolicyVersion,
        qualifyingTrigger: source.qualifyingTrigger,
        strategyParameterSetId: source.strategyParameterSetId,
        strategyParameterHash: source.strategyParameterHash,
      },
      previous ? {
        signedBuffer: previous.signedBuffer,
        crossingKey: previous.crossingKey,
        crossingConsumed: previous.crossingConsumed,
      } : null,
      parameterSet,
    );

    const id = "shadow-" + createHash("sha256")
      .update([source.id, parameterSet.id, parameterSet.parameterHash].join("\u001f"))
      .digest("hex");

    const inserted = await db.insert(v13StrategyShadowEvaluationTable).values({
      id,
      sourceEvaluationId: source.id,
      parameterSetId: opportunity.parameterSetId,
      parameterHash: opportunity.parameterHash,
      entryPolicyVersion: source.entryPolicyVersion,
      evaluatedAt: source.evaluatedAt,
      marketTicker: source.marketTicker,
      btcPrice: source.btcPrice,
      target: source.target,
      previousBuffer: previous?.signedBuffer ?? null,
      signedBuffer: opportunity.signedBuffer,
      absoluteBuffer: opportunity.absoluteBuffer,
      velocity: source.velocity,
      upBid: source.upBid,
      upOffer: source.upOffer,
      downBid: source.downBid,
      downOffer: source.downOffer,
      secondsRemaining: source.secondsRemaining,
      firstCross: opportunity.firstCross,
      signal: opportunity.signal,
      direction: opportunity.direction,
      qualifyingTrigger: opportunity.qualifyingTrigger,
      wouldEnter: opportunity.wouldEnter,
      entryOffer: opportunity.entryOffer,
      reason: opportunity.reason,
      executionAuthority: false,
    }).onConflictDoNothing().returning({ id: v13StrategyShadowEvaluationTable.id });

    if (inserted.length === 1) recorded += 1;
  }

  return { recorded, activeParameterSets: parameterSets.length };
}


export type V13ResearchPerformanceSummary = {
  parameterSetId: string;
  activatedAt: string;
  elapsedDays: number;
  championTrades: number;
  candidateTrades: number;
  avoidedTrades: number;
  championPnl: number;
  candidatePnl: number;
  pnlRetention: number | null;
  championHitRate: number | null;
  candidateHitRate: number | null;
  championAveragePnl: number | null;
  candidateAveragePnl: number | null;
  reviewEligible: boolean;
};

type ResearchOutcome = {
  pnl: number;
  stake: number;
  enteredAt: Date;
};

const roundResearchMoney = (value: number) => Math.round(value * 100) / 100;

export function summarizeV13ResearchOutcomes(
  parameterSetId: string,
  activatedAt: Date,
  now: Date,
  champion: ResearchOutcome[],
  candidate: ResearchOutcome[],
): V13ResearchPerformanceSummary {
  const finiteRows = (rows: ResearchOutcome[]) => rows.filter((row) =>
    Number.isFinite(row.pnl) && Number.isFinite(row.stake) && row.stake > 0 &&
    row.enteredAt instanceof Date && Number.isFinite(row.enteredAt.getTime()));
  const championRows = finiteRows(champion);
  const candidateRows = finiteRows(candidate);
  const sum = (rows: ResearchOutcome[]) => rows.reduce((total, row) => total + row.pnl, 0);
  const positive = (rows: ResearchOutcome[]) =>
    rows.length ? rows.filter((row) => row.pnl > 0).length / rows.length : null;
  const average = (rows: ResearchOutcome[]) =>
    rows.length ? sum(rows) / rows.length : null;
  const championPnl = sum(championRows);
  const candidatePnl = sum(candidateRows);
  const elapsedMs = Math.max(0, now.getTime() - activatedAt.getTime());
  const elapsedDays = elapsedMs / 86_400_000;

  return {
    parameterSetId,
    activatedAt: activatedAt.toISOString(),
    elapsedDays,
    championTrades: championRows.length,
    candidateTrades: candidateRows.length,
    avoidedTrades: Math.max(0, championRows.length - candidateRows.length),
    championPnl: roundResearchMoney(championPnl),
    candidatePnl: roundResearchMoney(candidatePnl),
    pnlRetention: championPnl > 0 ? candidatePnl / championPnl : null,
    championHitRate: positive(championRows),
    candidateHitRate: positive(candidateRows),
    championAveragePnl: average(championRows),
    candidateAveragePnl: average(candidateRows),
    // Evidence threshold only. It authorizes review, never promotion or trading.
    reviewEligible: elapsedDays >= 7 && candidateRows.length >= 50,
  };
}

/**
 * Compare a zero-authority price-cap challenger with champion paper outcomes
 * over the exact same post-activation period.
 *
 * The exact timestamp/direction/trigger join is intentionally strict. The
 * adaptive lane only tightens champion entry thresholds; V1.3 entries occur
 * on the fresh crossing, so every challenger entry remains an exact subset of
 * champion entry timing and can reuse the matched champion paper outcome.
 */
export async function summarizeV13ShadowCandidatePerformance(
  parameterSetId: string,
  now = new Date(),
): Promise<V13ResearchPerformanceSummary> {
  // The expiry/quantity overlay changes the number of contracts. The generic
  // shadow report reuses champion FULL-SIZE P&L and would materially overstate
  // this candidate. Do not include it in unadjusted leader rankings.
  if(parameterSetId===NEAR_EXPIRY_CAP_RESEARCH_ID)
    throw Error("quantity_capped_shadow_requires_independent_cost_and_depth_replay");
  const [parameterSet] = await db.select().from(v13StrategyParameterSetTable)
    .where(eq(v13StrategyParameterSetTable.id, parameterSetId)).limit(1);
  if (
    !parameterSet ||
    parameterSet.executionAuthority !== false ||
    parameterSet.classifierVersion !== "V1.3" ||
    parameterSet.state !== "SHADOW" ||
    !(parameterSet.activatedAt instanceof Date)
  ) {
    throw new Error("V13 shadow candidate is not active zero-authority research");
  }

  const champion = await db.select({
    pnl: forwardTestPositionTable.pnl,
    stake: forwardTestPositionTable.stake,
    enteredAt: forwardTestPositionTable.enteredAt,
  }).from(forwardTestPositionTable).where(and(
    eq(forwardTestPositionTable.engineId, "v1.3-paper"),
    eq(forwardTestPositionTable.strategyVersion, "V1.3"),
    gte(forwardTestPositionTable.enteredAt, parameterSet.activatedAt),
    inArray(forwardTestPositionTable.status, ["CLOSED", "SETTLED"]),
    isNotNull(forwardTestPositionTable.pnl),
  ));

  const candidate = await db.select({
    pnl: forwardTestPositionTable.pnl,
    stake: forwardTestPositionTable.stake,
    enteredAt: forwardTestPositionTable.enteredAt,
  }).from(v13StrategyShadowEvaluationTable)
    .innerJoin(forwardTestPositionTable, and(
      eq(v13StrategyShadowEvaluationTable.marketTicker,
        forwardTestPositionTable.marketTicker),
      eq(v13StrategyShadowEvaluationTable.direction,
        forwardTestPositionTable.direction),
      eq(v13StrategyShadowEvaluationTable.signal,
        forwardTestPositionTable.triggerType),
      eq(v13StrategyShadowEvaluationTable.evaluatedAt,
        forwardTestPositionTable.enteredAt),
    ))
    .where(and(
      eq(v13StrategyShadowEvaluationTable.parameterSetId, parameterSetId),
      eq(v13StrategyShadowEvaluationTable.parameterHash, parameterSet.parameterHash),
      eq(v13StrategyShadowEvaluationTable.wouldEnter, true),
      eq(v13StrategyShadowEvaluationTable.executionAuthority, false),
      gte(forwardTestPositionTable.enteredAt, parameterSet.activatedAt),
      inArray(forwardTestPositionTable.status, ["CLOSED", "SETTLED"]),
      isNotNull(forwardTestPositionTable.pnl),
    ));

  return summarizeV13ResearchOutcomes(
    parameterSetId,
    parameterSet.activatedAt,
    now,
    champion.map((row) => ({ ...row, pnl: row.pnl! })),
    candidate.map((row) => ({ ...row, pnl: row.pnl! })),
  );
}


export type V13ResearchRecommendation = {
  status: "COLLECTING" | "REVIEW_READY";
  leader: V13ResearchPerformanceSummary | null;
  ranked: V13ResearchPerformanceSummary[];
  reason: string;
};

export function rankV13ResearchSummaries(
  summaries: V13ResearchPerformanceSummary[],
): V13ResearchRecommendation {
  const ranked = [...summaries].sort((a, b) => {
    const aRetention = a.pnlRetention ?? Number.NEGATIVE_INFINITY;
    const bRetention = b.pnlRetention ?? Number.NEGATIVE_INFINITY;
    if (aRetention !== bRetention) return bRetention - aRetention;
    const aHit = a.candidateHitRate ?? Number.NEGATIVE_INFINITY;
    const bHit = b.candidateHitRate ?? Number.NEGATIVE_INFINITY;
    if (aHit !== bHit) return bHit - aHit;
    const aAvg = a.candidateAveragePnl ?? Number.NEGATIVE_INFINITY;
    const bAvg = b.candidateAveragePnl ?? Number.NEGATIVE_INFINITY;
    return bAvg - aAvg;
  });

  const eligible = ranked.filter((summary) => summary.reviewEligible);
  if (!eligible.length) {
    return {
      status: "COLLECTING",
      leader: null,
      ranked,
      reason: "No challenger has reached the 7-day / 50-completed-trade evidence gate",
    };
  }

  return {
    status: "REVIEW_READY",
    leader: eligible[0] ?? null,
    ranked,
    reason: "At least one challenger has enough prospective evidence for human review",
  };
}

export async function getV13AdaptiveResearchRecommendation(
  now = new Date(),
): Promise<V13ResearchRecommendation> {
  const summaries: V13ResearchPerformanceSummary[] = [];
  // Rank live prospective research versions, including autonomous
  // shadow-only candidates. Never rank an unactivated DRAFT or old RETIRED
  // row as current; this API cannot grant any trading authority.
  const candidates=await db.select({id:v13StrategyParameterSetTable.id})
    .from(v13StrategyParameterSetTable).where(and(
      eq(v13StrategyParameterSetTable.state,"SHADOW"),
      eq(v13StrategyParameterSetTable.executionAuthority,false),
    )).orderBy(asc(v13StrategyParameterSetTable.activatedAt)).limit(25);
  for (const candidate of candidates) {
    try {
      summaries.push(await summarizeV13ShadowCandidatePerformance(candidate.id, now));
    } catch {
      // One corrupt, missing or stale candidate cannot promote another;
      // incomplete evidence remains unavailable for this candidate.
    }
  }
  return rankV13ResearchSummaries(summaries);
}


export type V13ReplayObservation = {
  id: string;
  evaluatedAt: Date;
  marketTicker: string;
  btcPrice: number;
  target: number;
  signedBuffer: number;
  velocity: number | null;
  upBid: number | null;
  upOffer: number | null;
  downBid: number | null;
  downOffer: number | null;
  feedFreshness: "current" | "data-error";
};

export type V13CounterfactualReplayResult =
  | {
      status: "NO_ENTRY";
      marketTicker: string;
      parameterHash: string;
    }
  | {
      status: "UNRESOLVED";
      marketTicker: string;
      parameterHash: string;
      trigger: "SCOUT" | "CONFIRM";
      direction: "UP" | "DOWN";
      entryAt: Date;
      entryOffer: number;
      contracts: number;
      entryCost: number;
    }
  | {
      status: "CLOSED";
      marketTicker: string;
      parameterHash: string;
      trigger: "SCOUT" | "CONFIRM";
      direction: "UP" | "DOWN";
      entryAt: Date;
      exitAt: Date;
      entryOffer: number;
      exitBid: number;
      contracts: number;
      entryCost: number;
      payout: number;
      pnl: number;
      closeReason: "Wrong-side recross" | "Momentum invalidated";
    };

export function replayV13CounterfactualMarket(
  rawObservations: V13ReplayObservation[],
  rawParameters: V13StrategyParameters,
  requestedStake = 5,
): V13CounterfactualReplayResult {
  const parameters = assertV13StrategyParameters(rawParameters);
  const parameterHash = hashV13StrategyParameters(parameters);
  const observations = [...rawObservations]
    .filter((row) =>
      row.evaluatedAt instanceof Date &&
      Number.isFinite(row.evaluatedAt.getTime()) &&
      row.marketTicker &&
      Number.isFinite(row.btcPrice) &&
      Number.isFinite(row.target))
    .sort((a, b) => a.evaluatedAt.getTime() - b.evaluatedAt.getTime());

  if (!observations.length || !Number.isFinite(requestedStake) || requestedStake <= 0) {
    return {
      status: "NO_ENTRY",
      marketTicker: observations[0]?.marketTicker ?? "",
      parameterHash,
    };
  }

  let previousBuffer: number | null = null;
  let position: {
    direction: "up" | "down";
    trigger: "SCOUT" | "CONFIRM";
    entryAt: Date;
    entryOffer: number;
    contracts: number;
    entryCost: number;
  } | null = null;

  for (const row of observations) {
    const decision = evaluateV13StrategyWithParameters({
      marketTicker: row.marketTicker,
      btcPrice: row.btcPrice,
      target: row.target,
      previousBuffer,
      velocity: row.velocity,
      upOffer: row.upOffer,
      downOffer: row.downOffer,
      freshness: row.feedFreshness,
      position: position ? { status: "open", direction: position.direction } : null,
    }, parameters);

    if (!position) {
      if (
        decision.qualifyingTrigger &&
        (decision.signal === "SCOUT" || decision.signal === "CONFIRM") &&
        decision.entrySideOffer !== null &&
        (decision.direction === "UP" || decision.direction === "DOWN")
      ) {
        const contracts = Math.floor(requestedStake / decision.entrySideOffer);
        if (contracts > 0) {
          position = {
            direction: decision.direction === "UP" ? "up" : "down",
            trigger: decision.signal,
            entryAt: row.evaluatedAt,
            entryOffer: decision.entrySideOffer,
            contracts,
            entryCost: contracts * decision.entrySideOffer,
          };
        }
      }
    } else if (decision.signal === "EXIT" && decision.positionExitReason) {
      const exitBid = position.direction === "up" ? row.upBid : row.downBid;
      if (exitBid !== null && Number.isFinite(exitBid) && exitBid >= 0 && exitBid <= 1) {
        const payout = position.contracts * exitBid;
        return {
          status: "CLOSED",
          marketTicker: row.marketTicker,
          parameterHash,
          trigger: position.trigger,
          direction: position.direction === "up" ? "UP" : "DOWN",
          entryAt: position.entryAt,
          exitAt: row.evaluatedAt,
          entryOffer: position.entryOffer,
          exitBid,
          contracts: position.contracts,
          entryCost: position.entryCost,
          payout,
          pnl: payout - position.entryCost,
          closeReason: decision.positionExitReason,
        };
      }
    }

    previousBuffer = decision.buffer ?? row.signedBuffer;
  }

  const ticker = observations[0]?.marketTicker ?? "";
  if (!position) return { status: "NO_ENTRY", marketTicker: ticker, parameterHash };
  return {
    status: "UNRESOLVED",
    marketTicker: ticker,
    parameterHash,
    trigger: position.trigger,
    direction: position.direction === "up" ? "UP" : "DOWN",
    entryAt: position.entryAt,
    entryOffer: position.entryOffer,
    contracts: position.contracts,
    entryCost: position.entryCost,
  };
}

export type V13ReplaySummary = {
  parameterHash: string;
  markets: number;
  entries: number;
  closed: number;
  unresolved: number;
  positive: number;
  hitRate: number | null;
  pnl: number;
  averagePnl: number | null;
};

export function summarizeV13CounterfactualReplays(
  rows: V13CounterfactualReplayResult[],
): V13ReplaySummary {
  const parameterHash = rows[0]?.parameterHash ?? "";
  const entries = rows.filter((row) => row.status !== "NO_ENTRY");
  const closed = rows.filter((row): row is Extract<V13CounterfactualReplayResult, { status: "CLOSED" }> =>
    row.status === "CLOSED");
  const unresolved = rows.filter((row) => row.status === "UNRESOLVED").length;
  const pnl = closed.reduce((sum, row) => sum + row.pnl, 0);
  const positive = closed.filter((row) => row.pnl > 0).length;
  return {
    parameterHash,
    markets: rows.length,
    entries: entries.length,
    closed: closed.length,
    unresolved,
    positive,
    hitRate: closed.length ? positive / closed.length : null,
    pnl: roundResearchMoney(pnl),
    averagePnl: closed.length ? pnl / closed.length : null,
  };
}

/**
 * Replay one parameter set against every complete paper-evaluation stream in
 * the requested period. This is research-only and never creates positions,
 * orders, reservations or execution authority.
 */
export async function replayV13ParameterSetFromStoredEvaluations(
  parameters: V13StrategyParameters,
  from: Date,
  to: Date,
  requestedStake = 5,
): Promise<V13ReplaySummary> {
  if (!(from instanceof Date) || !(to instanceof Date) ||
      !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
      from >= to) {
    throw new Error("V13 replay period is invalid");
  }

  const rows = await db.select({
    id: forwardTestEvaluationTable.id,
    evaluatedAt: forwardTestEvaluationTable.evaluatedAt,
    marketTicker: forwardTestEvaluationTable.marketTicker,
    btcPrice: forwardTestEvaluationTable.btcPrice,
    target: forwardTestEvaluationTable.target,
    signedBuffer: forwardTestEvaluationTable.signedBuffer,
    velocity: forwardTestEvaluationTable.velocity,
    upBid: forwardTestEvaluationTable.upBid,
    upOffer: forwardTestEvaluationTable.upOffer,
    downBid: forwardTestEvaluationTable.downBid,
    downOffer: forwardTestEvaluationTable.downOffer,
    feedFreshness: forwardTestEvaluationTable.feedFreshness,
  }).from(forwardTestEvaluationTable).where(and(
    eq(forwardTestEvaluationTable.evaluationSource, "paper"),
    gte(forwardTestEvaluationTable.evaluatedAt, from),
    lt(forwardTestEvaluationTable.evaluatedAt, to),
  )).orderBy(
    asc(forwardTestEvaluationTable.marketTicker),
    asc(forwardTestEvaluationTable.evaluatedAt),
    asc(forwardTestEvaluationTable.id),
  );

  const byMarket = new Map<string, V13ReplayObservation[]>();
  for (const row of rows) {
    if (row.feedFreshness !== "current" && row.feedFreshness !== "data-error") continue;
    const list = byMarket.get(row.marketTicker) ?? [];
    list.push({
      id: row.id,
      evaluatedAt: row.evaluatedAt,
      marketTicker: row.marketTicker,
      btcPrice: row.btcPrice,
      target: row.target,
      signedBuffer: row.signedBuffer,
      velocity: row.velocity,
      upBid: row.upBid,
      upOffer: row.upOffer,
      downBid: row.downBid,
      downOffer: row.downOffer,
      feedFreshness: row.feedFreshness,
    });
    byMarket.set(row.marketTicker, list);
  }

  const replays = [...byMarket.values()].map((observations) =>
    replayV13CounterfactualMarket(observations, parameters, requestedStake));
  return summarizeV13CounterfactualReplays(replays);
}


export type V13ResearchSizingProfile = {
  id: string;
  label: string;
  cheapOfferCeiling: number;
  cheapMultiplier: number;
  confirmExpensiveMultiplier: number;
  scoutExpensiveMultiplier: number;
  maxMultiplier: number;
};

export const V13_BALANCED_RESEARCH_SIZING_PROFILE: V13ResearchSizingProfile =
  Object.freeze({
    id: "v13-research-sizing-balanced-1",
    label: "Balanced quality weighting: cheap 1.25x / confirm 1.0x / scout 0.75x",
    cheapOfferCeiling: 0.40,
    cheapMultiplier: 1.25,
    confirmExpensiveMultiplier: 1.00,
    scoutExpensiveMultiplier: 0.75,
    maxMultiplier: 1.25,
  });

export function v13ResearchSizingMultiplier(
  trigger: "SCOUT" | "CONFIRM",
  entryOffer: number,
  profile: V13ResearchSizingProfile = V13_BALANCED_RESEARCH_SIZING_PROFILE,
): number {
  if (!Number.isFinite(entryOffer) || entryOffer <= 0 || entryOffer > 1) {
    throw new Error("V13 research sizing entry offer is invalid");
  }
  const multiplier = entryOffer <= profile.cheapOfferCeiling
    ? profile.cheapMultiplier
    : trigger === "CONFIRM"
      ? profile.confirmExpensiveMultiplier
      : profile.scoutExpensiveMultiplier;
  if (!Number.isFinite(multiplier) || multiplier <= 0 ||
      multiplier > profile.maxMultiplier) {
    throw new Error("V13 research sizing multiplier is invalid");
  }
  return multiplier;
}

export type V13ResearchSizingOutcome = {
  pnl: number;
  stake: number;
  trigger: "SCOUT" | "CONFIRM";
  entryOffer: number;
};

export type V13ResearchSizingSummary = {
  profileId: string;
  trades: number;
  baselineStake: number;
  weightedStake: number;
  baselinePnl: number;
  weightedPnl: number;
  baselineReturnOnStake: number | null;
  weightedReturnOnStake: number | null;
  stakeRatio: number | null;
  pnlRatio: number | null;
};

/**
 * Linear paper-P&L sizing simulation only. This does not model market impact,
 * depth, fees or partial fills and therefore cannot authorize production size.
 */
export function simulateV13ResearchSizing(
  outcomes: V13ResearchSizingOutcome[],
  profile: V13ResearchSizingProfile = V13_BALANCED_RESEARCH_SIZING_PROFILE,
): V13ResearchSizingSummary {
  const valid = outcomes.filter((row) =>
    Number.isFinite(row.pnl) &&
    Number.isFinite(row.stake) && row.stake > 0 &&
    Number.isFinite(row.entryOffer) && row.entryOffer > 0 && row.entryOffer <= 1);
  let baselineStake = 0;
  let weightedStake = 0;
  let baselinePnl = 0;
  let weightedPnl = 0;
  for (const row of valid) {
    const multiplier = v13ResearchSizingMultiplier(
      row.trigger,
      row.entryOffer,
      profile,
    );
    baselineStake += row.stake;
    baselinePnl += row.pnl;
    weightedStake += row.stake * multiplier;
    weightedPnl += row.pnl * multiplier;
  }
  return {
    profileId: profile.id,
    trades: valid.length,
    baselineStake: roundResearchMoney(baselineStake),
    weightedStake: roundResearchMoney(weightedStake),
    baselinePnl: roundResearchMoney(baselinePnl),
    weightedPnl: roundResearchMoney(weightedPnl),
    baselineReturnOnStake: baselineStake > 0 ? baselinePnl / baselineStake : null,
    weightedReturnOnStake: weightedStake > 0 ? weightedPnl / weightedStake : null,
    stakeRatio: baselineStake > 0 ? weightedStake / baselineStake : null,
    pnlRatio: baselinePnl !== 0 ? weightedPnl / baselinePnl : null,
  };
}
