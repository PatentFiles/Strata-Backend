import assert from "node:assert/strict";
import test, { after } from "node:test";
import { pool } from "@workspace/db";
import { randomUUID, generateKeyPairSync, createHash } from "node:crypto";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET,
  V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { computeV13LiveMoneyPolicyHash, type V13ApprovedLiveMoneyPolicy } from "../v13LiveMoneyRisk";
import { ProductionLedger, identity } from "./ledger";
import { ProductionExecutor } from "./executor";
import { ProductionWorker } from "./worker";
import { encodeProductionOrder, KalshiProductionExchange } from "./transport";
import type { Exchange, Fill, Identity, MarketEvidence, Request, Snapshot } from "./types";

const url = process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url && /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url), "explicit disposable cluster required");
after(() => pool.end());
function policy(): V13ApprovedLiveMoneyPolicy {
  const p: V13ApprovedLiveMoneyPolicy = {
    id: "production-test", version: 1, supersedesPolicyId: null, state: "APPROVED",
    strategyVersion: "V1.3", strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH, championSelectionReviewId: "test-review",
    championSelectionEvidenceHash: "a".repeat(64), championSelectedBy: "simulated-owner",
    championSelectedAt: new Date(0), capitalLimitCents: 10_000, maxEntryStakeCents: 500,
    maxEntryAllInCents: 550, maxOpenPositions: 1, maxDailyLossCents: 1000, maxTotalLossCents: 2000,
    maxQuoteAgeMs: 15_000, maxFeeEvidenceAgeMs: 15_000,
    feePolicyVersion: "test-fees", feeSourceUrl: "https://invalid.test/fees", feeFormulaVersion: "test-v1",
    requireFullDepth: true, entryTimeInForce: "IOC", entryLimitSource: "SIGNAL_REFERENCE_OFFER",
    policyHash: null, createdBy: "simulated-owner", approvedBy: "simulated-owner", approvedAt: new Date(1),
  };
  p.policyHash = computeV13LiveMoneyPolicyHash(p);
  return p;
}
class SimulatedExchange implements Exchange {
  readonly mode = "SIMULATION" as const;
  posts: Request[] = []; cancels: string[] = [];
  throwPost = false; throwCancel = false; beforePost: (() => Promise<void>) | null = null;
  now = Date.now();
  book: MarketEvidence = {
    observedAtMs: this.now, bestAskDollars: "0.5000", asks: [{ priceDollars: "0.5000", availableContracts: "10" }],
    bestBidDollars: "0.4500", bids: [{ priceDollars: "0.4500", availableContracts: "10" }],
    fee: { policyVersion: "test-fees", sourceUrl: "https://invalid.test/fees", formulaVersion: "test-v1",
      fingerprint: "test-fingerprint-0000001", verifiedAtMs: this.now, contracts: 10, limitPrice: 0.5,
      reservedEntryFeeCents: 2, reservedExitFeeCents: 3 },
  };
  evidence: Snapshot = {
    identity: { subaccount: 1, exchangeIndex: 2, keyFingerprint: "b".repeat(64) },
    observedAtMs: this.now, authenticated: true, complete: true, historyFromMs: 0,
    cashMicros: "100000000", cashExact: true, orders: [], fills: [], settlements: [], positions: [],
    unexplainedCashActivity: false,
  };
  async market() { return structuredClone(this.book); }
  async snapshot(_identity: Identity) { return structuredClone(this.evidence); }
  async submit(request: Request, finalCheck: () => Promise<void>) {
    if (this.beforePost) await this.beforePost();
    await finalCheck();
    this.posts.push(structuredClone(request));
    if (this.throwPost) throw new Error("simulated_timeout_after_acceptance");
    return { orderId: `order-${request.clientOrderId}` };
  }
  async cancel(id: string, finalCheck: () => Promise<void>) {
    await finalCheck(); this.cancels.push(id);
    if (this.throwCancel) throw new Error("simulated_cancel_timeout");
  }
  fill(request: Request, quantity = "200", terminal = true, fee = "10000") {
    const orderId = `order-${request.clientOrderId}`;
    const gross = String(BigInt(quantity) * BigInt(request.limitMicros) / 100n);
    const fill: Fill = { id: randomUUID(), orderId, clientOrderId: request.clientOrderId,
      market: request.market, side: request.side, action: request.action, quantityHundredths: quantity,
      priceMicros: request.limitMicros, grossMicros: gross, feeMicros: fee, occurredAtMs: this.now };
    this.evidence.fills.push(fill);
    const old = this.evidence.orders.find(o => o.orderId === orderId);
    const filled = String(BigInt(old?.filledHundredths ?? "0") + BigInt(quantity));
    if (old) { old.filledHundredths = filled; old.terminal = terminal; }
    else this.evidence.orders.push({ orderId, request, filledHundredths: filled, terminal });
    this.evidence.cashMicros = String(BigInt(this.evidence.cashMicros) +
      (request.action === "BUY" ? -(BigInt(gross) + BigInt(fee)) : BigInt(gross) - BigInt(fee)));
    const pos = this.evidence.positions.find(p => p.market === request.market && p.side === request.side);
    const qty = BigInt(pos?.quantityHundredths ?? "0") + (request.action === "BUY" ? BigInt(quantity) : -BigInt(quantity));
    if (pos) pos.quantityHundredths = String(qty);
    else this.evidence.positions.push({ market: request.market, side: request.side, quantityHundredths: String(qty) });
    return fill;
  }
}

async function fixture(fault?: (stage: string) => void) {
  assert.equal((await pool.query("SHOW fsync")).rows[0].fsync, "on");
  assert.equal((await pool.query("SHOW synchronous_commit")).rows[0].synchronous_commit, "on");
  await pool.query("TRUNCATE v13_production_observation,v13_production_event,v13_production_position,v13_production_intent,v13_production_account,forward_test_evaluations,forward_test_windows,v13_live_money_policy,strata_configured_stake CASCADE");
  const p = policy(), keys = Object.keys(p);
  await pool.query(`INSERT INTO v13_live_money_policy(${keys.map(k => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)).join(",")})
    VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(p));
  await pool.query(`INSERT INTO v13_production_account(id,policy_id,subaccount,exchange_index,key_fingerprint,
    commissioning_digest,minimum_exit_micros,fee_artifact_digest,cash_precision_verified,commissioned,
    kill_switch,execution_enabled,cash_micros,initial_cash_micros)
    VALUES('test-account',$1,1,2,$2,$3,400000,$3,true,true,false,true,100000000,100000000)`, [p.id, "b".repeat(64), "c".repeat(64)]);
  await pool.query(`INSERT INTO strata_configured_stake(id,configured_stake_cents,revision,updated_at)
    VALUES('production',$1,1,now())`, [p.maxEntryStakeCents]);
  const exchange = new SimulatedExchange();
  const ledger = new ProductionLedger(pool, "test-account");
  const executor = new ProductionExecutor(ledger, exchange, () => exchange.now, fault);
  await executor.reconcile();
  async function source(id = randomUUID(), crossing = "test-cross") {
    await pool.query(`INSERT INTO forward_test_evaluations(id,evaluated_at,market_ticker,btc_price,target,
      signed_buffer,absolute_buffer,velocity,feed_freshness,fresh_cross,crossing_consumed,crossing_key,signal,
      direction,qualifying_trigger,reason,entry_offer,position_was_open,previous_side,up_offer,down_offer,
      btc_provider_age_ms,btc_receive_age_ms,market_age_ms,strategy_parameter_set_id,strategy_parameter_hash)
      VALUES($1,$2,'TEST-MARKET',100010,100000,10,10,1,'current',true,true,$3,'SCOUT','UP',true,'test',0.5,false,
        'DOWN',0.5,0.5,0,0,0,$4,$5)`,
    [id, new Date(exchange.now), crossing, V13_CHAMPION_PARAMETER_SET.id, V13_CHAMPION_PARAMETER_HASH]);
    return id;
  }
  async function exitFeed() {
    exchange.now++;
    exchange.book.observedAtMs = exchange.now; exchange.evidence.observedAtMs = exchange.now;
    const id = await source(randomUUID(), "owned-exit-cross");
    await pool.query(`UPDATE forward_test_evaluations SET btc_price=99999,signed_buffer=-1,absolute_buffer=1,
      velocity=-1,signal='EXIT',direction='UP',qualifying_trigger=false,fresh_cross=false WHERE id=$1`, [id]);
  }
  return { ledger, executor, exchange, source, exitFeed };
}
test("unknown historical strategy identity stays unknown and cannot authorize production entry", async () => {
  const f = await fixture();
  const id = await f.source();
  await pool.query("UPDATE forward_test_evaluations SET strategy_parameter_set_id=NULL,strategy_parameter_hash=NULL WHERE id=$1", [id]);
  await assert.rejects(f.executor.prepareEntry(id), /production_source_not_qualifying_champion/);
  const { rows: [row] } = await pool.query("SELECT strategy_parameter_set_id,strategy_parameter_hash FROM forward_test_evaluations WHERE id=$1", [id]);
  assert.equal(row.strategy_parameter_set_id, null);
  assert.equal(row.strategy_parameter_hash, null);
  assert.equal(f.exchange.posts.length, 0);
});

test("a partial parameter identity is rejected without altering an evaluation", async () => {
  const f = await fixture();
  const id = await f.source();
  await assert.rejects(pool.query("UPDATE forward_test_evaluations SET strategy_parameter_hash=NULL WHERE id=$1", [id]), { code: "23514" });
  const { rows: [row] } = await pool.query("SELECT strategy_parameter_hash FROM forward_test_evaluations WHERE id=$1", [id]);
  assert.equal(row.strategy_parameter_hash, V13_CHAMPION_PARAMETER_HASH);
});

async function invariant(l: ProductionLedger) {
  await l.transaction(async (tx, a) => l.assertConservation(tx, a));
}

test("real PostgreSQL: concurrent duplicate/crossing claims reserve once and submit locally once", async () => {
  const f = await fixture(), source = await f.source();
  const ids = await Promise.all(Array.from({ length: 12 }, () => f.executor.prepareEntry(source)));
  assert.equal(new Set(ids).size, 1);
  assert.equal((await f.ledger.readAccount()).reserved_micros, "5050000");
  await Promise.all(ids.map(id => f.executor.dispatch(id)));
  assert.equal(f.exchange.posts.length, 1);
  const duplicateCross = await f.source(randomUUID(), "test-cross");
  assert.equal(await f.executor.prepareEntry(duplicateCross), ids[0]);
  await invariant(f.ledger);
});
test("reservation transaction rolls back after a crash, with no capability or position leak", async () => {
  const f = await fixture(stage => { if (stage === "after_reservation") throw new Error("crash"); });
  await assert.rejects(f.executor.prepareEntry(await f.source()), /crash/);
  assert.equal((await f.ledger.readAccount()).reserved_micros, "0");
  assert.equal((await pool.query("SELECT count(*) FROM v13_production_intent")).rows[0].count, "0");
  await invariant(f.ledger);
});
test("dispatch-commit crash survives restart without replay or releasing uncertain funds", async () => {
  const f = await fixture(stage => { if (stage === "after_dispatch_commit") throw new Error("crash"); });
  const id = await f.executor.prepareEntry(await f.source());
  await assert.rejects(f.executor.dispatch(id), /crash/);
  const restarted = new ProductionExecutor(f.ledger, f.exchange, () => f.exchange.now);
  await restarted.reconcile(); await restarted.dispatch(id);
  assert.equal(f.exchange.posts.length, 0);
  assert.equal((await f.ledger.readAccount()).reserved_micros, "5050000");
  await assert.rejects(restarted.prepareEntry(await f.source(randomUUID(), "another")), /uncertain/);
});
test("timeout after accepted POST and crash after POST never replay; authoritative partial fills recover", async () => {
  for (const crash of [false, true]) {
    const f = await fixture(stage => { if (crash && stage === "after_post_before_commit") throw new Error("crash"); });
    f.exchange.throwPost = !crash;
    const id = await f.executor.prepareEntry(await f.source());
    await assert.rejects(f.executor.dispatch(id), /timeout|crash/);
    f.exchange.fill(f.exchange.posts[0]!, "100");
    await f.executor.reconcile();
    await new ProductionExecutor(f.ledger, f.exchange).dispatch(id);
    assert.equal(f.exchange.posts.length, 1);
    assert.equal((await f.ledger.readAccount()).reserved_micros, "30000");
    assert.equal((await pool.query("SELECT quantity_hundredths FROM v13_production_position")).rows[0].quantity_hundredths, "100");
    await f.executor.reconcile(); // duplicate history is financially idempotent
    assert.equal((await pool.query("SELECT count(*) FROM v13_production_event")).rows[0].count, "1");
    await invariant(f.ledger);
  }
});
test("partial reduce-only exits preserve residuals and exact cost basis; settlement closes remaining ownership", async () => {
  const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
  await f.executor.dispatch(id); f.exchange.fill(f.exchange.posts[0]!);
  await f.executor.reconcile();
  await f.exitFeed();
  const exit = await f.executor.prepareExit(id, 0.4);
  await f.executor.dispatch(exit); assert.equal(f.exchange.posts[1]!.reduceOnly, true);
  f.exchange.fill(f.exchange.posts[1]!, "100");
  await f.executor.reconcile();
  assert.equal((await pool.query("SELECT quantity_hundredths FROM v13_production_position")).rows[0].quantity_hundredths, "100");
  f.exchange.evidence.settlements.push({ id: "settlement-1", market: "TEST-MARKET", side: "YES",
    result: "YES", quantityHundredths: "100", payoutMicros: "1000000", feeMicros: "0", occurredAtMs: f.exchange.now });
  f.exchange.evidence.positions[0]!.quantityHundredths = "0";
  f.exchange.evidence.cashMicros = String(BigInt(f.exchange.evidence.cashMicros) + 1000000n);
  await f.executor.reconcile(); await f.executor.reconcile();
  assert.equal((await f.ledger.readAccount()).reserved_micros, "0");
  await invariant(f.ledger);
});
test("late fill during cancel timeout is accounted, cancellation is not repeated, no release from DELETE response", async () => {
  const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
  await f.executor.dispatch(id); f.exchange.fill(f.exchange.posts[0]!, "100", false);
  await f.executor.reconcile();
  f.exchange.throwCancel = true;
  await assert.rejects(f.executor.cancel(id), /cancel_timeout/);
  await f.executor.cancel(id);
  assert.equal(f.exchange.cancels.length, 1);
  assert.ok(BigInt((await f.ledger.readAccount()).reserved_micros) > 30000n);
  f.exchange.fill(f.exchange.posts[0]!, "100", true);
  await f.executor.reconcile(); await invariant(f.ledger);
  assert.equal((await f.ledger.readAccount()).reserved_micros, "30000");
});
test("account mismatch, incomplete/404-like history, foreign activity and cash mismatch freeze rather than clear", async () => {
  for (const mutate of [
    (s: Snapshot) => { s.identity.subaccount = 0; },
    (s: Snapshot) => { s.complete = false; },
    (s: Snapshot) => { s.cashExact = false; },
    (s: Snapshot) => { s.unexplainedCashActivity = true; },
    (s: Snapshot) => { s.cashMicros = "100000001"; },
  ]) {
    const f = await fixture(); mutate(f.exchange.evidence);
    await assert.rejects(f.executor.reconcile());
    assert.ok((await f.ledger.readAccount()).blocked_reason);
    await invariant(f.ledger);
  }
});
test("revoked policy, stale fee and kill-switch changes stop the final POST fence", async () => {
  for (const change of ["policy", "fee", "kill"]) {
    const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
    if (change === "policy") await pool.query("UPDATE v13_live_money_policy SET state='REVOKED'");
    if (change === "fee") f.exchange.now += 16000;
    if (change === "kill") await pool.query("UPDATE v13_production_account SET kill_switch=true");
    await assert.rejects(f.executor.dispatch(id));
    assert.equal(f.exchange.posts.length, 0);
    await invariant(f.ledger);
  }
});
test("policy revocation cannot commit while the final mutation fence owns its policy lock", async () => {
  const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
  let released!: () => void;
  const wait = new Promise<void>(r => { released = r; });
  let reached!: () => void;
  const entered = new Promise<void>(r => { reached = r; });
  f.exchange.beforePost = async () => { reached(); await wait; };
  const sending = f.executor.dispatch(id); await entered;
  let revoked = false;
  const revocation = pool.query("UPDATE v13_live_money_policy SET state='REVOKED'").then(() => { revoked = true; });
  await new Promise(r => setTimeout(r, 50)); assert.equal(revoked, false);
  released(); await sending; await revocation;
  assert.equal(f.exchange.posts.length, 1);
});
test("production worker startup cannot pass engaged kill switches; tick never replays unknown attempts", async () => {
  const f = await fixture(), worker = new ProductionWorker(f.executor);
  await pool.query("UPDATE v13_production_account SET kill_switch=true,execution_enabled=false,commissioned=false");
  await assert.rejects(worker.start(), /disabled_or_uncommissioned/);
  assert.equal(f.exchange.posts.length, 0); worker.stop();
});
test("owned consumer independently emits an EXIT from actual ownership even when the paper record is WATCH", async () => {
  const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
  await f.executor.dispatch(id); f.exchange.fill(f.exchange.posts[0]!); await f.executor.reconcile();
  await f.exitFeed();
  await pool.query("UPDATE forward_test_evaluations SET signal='WATCH',direction='NONE' WHERE signal='EXIT'");
  const worker = new ProductionWorker(f.executor);
  await worker.tick();
  assert.equal(f.exchange.posts.length, 2);
  assert.equal(f.exchange.posts[1]!.action, "SELL");
  const exit = (await pool.query("SELECT decision FROM v13_production_intent WHERE kind='EXIT'")).rows[0];
  assert.equal(exit.decision.ownedEvaluation.decision.signal, "EXIT");
  assert.equal(exit.decision.ownedEvaluation.source.signal, "WATCH");
  await invariant(f.ledger);
});
test("a paper EXIT cannot order an exit while the reconciled owned position has no champion exit trigger", async () => {
  const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
  await f.executor.dispatch(id); f.exchange.fill(f.exchange.posts[0]!); await f.executor.reconcile();
  await pool.query("UPDATE forward_test_evaluations SET signal='EXIT',qualifying_trigger=false");
  await assert.rejects(f.executor.prepareExit(id, 0.4), /owned_exit_not_eligible/);
  await new ProductionWorker(f.executor).tick();
  assert.equal(f.exchange.posts.length, 1);
});
test("fractional fills remain exact hundredths; no upward-rounded fractional exit and winning settlement conserve money", async () => {
  const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
  await f.executor.dispatch(id); f.exchange.fill(f.exchange.posts[0]!, "50"); await f.executor.reconcile();
  await f.exitFeed();
  await assert.rejects(f.executor.prepareExit(id, 0.4), /invalid_input/);
  f.exchange.evidence.settlements.push({ id: "fractional-settle", market: "TEST-MARKET", side: "YES",
    result: "YES", quantityHundredths: "50", payoutMicros: "500000", feeMicros: "0", occurredAtMs: f.exchange.now });
  f.exchange.evidence.positions[0]!.quantityHundredths = "0";
  f.exchange.evidence.cashMicros = String(BigInt(f.exchange.evidence.cashMicros) + 500000n);
  await f.executor.reconcile(); await invariant(f.ledger);
});
test("late terminal fills are booked and freeze new entry; GET-only restart recovery works with execution disabled", async () => {
  const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
  await f.executor.dispatch(id); f.exchange.fill(f.exchange.posts[0]!, "100"); await f.executor.reconcile();
  await pool.query("UPDATE v13_production_account SET kill_switch=true,execution_enabled=false");
  f.exchange.fill(f.exchange.posts[0]!, "100", true);
  const worker = new ProductionWorker(new ProductionExecutor(f.ledger, f.exchange, () => f.exchange.now));
  await worker.startRecovery();
  await new Promise(r => setTimeout(r, 75)); worker.stop();
  assert.equal((await pool.query("SELECT quantity_hundredths FROM v13_production_position")).rows[0].quantity_hundredths, "200");
  assert.equal((await f.ledger.readAccount()).blocked_reason, "late_fill_after_terminal");
  assert.equal(f.exchange.posts.length, 1); await invariant(f.ledger);
});
test("changed fill evidence, missing fill totals and foreign order identity cannot release reservations", async () => {
  for (const mode of ["changed", "missing", "foreign"]) {
    const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
    await f.executor.dispatch(id); const fill = f.exchange.fill(f.exchange.posts[0]!, "100", false);
    await f.executor.reconcile(); const held = (await f.ledger.readAccount()).reserved_micros;
    if (mode === "changed") fill.feeMicros = "20000";
    if (mode === "missing") {
      f.exchange.evidence.orders[0]!.terminal = true; f.exchange.evidence.orders[0]!.filledHundredths = "200";
    }
    if (mode === "foreign") f.exchange.evidence.orders[0]!.request = { ...f.exchange.posts[0]!, clientOrderId: "foreign-client" };
    await assert.rejects(f.executor.reconcile());
    assert.equal((await f.ledger.readAccount()).reserved_micros, held); await invariant(f.ledger);
  }
});
test("real PostgreSQL constraints reject over-reservation, missing commission proof, wrong pair and duplicate approval", async () => {
  const f = await fixture();
  await assert.rejects(pool.query("UPDATE v13_production_account SET reserved_micros=cash_micros+1"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE v13_production_account SET commissioning_digest=NULL"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE v13_production_account SET subaccount=0"), { code: "23514" });
  await assert.rejects(pool.query(`INSERT INTO v13_live_money_policy SELECT (jsonb_populate_record(NULL::v13_live_money_policy,
    to_jsonb(p)||'{"id":"second-approval","version":2}'::jsonb)).* FROM v13_live_money_policy p`), { code: "23505" });
  await invariant(f.ledger);
});
test("canonical wire maps NO sell to YES-book bid and complementary price; IOC and reduce_only never disappear", () => {
  const r: Request = { market: "KXBTC15M-TEST", side: "NO", action: "SELL", contracts: 2,
    limitMicros: 430000, timeInForce: "IOC", reduceOnly: true, clientOrderId: `v13p-${randomUUID()}` };
  const wire = encodeProductionOrder(r);
  assert.equal(wire.side, "bid"); assert.equal(wire.price, "0.5700");
  assert.equal(wire.reduce_only, true); assert.equal(wire.time_in_force, "immediate_or_cancel");
  assert.equal(wire.subaccount, 1); assert.equal(wire.exchange_index, 2);
  assert.throws(() => encodeProductionOrder({ ...r, reduceOnly: false }), /wire_invalid/);
});
test("final account proof and immutable source fence block stale/changed evidence before a POST, with a proven local abort", async () => {
  for (const change of ["cash", "source", "depth"]) {
    const f = await fixture(), source = await f.source(), id = await f.executor.prepareEntry(source);
    if (change === "cash") f.exchange.evidence.cashMicros = "100000001";
    if (change === "source") await pool.query("UPDATE forward_test_evaluations SET velocity=2 WHERE id=$1", [source]);
    if (change === "depth") f.exchange.book.asks[0]!.availableContracts = "1";
    await assert.rejects(f.executor.dispatch(id));
    assert.equal(f.exchange.posts.length, 0);
    assert.equal((await f.ledger.readAccount()).reserved_micros, "0");
    assert.equal((await pool.query("SELECT state FROM v13_production_intent")).rows[0].state, "BLOCKED");
    await invariant(f.ledger);
  }
});
test("read providers inside a fence reuse the transaction client rather than deadlocking on a second account lock", async () => {
  const f = await fixture();
  await f.ledger.transaction(async (tx, a) => {
    await tx.query("UPDATE v13_production_account SET minimum_exit_micros=410000 WHERE id=$1", [a.id]);
    assert.equal((await f.ledger.readAccount()).minimum_exit_micros, 410000);
    assert.equal((await f.ledger.query("SELECT txid_current() id")).rows[0].id, (await tx.query("SELECT txid_current() id")).rows[0].id);
  });
});
test("live transport rejects a caller-forged final fence without any HTTP or use of real credentials", async () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString().trim();
  const keyId = "synthetic-key", fingerprint = createHash("sha256").update(`${keyId}\u001f${privateKey}`).digest("hex");
  let requests = 0;
  const transport = new KalshiProductionExchange({ keyId, privateKey,
    identity: { subaccount: 1, exchangeIndex: 2, keyFingerprint: fingerprint },
    fundingAnchor: { transferId: "fake", transferredAt: new Date(0).toISOString(),
      amountCents: 2500, baselineCashMicros: "25000000", baselineAt: new Date(1).toISOString() },
    ticker: async () => "KXBTC15M-TEST", requests: async () => [], orderMarket: async () => "KXBTC15M-TEST",
    market: async () => { throw new Error("must_not_read"); },
    fetchImpl: async () => { requests++; throw new Error("must_not_send"); },
  });
  await assert.rejects(transport.submit({ market: "KXBTC15M-TEST", side: "YES", action: "BUY",
    contracts: 1, limitMicros: 500000, timeInForce: "IOC", reduceOnly: false,
    clientOrderId: `v13p-${randomUUID()}` }, async () => {}), /opaque_fence_required/);
  await assert.rejects(transport.cancel("fake-order", async () => {}), /opaque_fence_required/);
  assert.equal(requests, 0);
});
test("new exposure is refused after an actual open position and fee-inclusive cash/capital ceilings remain effective", async () => {
  const f = await fixture(), id = await f.executor.prepareEntry(await f.source());
  await f.executor.dispatch(id); f.exchange.fill(f.exchange.posts[0]!); await f.executor.reconcile();
  await assert.rejects(f.executor.prepareEntry(await f.source(randomUUID(), "second-cross")), /position_limit_reached/);
  await invariant(f.ledger);
});
test("NO-side owned exit uses the actual NO position, not a YES paper signal", async () => {
  const f = await fixture(), source = await f.source();
  await pool.query(`UPDATE forward_test_evaluations SET btc_price=99990,signed_buffer=-10,
    velocity=-1,previous_side='UP',direction='DOWN' WHERE id=$1`, [source]);
  const id = await f.executor.prepareEntry(source); await f.executor.dispatch(id);
  assert.equal(f.exchange.posts[0]!.side, "NO");
  f.exchange.fill(f.exchange.posts[0]!); await f.executor.reconcile();
  await f.exitFeed();
  await pool.query(`UPDATE forward_test_evaluations SET btc_price=100001,signed_buffer=1,velocity=1
    WHERE crossing_key='owned-exit-cross'`);
  await new ProductionWorker(f.executor).tick();
  assert.equal(f.exchange.posts[1]!.side, "NO"); assert.equal(f.exchange.posts[1]!.action, "SELL");
  f.exchange.fill(f.exchange.posts[1]!); await f.executor.reconcile(); await invariant(f.ledger);
});

test("zero departure matches shared classifier for UP and DOWN; zero touch/opening/drift never reserve", async () => {
  for (const side of ["UP", "DOWN"]) {
    const f = await fixture(), id = await f.source();
    await pool.query(`UPDATE forward_test_evaluations SET previous_side='AT',
      btc_price=$2,signed_buffer=$3,velocity=$4,direction=$5 WHERE id=$1`,
      [id, side === "UP" ? 100010 : 99990, side === "UP" ? 10 : -10, side === "UP" ? 1 : -1, side]);
    await f.executor.prepareEntry(id);
    assert.ok(BigInt((await f.ledger.readAccount()).reserved_micros) > 0n);
    assert.equal(f.exchange.posts.length, 0);
  }
  for (const mutation of [
    "previous_side=NULL",
    "previous_side='UP'",
    "btc_price=100000,signed_buffer=0,absolute_buffer=0",
  ]) {
    const f = await fixture(), id = await f.source();
    await pool.query(`UPDATE forward_test_evaluations SET ${mutation} WHERE id=$1`, [id]);
    await assert.rejects(f.executor.prepareEntry(id), /classification_mismatch/);
    assert.equal((await f.ledger.readAccount()).reserved_micros, "0");
  }
});
test("v2 source requires separately hashed entry-policy approval and stable consumed market claim", async () => {
  const f = await fixture(), id = await f.source(randomUUID(), "TEST-MARKET:first");
  await pool.query("UPDATE forward_test_evaluations SET entry_policy_version=$2 WHERE id=$1",
    [id, V13_ENTRY_POLICY_VERSION]);
  await assert.rejects(f.executor.prepareEntry(id), /entry_policy_revision_not_approved/);
  assert.equal((await f.ledger.readAccount()).reserved_micros, "0");
  const p = { ...policy(), entryPolicyVersion: V13_ENTRY_POLICY_VERSION };
  p.policyHash = computeV13LiveMoneyPolicyHash(p);
  await pool.query("UPDATE v13_live_money_policy SET entry_policy_version=$1,policy_hash=$2", [p.entryPolicyVersion, p.policyHash]);
  await pool.query(`INSERT INTO forward_test_windows(ticker,target,entry_policy_version,
    crossing_key,crossing_consumed,starts_at,ends_at)
    VALUES('TEST-MARKET',100000,$1,'TEST-MARKET:first',true,$2,$3)
    ON CONFLICT(ticker) DO UPDATE SET entry_policy_version=EXCLUDED.entry_policy_version,
      crossing_key=EXCLUDED.crossing_key,crossing_consumed=true,
      starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at`,
    [V13_ENTRY_POLICY_VERSION, new Date(f.exchange.now - 1000), new Date(f.exchange.now + 900000)]);
  await pool.query("UPDATE forward_test_windows SET crossing_consumed=false WHERE ticker='TEST-MARKET'");
  await assert.rejects(f.executor.prepareEntry(id), /window_or_claim_not_current/);
  await pool.query("UPDATE forward_test_windows SET crossing_consumed=true WHERE ticker='TEST-MARKET'");
  await pool.query("UPDATE forward_test_evaluations SET crossing_consumed=false WHERE id=$1", [id]);
  await assert.rejects(f.executor.prepareEntry(id), /claim_not_proven/);
  await pool.query("UPDATE forward_test_evaluations SET crossing_consumed=true,crossing_key='wrong-event-key' WHERE id=$1", [id]);
  await assert.rejects(f.executor.prepareEntry(id), /claim_not_proven/);
  await pool.query("UPDATE forward_test_evaluations SET crossing_key='TEST-MARKET:first' WHERE id=$1", [id]);
  const intent = await f.executor.prepareEntry(id);
  const duplicate = await f.source(randomUUID(), "TEST-MARKET:first");
  await pool.query("UPDATE forward_test_evaluations SET entry_policy_version=$2 WHERE id=$1", [duplicate, V13_ENTRY_POLICY_VERSION]);
  assert.equal(await f.executor.prepareEntry(duplicate), intent);
  // Approval tampering remains fenced before any simulated POST.
  await pool.query("UPDATE v13_live_money_policy SET entry_policy_version=NULL");
  await assert.rejects(f.executor.dispatch(intent));
  assert.equal(f.exchange.posts.length, 0);
});
test("v2 window expiry at the final fence aborts locally without POST or leaked funds", async () => {
  const f = await fixture(), id = await f.source(randomUUID(), "TEST-MARKET:first");
  const p = { ...policy(), entryPolicyVersion: V13_ENTRY_POLICY_VERSION };
  p.policyHash = computeV13LiveMoneyPolicyHash(p);
  await pool.query("UPDATE v13_live_money_policy SET entry_policy_version=$1,policy_hash=$2", [p.entryPolicyVersion, p.policyHash]);
  await pool.query("UPDATE forward_test_evaluations SET entry_policy_version=$2 WHERE id=$1", [id, p.entryPolicyVersion]);
  await pool.query(`INSERT INTO forward_test_windows(ticker,target,entry_policy_version,
    crossing_key,crossing_consumed,starts_at,ends_at)
    VALUES('TEST-MARKET',100000,$1,'TEST-MARKET:first',true,$2,$3)
    ON CONFLICT(ticker) DO UPDATE SET entry_policy_version=EXCLUDED.entry_policy_version,
      crossing_key=EXCLUDED.crossing_key,crossing_consumed=true,
      starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at`,
    [p.entryPolicyVersion, new Date(f.exchange.now - 1000), new Date(f.exchange.now + 1000)]);
  const intent = await f.executor.prepareEntry(id);
  f.exchange.now += 1500; // quotes/account still inside existing 15-second bound
  await assert.rejects(f.executor.dispatch(intent), /window_or_claim_not_current/);
  assert.equal(f.exchange.posts.length, 0);
  assert.equal((await f.ledger.readAccount()).reserved_micros, "0");
});
test("approved v2 Scout and Confirm complete simulated entry/owned exit without permitting market re-entry", async () => {
  for (const [side, signal, buffer] of [["YES", "SCOUT", 10], ["NO", "CONFIRM", -25]] as const) {
    const f = await fixture(), id = await f.source(randomUUID(), "TEST-MARKET:first");
    const p = { ...policy(), entryPolicyVersion: V13_ENTRY_POLICY_VERSION };
    p.policyHash = computeV13LiveMoneyPolicyHash(p);
    await pool.query("UPDATE v13_live_money_policy SET entry_policy_version=$1,policy_hash=$2", [p.entryPolicyVersion, p.policyHash]);
    await pool.query(`UPDATE forward_test_evaluations SET entry_policy_version=$2,
      btc_price=$3,signed_buffer=$4,absolute_buffer=$5,velocity=$6,signal=$7,
      direction=$8,previous_side=$9 WHERE id=$1`,
      [id, p.entryPolicyVersion, 100000 + buffer, buffer, Math.abs(buffer),
        Math.sign(buffer), signal, side === "YES" ? "UP" : "DOWN", side === "YES" ? "DOWN" : "UP"]);
    await pool.query(`INSERT INTO forward_test_windows(ticker,target,entry_policy_version,
      crossing_key,crossing_consumed,starts_at,ends_at)
      VALUES('TEST-MARKET',100000,$1,'TEST-MARKET:first',true,$2,$3)
      ON CONFLICT(ticker) DO UPDATE SET entry_policy_version=EXCLUDED.entry_policy_version,
        crossing_key=EXCLUDED.crossing_key,crossing_consumed=true,
        starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at`,
      [p.entryPolicyVersion, new Date(f.exchange.now - 1000), new Date(f.exchange.now + 900000)]);
    const intent = await f.executor.prepareEntry(id);
    await f.executor.dispatch(intent);
    assert.equal(f.exchange.posts.length, 1); assert.equal(f.exchange.posts[0]!.side, side);
    f.exchange.fill(f.exchange.posts[0]!); await f.executor.reconcile();
    await f.exitFeed();
    if (side === "NO") await pool.query(`UPDATE forward_test_evaluations
      SET btc_price=100001,signed_buffer=1,velocity=1 WHERE crossing_key='owned-exit-cross'`);
    const exit = await f.executor.prepareExit(intent, .4);
    await f.executor.dispatch(exit);
    assert.equal(f.exchange.posts[1]!.side, side); assert.equal(f.exchange.posts[1]!.reduceOnly, true);
    f.exchange.fill(f.exchange.posts[1]!); await f.executor.reconcile();
    const duplicate = await f.source(randomUUID(), "TEST-MARKET:first");
    await pool.query("UPDATE forward_test_evaluations SET entry_policy_version=$2 WHERE id=$1", [duplicate, p.entryPolicyVersion]);
    assert.equal(await f.executor.prepareEntry(duplicate), intent);
    await new ProductionExecutor(f.ledger, f.exchange, () => f.exchange.now).dispatch(intent);
    assert.equal(f.exchange.posts.length, 2);
    assert.equal((await f.ledger.readAccount()).reserved_micros, "0");
    await invariant(f.ledger);
  }
});
test("unknown policy revision and champion-hash approval mismatch cannot reserve production funds", async () => {
  const f = await fixture(), id = await f.source();
  await pool.query("UPDATE forward_test_evaluations SET entry_policy_version='unreviewed' WHERE id=$1", [id]);
  await assert.rejects(f.executor.prepareEntry(id), /entry_policy_revision_not_approved/);
  await pool.query("UPDATE forward_test_evaluations SET entry_policy_version=NULL WHERE id=$1", [id]);
  await pool.query("UPDATE v13_live_money_policy SET policy_hash=$1", ["d".repeat(64)]);
  await assert.rejects(f.executor.prepareEntry(id));
  assert.equal((await f.ledger.readAccount()).reserved_micros, "0");
  assert.equal(f.exchange.posts.length, 0);
});
test("configured stake is pinned and a later revision cannot resize a prepared entry", async () => {
  const f = await fixture();
  await pool.query("UPDATE strata_configured_stake SET configured_stake_cents=500, revision=2 WHERE id='production'");
  f.exchange.book.fee = {
    ...f.exchange.book.fee,
    fingerprint: "test-fingerprint-one-contract",
    contracts: 10,
    reservedEntryFeeCents: 1,
    reservedExitFeeCents: 2,
  };
  const id = await f.executor.prepareEntry(await f.source());
  const prepared = (await pool.query("SELECT decision, request FROM v13_production_intent WHERE id=$1", [id])).rows[0];
  assert.equal(prepared.decision.configuredStakeCents, 500);
  assert.equal(prepared.decision.stakeRevision, 2);
  await pool.query("UPDATE strata_configured_stake SET configured_stake_cents=501, revision=3 WHERE id='production'");
  await assert.rejects(f.executor.dispatch(id), /production_pinned_stake_changed_or_unproven/);
  assert.equal(f.exchange.posts.length, 0);
  const still = (await pool.query("SELECT request FROM v13_production_intent WHERE id=$1", [id])).rows[0];
  assert.equal(still.request.contracts, prepared.request.contracts);
});
test("configured stake above the approved maximum cannot enter", async () => {
  const f = await fixture();
  await pool.query("UPDATE strata_configured_stake SET configured_stake_cents=501 WHERE id='production'");
  await assert.rejects(f.executor.prepareEntry(await f.source()), /configured_stake_above_approved_maximum/);
  assert.equal(f.exchange.posts.length, 0);
});

test("technical renewal runs only after a successful committed reconciliation",async()=>{
 const f=await fixture();
 let renewals=0;
 f.executor.afterReconcile=async snapshot=>{
  const account=await f.ledger.readAccount();
  assert.equal(account.cash_micros,snapshot.cashMicros);
  assert.equal(account.reconciled_at?.getTime(),snapshot.observedAtMs);
  renewals++;
 };
 await f.executor.reconcile();
 assert.equal(renewals,1);
 f.exchange.evidence.cashMicros='1';
 await assert.rejects(f.executor.reconcile(),/production_external_cash_mismatch/);
 assert.equal(renewals,1,"a signed but unreconciled snapshot must not renew authority");
});

test("final authorization is rechecked after the transport's last asynchronous boundary",async()=>{
 const f=await fixture();
 let authorized=true,checks=0;
 f.executor.authorizeFinalEntry=async tx=>{
  checks++;
  // Same transaction sees the durable precommitted intent.
  assert.equal((await tx.query("SELECT state FROM v13_production_intent")).rows[0].state,'DISPATCHED');
  if(!authorized)throw new Error('production_entry_release_not_current');
 };
 const id=await f.executor.prepareEntry(await f.source());
 f.exchange.beforePost=async()=>{authorized=false;};
 await assert.rejects(f.executor.dispatch(id),/production_entry_release_not_current/);
 assert.equal(checks,2);
 assert.equal(f.exchange.posts.length,0);
});
