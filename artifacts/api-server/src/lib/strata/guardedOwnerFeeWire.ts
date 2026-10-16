import { pool } from "@workspace/db";
import { parseOwnerFeeSource, verifyOwnerFeeSourceStage } from "./ownerFeeSourceStage";
/**
 * Last auditable source authorization fence AFTER ProductionExecutor's final
 * market/fingerprint check, immediately before the Kalshi order POST.
 *
 * A shared PostgreSQL lock is held on grant, consent, release, and both policy
 * signatures until the exchange POST returns. Revocation cannot silently
 * overtake an already admitted POST. Every later POST rechecks afresh.
 *
 * No non-order endpoint uses this alternative fee source guard. DELETE cancel
 * remains available to reduce risk even after a source grant is revoked.
 */
export function createGuardedOwnerFeeFetch(
  ownerUserId:string, sourceUrl:string, transport:typeof fetch,
):typeof fetch {
  const identity=parseOwnerFeeSource(sourceUrl);
  if(!identity)throw new Error("owner_fee_source_identity_invalid");
  return async (request,init)=>{
    if(init?.method!=="POST")return transport(request,init);
    if(typeof request!=="string" ||
      request!=="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders" ||
      typeof init.body!=="string")
      throw new Error("unexpected_production_fee_source_order_endpoint");
    let parsed:unknown;
    try{parsed=JSON.parse(init.body);}catch{
      throw new Error("production_order_body_unreadable");
    }
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))
      throw new Error("production_order_body_invalid");
    const order=parsed as Record<string,unknown>;
    const ticker=order.ticker;
    if(typeof ticker!=="string"||!/^KXBTC15M[A-Za-z0-9._-]+$/.test(ticker)||
      order.subaccount!==1||order.exchange_index!==2)
      throw new Error("owner_order_scope_invalid");
    const assessment=await verifyOwnerFeeSourceStage(ownerUserId,"ORDER_ENTRY",
      sourceUrl,ticker);
    if(!assessment.ok)throw new Error("owner_fee_source_order_fence_closed");
    const client=await pool.connect();
    let committed=false;
    try{
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='1000ms'");
      await client.query("SET LOCAL statement_timeout='15000ms'");
      const rows=await client.query(`
        SELECT g.grant_id
        FROM private.strata_fee_source_grants g
        JOIN private.strata_fee_source_owner_consents c
          ON c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id
        JOIN public.strata_fee_operator_release_candidates r
          ON r.release_id=g.release_id AND r.content_sha256=g.reviewed_pdf_sha256
        JOIN private.strata_fee_source_policy_reviews p1
          ON p1.release_id=g.release_id AND p1.owner_user_id=g.owner_user_id
          AND p1.policy_decision_sha256=g.policy_decision_sha256
        JOIN private.strata_fee_source_policy_reviews p2
          ON p2.release_id=g.release_id AND p2.owner_user_id=g.owner_user_id
          AND p2.policy_decision_sha256=g.policy_decision_sha256
          AND p2.reviewer_user_id>p1.reviewer_user_id
        WHERE g.grant_id=$1::uuid AND g.release_id=$2::uuid
          AND g.owner_user_id=$3::uuid
          AND g.policy_version='operator_attested_fee_source_v1'
          AND g.policy_decision_sha256=
            'f8f7e0920168ab4601c59a3a9343e940d78dd974512c7ec97f7d052bf5fd685e'
          AND g.revoked_at IS NULL AND g.expires_at>now()+interval '12 seconds'
          AND r.revoked_at IS NULL AND r.expires_at>now()+interval '12 seconds'
          AND c.revoked_at IS NULL
          AND c.confirmation='CONFIRM_OPERATOR_FEE_SOURCE_ONLY'
          AND c.release_id=g.release_id
          AND p1.revoked_at IS NULL AND p2.revoked_at IS NULL
          AND p1.expires_at>now()+interval '12 seconds'
          AND p2.expires_at>now()+interval '12 seconds'
          AND p1.reviewed_pdf_sha256=g.reviewed_pdf_sha256
          AND p2.reviewed_pdf_sha256=g.reviewed_pdf_sha256
          AND g.authorized_stages @> ARRAY['ORDER_ENTRY']::text[]
        FOR SHARE OF g,c,r,p1,p2`,
        [identity.grantId,identity.releaseId,ownerUserId]);
      if(rows.rows.length!==1)throw new Error("owner_fee_source_order_gate_not_unique");
      const response=await transport(request,init);
      await client.query("COMMIT");committed=true;
      return response;
    }finally{
      if(!committed){try{await client.query("ROLLBACK");}catch{}}
      client.release();
    }
  };
}
