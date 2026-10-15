import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { pool } from "@workspace/db";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET, V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { planV13IocEntry } from "../v13ExecutionPlanner";
import { computeV13LiveMoneyPolicyHash, type V13ApprovedLiveMoneyPolicy } from "../v13LiveMoneyRisk";
import type { Fill, MarketEvidence, Request, Snapshot } from "../v13-production/types";
import { openOwnedExecutionSession, type AccountDispatchState } from "./accountProductionSession";
import { personalAccountSnapshot } from "./personalExchangeRead";
import { dedicatedSignerFingerprint } from "./commissioning";
import { UPSERT_STAKE_SQL } from "./userScopeDatabase";
import { reportOwnedActivation, readOwnedApprovedFeeEvidence } from "./personalAccountActivation";

const url = process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url && /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url), "explicit disposable cluster required");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "acct-personal";
const STAKES = [100, 500, 25_000, 100_000, 500_000, 2_500_000];

after(() => pool.end());


test("owner readiness resolves its account with a UUID owner and text policy creator, while foreign owners stay isolated", async () => {
  await reset();
  // Disposable PostgreSQL includes the public Drizzle schema; supply only the
  // private credential table shape needed by this read-only readiness join.
  await pool.query("CREATE SCHEMA IF NOT EXISTS private");
  await pool.query(`CREATE TABLE IF NOT EXISTS private.kalshi_connection_credentials (
    owner_user_id uuid NOT NULL,
    financial_account_id uuid,
    key_fingerprint text,
    role text,
    revoked_at timestamptz,
    verified_at timestamptz,
    verification_reason text
  )`);
  // The new personal commissioning read verifies bot-funding provenance.
  // Supply the owner-ledger schema in the disposable fixture (no live funds).
  await pool.query(`CREATE TABLE IF NOT EXISTS private.kalshi_owner_pilot_transfers (
    execution_account_id text NOT NULL,
    owner_user_id uuid NOT NULL,
    state text NOT NULL,
    bot_after_cents bigint,
    completed_at timestamptz
  )`);
  let diagnosticReadinessError = "";
  const diagnosticDb = {
    query: async (sql: string, params?: unknown[]) => {
      try { return await pool.query(sql, params); }
      catch (error) {
        diagnosticReadinessError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  };
  const owner = await reportOwnedActivation(diagnosticDb, USER);
  assert.equal(owner.ok, true);
  assert.equal(owner.accountId, ACCOUNT, "valid owned account must not fail closed: " + diagnosticReadinessError);
  assert.equal(owner.readyForLive, false);
  assert.equal(owner.blockers.includes("policy_not_approved"), true);

  // Executes the real read-only fee-evidence JOIN against PostgreSQL. The
  // owner has no approved policy, so this must return a blocker, not throw
  // SQLSTATE 42883 (operator does not exist: text = uuid).
  const fee = await readOwnedApprovedFeeEvidence(pool, USER);
  assert.deepEqual(fee, { ok: false, reason: "policy_not_approved" });
  const foreignFee = await readOwnedApprovedFeeEvidence(pool, OTHER);
  assert.deepEqual(foreignFee, { ok: false, reason: "policy_not_approved" });

  const foreign = await reportOwnedActivation(pool, OTHER);
  assert.equal(foreign.accountId, null);
  assert.deepEqual(foreign.blockers, ["execution_account_missing"]);
});


test("owned stake revisions persist, and a stale revision cannot overwrite", async () => {
  await reset();
  await pool.query(UPSERT_STAKE_SQL, [100, ACCOUNT, null, USER]);
  const first = await pool.query("SELECT configured_stake_cents, revision FROM strata_configured_stake WHERE execution_account_id=$1", [ACCOUNT]);
  assert.equal(Number(first.rows[0].configured_stake_cents), 100);
  assert.equal(Number(first.rows[0].revision), 1);
  let revision = 1;
  for (const cents of STAKES.slice(1)) {
    const saved = await pool.query(UPSERT_STAKE_SQL, [cents, ACCOUNT, revision, USER]);
    assert.equal(saved.rows.length, 1);
    revision = Number(saved.rows[0].revision);
    assert.equal(revision > 1, true);
  }
  const stale = await pool.query(UPSERT_STAKE_SQL, [100, ACCOUNT, 1, USER]);
  assert.equal(stale.rows.length, 0);
  const current = await pool.query("SELECT configured_stake_cents FROM strata_configured_stake WHERE execution_account_id=$1", [ACCOUNT]);
  assert.equal(Number(current.rows[0].configured_stake_cents), 2_500_000);
  const legacy = await pool.query("SELECT configured_stake_cents FROM strata_configured_stake WHERE id='production'");
  assert.equal(Number(legacy.rows[0].configured_stake_cents), 25);
  const other = await pool.query(UPSERT_STAKE_SQL, [100, ACCOUNT, revision, OTHER]);
  assert.equal(other.rows.length, 0);
});

test("concurrent stake updates keep the first revision winner", async () => {
  await reset();
  await pool.query(UPSERT_STAKE_SQL, [100, ACCOUNT, null, USER]);
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query("BEGIN");
    await second.query("BEGIN");
    const winner = first.query(UPSERT_STAKE_SQL, [500, ACCOUNT, 1, USER]);
    await winner;
    const loser = second.query(UPSERT_STAKE_SQL, [25_000, ACCOUNT, 1, USER]);
    await first.query("COMMIT");
    const lost = await loser;
    await second.query("COMMIT");
    assert.equal(lost.rows.length, 0);
  } finally {
    first.release();
    second.release();
  }
  const row = await pool.query("SELECT configured_stake_cents, revision FROM strata_configured_stake WHERE execution_account_id=$1", [ACCOUNT]);
  assert.equal(Number(row.rows[0].configured_stake_cents), 500);
  assert.equal(Number(row.rows[0].revision), 2);
});

test("a changed owned stake sizes the next mock order, and a crash does not replay the POST", async () => {
  const posts: string[] = [];
  const session = await tradingSession(100, posts);
  await pool.query("UPDATE strata_configured_stake SET configured_stake_cents=500, revision=2 WHERE execution_account_id=$1", [ACCOUNT]);
  session.book = book(500, session.now);
  const sized = await session.executor.prepareEntry(await source(session.now));
  assert.equal((await requestOf(sized)).contracts, contractsFor(500));
  await session.executor.dispatch(sized);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.includes("\"subaccount\":1"), true);
  assert.equal(posts[0]!.includes("KXBTC15M-TEST"), true);
  assert.equal(posts[0]!.includes("BEGIN"), false);
  await session.executor.dispatch(sized);
  assert.equal(posts.length, 1);
  const crashPosts: string[] = [];
  const crashed = await tradingSession(100, crashPosts, 60_000_000_000, (stage) => {
    if (stage === "after_post_before_commit") throw new Error("crash");
  });
  const crashedId = await crashed.executor.prepareEntry(await source(crashed.now));
  await assert.rejects(crashed.executor.dispatch(crashedId), /crash/);
  assert.equal(crashPosts.length, 1);
  await crashed.executor.dispatch(crashedId);
  assert.equal(crashPosts.length, 1);
  const legacy = await pool.query("SELECT cash_micros::text AS cash, kill_switch FROM v13_production_account WHERE id='production'");
  assert.equal(legacy.rows[0].cash, "1");
  assert.equal(legacy.rows[0].kill_switch, true);
});

test("three independently approved owners cannot alter the current owner's V2 entry or policy", async () => {
  const posts: string[] = [];
  const session = await tradingSession(100, posts);
  const approved = { ...policy(), executionAccountId: ACCOUNT, entryPolicyVersion: V13_ENTRY_POLICY_VERSION };
  approved.policyHash = computeV13LiveMoneyPolicyHash(approved);
  await pool.query(
    "UPDATE v13_live_money_policy SET entry_policy_version=$1, policy_hash=$2 WHERE id=$3 AND execution_account_id=$4",
    [V13_ENTRY_POLICY_VERSION, approved.policyHash, approved.id, ACCOUNT],
  );

  // Distinct owner-linked APPROVED policies must coexist without affecting
  // the signed-in owner's ledger. No simulated POST is made for another owner.
  for (const [ownerId, accountId, policyId] of [
    [OTHER, "acct-other", "policy-other"],
    ["33333333-3333-4333-8333-333333333333", "acct-third", "policy-third"],
  ]) {
    await pool.query(`INSERT INTO v13_production_account(id,owner_user_id,subaccount,exchange_index,key_fingerprint,
      cash_precision_verified,commissioned,kill_switch,execution_enabled,cash_micros,initial_cash_micros)
      VALUES($1,$2,1,2,$3,false,false,true,false,0,0)`, [accountId, ownerId, "e".repeat(64)]);
    const foreign = {
      ...policy(), id: policyId, executionAccountId: accountId, createdBy: ownerId,
      approvedBy: ownerId, championSelectedBy: ownerId, entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
    };
    foreign.policyHash = computeV13LiveMoneyPolicyHash(foreign);
    const keys = Object.keys(foreign);
    await pool.query(`INSERT INTO v13_live_money_policy(${keys.map((key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)).join(",")})
      VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(foreign));
    await pool.query("UPDATE v13_production_account SET policy_id=$2 WHERE id=$1", [accountId, policyId]);
  }
  assert.equal(Number((await pool.query(
    "SELECT count(*) AS n FROM v13_live_money_policy WHERE state='APPROVED' AND execution_account_id IS NOT NULL",
  )).rows[0].n), 3);
  const inspected = await session.executor.ledger.transaction(
    (tx, account) => session.executor.ledger.policy(tx, account),
  );
  assert.equal(inspected.policyHash, approved.policyHash);
  assert.equal(inspected.entryPolicyVersion, V13_ENTRY_POLICY_VERSION);

  // Even if a foreign account ID is supplied, the owned ledger cannot read
  // that user's policy or obtain their order authority.
  const foreignProbe = openOwnedExecutionSession({
    pool, ownerUserId: USER, executionAccountId: "acct-other",
    state: dispatchState("e".repeat(64)),
  });
  await assert.rejects(
    foreignProbe.executor.ledger.transaction(
      (tx, account) => foreignProbe.executor.ledger.policy(tx, account),
    ), /production_policy_missing/,
  );

  // A V1/NULL evaluation cannot run under an explicit V2-approved policy.
  await assert.rejects(
    session.executor.prepareEntry(await source(session.now)),
    /production_entry_policy_revision_not_approved/,
  );

  const evaluationId = await source(session.now);
  // V2 claims are tied to the market's first qualifying cross, never the
  // evaluation UUID. Keep the source row and window identity identical.
  await pool.query(
    "UPDATE forward_test_evaluations SET entry_policy_version=$2, crossing_key=market_ticker||':first' WHERE id=$1",
    [evaluationId, V13_ENTRY_POLICY_VERSION],
  );
  const evaluation = (await pool.query(
    "SELECT market_ticker,target,crossing_key FROM forward_test_evaluations WHERE id=$1", [evaluationId],
  )).rows[0];
  await pool.query(`INSERT INTO forward_test_windows(
    ticker,target,starts_at,ends_at,entry_policy_version,crossing_consumed,crossing_key)
    VALUES($1,$2,$3,$4,$5,true,$6)`, [
    evaluation.market_ticker, evaluation.target, new Date(session.now - 60_000),
    new Date(session.now + 60_000), V13_ENTRY_POLICY_VERSION, evaluation.crossing_key,
  ]);
  const intent = await session.executor.prepareEntry(evaluationId);
  assert.equal((await requestOf(intent)).limitMicros, 500_000);
  await session.executor.dispatch(intent);
  assert.equal(posts.length, 1);
});

test("insufficient cash, stale depth, kill, and the other owner cannot submit", async () => {
  const poor = await tradingSession(100, [], 1_000);
  await assert.rejects(poor.executor.prepareEntry(await source(poor.now)), /cash|insufficient|live_money/);
  assert.equal(poor.posts.length, 0);
  const stale = await tradingSession(100, []);
  stale.book = book(100, stale.now - 20_000);
  await assert.rejects(stale.executor.prepareEntry(await source(stale.now)), /stale|fee_evidence|market_evidence/);
  const killed = await tradingSession(100, []);
  await pool.query("UPDATE v13_production_account SET kill_switch=true WHERE id=$1", [ACCOUNT]);
  await assert.rejects(killed.executor.prepareEntry(await source(killed.now)), /production_authority_disabled_or_uncommissioned|account_kill/);
  const foreign = await tradingSession(100, []);
  foreign.executor.accountOwnerUserId = OTHER;
  await assert.rejects(foreign.executor.prepareEntry(await source(foreign.now)), /foreign_execution_account|production_policy_missing/);
  assert.equal(foreign.posts.length, 0);
});

test("a mock partial fill reconciles once and a later dispatch does not post again", async () => {
  const posts: string[] = [];
  const session = await tradingSession(100, posts);
  const id = await session.executor.prepareEntry(await source(session.now));
  const request = await requestOf(id);
  await session.executor.dispatch(id);
  fill(session.evidence, request, "100");
  await session.executor.reconcile();
  await session.executor.dispatch(id);
  assert.equal(posts.length, 1);
  const position = await pool.query("SELECT quantity_hundredths::text AS qty FROM v13_production_position WHERE account_id=$1", [ACCOUNT]);
  assert.equal(position.rows[0].qty, "100");
  const again = new (await import("../v13-production/executor")).ProductionExecutor(session.executor.ledger, session.exchange, () => session.now);
  again.accountOwnerUserId = USER;
  await again.dispatch(id);
  assert.equal(posts.length, 1);
});

test("a reconciled fill and settlement allow a second order without replaying the first", async () => {
  const posts: string[] = [];
  const session = await tradingSession(100, posts);
  const id = await session.executor.prepareEntry(await source(session.now));
  const request = await requestOf(id);
  await session.executor.dispatch(id);
  const quantity = `${request.contracts}.00`;
  const hundredths = request.contracts * 100;
  const gross = BigInt(hundredths) * BigInt(request.limitMicros) / 100n;
  const spent = gross;
  const first = personalAccountSnapshot(session.evidence.identity, {
    ok: true, observedAtMs: session.now, cashMicros: String(BigInt(session.evidence.cashMicros) - spent),
    orders: [exchangeOrder(request, quantity)],
    fills: [exchangeFill(request, quantity, session.now)],
    positions: [{ ticker: request.market, position_fp: quantity, subaccount: 1, exchange_index: 2 }],
    settlements: [],
  }, [request]);
  assert.equal("orders" in first, true);
  if (!("orders" in first)) return;
  Object.assign(session.evidence, first);
  await session.executor.reconcile();
  const payout = BigInt(hundredths) * 10_000n;
  const settled = personalAccountSnapshot(session.evidence.identity, {
    ok: true, observedAtMs: session.now, cashMicros: String(BigInt(session.evidence.cashMicros) + payout),
    orders: [exchangeOrder(request, quantity)],
    fills: [exchangeFill(request, quantity, session.now)],
    positions: [{ ticker: request.market, position_fp: "0.00", subaccount: 1, exchange_index: 2 }],
    settlements: [{
      ticker: request.market, yes_count_fp: quantity, no_count_fp: "0.00", market_result: "yes",
      revenue: Number(payout / 10_000n), settled_time: new Date(session.now).toISOString(),
      subaccount: 1, exchange_index: 2,
    }],
  }, [request]);
  assert.equal("settlements" in settled, true);
  if (!("settlements" in settled)) return;
  Object.assign(session.evidence, settled);
  await session.executor.reconcile();
  const second = await session.executor.prepareEntry(await source(session.now));
  await session.executor.dispatch(second);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0], posts[1]);
});

test("stake amounts from one dollar through the ceiling are executable sizes, not a hardcoded default", async () => {
  for (const cents of STAKES) {
    const session = await tradingSession(cents, []);
    const id = await session.executor.prepareEntry(await source(session.now));
    assert.equal((await requestOf(id)).contracts, contractsFor(cents));
    assert.equal(session.posts.length, 0);
  }
});

async function reset(): Promise<void> {
  await pool.query("TRUNCATE v13_production_observation,v13_production_event,v13_production_position,v13_production_intent,v13_production_account,forward_test_evaluations,forward_test_windows,v13_live_money_policy,strata_configured_stake,live_execution_config CASCADE");
  await pool.query(`INSERT INTO live_execution_config(id, mode, live_execution_enabled, manual_kill_switch)
    VALUES('singleton','SHADOW_LIVE',false,false)`);
  await pool.query(`INSERT INTO v13_production_account(id,policy_id,subaccount,exchange_index,key_fingerprint,
    commissioning_digest,cash_precision_verified,commissioned,kill_switch,execution_enabled,cash_micros,initial_cash_micros)
    VALUES('production',NULL,1,2,$1,NULL,false,false,true,false,1,1)`, ["c".repeat(64)]);
  await pool.query(`INSERT INTO strata_configured_stake(id,configured_stake_cents,revision,updated_at)
    VALUES('production',25,1,now())`);
  await pool.query(`INSERT INTO v13_production_account(id,owner_user_id,subaccount,exchange_index,key_fingerprint,
    cash_precision_verified,commissioned,kill_switch,execution_enabled,cash_micros,initial_cash_micros)
    VALUES($1,$2,1,2,$3,false,false,true,false,0,0)`, [ACCOUNT, USER, "b".repeat(64)]);
}

async function tradingSession(
  stakeCents: number,
  posts: string[],
  cashMicros = 60_000_000_000,
  fault?: (stage: string) => void,
) {
  await reset();
  await pool.query(`UPDATE live_execution_config
    SET mode = 'V13_PRODUCTION', live_execution_enabled = true, manual_kill_switch = false
    WHERE id = 'singleton'`);
  const now = Date.now();
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const material = { keyId: "personal-key", privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
  const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
  assert.ok(fingerprint);
  const approved = { ...policy(), executionAccountId: ACCOUNT };
  const keys = Object.keys(approved);
  await pool.query(`INSERT INTO v13_live_money_policy(${keys.map((key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)).join(",")})
    VALUES(${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(approved));
  await pool.query(`UPDATE v13_production_account SET policy_id=$3, key_fingerprint=$4,
    commissioning_digest=$5, minimum_exit_micros=400000, fee_artifact_digest=$5, cash_precision_verified=true,
    commissioned=true, kill_switch=false, execution_enabled=true, cash_micros=$6, initial_cash_micros=$6,
    reconciled_at=$7
    WHERE id=$1 AND owner_user_id=$2`,
  [ACCOUNT, USER, approved.id, fingerprint, "d".repeat(64), String(cashMicros), new Date(now)]);
  await pool.query(`INSERT INTO strata_configured_stake(id,execution_account_id,configured_stake_cents,revision,updated_at)
    VALUES($1,$1,$2,1,$3)`, [ACCOUNT, stakeCents, new Date(now)]);
  const evidence = snapshot(fingerprint!, now, cashMicros);
  let currentBook = book(stakeCents, now);
  const session = openOwnedExecutionSession({
    pool,
    ownerUserId: USER,
    executionAccountId: ACCOUNT,
    state: dispatchState(fingerprint!),
    material,
    now: () => now,
    intervalMs: 60_000,
    fault,
    readMarket: async () => structuredClone(currentBook),
    readSnapshot: async () => structuredClone(evidence),
    fetchImpl: async (_url, init) => {
      posts.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    },
  });
  await session.executor.reconcile();
  return { ...session, now, evidence, posts, get book() { return currentBook; }, set book(value: MarketEvidence) { currentBook = value; } };
}

function policy(): V13ApprovedLiveMoneyPolicy {
  const approved: V13ApprovedLiveMoneyPolicy = {
    id: "policy-personal", version: 1, supersedesPolicyId: null, state: "APPROVED",
    strategyVersion: "V1.3", strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH, championSelectionReviewId: "personal-review",
    championSelectionEvidenceHash: "a".repeat(64), championSelectedBy: USER,
    championSelectedAt: new Date(0), capitalLimitCents: 6_000_000, maxEntryStakeCents: 2_500_000,
    maxEntryAllInCents: 6_000_000, maxOpenPositions: 1, maxDailyLossCents: 6_000_000,
    maxTotalLossCents: 6_000_000, maxQuoteAgeMs: 15_000, maxFeeEvidenceAgeMs: 15_000,
    feePolicyVersion: "test-fees", feeSourceUrl: "https://invalid.test/fees", feeFormulaVersion: "test-v1",
    requireFullDepth: true, entryTimeInForce: "IOC", entryLimitSource: "SIGNAL_REFERENCE_OFFER",
    policyHash: null, createdBy: USER, approvedBy: USER, approvedAt: new Date(1),
  };
  approved.policyHash = computeV13LiveMoneyPolicyHash(approved);
  return approved;
}

function book(stakeCents: number, observedAtMs: number): MarketEvidence {
  const plan = planV13IocEntry({
    signal: "SCOUT", direction: "UP", referenceOffer: 0.5, maxStakeCents: stakeCents,
    bestAskDollars: "0.5000", askLevels: [{ priceDollars: "0.5000", availableContracts: "100000" }],
  });
  if (!plan.ok) throw new Error(plan.reason);
  return {
    observedAtMs, bestAskDollars: "0.5000",
    asks: [{ priceDollars: "0.5000", availableContracts: "100000" }],
    bestBidDollars: "0.4500", bids: [{ priceDollars: "0.4500", availableContracts: "100000" }],
    fee: {
      policyVersion: "test-fees", sourceUrl: "https://invalid.test/fees", formulaVersion: "test-v1",
      fingerprint: "fee-evidence-fingerprint", verifiedAtMs: observedAtMs,
      contracts: plan.plan.contracts, limitPrice: plan.plan.limitPrice,
      reservedEntryFeeCents: 1, reservedExitFeeCents: 1,
    },
  };
}

function contractsFor(stakeCents: number): number {
  const plan = planV13IocEntry({
    signal: "SCOUT", direction: "UP", referenceOffer: 0.5, maxStakeCents: stakeCents,
    bestAskDollars: "0.5000", askLevels: [{ priceDollars: "0.5000", availableContracts: "100000" }],
  });
  if (!plan.ok) throw new Error(plan.reason);
  return plan.plan.contracts;
}

function snapshot(fingerprint: string, observedAtMs: number, cashMicros: number): Snapshot {
  return {
    identity: { subaccount: 1, exchangeIndex: 2, keyFingerprint: fingerprint },
    observedAtMs, complete: true, authenticated: true, historyFromMs: 0,
    cashMicros: String(cashMicros), cashExact: true, orders: [], fills: [], settlements: [],
    positions: [], unexplainedCashActivity: false,
  };
}

function dispatchState(fingerprint: string): AccountDispatchState {
  return {
    leaseState: "owned", armRequested: true, accountKill: false, globalKill: false,
    fencingToken: 3, presentedToken: 3, workerActuallyScheduled: true,
    authenticatedUserId: USER, ownerUserId: USER, credentialFingerprint: fingerprint,
    presentedFingerprint: fingerprint, uncertainOrderCount: 0, duplicateClientOrder: false,
    liveExecutionEnabled: true,
  };
}

async function source(now: number): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO forward_test_evaluations(id,evaluated_at,market_ticker,btc_price,target,
    signed_buffer,absolute_buffer,velocity,feed_freshness,fresh_cross,crossing_consumed,crossing_key,signal,
    direction,qualifying_trigger,reason,entry_offer,position_was_open,previous_side,up_offer,down_offer,
    btc_provider_age_ms,btc_receive_age_ms,market_age_ms,strategy_parameter_set_id,strategy_parameter_hash)
    VALUES($1,$2,'KXBTC15M-TEST',100010,100000,10,10,1,'current',true,true,$3,'SCOUT','UP',true,'test',0.5,false,
      'DOWN',0.5,0.5,0,0,0,$4,$5)`,
  [id, new Date(now), `${id}:first`, V13_CHAMPION_PARAMETER_SET.id, V13_CHAMPION_PARAMETER_HASH]);
  return id;
}

async function requestOf(id: string): Promise<Request> {
  const row = await pool.query("SELECT request FROM v13_production_intent WHERE id=$1", [id]);
  const request = row.rows[0].request;
  return typeof request === "string" ? JSON.parse(request) as Request : request as Request;
}

function exchangeOrder(request: Request, quantity: string): Record<string, unknown> {
  return {
    order_id: `order-${request.clientOrderId}`, client_order_id: request.clientOrderId, ticker: request.market,
    status: "executed", side: "bid", price: (request.limitMicros / 1_000_000).toFixed(4),
    initial_count_fp: quantity, fill_count_fp: quantity, subaccount: 1, exchange_index: 2,
  };
}

function exchangeFill(request: Request, quantity: string, occurredAtMs: number): Record<string, unknown> {
  return {
    trade_id: `fill-${request.clientOrderId}`, order_id: `order-${request.clientOrderId}`, ticker: request.market,
    count_fp: quantity, yes_price_dollars: (request.limitMicros / 1_000_000).toFixed(6), fee_cost: "0.000000",
    created_time: new Date(occurredAtMs).toISOString(), subaccount: 1, exchange_index: 2,
  };
}

function fill(evidence: Snapshot, request: Request, quantity: string): void {
  const orderId = `order-${request.clientOrderId}`;
  const gross = String(BigInt(quantity) * BigInt(request.limitMicros) / 100n);
  const fillRow: Fill = {
    id: randomUUID(), orderId, clientOrderId: request.clientOrderId, market: request.market,
    side: request.side, action: request.action, quantityHundredths: quantity, priceMicros: request.limitMicros,
    grossMicros: gross, feeMicros: "10000", occurredAtMs: evidence.observedAtMs,
  };
  evidence.fills.push(fillRow);
  evidence.orders.push({ orderId, request, filledHundredths: quantity, terminal: true });
  evidence.cashMicros = String(BigInt(evidence.cashMicros) - BigInt(gross) - 10_000n);
  evidence.positions.push({ market: request.market, side: request.side, quantityHundredths: quantity });
}
