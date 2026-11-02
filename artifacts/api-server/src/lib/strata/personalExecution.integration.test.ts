import {entryCashRiskFeeFixture} from "../v13-production/entryCashRisk.fixture";
import {canonicalEntryQuoteEvidenceDigest} from "../v13-production/entryQuoteEvidence";
import {dispatchReviewedProtectiveExitOnce} from "./ownerFeeEmergencyExitSignedDispatch";
import {requestQuantityHundredths,formatContractHundredths} from "../v13-production/requestQuantity";
import { readFileSync } from "node:fs";
import { quoteFromEntryBook } from "../forwardEntryBookQuote";
import { reserveOwnedEmergencyExitProof } from "./ownerFeeEmergencyExitReserve";
import { markOwnedEmergencyExitUnknownForReview } from "./ownerFeeEmergencyExitUnknownCommit";
import { sealedFinancialProtectiveExitOrder } from "./ownedProtectiveFinancialIntent";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { pool } from "@workspace/db";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET, V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { planV13IocEntry } from "../v13ExecutionPlanner";
import { computeV13LiveMoneyPolicyHash, type V13ApprovedLiveMoneyPolicy } from "../v13LiveMoneyRisk";
import type { Fill, MarketEvidence, Request, Snapshot } from "../v13-production/types";
import { openOwnedExecutionSession, type AccountDispatchState } from "./accountProductionSession";
import { personalAccountSnapshot } from "./personalExchangeRead";
import { dedicatedSignerFingerprint } from "./commissioning";
import { readUnresolvedIntentMode } from "./workerUncertainOrderGate";
import {TechnicalReleaseEntryGate} from "./technicalReleaseEntryGate";
import {reconciledFlatEntryEvidence} from "./reconciledFlatEntryEvidence";
import { UPSERT_STAKE_SQL } from "./userScopeDatabase";
import { reportOwnedActivation, readOwnedApprovedFeeEvidence } from "./personalAccountActivation";

const url = process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url && /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url), "explicit disposable cluster required");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "acct-personal";
const STAKES = [500, 1000, 25_000, 100_000, 500_000, 2_500_000];

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
  // Readiness uses historical evidence as an alternative to new pilot receipts.
  // Keep this schema in the disposable PostgreSQL fixture only. Without it,
  // the read fails closed (accountId:null) even for valid existing owners.
  await pool.query(`CREATE TABLE IF NOT EXISTS private.kalshi_owner_historical_funding (
    execution_account_id text PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    exchange_transfer_id text NOT NULL UNIQUE,
    transfer_created_at timestamptz NOT NULL,
    primary_after_cents bigint NOT NULL CHECK (primary_after_cents = 0),
    bot_after_cents bigint NOT NULL CHECK (bot_after_cents = 2500),
    verified_at timestamptz NOT NULL
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
  await pool.query(`CREATE TABLE IF NOT EXISTS private.kalshi_owner_historical_funding (
    execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),
    owner_user_id uuid NOT NULL,
    exchange_transfer_id text NOT NULL UNIQUE,
    transfer_created_at timestamptz NOT NULL,
    primary_after_cents bigint NOT NULL CHECK (primary_after_cents = 0),
    bot_after_cents bigint NOT NULL CHECK (bot_after_cents = 2500),
    verified_at timestamptz NOT NULL
  )`);
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
  await pool.query(UPSERT_STAKE_SQL, [500, ACCOUNT, null, USER]);
  const first = await pool.query("SELECT configured_stake_cents, revision FROM strata_configured_stake WHERE execution_account_id=$1", [ACCOUNT]);
  assert.equal(Number(first.rows[0].configured_stake_cents), 500);
  assert.equal(Number(first.rows[0].revision), 1);
  let revision = 1;
  for (const cents of STAKES.slice(1)) {
    const saved = await pool.query(UPSERT_STAKE_SQL, [cents, ACCOUNT, revision, USER]);
    assert.equal(saved.rows.length, 1);
    revision = Number(saved.rows[0].revision);
    assert.equal(revision > 1, true);
  }
  const stale = await pool.query(UPSERT_STAKE_SQL, [500, ACCOUNT, 1, USER]);
  assert.equal(stale.rows.length, 0);
  const current = await pool.query("SELECT configured_stake_cents FROM strata_configured_stake WHERE execution_account_id=$1", [ACCOUNT]);
  assert.equal(Number(current.rows[0].configured_stake_cents), 2_500_000);
  const legacy = await pool.query("SELECT configured_stake_cents FROM strata_configured_stake WHERE id='production'");
  assert.equal(Number(legacy.rows[0].configured_stake_cents), 25);
  const other = await pool.query(UPSERT_STAKE_SQL, [500, ACCOUNT, revision, OTHER]);
  assert.equal(other.rows.length, 0);
});

test("concurrent stake updates keep the first revision winner", async () => {
  await reset();
  const initial = await pool.query(UPSERT_STAKE_SQL, [500, ACCOUNT, null, USER]);
  assert.equal(initial.rows.length,1,"baseline stake must exist before concurrency test");
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query("BEGIN");
    await second.query("BEGIN");
    const winner = first.query(UPSERT_STAKE_SQL, [1000, ACCOUNT, 1, USER]);
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
  assert.equal(Number(row.rows[0].configured_stake_cents), 1000);
  assert.equal(Number(row.rows[0].revision), 2);
});

test("a changed owned stake sizes the next mock order, and a crash does not replay the POST", async () => {
  const posts: string[] = [];
  const session = await tradingSession(500, posts);
  await pool.query("UPDATE strata_configured_stake SET configured_stake_cents=1000, revision=2 WHERE execution_account_id=$1", [ACCOUNT]);
  session.book = book(1000, session.now);
  const sized = await session.executor.prepareEntry(await source(session.now));
  assert.equal((await requestOf(sized)).contracts, contractsFor(1000));
  await session.executor.dispatch(sized);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.includes("\"subaccount\":1"), true);
  assert.equal(posts[0]!.includes("KXBTC15M-TEST-000"), true);
  assert.equal(posts[0]!.includes("BEGIN"), false);
  await session.executor.dispatch(sized);
  assert.equal(posts.length, 1);
  const crashPosts: string[] = [];
  const crashed = await tradingSession(500, crashPosts, 60_000_000_000, (stage) => {
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
  const session = await tradingSession(500, posts);
  const approved = { ...policy(), executionAccountId: ACCOUNT, entryPolicyVersion: V13_ENTRY_POLICY_VERSION };
  approved.policyHash = computeV13LiveMoneyPolicyHash(approved);
  await pool.query(
    "UPDATE v13_live_money_policy SET entry_policy_version=$1, policy_hash=$2 WHERE id=$3 AND execution_account_id=$4",
    [V13_ENTRY_POLICY_VERSION, approved.policyHash, approved.id, ACCOUNT],
  );
  session.book.fee=entryCashRiskFeeFixture({now:session.now,market:"KXBTC15M-TEST-000",side:"YES",price:.5,contracts:10,policyHash:approved.policyHash!});

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
  const poor = await tradingSession(500, [], 1_000);
  await assert.rejects(poor.executor.prepareEntry(await source(poor.now)), /cash|insufficient|live_money/);
  assert.equal(poor.posts.length, 0);
  const stale = await tradingSession(500, []);
  stale.book = book(500, stale.now - 20_000);
  await assert.rejects(stale.executor.prepareEntry(await source(stale.now)), /stale|fee_evidence|market_evidence/);
  const killed = await tradingSession(500, []);
  await pool.query("UPDATE v13_production_account SET kill_switch=true WHERE id=$1", [ACCOUNT]);
  await assert.rejects(killed.executor.prepareEntry(await source(killed.now)), /production_authority_disabled_or_uncommissioned|account_kill/);
  const foreign = await tradingSession(500, []);
  foreign.executor.accountOwnerUserId = OTHER;
  await assert.rejects(foreign.executor.prepareEntry(await source(foreign.now)), /foreign_execution_account|production_policy_missing/);
  assert.equal(foreign.posts.length, 0);
});

test("a mock partial fill reconciles once and a later dispatch does not post again", async () => {
  const posts: string[] = [];
  const session = await tradingSession(500, posts);
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
  const session = await tradingSession(500, posts);
  const id = await session.executor.prepareEntry(await source(session.now));
  const request = await requestOf(id);
  await session.executor.dispatch(id);
  const quantity = formatContractHundredths(requestQuantityHundredths(request));
  const hundredths = Number(requestQuantityHundredths(request));
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

test("stake amounts from the minimum through the ceiling are executable sizes, not a hardcoded default", async () => {
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
  // Disposable fixture: a verified and sufficiently funded owner account
  // exercises the new cash-backed SQL stake guard without external requests.
  await pool.query(`INSERT INTO v13_production_account(id,owner_user_id,subaccount,exchange_index,key_fingerprint,
    cash_precision_verified,commissioned,kill_switch,execution_enabled,cash_micros,initial_cash_micros,reconciled_at)
    VALUES($1,$2,1,2,$3,false,false,true,false,30000000000,30000000000,now())`, [ACCOUNT, USER, "b".repeat(64)]);
}

async function tradingSession(
  stakeCents: number,
  posts: string[],
  cashMicros = 60_000_000_000,
  fault?: (stage: string) => void,
  guardSnapshotUncertainty = false,
) {
  await reset();
  await pool.query(`UPDATE live_execution_config
    SET mode = 'V13_PRODUCTION', live_execution_enabled = true, manual_kill_switch = false
    WHERE id = 'singleton'`);
  let now = Date.now();
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
  if (guardSnapshotUncertainty) {
    await pool.query("CREATE SCHEMA IF NOT EXISTS private");
    await pool.query(`CREATE TABLE IF NOT EXISTS private.strata_emergency_exit_reservations (
      execution_account_id text, state text
    )`);
    await pool.query("TRUNCATE private.strata_emergency_exit_reservations");
  }
  const entryGate=new TechnicalReleaseEntryGate();
  const evidence = snapshot(fingerprint!, now, cashMicros);
  let currentBook = book(stakeCents, now);
  const session = openOwnedExecutionSession({
    pool,
    ownerUserId: USER,
    executionAccountId: ACCOUNT,
    state: { ...dispatchState(fingerprint!), entriesAuthorized: true },
    material,
    now: () => now,
    intervalMs: 60_000,
    fault,
    entriesOpen: guardSnapshotUncertainty ? () => entryGate.mayEnter(session.exchange.state.entriesAuthorized,false) : undefined,
    readMarket: async () => structuredClone(currentBook),
    readSnapshot: async () => {
      if (guardSnapshotUncertainty) {
        entryGate.beginReconciliation();
        const ledger = session.executor.ledger;
        const currentEntry = ledger.currentFinalSnapshotEntry();
        const tx = currentEntry ? ledger.currentTransaction() : null;
        const unresolved = await readUnresolvedIntentMode(
          (sql, params) => (tx ?? pool).query(sql, params), ACCOUNT, currentEntry,
        );
        if (!unresolved.ok) session.exchange.state.entriesAuthorized = false;
        if (unresolved.ok && unresolved.mode === "recovery") {
          entryGate.beginReconciliation();
          if(currentEntry)throw new Error("production_other_uncertain_order");
        }
      }
      return structuredClone(evidence);
    },
    fetchImpl: async (_url, init) => {
      posts.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    },
  });
  // Test-only stand-in for the production exact-SHA final authority check.
  if(guardSnapshotUncertainty)session.executor.authorizeFinalEntry=async()=>entryGate.completeReconciliation(true);
  if(guardSnapshotUncertainty)session.executor.afterReconcile=async signed=>{
    entryGate.completeReconciliation(await reconciledFlatEntryEvidence(pool,{accountId:ACCOUNT,ownerId:USER,snapshot:signed,nowMs:now}));
  };
  await session.executor.reconcile();
  return { ...session, entryGate, get now() { return now; }, material, evidence, posts,
    advance(ms:number) { now+=ms; evidence.observedAtMs=now;currentBook.observedAtMs=now;currentBook.fee.verifiedAtMs=now; },
    get book() { return currentBook; }, set book(value: MarketEvidence) { currentBook = value; } };
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
    fee: entryCashRiskFeeFixture({now:observedAtMs,market:"KXBTC15M-TEST-000",side:"YES",price:.5,
      contracts:plan.plan.contracts,policyHash:policy().policyHash!}),
  };
}

function contractsFor(stakeCents: number): number {
  const plan = planV13IocEntry({
    signal: "SCOUT", direction: "UP", referenceOffer: 0.5, maxStakeCents: stakeCents,
    bestAskDollars: "0.5000", askLevels: [{ priceDollars: "0.5000", availableContracts: "100000" }],
  });
  if (!plan.ok) throw new Error(plan.reason);
  return Math.min(plan.plan.contracts,Math.floor(6_000_000*10000/(1_000_000+999900)));
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
  // Actual producer helper, offline coherent public-book fixture: no receipt
  // bypass or invented integrity digest for the now-mandatory LIVE source gate.
  const ticker = "KXBTC15M-TEST-000";
  const quote = quoteFromEntryBook({ticker,source:"KALSHI_PUBLIC_REST",timestampAuthority:"LOCAL_RECEIPT_ONLY",
    requestStartedAtMs:now,receivedAtMs:now,bodyCompletedAtMs:now,
    yesBids:[{priceTicks:5000,contractsHundredths:100000}],
    noBids:[{priceTicks:5000,contractsHundredths:100000}]},
    {ticker,target:100000,startsAt:new Date(now-1000),endsAt:new Date(now+900000),
      fetchedAt:new Date(now),status:"open",result:null,yesAsk:.5,noAsk:.5,yesBid:.5,noBid:.5,yesPrice:.5,noPrice:.5},
    now,now,"YES",5);
  await pool.query(`INSERT INTO forward_test_evaluations(id,evaluated_at,market_ticker,btc_price,target,
    signed_buffer,absolute_buffer,velocity,feed_freshness,fresh_cross,crossing_consumed,crossing_key,signal,
    direction,qualifying_trigger,reason,entry_offer,position_was_open,previous_side,up_offer,down_offer,
    btc_provider_age_ms,btc_receive_age_ms,market_age_ms,strategy_parameter_set_id,strategy_parameter_hash,
    up_bid,down_bid,entry_quote_evidence)
    VALUES($1,$2,'KXBTC15M-TEST-000',100010,100000,10,10,1,'current',true,true,$3,'SCOUT','UP',true,'test',0.5,false,
      'DOWN',0.5,0.5,0,0,0,$4,$5,0.5,0.5,$6::jsonb)`,
  [id, new Date(now), `${id}:first`, V13_CHAMPION_PARAMETER_SET.id, V13_CHAMPION_PARAMETER_HASH, JSON.stringify(quote.evidence)]);
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
  evidence.cashMicros = String(BigInt(evidence.cashMicros) + (request.action==='BUY'?-BigInt(gross):BigInt(gross)) - 10_000n);
  const position=evidence.positions.find(p=>p.market===request.market&&p.side===request.side);
  const updated=(position?BigInt(position.quantityHundredths):0n)+(request.action==='BUY'?BigInt(quantity):-BigInt(quantity));
  if(position)position.quantityHundredths=updated.toString();else evidence.positions.push({market:request.market,side:request.side,quantityHundredths:updated.toString()});
}


test("final signed account proof does not classify its own locked DISPATCHED entry as a foreign uncertainty", async () => {
  const session = await tradingSession(500, [], 60_000_000_000, undefined, true);
  const id = await session.executor.prepareEntry(await source(session.now));
  assert.equal(session.executor.ledger.currentFinalSnapshotEntry(), null);
  await session.executor.dispatch(id);
  assert.equal(session.posts.length, 1);
  assert.equal(session.exchange.state.entriesAuthorized, true);
  assert.equal(session.executor.ledger.currentFinalSnapshotEntry(), null);
  assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1", [id])).rows[0].state, "UNKNOWN");
  // A later ordinary reconciliation gets no exemption: the UNKNOWN holds
  // entry authority, despite complete empty exchange evidence.
  await session.executor.reconcile();
  assert.equal(session.exchange.state.entriesAuthorized, true, "reconciliation is not an owner STOP");
  assert.equal(session.entryGate.mayEnter(true,false), false, "UNKNOWN remains held");
  assert.equal(session.posts.length, 1);
});

test("terminal zero-fill signed reconciliation permits a later entry without resetting STOP", async()=>{
  const s=await tradingSession(500,[],60_000_000_000,undefined,true);
  const first=await s.executor.prepareEntry(await source(s.now));
  await s.executor.dispatch(first);
  await s.executor.reconcile();
  assert.equal(s.entryGate.mayEnter(s.exchange.state.entriesAuthorized,false),false);
  const request=await requestOf(first);
  s.evidence.orders.push({orderId:"zero-fill",request,filledHundredths:"0",terminal:true});
  s.advance(1);
  await s.executor.reconcile();
  assert.equal(s.entryGate.mayEnter(s.exchange.state.entriesAuthorized,false),true);
  const second=await s.executor.prepareEntry(await source(s.now));
  await s.executor.dispatch(second);
  assert.equal(s.posts.length,2);
  s.exchange.state.entriesAuthorized=false;
  s.evidence.orders.push({orderId:"zero-fill-2",request:await requestOf(second),filledHundredths:"0",terminal:true});
  s.advance(1);await s.executor.reconcile();
  assert.equal(s.entryGate.mayEnter(s.exchange.state.entriesAuthorized,false),false,"flat proof never clears STOP");
  assert.equal(s.posts.length,2,"reconciliation never posts");
});

test("open filled exposure holds entries until terminal settlement is independently reconciled",async()=>{
  const s=await tradingSession(500,[],60_000_000_000,undefined,true);
  const id=await s.executor.prepareEntry(await source(s.now));
  await s.executor.dispatch(id);
  const request=await requestOf(id),quantity=requestQuantityHundredths(request).toString();
  fill(s.evidence,request,quantity);
  s.advance(1);await s.executor.reconcile();
  assert.equal(s.entryGate.mayEnter(s.exchange.state.entriesAuthorized,false),false,"open exposure held");
  assert.equal(s.exchange.state.entriesAuthorized,true,"normal fill does not latch STOP");
  const payout=String(BigInt(quantity)*10000n);
  s.advance(1);
  s.evidence.settlements.push({id:"settle",market:request.market,side:request.side,result:"YES",
    quantityHundredths:quantity,payoutMicros:payout,feeMicros:"0",occurredAtMs:s.now});
  s.evidence.positions=[];
  s.evidence.cashMicros=String(BigInt(s.evidence.cashMicros)+BigInt(payout));
  await s.executor.reconcile();
  assert.equal(s.entryGate.mayEnter(s.exchange.state.entriesAuthorized,false),true);
  assert.equal(s.posts.length,1,"settlement reconciliation is GET-only");
});

async function protectiveFixture(withMarker:boolean,guardSnapshotUncertainty=false,ownedQuantity="200",ownedSide:"YES"|"NO"="YES") {
  const s=await tradingSession(500,[],60_000_000_000,undefined,guardSnapshotUncertainty);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS private; CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES('${USER}') ON CONFLICT DO NOTHING;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
    DROP TABLE IF EXISTS private.strata_emergency_exit_reservations CASCADE;
    DROP TABLE IF EXISTS private.kalshi_account_worker_lease CASCADE;`);
  for(const file of ["strata_emergency_exit_reservation_private.sql","strata_emergency_exit_baseline_private.sql","strata_protective_exit_request_snapshot_private.sql","strata_protective_exit_reconciliation_private.sql","strata_protective_exit_local_no_send.sql","strata_protective_exit_fractional_quantity.sql"])
    await pool.query(readFileSync(`../../sql/${file}`,"utf8"));
  await pool.query(`CREATE TABLE private.kalshi_account_worker_lease(
    execution_account_id text PRIMARY KEY,owner_user_id uuid,holder_id text,fencing_token bigint,
    state text,account_kill boolean,arm_requested boolean,credential_fingerprint text,heartbeat_at timestamptz);
    INSERT INTO private.kalshi_account_worker_lease VALUES('${ACCOUNT}','${USER}','worker',3,'owned',false,true,'${s.evidence.identity.keyFingerprint}',now())`);
  const entrySource=await source(s.now);
  if(ownedSide==='NO'){
   s.book.fee=entryCashRiskFeeFixture({now:s.now,market:'KXBTC15M-TEST-000',side:'NO',price:.5,contracts:10,policyHash:s.book.fee.cashRisk!.policyHash});
   const evidence=(await pool.query('SELECT entry_quote_evidence FROM forward_test_evaluations WHERE id=$1',[entrySource])).rows[0].entry_quote_evidence;
   evidence.capacity.side='NO';evidence.evidenceDigest=canonicalEntryQuoteEvidenceDigest(evidence);
   await pool.query("UPDATE forward_test_evaluations SET btc_price=99990,signed_buffer=-10,velocity=-1,previous_side='UP',direction='DOWN',entry_quote_evidence=$2 WHERE id=$1",[entrySource,evidence]);
  }
  const parent=await s.executor.prepareEntry(entrySource);
  await s.executor.dispatch(parent);fill(s.evidence,await requestOf(parent),ownedQuantity);
  await s.executor.reconcile();
  async function exitFeed() {
    s.advance(1);const evaluation=await source(s.now);
    await pool.query(`UPDATE forward_test_evaluations SET btc_price=99999,signed_buffer=-1,absolute_buffer=1,
      velocity=-1,signal='EXIT',direction='UP',qualifying_trigger=false,fresh_cross=false WHERE id=$1`,[evaluation]);
    if(ownedSide==='NO')await pool.query("UPDATE forward_test_evaluations SET btc_price=100001,signed_buffer=1,absolute_buffer=1,velocity=1,direction='DOWN' WHERE id=$1",[evaluation]);
  }
  await exitFeed();
  const exit=await s.executor.prepareExit(parent,.4);
  const order=sealedFinancialProtectiveExitOrder({positionId:parent,market:"KXBTC15M-TEST-000",side:ownedSide,quantityHundredths:ownedQuantity,minimumExitMicros:400000},await requestOf(exit),s.book);
  const inspect: typeof import("./ownerFeeEmergencyExitRead").inspectOwnedEmergencyExitRead = async()=>({
    ok:false,reason:"test",tradingAuthorized:false,diagnosticEligible:true,needsIndependentApproval:true,
    verifiedPositionFp:(ownedSide==='NO'?'-':'')+formatContractHundredths(BigInt(ownedQuantity)),verifiedPositionObservedAtMs:s.now,
  });
  const lease={holderId:"worker",fencingToken:3};
  const reserve=()=>reserveOwnedEmergencyExitProof(USER,ACCOUNT,s.material,order,lease,{db:pool,inspect,now:()=>s.now});
  let reservationId:string|null=null;
  if(withMarker){const r=await reserve();assert.equal(r.reservationPrepared,true,r.reason);reservationId=r.reservationId!;}
  const mark=()=>markOwnedEmergencyExitUnknownForReview(USER,ACCOUNT,reservationId!,s.material,order,lease,{db:pool,inspect,now:()=>s.now});
  return {...s,parent,exit,order,exitFeed,reserve,mark,reservationId, get now(){return s.now;}};
}

test("owned stale PREPARED EXIT with absent marker is blocked without reducing exposure, and late reserve cannot create orphan",async()=>{
  const f=await protectiveFixture(false);
  const before=await f.executor.ledger.readAccount();
  const position=(await pool.query("SELECT * FROM v13_production_position WHERE id=$1",[f.parent])).rows[0];
  f.advance(15_001);await f.executor.reconcile();
  assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[f.exit])).rows[0].state,"BLOCKED");
  assert.equal((await f.executor.ledger.readAccount()).reserved_micros,before.reserved_micros);
  assert.equal((await f.executor.ledger.readAccount()).cash_micros,before.cash_micros);
  assert.deepEqual((await pool.query("SELECT * FROM v13_production_position WHERE id=$1",[f.parent])).rows[0],position);
  assert.equal((await f.reserve()).reservationPrepared,false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM private.strata_emergency_exit_reservations")).rows[0].n,0);
  await f.exitFeed();const next=await f.executor.prepareExit(f.parent,.4);
  assert.notEqual(next,f.exit);assert.equal(f.posts.length,1); // only original entry
});

test("owned coupled PREPARED EXIT and marker expire atomically to BLOCKED and VOID, never replaying old order",async()=>{
  const f=await protectiveFixture(true);const before=await f.executor.ledger.readAccount();
  f.advance(15_001);await f.executor.reconcile();
  assert.equal((await pool.query("SELECT state FROM private.strata_emergency_exit_reservations")).rows[0].state,"VOID");
  assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[f.exit])).rows[0].state,"BLOCKED");
  assert.equal((await f.executor.ledger.readAccount()).reserved_micros,before.reserved_micros);
  assert.equal((await f.mark()).unknownRecorded,false);
  await f.executor.dispatch(f.exit);assert.equal(f.posts.length,1);
});

test("protective marker winning before cleanup retains financial DISPATCHED/private UNKNOWN and inventory",async()=>{
  const f=await protectiveFixture(true);
  const marked=await f.mark();assert.equal(marked.unknownRecorded,true,marked.reason);
  f.advance(15_001);await f.executor.reconcile();
  assert.equal((await pool.query("SELECT state FROM private.strata_emergency_exit_reservations")).rows[0].state,"UNKNOWN");
  assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[f.exit])).rows[0].state,"DISPATCHED");
  assert.equal((await pool.query("SELECT quantity_hundredths FROM v13_production_position WHERE id=$1",[f.parent])).rows[0].quantity_hundredths,"200");
  assert.equal(f.posts.length,1);
});

test("coupled EXIT cleanup audit failure rolls back VOID and BLOCKED while retaining all exposure",async()=>{
  const f=await protectiveFixture(true);
  const observe=f.executor.ledger.observe.bind(f.executor.ledger);
  f.executor.ledger.observe=async(tx,kind,payload)=>{
    if(kind==="PROVEN_NOT_POSTED")throw Error("audit_write_failed");return await observe(tx,kind,payload);
  };
  f.advance(15_001);await assert.rejects(f.executor.reconcile(),/audit_write_failed/);
  assert.equal((await pool.query("SELECT state FROM private.strata_emergency_exit_reservations")).rows[0].state,"PREPARED");
  assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[f.exit])).rows[0].state,"PREPARED");
  assert.equal(f.posts.length,1);
});

test("private UNKNOWN paired with PREPARED financial inconsistency blocks cleanup",async()=>{
  const f=await protectiveFixture(true);
  await pool.query("UPDATE private.strata_emergency_exit_reservations SET state='UNKNOWN',updated_at=now()");
  f.advance(15_001);await assert.rejects(f.executor.reconcile(),/protective_prepared_expiry_marker_not_proven_unsent/);
  assert.equal((await pool.query("SELECT state FROM private.strata_emergency_exit_reservations")).rows[0].state,"UNKNOWN");
  assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[f.exit])).rows[0].state,"PREPARED");
});

test("concurrent protective marker and cleanup serialize without replay or deleting exposure",async()=>{
  for(let n=0;n<3;n++){
    const f=await protectiveFixture(true);f.advance(15_001);
    const [reconciled,marked]=await Promise.allSettled([f.executor.reconcile(),f.mark()]);
    assert.equal(marked.status,"fulfilled");
    const marker=(await pool.query("SELECT state FROM private.strata_emergency_exit_reservations")).rows[0].state;
    const financial=(await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[f.exit])).rows[0].state;
    if(marked.status==="fulfilled"&&marked.value.unknownRecorded){
      assert.equal(marker,"UNKNOWN");assert.equal(financial,"DISPATCHED");
    }else{
      assert.equal(reconciled.status,"fulfilled");assert.equal(marker,"VOID");assert.equal(financial,"BLOCKED");
    }
    assert.equal((await pool.query("SELECT quantity_hundredths FROM v13_production_position WHERE id=$1",[f.parent])).rows[0].quantity_hundredths,"200");
    assert.equal(f.posts.length,1);
  }
});

test("zero partial and full protective outcomes require terminal flat proof before continuation",async()=>{
  for(const qty of ["0","100","200"]){
    const f=await protectiveFixture(true,true);
    const gate=f.entryGate;
    gate.beginReconciliation();
    assert.equal((await f.mark()).unknownRecorded,true);
    const request=await requestOf(f.exit),orderId=`exit-${f.exit}`;
    f.advance(15_001);
    f.evidence.orders.push({orderId,request,terminal:true,filledHundredths:qty});
    if(qty!=="0"){
      const gross=BigInt(qty)*BigInt(request.limitMicros)/100n;
      f.evidence.fills.push({id:randomUUID(),orderId,clientOrderId:request.clientOrderId,
        market:request.market,side:request.side,action:"SELL",quantityHundredths:qty,
        priceMicros:request.limitMicros,grossMicros:String(gross),feeMicros:"0",occurredAtMs:f.now});
      f.evidence.cashMicros=String(BigInt(f.evidence.cashMicros)+gross);
      f.evidence.positions[0]!.quantityHundredths=String(200n-BigInt(qty));
    }
    await f.executor.reconcile();
    assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[f.exit])).rows[0].state,"TERMINAL");
    assert.equal((await pool.query("SELECT state FROM private.strata_emergency_exit_reservations")).rows[0].state,"UNKNOWN");
    assert.equal((await pool.query("SELECT quantity_hundredths FROM v13_production_position WHERE id=$1",[f.parent])).rows[0].quantity_hundredths,String(200n-BigInt(qty)));
    assert.equal(f.posts.length,1);
    assert.equal(gate.mayEnter(f.exchange.state.entriesAuthorized,false),false,"private UNKNOWN is always held");
    // Disposable fixture for a successful independent private GET recovery.
    // This changes only the test marker after exact terminal exchange evidence;
    // production uses its existing authenticated recovery implementation.
    await pool.query("UPDATE private.strata_emergency_exit_reservations SET state='RECONCILED',updated_at=now()");
    await f.executor.reconcile();
    assert.equal(gate.mayEnter(f.exchange.state.entriesAuthorized,false),qty==="200",
      "zero/partial exits retain exposure; only full flat reconciled exit resumes");
    if(qty==="200"){
      f.advance(1);
      const next=await f.executor.prepareEntry(await source(f.now));
      await f.executor.dispatch(next);
      assert.equal(f.posts.length,2,"next entry is separate, never exit replay");
      f.exchange.state.entriesAuthorized=false;
      gate.completeReconciliation(true);
      assert.equal(gate.mayEnter(f.exchange.state.entriesAuthorized,false),false,"STOP remains sticky");
    }
  }
});


test("mismatched immutable protective marker body blocks financial cleanup",async()=>{
  const f=await protectiveFixture(false);
  const raw=JSON.stringify({...f.order,count:"1.00"});
  await pool.query(`INSERT INTO private.strata_emergency_exit_reservations(
    reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,reducing_side,
    quantity_hundredths,order_digest,worker_fencing_token,worker_holder_id,initial_position_fp,
    position_observed_at_ms,order_request_json)
    VALUES($1,$2,$3,$4,$5,'YES',200,$6,3,'worker','2.00',$7,$8)`,
    [randomUUID(),USER,ACCOUNT,f.order.ticker,f.order.client_order_id,
      createHash("sha256").update(raw).digest("hex"),f.now,raw]);
  f.advance(15_001);
  await assert.rejects(f.executor.reconcile(),/protective_prepared_expiry_marker_not_proven_unsent/);
  assert.equal((await pool.query("SELECT state FROM private.strata_emergency_exit_reservations")).rows[0].state,"PREPARED");
  assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[f.exit])).rows[0].state,"PREPARED");
  assert.equal(f.posts.length,1);
});


test("final authority refresh cannot override a concurrent protective reservation",async()=>{
  // Only this disposable test fixture: isolate the read-gate table shape from
  // the preceding full reservation-transition tests, which enforce creation.
  await pool.query("DROP TABLE IF EXISTS private.strata_emergency_exit_reservations CASCADE");
  const s=await tradingSession(500,[],60_000_000_000,undefined,true);
  const id=await s.executor.prepareEntry(await source(s.now));
  await pool.query("INSERT INTO private.strata_emergency_exit_reservations(execution_account_id,state) VALUES($1,'UNKNOWN')",[ACCOUNT]);
  await assert.rejects(s.executor.dispatch(id),/production_other_uncertain_order/);
  assert.equal(s.posts.length,0);
  assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[id])).rows[0].state,"BLOCKED");
});

test("main owned financial seal/reserve/UNKNOWN uses exact .01/.50/1.50 without entry resizing",async()=>{
 for(const quantity of ['1','50','150']){
  const f=await protectiveFixture(true,false,quantity),request=await requestOf(f.exit);
  assert.equal(request.quantityVersion,'EXIT_HUNDREDTHS_V1');assert.equal(requestQuantityHundredths(request),BigInt(quantity));
  assert.equal(Object.hasOwn(request,'contracts'),false);assert.equal(f.order.count,formatContractHundredths(BigInt(quantity)));
  assert.equal((await requestOf(f.parent)).contracts,10,'ENTRY remains whole stake-sized');
  const marker=await f.mark();assert.equal(marker.unknownRecorded,true,marker.reason);
  const row=(await pool.query('SELECT state,quantity_hundredths FROM private.strata_emergency_exit_reservations')).rows[0];
  assert.equal(row.state,'UNKNOWN');assert.equal(row.quantity_hundredths,quantity);
  assert.equal((await pool.query('SELECT quantity_hundredths FROM v13_production_position WHERE id=$1',[f.parent])).rows[0].quantity_hundredths,quantity);
  assert.equal(f.posts.length,1,'only synthetic entry, no unauthorized exit replay');
 }
});

async function actualOwnedFinalFence(f:Awaited<ReturnType<typeof protectiveFixture>>) {
 await pool.query(`CREATE TABLE IF NOT EXISTS private.strata_standing_execution_reviews(release_id uuid,owner_user_id uuid,execution_account_id text,release_commit_sha text);
 CREATE TABLE IF NOT EXISTS private.strata_protective_exit_release(release_commit_sha text,state text,created_at timestamptz,expires_at timestamptz,revoked_at timestamptz,independent_reviewer_id uuid,operator_approver_id uuid);
 DELETE FROM private.strata_standing_execution_reviews;DELETE FROM private.strata_protective_exit_release;
 INSERT INTO private.strata_protective_exit_release VALUES('${'a'.repeat(40)}','approved',now()-interval '1 minute',now()+interval '1 hour',NULL,'33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444');`);
 await f.executor.ledger.transaction(async(tx)=>{await f.executor.ledger.observe(tx,'OWNER_ACTIVATION_REQUEST',{});});
 await pool.query("UPDATE private.kalshi_account_worker_lease SET heartbeat_at=now()");
 return {ownerId:USER,accountId:ACCOUNT,reservationId:f.reservationId!,material:f.material,order:f.order,lease:{holderId:'worker',fencingToken:3}};
}
test("actual owned signed route closes exact fractional quantities through real PG fence and durable outcome",async()=>{
 for(const side of ['YES','NO'] as const)for(const [quantity,filled] of [['1','1'],['50','50'],['150','150'],['150','25']]){
  const residual=BigInt(quantity!)-BigInt(filled!);
  const f=await protectiveFixture(true,false,quantity!,side),input=await actualOwnedFinalFence(f),original=globalThis.fetch;
  let posts=0;
  const receipt={order_id:'fractional-exit-'+quantity,client_order_id:f.order.client_order_id,fill_count:formatContractHundredths(BigInt(filled!)),remaining_count:'0.00',ts_ms:Date.now()};
  globalThis.fetch=(async(_url,init)=>{posts++;assert.equal(init?.method,'POST');assert.ok(new Headers(init?.headers).get('KALSHI-ACCESS-SIGNATURE'));
   const body=JSON.parse(String(init?.body));assert.equal(body.count,formatContractHundredths(BigInt(quantity!)));assert.equal(body.reduce_only,true);
   return new Response(JSON.stringify(receipt),{status:201});}) as typeof fetch;
  try{
   const result=await dispatchReviewedProtectiveExitOnce(input,{db:pool,mark:async()=>f.mark(),verifyFee:async()=>({ok:true,monetaryFeeAuthorized:true,marketTicker:f.order.ticker}) as any,
    readAuthenticatedOutcome:async()=>({clientOrderId:String(f.order.client_order_id),requestedCountFp:String(f.order.count),marketTicker:String(f.order.ticker),
      initialPositionFp:(side==='NO'?'-':'')+f.order.count,observedPositionFp:residual===0n?'0.00':(side==='NO'?'-':'')+formatContractHundredths(residual),positionMarketTicker:String(f.order.ticker),reducingBookSide:side==='YES'?'ask':'bid',
      completeExchangeHistory:true,exactMarketAndAccountMatched:true,orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
      authenticatedOrder:{order_id:receipt.order_id,client_order_id:f.order.client_order_id,status:'canceled',initial_count_fp:f.order.count,fill_count_fp:receipt.fill_count,remaining_count_fp:'0.00'},
      response:{httpStatus:201,...receipt}})});
   assert.equal(result.state,'RECONCILED',result.reason);assert.equal(result.filledHundredths,filled);assert.equal(posts,1);
   assert.equal((await pool.query('SELECT state FROM private.strata_emergency_exit_reservations')).rows[0].state,'RECONCILED');
   fill(f.evidence,await requestOf(f.exit),filled!);f.advance(1);await f.executor.reconcile();
   assert.equal((await pool.query('SELECT quantity_hundredths FROM v13_production_position WHERE id=$1',[f.parent])).rows[0].quantity_hundredths,residual.toString());
   if(residual>0n){await f.exitFeed();const next=await f.executor.prepareExit(f.parent,.4);assert.notEqual(next,f.exit);assert.equal(requestQuantityHundredths(await requestOf(next)),residual);}
   const again=await dispatchReviewedProtectiveExitOnce(input,{db:pool,mark:async()=>f.mark(),verifyFee:async()=>({ok:true,monetaryFeeAuthorized:true,marketTicker:f.order.ticker}) as any});
   assert.equal(again.postAttempted,false);assert.equal(posts,1);
  }finally{globalThis.fetch=original;}
 }
});
test("actual fractional exit transport uncertainty remains UNKNOWN and never replays",async()=>{
 const f=await protectiveFixture(true,false,'50'),input=await actualOwnedFinalFence(f),original=globalThis.fetch;let posts=0;
 globalThis.fetch=(async()=>{posts++;throw Error('synthetic timeout after send');}) as typeof fetch;
 try{const ports={db:pool,mark:async()=>f.mark(),verifyFee:async()=>({ok:true,monetaryFeeAuthorized:true,marketTicker:f.order.ticker}) as any};
  const result=await dispatchReviewedProtectiveExitOnce(input,ports);assert.equal(result.state,'UNKNOWN');assert.equal(result.postAttempted,true);
  assert.equal((await dispatchReviewedProtectiveExitOnce(input,ports)).postAttempted,false);assert.equal(posts,1);
  assert.equal((await pool.query('SELECT quantity_hundredths FROM v13_production_position WHERE id=$1',[f.parent])).rows[0].quantity_hundredths,'50');
 }finally{globalThis.fetch=original;}
});
test("actual fractional final fee no-send preserves inventory and durably permits fresh identity",async()=>{
 const f=await protectiveFixture(true,false,'1'),input=await actualOwnedFinalFence(f);let checks=0,posts=0;
 const result=await dispatchReviewedProtectiveExitOnce(input,{db:pool,mark:async()=>f.mark(),verifyFee:async()=>({ok:++checks===1,monetaryFeeAuthorized:checks===1,marketTicker:f.order.ticker}) as any,post:async()=>{posts++;throw Error('must not post');}});
 assert.equal(result.postAttempted,false);assert.equal(posts,0);
 assert.equal((await pool.query('SELECT state FROM private.strata_emergency_exit_reservations')).rows[0].state,'VOID');
 assert.equal((await pool.query('SELECT state FROM v13_production_intent WHERE id=$1',[f.exit])).rows[0].state,'BLOCKED');
 f.advance(1);await f.executor.reconcile();await f.exitFeed();assert.notEqual(await f.executor.prepareExit(f.parent,.4),f.exit);
 assert.equal((await pool.query('SELECT quantity_hundredths FROM v13_production_position WHERE id=$1',[f.parent])).rows[0].quantity_hundredths,'1');
});
test("actual fractional final signed fence rejects post-marker quantity, side and price mutation",async()=>{
 for(const mutation of [{quantityHundredths:'1'},{side:'NO'},{limitMicros:440000}]){
  const f=await protectiveFixture(true,false,'50'),input=await actualOwnedFinalFence(f);let checks=0,posts=0;
  const result=await dispatchReviewedProtectiveExitOnce(input,{db:pool,mark:async()=>f.mark(),verifyFee:async()=>{
   if(++checks===2)await pool.query('UPDATE v13_production_intent SET request=request || $2::jsonb WHERE id=$1',[f.exit,JSON.stringify(mutation)]);
   return {ok:true,monetaryFeeAuthorized:true,marketTicker:f.order.ticker} as any;
  },post:async()=>{posts++;throw Error('must not send changed identity');}});
  assert.equal(posts,0);assert.equal(result.postAttempted,false);assert.equal(result.state,'UNKNOWN');
  assert.equal((await pool.query('SELECT state FROM private.strata_emergency_exit_reservations')).rows[0].state,'UNKNOWN');
 }
});

// Local audit fixture exports; not a runtime change.
export {tradingSession,protectiveFixture,source,requestOf,fill,policy,USER,ACCOUNT};

test('owned ledger inherits batched transaction start without changing scoped policy, locks or fake-transport outcome',async()=>{
 const runs=[];
 for(const baseline of [true,false]){
  const posts:string[]=[];const s=await tradingSession(500,posts);let requests=0,batches=0;
  const counted=new Proxy(pool,{get(target,key){
   if(key==='connect')return async()=>{const c=await target.connect();return new Proxy(c,{get(client,k){
    if(k==='query')return async(...args:unknown[])=>{
     if(String(args[0]).startsWith('BEGIN; SELECT * FROM v13_production_account')){
      batches++;if(baseline){requests+=2;return [await c.query('BEGIN'),await c.query('SELECT * FROM v13_production_account WHERE id=$1 FOR UPDATE',[ACCOUNT])]}
     }
     requests++;return Reflect.apply(c.query,c,args);
    };
    const value=Reflect.get(client,k);return typeof value==='function'?value.bind(client):value;
   }})};
   if(key==='query')return(...args:unknown[])=>{requests++;return Reflect.apply(target.query,target,args)};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  Object.defineProperty(s.executor.ledger,'pool',{value:counted});
  assert.equal(s.executor.ledger.constructor.name,'OwnedAccountLedger');
  await s.executor.reconcile();
  const id=await s.executor.prepareEntry(await source(s.now));
  await s.executor.dispatch(id);
  const row=(await pool.query('SELECT state,reserved_micros FROM v13_production_intent WHERE id=$1',[id])).rows[0];
  assert.equal(row.state,'UNKNOWN');assert.equal(posts.length,1);assert.ok(BigInt(row.reserved_micros)>0n);
  assert.equal(s.executor.ledger.currentTransaction(),null);
  runs.push({requests,batches,state:row.state,posts:posts.length});
 }
 assert.equal(runs[0].batches,4);assert.equal(runs[1].batches,4);
 assert.equal(runs[0].requests-runs[1].requests,4);
 console.log('OWNED_LEDGER_TRANSACTION_START_PROOF',JSON.stringify({scope:'real owned ledger/PG, fixture market/signed snapshot/raw HTTP; not production authority or fills',baseline:runs[0],batched:runs[1]}));
});

import {CommittedPublicMetadataCoordinator,type MetadataPrefetchAttempt} from "./committedPublicMetadata";
import {readOwnedEntryMarket} from "./ownedEntryMarketRead";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";
import {createEntryWireClockFetch} from "./entryWireClock";

test("enabled public prefetch through actual supervisor reader + owned executor: original captures, real PG prepare/final gates, fresh final reads and no-send refusals",async()=>{
 for(const mode of ["success","fence","release","final-metadata-change","final-authority-revoked"]){
  const posts:string[]=[],s=await tradingSession(500,posts);
  const approved={...policy(),maxQuoteAgeMs:5000};approved.policyHash=computeV13LiveMoneyPolicyHash(approved);
  await pool.query("UPDATE v13_live_money_policy SET max_quote_age_ms=5000,policy_hash=$1 WHERE id=$2",[approved.policyHash,approved.id]);
  const evaluationId=await source(s.now),originalAt=s.now,market="KXBTC15M-TEST-000",event="KXBTC15M-TEST";
  const close=new Date(s.now+900_000).toISOString(),open=new Date(s.now-1000).toISOString();
  const pages:Record<string,any>={
    [`/markets/${market}`]:{market:{ticker:market,event_ticker:event,exchange_index:2,status:"active",open_time:open,close_time:close,expiration_time:close,expected_expiration_time:close,latest_expiration_time:close,price_level_structure:"deci_cent"}},
    [`/events/${event}`]:{event:{event_ticker:event,series_ticker:"KXBTC15M",exchange_index:2,fee_type_override:null,fee_multiplier_override:null}},
    "/series/KXBTC15M":{series:{ticker:"KXBTC15M",exchange_index:2,fee_type:"quadratic",fee_multiplier:1}},
    "/series/fee_changes?series_ticker=KXBTC15M&show_historical=false":{series_fee_change_arr:[]},
    [`/events/fee_changes?event_ticker=${event}&limit=100`]:{event_fee_changes:[],cursor:""},
  };
  const calls:string[]=[],contexts:unknown[]=[];let books=0,fees=0,signed=0,finalAuthority=0,authorityOpen=true;
  const fetchPublic=(async(input,init)=>{const path=String(input).replace("https://external-api.kalshi.com/trade-api/v2","");assert.equal(init?.method,"GET");assert.ok(path in pages);calls.push(path);return Response.json(pages[path]);}) as typeof fetch;
  const coordinator=new CommittedPublicMetadataCoordinator(fetchPublic,()=>s.now,()=>0);
  const binding={accountId:ACCOUNT,ownerId:USER,holderId:"fixture-holder",releaseSha:"a".repeat(40),fence:"3",policyHash:approved.policyHash!};
  const hint={evaluationId,marketTicker:market,evaluatedAtMs:originalAt,committedAtMs:originalAt,btcProviderAgeMs:0,btcReceiveAgeMs:0,marketAgeMs:0,qualifyingTrigger:true as const};
  const attempt=coordinator.start(binding,hint)!;assert.ok(attempt);
  let active:MetadataPrefetchAttempt|null=attempt;
  const originalSnapshot=s.exchange.readSnapshot!;let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let reconciled=false;
  Object.defineProperty(s.exchange,"readSnapshot",{value:async(...args:Parameters<typeof originalSnapshot>)=>{signed++;if(signed===1)await held;return originalSnapshot(...args);}});
  const reconciling=s.executor.reconcile().then(()=>{reconciled=true;});
  await attempt.drained;assert.equal(reconciled,false);assert.equal(calls.length,5);release();await reconciling;attempt.pause();s.advance(200);
  Object.defineProperty(s.exchange,"readMarket",{value:(ticker:string,side:"YES"|"NO",context:import("../v13-production/types").EntryPrepareMarketContext|undefined)=>{
    contexts.push(context);
    return readOwnedEntryMarket({market:ticker,side,context,now:()=>s.now,apiSource:true,activeMetadata:active,
      metadataScope:()=>binding,publicFetch:fetchPublic,
      verifyFee:async(_clock,read,capture)=>{fees++;const observation=await probeCurrentKalshiFeeApi(fetchPublic,()=>s.now,ticker,read,capture);if(!observation.ok)throw Error(observation.reason);return Date.parse(observation.liveVerifiedAt!);},
      readBook:async()=>{books++;return {orderbook_fp:{yes_dollars:[["0.5000","100000"]],no_dollars:[["0.5000","100000"]]}};},
      readPublic:async()=>{throw Error("unexpected_public_fallback");},configuredStakeCents:500,
      policyVersion:approved.feePolicyVersion!,sourceUrl:approved.feeSourceUrl!,formulaVersion:approved.feeFormulaVersion!,artifactDigest:"d".repeat(64),policyHash:approved.policyHash!,
    });
  }});
  const originalTransport=s.exchange.fetchImpl!;
  Object.defineProperty(s.exchange,"fetchImpl",{value:createEntryWireClockFetch(()=>s.executor.ledger.assertFinalWireClock(),originalTransport)});
  s.executor.authorizeFinalEntry=async()=>{finalAuthority++;if(!authorityOpen)throw Error("production_entry_release_not_current");};
  if(mode==="fence")binding.fence="4";
  if(mode==="release")binding.releaseSha="b".repeat(40);
  if(mode==="fence"||mode==="release"){
    await assert.rejects(s.executor.prepareEntry(evaluationId));assert.equal(calls.length,5,mode+" must not fallback/retry");assert.equal(posts.length,0);attempt.discard();await attempt.drained;continue;
  }
  const id=await s.executor.prepareEntry(evaluationId);
  const decision=(await pool.query("SELECT decision FROM v13_production_intent WHERE id=$1",[id])).rows[0].decision;
  assert.equal(decision.book.publicMetadataCapture.observedAtMs,originalAt);assert.equal(decision.book.fee.verifiedAtMs,originalAt);
  assert.equal(decision.book.observedAtMs,s.now);assert.equal(new Date(decision.source.evaluated_at).getTime(),originalAt);
  assert.equal(calls.length,5);assert.equal(books,1);assert.equal(fees,1);
  if(mode==="final-metadata-change")pages["/series/KXBTC15M"].series.fee_multiplier=2;
  if(mode==="final-authority-revoked")authorityOpen=false;
  if(mode==="success")await s.executor.dispatch(id);else await assert.rejects(s.executor.dispatch(id));
  if(mode==="final-authority-revoked"){
    assert.equal(contexts.length,1,"earlier final authority denial must precede even fresh final provider reads");
    assert.equal(calls.length,5);assert.equal(books,1);assert.equal(fees,1);
  }else{
    assert.equal(contexts.length,2);assert.ok(contexts[0]);assert.equal(contexts[1],undefined,"real final executor call has no prepare context");
    assert.equal(calls.length,10);assert.equal(books,2);assert.equal(fees,2);
  }
  assert.equal(posts.length,mode==="success"?1:0);
  if(mode==="success"){assert.ok(finalAuthority>=1);assert.equal(signed,2,"mandatory reconciliation + independently fresh final signed account snapshot");assert.equal((await pool.query("SELECT state FROM v13_production_intent WHERE id=$1",[id])).rows[0].state,"UNKNOWN");}
  attempt.discard();await attempt.drained;active=null;
 }
});

import {notifyCommittedForwardSignal} from "../forwardTestSignalWake";
import {recordLiveSignalDecision} from "../v13-production/signalDecisionTrace";
test("enabled/disabled identical-delay replay through actual worker, supervisor reader, owned executor and fake wire",async()=>{
 const outcomes:Array<Record<string,number|boolean|string>>=[];
 const fixtureOpen=new Date(Date.now()-60_000).toISOString(),fixtureClose=new Date(Date.now()+900_000).toISOString();
 const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
 const until=async(check:()=>boolean)=>{const deadline=performance.now()+10_000;while(!check()){if(performance.now()>deadline)throw Error("prefetch_worker_fixture_timeout");await delay(5);}};
 for(const enabled of [false,true]){
  const posts:string[]=[],s=await tradingSession(500,posts);
  // Real mandatory decision receipts, with explicit offline release identity.
  // Optional historical catch-up is out of this latency fixture's scope.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS private;
    CREATE TABLE IF NOT EXISTS private.strata_v13_signal_decisions (
      decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      execution_account_id text NOT NULL,evaluation_id text NOT NULL REFERENCES forward_test_evaluations(id),
      observed_at timestamptz NOT NULL DEFAULT now(),phase text NOT NULL,source_age_ms integer,
      reason text,release_commit_sha text NOT NULL,UNIQUE(execution_account_id,evaluation_id,phase))`);
  s.worker.signalTrace!.record=decision=>recordLiveSignalDecision(decision,pool,"a".repeat(40));
  s.worker.signalTrace!.sweep=async()=>0;
  const approved={...policy(),maxQuoteAgeMs:5000};approved.policyHash=computeV13LiveMoneyPolicyHash(approved);
  await pool.query("UPDATE v13_live_money_policy SET max_quote_age_ms=5000,policy_hash=$1 WHERE id=$2",[approved.policyHash,approved.id]);
  const evaluationId=await source(s.now),evaluatedAt=s.now,market="KXBTC15M-TEST-000",event="KXBTC15M-TEST";
  // Preserve the recorded 02:31 source's initial 1163ms BTC age and 787ms
  // producer commit delay. Remaining provider delays below are synthetic.
  await pool.query("UPDATE forward_test_evaluations SET btc_provider_age_ms=1163 WHERE id=$1",[evaluationId]);
  s.advance(787);const committedAt=s.now;
  const anchor=performance.now();let eligibilityReads=0;
  const clockValue=()=>{const value=committedAt+Math.floor(performance.now()-anchor);if(value>s.now)s.advance(value-s.now);return s.now;};
  const clock=()=>{eligibilityReads++;return clockValue();};
  Object.defineProperty(s.executor,"now",{value:clock});
  const end=fixtureClose;
  const pages:Record<string,unknown>={
    [`/markets/${market}`]:{market:{ticker:market,event_ticker:event,exchange_index:2,status:"active",open_time:fixtureOpen,close_time:end,expiration_time:end,expected_expiration_time:end,latest_expiration_time:end,price_level_structure:"deci_cent"}},
    [`/events/${event}`]:{event:{event_ticker:event,series_ticker:"KXBTC15M",exchange_index:2}},
    "/series/KXBTC15M":{series:{ticker:"KXBTC15M",exchange_index:2,fee_type:"quadratic",fee_multiplier:1}},
    "/series/fee_changes?series_ticker=KXBTC15M&show_historical=false":{series_fee_change_arr:[]},
    [`/events/fee_changes?event_ticker=${event}&limit=100`]:{event_fee_changes:[],cursor:""},
  };
  const calls:Array<{path:string;at:number}>=[];
  const publicFetch=(async(input)=>{const path=String(input).replace("https://external-api.kalshi.com/trade-api/v2","");calls.push({path,at:performance.now()-anchor});assert.ok(path in pages);await delay(80);clockValue();return Response.json(pages[path]);}) as typeof fetch;
  const coordinator=new CommittedPublicMetadataCoordinator(publicFetch,clockValue,()=>performance.now());
  const binding={accountId:ACCOUNT,ownerId:USER,holderId:"fixture-holder",releaseSha:"a".repeat(40),fence:"3",policyHash:approved.policyHash!};
  let active:MetadataPrefetchAttempt|null=null,signed=0,fees=0,books=0,wireAt=0,initialMs=0,reconcileFinishedAt=0;
  if(enabled)s.executor.prefetchCommittedPublicMetadata=h=>{active=coordinator.start(binding,h);return active;};
  const originalSnapshot=s.exchange.readSnapshot!;
  Object.defineProperty(s.exchange,"readSnapshot",{value:async(...args:Parameters<typeof originalSnapshot>)=>{signed++;await delay(300);clockValue();if(signed===1)reconcileFinishedAt=performance.now()-anchor;return originalSnapshot(...args);}});
  Object.defineProperty(s.exchange,"readMarket",{value:async(ticker:string,side:"YES"|"NO",context:import("../v13-production/types").EntryPrepareMarketContext|undefined)=>{
    const started=performance.now();
    const result=await readOwnedEntryMarket({market:ticker,side,context,now:clock,apiSource:true,activeMetadata:active,metadataScope:()=>binding,publicFetch,
      verifyFee:async(_clock,read,capture)=>{fees++;const observed=await probeCurrentKalshiFeeApi(publicFetch,clock,ticker,read,capture);if(!observed.ok)throw Error(observed.reason);await delay(40);clockValue();return Date.parse(observed.liveVerifiedAt!);},
      readBook:async()=>{books++;await delay(60);clockValue();return {orderbook_fp:{yes_dollars:[["0.5000","100000"]],no_dollars:[["0.5000","100000"]]}};},
      readPublic:async()=>{throw Error("unexpected_public_fallback");},configuredStakeCents:500,
      policyVersion:approved.feePolicyVersion!,sourceUrl:approved.feeSourceUrl!,formulaVersion:approved.feeFormulaVersion!,artifactDigest:"d".repeat(64),policyHash:approved.policyHash!,
    });
    if(context)initialMs=performance.now()-started;return result;
  }});
  s.executor.authorizeFinalEntry=async()=>{}; // Explicit fixture authority; never real consent or release.
  const transport=s.exchange.fetchImpl!;
  Object.defineProperty(s.exchange,"fetchImpl",{value:createEntryWireClockFetch(()=>s.executor.ledger.assertFinalWireClock(),async(input,init)=>{
    wireAt=clockValue()-evaluatedAt;const response=await transport(input,init);s.worker.stop();return response;
  })});
  try{
    (s.worker as unknown as {schedule():void}).schedule();await until(()=>signed===1);
    notifyCommittedForwardSignal({evaluationId,marketTicker:market,evaluatedAtMs:evaluatedAt,committedAtMs:clockValue(),btcProviderAgeMs:1163,btcReceiveAgeMs:0,marketAgeMs:0,qualifyingTrigger:true});
    await until(()=>posts.length===1);await until(()=>!(s.worker as unknown as {running:boolean}).running);
    const row=(await pool.query("SELECT state,decision,request FROM v13_production_intent WHERE evaluation_id=$1",[evaluationId])).rows[0];
    assert.equal(row.state,"UNKNOWN","fake HTTP acceptance is never fabricated exchange ACK/fill evidence");
    assert.equal(new Date(row.decision.source.evaluated_at).getTime(),evaluatedAt);assert.equal(row.decision.source.btc_provider_age_ms,1163);
    assert.equal(calls.length,10);assert.equal(books,2);assert.equal(fees,2);assert.equal(signed,2);assert.ok(wireAt>=787&&wireAt+1163<=5000);
    if(enabled){assert.ok(calls.slice(0,5).every(c=>c.at<reconcileFinishedAt));assert.ok(row.decision.book.publicMetadataCapture);assert.equal(row.decision.book.fee.verifiedAtMs,row.decision.book.publicMetadataCapture.observedAtMs);assert.ok(row.decision.book.fee.verifiedAtMs<row.decision.book.observedAtMs);}
    else {assert.ok(calls[0]!.at>=reconcileFinishedAt);assert.equal(row.decision.book.publicMetadataCapture,undefined);}
    outcomes.push({enabled,initialEvidenceMs:initialMs,wireSourceAgeMs:wireAt,effectiveBtcAgeMs:wireAt+1163,
      eligibilityReads,publicCalls:calls.length,signedSnapshots:signed,state:row.state,
      requestShape:JSON.stringify({...row.request,clientOrderId:null}),
      plannedAllInCents:row.decision.preflight.plannedAllInCents,cashModel:row.decision.book.fee.cashRisk.modelFingerprint});
  }finally{s.worker.stop();(active as MetadataPrefetchAttempt|null)?.discard();}
 }
 assert.equal(outcomes[0]!.eligibilityReads,outcomes[1]!.eligibilityReads,"prefetch must add no eligibility clock samples");
 assert.equal(outcomes[0]!.requestShape,outcomes[1]!.requestShape);assert.equal(outcomes[0]!.plannedAllInCents,outcomes[1]!.plannedAllInCents);assert.equal(outcomes[0]!.cashModel,outcomes[1]!.cashModel);
 assert.ok(Number(outcomes[1]!.initialEvidenceMs)<Number(outcomes[0]!.initialEvidenceMs),"same delays must actually overlap, not just rename a cache");
 console.info("PUBLIC_PREFETCH_IDENTICAL_DELAY_REPLAY",JSON.stringify({delaysMs:{public:80,signedBook:60,feeAuthority:40,signedAccount:300},outcomes,scope:"offline mocked provider/fee authority; actual worker/reader/ledger/executor/wire guard; not production savings"}));
});

async function staleRetryFixture(maxAge=5000) {
 const posts:string[]=[],s=await tradingSession(500,posts);
 const approved={...policy(),maxQuoteAgeMs:maxAge};approved.policyHash=computeV13LiveMoneyPolicyHash(approved);
 await pool.query("UPDATE v13_live_money_policy SET max_quote_age_ms=$1,policy_hash=$2 WHERE id=$3",[maxAge,approved.policyHash,approved.id]);
 s.book.fee=entryCashRiskFeeFixture({now:s.now,market:"KXBTC15M-TEST-000",side:"YES",price:.5,contracts:10,policyHash:approved.policyHash!});
 const id=await source(s.now);let reads=0;
 const original=s.exchange.market.bind(s.exchange);
 Object.defineProperty(s.exchange,"market",{value:async(...args:Parameters<typeof original>)=>{reads++;return original(...args);},configurable:true});
 return {s,id,get reads(){return reads;}};
}

test("stale retry: each original feed age preserves inclusive 5000 boundary and skips all market/fee work at 5001",async()=>{
 for(const field of ["btc_provider_age_ms","btc_receive_age_ms","market_age_ms"]){
  for(const effective of [5000,5001]){
   const f=await staleRetryFixture();await pool.query(`UPDATE forward_test_evaluations SET ${field}=$2 WHERE id=$1`,[f.id,effective-4000]);f.s.advance(4000);
   let clocks=0;Object.defineProperty(f.s.executor,"now",{value:()=>{clocks++;return f.s.now;}});
   if(effective===5000){const intent=await f.s.executor.prepareEntry(f.id);assert.ok(intent);assert.equal(f.reads,1);}
   else{await assert.rejects(f.s.executor.prepareEntry(f.id),/production_source_feed_stale_or_changed/);assert.equal(f.reads,0);assert.equal(clocks,4,"canonical sample + two reconciliation checks + admission; no added clock");}
   assert.equal(f.s.posts.length,0);
  }
 }
});

test("stale retry: existing PREPARED UNKNOWN and TERMINAL intents replay without another reservation or provider read",async()=>{
 for(const state of ["PREPARED","UNKNOWN","TERMINAL"]){
  const f=await staleRetryFixture();const intent=await f.s.executor.prepareEntry(f.id);
  await pool.query("UPDATE v13_production_intent SET state=$2,terminal=$3 WHERE id=$1",[intent,state,state==="TERMINAL"]);
  await pool.query("UPDATE forward_test_evaluations SET btc_provider_age_ms=1001 WHERE id=$1",[f.id]);f.s.advance(4000);
  const before=(await pool.query("SELECT reserved_micros,revision FROM v13_production_account WHERE id=$1",[ACCOUNT])).rows[0];
  assert.equal(await f.s.executor.prepareEntry(f.id),intent);assert.equal(f.reads,1);
  assert.deepEqual((await pool.query("SELECT reserved_micros,revision FROM v13_production_account WHERE id=$1",[ACCOUNT])).rows[0],before);
  assert.equal(f.s.posts.length,0);
 }
});

test("stale retry: authoritative account policy and source denials precede stale without market evidence",async()=>{
 for(const mode of ["kill","frozen","revoked","wrong-policy","changed-source","unknown"]){
  const f=await staleRetryFixture();
  if(mode==="unknown") {const other=await source(f.s.now);const intent=await f.s.executor.prepareEntry(other);await pool.query("UPDATE v13_production_intent SET state='UNKNOWN' WHERE id=$1",[intent]);}
  await pool.query("UPDATE forward_test_evaluations SET btc_provider_age_ms=1001 WHERE id=$1",[f.id]);f.s.advance(4000);const beforeReads=f.reads;
  const reasons:Record<string,string>={kill:"production_authority_disabled_or_uncommissioned",frozen:"production_account_frozen",revoked:"production_policy_missing","wrong-policy":"production_entry_policy_revision_not_approved","changed-source":"production_source_feed_stale_or_changed",unknown:"production_uncertain_order_blocks_mutation"};
  if(mode==="kill")await pool.query("UPDATE v13_production_account SET kill_switch=true WHERE id=$1",[ACCOUNT]);
  if(mode==="frozen")await pool.query("UPDATE v13_production_account SET blocked_reason='test' WHERE id=$1",[ACCOUNT]);
  if(mode==="revoked")await pool.query("UPDATE v13_live_money_policy SET state='REVOKED' WHERE id='policy-personal'");
  if(mode==="wrong-policy")await pool.query("UPDATE forward_test_evaluations SET entry_policy_version='not-approved' WHERE id=$1",[f.id]);
  if(mode==="changed-source"){
   const original=f.s.executor.ledger.transaction.bind(f.s.executor.ledger);
   Object.defineProperty(f.s.executor.ledger,"transaction",{value:async(...args:Parameters<typeof original>)=>{await pool.query("UPDATE forward_test_evaluations SET reason='changed' WHERE id=$1",[f.id]);return original(...args);}});
  }
  await assert.rejects(f.s.executor.prepareEntry(f.id),new RegExp(reasons[mode]!));assert.equal(f.reads,beforeReads);assert.equal(f.s.posts.length,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM v13_production_intent WHERE evaluation_id=$1",[f.id])).rows[0].n,0);
 }
});

test("stale retry: wider approved policy falls back outside locks and repeats STOP gate after real read",async()=>{
 for(const stop of [false,true]){
  const f=await staleRetryFixture(15000);await pool.query("UPDATE forward_test_evaluations SET btc_provider_age_ms=1001 WHERE id=$1",[f.id]);f.s.advance(4000);
  const original=f.s.exchange.market.bind(f.s.exchange);
  Object.defineProperty(f.s.exchange,"market",{value:async(...args:Parameters<typeof original>)=>{
   // A separate connection can acquire the account row: no DB lock held over network.
   const client=await pool.connect();try{await client.query("BEGIN; SET LOCAL lock_timeout='100ms'");await client.query("SELECT id FROM v13_production_account WHERE id=$1 FOR UPDATE",[ACCOUNT]);if(stop)await client.query("UPDATE v13_production_account SET kill_switch=true WHERE id=$1",[ACCOUNT]);await client.query("COMMIT");}finally{client.release();}
   return original(...args);
  }});
  if(stop)await assert.rejects(f.s.executor.prepareEntry(f.id),/production_authority_disabled_or_uncommissioned/);
  else assert.ok(await f.s.executor.prepareEntry(f.id));
  assert.equal(f.reads,1);assert.equal(f.s.posts.length,0);
 }
});

test("stale retry: observed expiry cannot be erased by clock rollback, provider failure no longer masks stale",async()=>{
 const f=await staleRetryFixture();await pool.query("UPDATE forward_test_evaluations SET btc_provider_age_ms=1001 WHERE id=$1",[f.id]);f.s.advance(4000);
 let calls=0;Object.defineProperty(f.s.executor,"now",{value:()=>{calls++;return f.s.now-(calls===1?0:1000);}});
 Object.defineProperty(f.s.exchange,"market",{value:async()=>{throw Error("provider_failure_must_not_run");}});
 await assert.rejects(f.s.executor.prepareEntry(f.id),/production_source_feed_stale_or_changed/);assert.equal(f.s.posts.length,0);
});

test("stale retry: invalid current-policy window still denies before stale, concurrent stale callers create nothing",async()=>{
 const f=await staleRetryFixture();const p={...policy(),maxQuoteAgeMs:5000,entryPolicyVersion:V13_ENTRY_POLICY_VERSION};p.policyHash=computeV13LiveMoneyPolicyHash(p);
 await pool.query("UPDATE v13_live_money_policy SET entry_policy_version=$1,policy_hash=$2 WHERE id=$3",[V13_ENTRY_POLICY_VERSION,p.policyHash,p.id]);
 await pool.query("UPDATE forward_test_evaluations SET entry_policy_version=$2,crossing_key=market_ticker||':first',btc_provider_age_ms=1001 WHERE id=$1",[f.id,V13_ENTRY_POLICY_VERSION]);f.s.advance(4000);
 await assert.rejects(f.s.executor.prepareEntry(f.id),/production_entry_window_or_claim_not_current/);assert.equal(f.reads,0);
 const g=await staleRetryFixture();await pool.query("UPDATE forward_test_evaluations SET market_age_ms=1001 WHERE id=$1",[g.id]);g.s.advance(4000);
 const results=await Promise.allSettled([g.s.executor.prepareEntry(g.id),g.s.executor.prepareEntry(g.id)]);
 for(const result of results){assert.equal(result.status,"rejected");if(result.status==="rejected")assert.match(String(result.reason),/production_source_feed_stale_or_changed/);}
 assert.equal(g.reads,0);assert.equal(g.s.posts.length,0);
 assert.equal((await pool.query("SELECT count(*)::int n FROM v13_production_intent WHERE account_id=$1",[ACCOUNT])).rows[0].n,0);
 assert.equal((await pool.query("SELECT reserved_micros FROM v13_production_account WHERE id=$1",[ACCOUNT])).rows[0].reserved_micros,"0");
});
