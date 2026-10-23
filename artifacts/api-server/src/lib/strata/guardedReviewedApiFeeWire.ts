import { pool } from "@workspace/db";
import { verifyMonetaryFeeContract } from "./monetaryFeeContract";
import {
 parseReviewedApiSource, verifyReviewedApiFeeSourceStage, API_SOURCE_POLICY_VERSION, API_SOURCE_FORMULA_VERSION
} from "./apiFeeSourceStage";
/**
 * Last exact-market API-source fee fence for the alternative PDF-free source.
 * Runs WITH a DB transaction and row-share locks until the signed exchange
 * POST returns. New exposure is explicitly paused: reduce-only IOC exits
 * require current independent source reviews, owner consent, fee model and
 * fresh exact-market API metadata. This is not a trading activation toggle.
 */
/** Recheck durable account/exchange signer and global controls while row locks
 * remain held through the single signed POST. Never trust worker startup state
 * as the last authorization when an operator can STOP or revoke credentials. */
export const FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL = `
 SELECT a.id
 FROM v13_production_account a
 JOIN v13_live_money_policy p ON p.id=a.policy_id
   AND p.execution_account_id=a.id
 JOIN live_execution_config live ON live.id='singleton'
 JOIN private.kalshi_account_worker_lease lease
   ON lease.execution_account_id=a.id AND lease.owner_user_id=a.owner_user_id
   AND lease.financial_account_id=a.kalshi_connection_id
   AND lease.credential_fingerprint=a.key_fingerprint
 JOIN private.kalshi_connection_credentials c
   ON c.owner_user_id=a.owner_user_id
   AND c.financial_account_id=a.kalshi_connection_id
   AND c.key_fingerprint=a.key_fingerprint
 WHERE a.owner_user_id=$1::uuid AND a.id=$2
   AND a.subaccount=1 AND a.exchange_index=2
   AND a.commissioned=true AND a.execution_enabled=true
   AND a.kill_switch=false AND a.cash_precision_verified=true
   AND a.blocked_reason IS NULL
   AND a.key_fingerprint=$3
   AND p.policy_hash=$4 AND p.state='APPROVED'
   AND p.fee_source_url=$5
   AND p.fee_policy_version='${API_SOURCE_POLICY_VERSION}'
   AND p.fee_formula_version='${API_SOURCE_FORMULA_VERSION}'
   AND live.live_execution_enabled=true AND live.manual_kill_switch=false
   AND c.role='restricted_execution'
   AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL
   AND c.verification_reason='credential_verified'
   AND lease.state='owned' AND lease.account_kill=false
   AND lease.fencing_token=$6::bigint AND lease.holder_id=$7
   AND lease.heartbeat_at>now()-interval '30 seconds'
   -- An entry/increase needs BOTH independently reviewed executable EXIT code
   -- and this account owner's separately authenticated exact-SHA release.
   -- Neither the checkbox nor any client-provided reduce_only flag grants it.
   AND (NOT $8::boolean OR (
      EXISTS (
        SELECT 1 FROM private.strata_owner_sha_approvals oa
        WHERE oa.owner_user_id=a.owner_user_id
          AND oa.execution_account_id=a.id
          AND oa.release_commit_sha=$9 AND oa.revoked_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM private.strata_protective_exit_release x
        WHERE x.release_commit_sha=$9 AND x.state='approved'
          AND x.revoked_at IS NULL AND x.created_at<=now()
          AND x.expires_at>now()+interval '20 minutes'
          AND x.independent_reviewer_id<>a.owner_user_id
          AND x.operator_approver_id<>x.independent_reviewer_id
      )
   ))
 FOR SHARE OF a,p,live,c,lease
`;
export function createGuardedReviewedApiFeeFetch(
 ownerUserId:string,executionAccountId:string,sourceUrl:string,transport:typeof fetch,
 expectedPolicyHash:string,expectedSignerFingerprint:string,
 expectedFencingToken:number,expectedLeaseHolderId:string,
 deps:{connect?:()=>ReturnType<typeof pool.connect>;
   verify?:typeof verifyReviewedApiFeeSourceStage;
   verifyMonetary?:typeof verifyMonetaryFeeContract}={},
):typeof fetch {
 if(!parseReviewedApiSource(sourceUrl))
  throw new Error("reviewed_api_source_url_invalid");
 if(!executionAccountId || !/^[a-f0-9]{64}$/i.test(expectedPolicyHash) ||
    !/^[a-f0-9]{64}$/i.test(expectedSignerFingerprint) ||
    !Number.isSafeInteger(expectedFencingToken) || expectedFencingToken<=0 ||
    !expectedLeaseHolderId || expectedLeaseHolderId.length>200)
  throw new Error("reviewed_api_account_identity_missing");
 return async (request,init)=>{
  // Fetch accepts Request objects and normalizes method case. A POST must
  // never bypass the fee/order fence through a non-string input or 'post'.
  const rawMethod=init?.method ??
    (request instanceof Request ? request.method : "GET");
  const method=rawMethod.toUpperCase();
  if(method!=="POST"){
    if(!["GET","HEAD","DELETE"].includes(method))
      throw new Error("api_fee_unsupported_exchange_method");
    // Even read-only Kalshi calls can carry a live API signature. Never pass
    // those headers to user-provided, redirecting, or non-Kalshi URLs.
    // URL parsing normalizes ports, credentials and encoded path components.
    let parsed:URL;
    try{
      parsed=new URL(request instanceof Request ? request.url :
        typeof request==="string" ? request : request.toString());
    }catch{throw new Error("api_fee_unexpected_read_endpoint");}
    if(parsed.origin!=="https://external-api.kalshi.com" ||
       parsed.username!=="" || parsed.password!=="" ||
       !/^\/trade-api\/v2\/(?:portfolio|historical|markets|events|series|exchange)(?:\/|$)/.test(parsed.pathname) ||
       /%2f|%5c|%2e|\\\\|\/\//i.test(parsed.pathname))
      throw new Error("api_fee_unexpected_read_endpoint");
    if(method==="DELETE"){
      // Permit safety cancellations only at documented order-ID endpoints.
      if(!/^\/trade-api\/v2\/portfolio\/(?:orders|events\/orders)\/[A-Za-z0-9_-]+$/.test(parsed.pathname))
        throw new Error("api_fee_unexpected_cancel_endpoint");
    }
    // Signed request headers must never follow a provider redirect onto a
    // different origin, even when the caller used Request.redirect="follow".
    return transport(request,{...init,redirect:"error"});
  }
  if(init?.method!=="POST" || typeof request!=="string" ||
     request!=="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders"||
     typeof init.body!=="string")
    throw new Error("api_fee_unexpected_order_endpoint");
  let order:Record<string,unknown>;
  try{
   const raw=JSON.parse(init.body);
   if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid");
   order=raw as Record<string,unknown>;
  }catch{throw new Error("api_fee_order_body_invalid");}
  const ticker=order.ticker;
  if(typeof ticker!=="string" || !/^KXBTC15M-[A-Za-z0-9-]+$/.test(ticker) ||
     order.subaccount!==1 || order.exchange_index!==2)
    throw new Error("api_fee_order_scope_invalid");
  // A new entry is possible ONLY when exact deployed SHA, signed protective
  // EXIT capability, owner SHA authorization, and fresh Kalshi/readiness
  // evidence are independently present. This is not a browser bypass.
  if (order.reduce_only!==true && order.reduce_only!==false)
    throw new Error("api_fee_reduce_only_indicator_invalid");
  const isEntry=order.reduce_only===false;
  const deployedSha=process.env.RAILWAY_GIT_COMMIT_SHA;
  if(isEntry && (process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=="true" ||
     process.env.NODE_ENV!=="production" ||
     !/^[a-f0-9]{40}$/.test(deployedSha??"")))
    throw new Error("api_fee_source_new_entry_blocked_pending_exit_validation");
  if(order.time_in_force!=="immediate_or_cancel"||
     order.self_trade_prevention_type!=="taker_at_cross"||
     order.post_only!==false || order.expiration_time!==undefined ||
     typeof order.client_order_id!=="string" ||
     !/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(order.client_order_id) ||
     (order.side!=="bid"&&order.side!=="ask") ||
     typeof order.count!=="string"||!/^[0-9]{1,9}\.[0-9]{2}$/.test(order.count) ||
     Number(order.count)<=0 ||
     typeof order.price!=="string"||!/^0\.[0-9]{4}$/.test(order.price) ||
     Number(order.price)<=0)
    throw new Error("api_fee_order_shape_unverified");
  const client=await(deps.connect?.()??pool.connect());
  let committed=false;
  try{
   await client.query("BEGIN");
   await client.query("SET LOCAL lock_timeout='1000ms'");
   await client.query("SET LOCAL statement_timeout='15000ms'");
   const finalAccount=await client.query(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,[
    ownerUserId,executionAccountId,expectedSignerFingerprint,expectedPolicyHash,sourceUrl,
    expectedFencingToken,expectedLeaseHolderId,isEntry,
    isEntry?deployedSha:null,
   ]);
   if(finalAccount.rows.length!==1)
    throw new Error(isEntry?
     "api_fee_final_entry_exit_release_owner_or_account_closed":
     "api_fee_final_account_signer_or_kill_closed");
   // A signed reviewed-API fee source is itself the independently reviewed
   // monetary model for this market. Requiring a separate PDF fetch here
   // makes the approved PDF-free alternative impossible during HTTP 429.
   // Preserve the additional verifier for explicit test/legacy callers.
   if(deps.verifyMonetary){
    const monetary=await deps.verifyMonetary("ORDER_ENTRY",ticker);
    if(!monetary.ok || monetary.marketTicker!==ticker)
     throw new Error("api_fee_final_order_monetary_source_closed");
   }
   const checked=await (deps.verify??verifyReviewedApiFeeSourceStage)(
    ownerUserId,"ORDER_ENTRY",sourceUrl,ticker,{db:client});
   if(!checked.ok || checked.identity.marketTicker!==ticker ||
      checked.identity.sourceUrl!==sourceUrl ||
      checked.identity.feePolicyVersion!==API_SOURCE_POLICY_VERSION ||
      checked.identity.formulaVersion!==API_SOURCE_FORMULA_VERSION ||
      !/^[a-f0-9]{64}$/.test(checked.identity.digest))
    throw new Error("api_fee_final_order_grant_or_market_closed");
   const response=await transport(request,init);
   await client.query("COMMIT");committed=true;
   return response;
  }finally{
   if(!committed){try{await client.query("ROLLBACK");}catch{}}
   client.release();
  }
 };
}
