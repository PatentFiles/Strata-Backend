import { evaluateV13Strategy, V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from "@workspace/v13-strategy";
import { ProductionExecutor } from "./executor";
import { digest, money, requireProof } from "./types";

/**
 * Feed observations are provenance, not commands. Re-evaluate the unchanged
 * champion against the separately reconciled owned production position.
 */
export async function consumeOwnedPosition(executor: ProductionExecutor): Promise<void> {
  const l = executor.ledger;
  const owned = (await l.pool.query(`SELECT * FROM v13_production_position
    WHERE account_id=$1 AND quantity_hundredths>0`, [l.accountId])).rows;
  for (const pos of owned) {
    const source = (await l.pool.query(`SELECT * FROM forward_test_evaluations
      WHERE evaluation_source='paper' AND market_ticker=$1 ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
    [pos.market])).rows[0];
    if (!source) continue;
    const evaluation = await l.transaction(async (tx, a) => {
      await executor.gate(tx, a, true);
      const p = await l.policy(tx, a);
      const age = executor.now() - new Date(source.evaluated_at).getTime();
      requireProof(source.strategy_parameter_set_id === V13_CHAMPION_PARAMETER_SET.id &&
        source.strategy_parameter_hash === V13_CHAMPION_PARAMETER_HASH &&
        source.feed_freshness === "current" && age >= 0 && age <= p.maxQuoteAgeMs &&
        ["btc_provider_age_ms", "btc_receive_age_ms", "market_age_ms"].every(k =>
          typeof source[k] === "number" && source[k] >= 0 && source[k] + age <= p.maxQuoteAgeMs) &&
        Number.isFinite(source.btc_price) && Number.isFinite(source.target) &&
        Math.abs(source.signed_buffer - (source.btc_price - source.target)) < 0.00001,
      "production_owned_feed_unproven");
      const current = (await tx.query("SELECT * FROM v13_production_position WHERE id=$1 FOR UPDATE", [pos.id])).rows[0];
      requireProof(current && money(current.quantity_hundredths) > 0n, "production_position_changed");
      const decision = evaluateV13Strategy({ marketTicker: current.market, btcPrice: source.btc_price,
        target: source.target, previousBuffer: null, velocity: source.velocity,
        upOffer: source.up_offer, downOffer: source.down_offer, freshness: "current",
        position: { status: "open", direction: current.side === "YES" ? "up" : "down" } });
      const evidence = { position: current, sourcePaperEvaluationId: source.id, source,
        decision, policyHash: p.policyHash, observedAtMs: executor.now() };
      await l.observe(tx, "OWNED_POSITION_EVALUATION", evidence);
      return { decision, floor: a.minimum_exit_micros, digest: digest(evidence), evidence };
    });
    if (evaluation.decision.signal !== "EXIT" || !evaluation.decision.positionExitReason) continue;
    requireProof(evaluation.floor, "production_exit_floor_missing");
    // Never use the legacy V13 SELL transport as a fallback after protective
    // release is selected: that would bypass the one-use reservation/release
    // and could send a second exit after a signed IOC with unknown response.
    if(process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE==="true"){
      requireProof(executor.protectiveExit,"protective_exit_worker_not_integrated");
      await executor.protectiveExit({
        id:String(pos.id),market:String(pos.market),
        side:pos.side as "YES"|"NO",
        quantity_hundredths:String(pos.quantity_hundredths),
      },Number(evaluation.floor));
      continue;
    }
    const id = await executor.prepareExit(pos.id, evaluation.floor / 1_000_000);
    // Legacy V13 path retained only while the protective-release gate is OFF.
    await executor.dispatch(id);
  }
}
