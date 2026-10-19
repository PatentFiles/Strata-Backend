/** Final server-owned monetary source and account fence for Kalshi POST.
 * This is an additional defense for the existing direct-owner standing policy.
 * All exchange orders keep the regular executor risk, ledger and signing checks.
 * Never infer authority from a browser observation or a cached digest.
 */
import { pool } from "@workspace/db";
import { verifyMonetaryFeeContract } from "./monetaryFeeContract";
import { CANONICAL_FEE_SCHEDULE_URL, STANDING_FEE_POLICY_VERSION,
 STANDARD_QUADRATIC_FEE_FORMULA_VERSION } from "../microLiveFeeArtifact";

const ORDER_URL="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders";
const TICKER=/^KXBTC15M-[A-Za-z0-9-]+$/;
const HEX=/^[a-f0-9]{64}$/;
type DbClient={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;release():void};
type DbConnector=()=>Promise<DbClient>;

export const FINAL_MONETARY_ACCOUNT_FENCE_SQL=`
 SELECT a.id FROM v13_production_account a
 JOIN v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
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
  AND a.key_fingerprint=$3 AND a.fee_artifact_digest=$8
  AND p.policy_hash=$4 AND p.state='APPROVED'
  AND p.fee_source_url=$5
  AND p.fee_policy_version=$9 AND p.fee_formula_version=$10
  AND live.live_execution_enabled=true AND live.manual_kill_switch=false
  AND c.role='restricted_execution' AND c.revoked_at IS NULL
  AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
  AND lease.state='owned' AND lease.account_kill=false
  AND lease.fencing_token=$6::bigint AND lease.holder_id=$7
  AND lease.heartbeat_at>now()-interval '30 seconds'
 FOR SHARE OF a,p,live,c,lease
`;

export function createGuardedMonetaryFeeFetch(
 ownerUserId:string,executionAccountId:string,transport:typeof fetch,
 expectedPolicyHash:string,expectedSignerFingerprint:string,
 expectedFencingToken:number,expectedLeaseHolderId:string,
 expectedFeeDigest:string,
 deps:{connect?:DbConnector;verify?:typeof verifyMonetaryFeeContract}={},
):typeof fetch{
 if(!ownerUserId||!executionAccountId||!HEX.test(expectedPolicyHash)||
    !HEX.test(expectedSignerFingerprint)||!HEX.test(expectedFeeDigest)||
    !Number.isSafeInteger(expectedFencingToken)||expectedFencingToken<=0||
    !expectedLeaseHolderId||expectedLeaseHolderId.length>200)
   throw Error("monetary_fee_account_identity_invalid");
 return async(request,init)=>{
  const method=(init?.method??(request instanceof Request?request.method:"GET")).toUpperCase();
  if(method!=="POST")return transport(request,init);
  if(init?.method!=="POST"||typeof request!=="string"||
     request!==ORDER_URL||typeof init.body!=="string")
    throw Error("monetary_fee_order_endpoint_invalid");
  let order:Record<string,unknown>;
  try {
   const parsed:unknown=JSON.parse(init.body);
   if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error("invalid");
   order=parsed as Record<string,unknown>;
  }catch{throw Error("monetary_fee_order_body_invalid");}
  const ticker=order.ticker;
  if(typeof ticker!=="string"||!TICKER.test(ticker)||
     order.subaccount!==1||order.exchange_index!==2)
    throw Error("monetary_fee_order_scope_invalid");
  // Preserve the protective-exit hold until separately verified live.
  if(order.reduce_only!==true)
    throw Error("monetary_fee_new_risk_requires_exit_validation");
  if(order.time_in_force!=="immediate_or_cancel"||
     order.self_trade_prevention_type!=="taker_at_cross"||
     order.post_only!==false||order.expiration_time!==undefined||
     (order.side!=="bid"&&order.side!=="ask")||
     typeof order.count!=="string"||!/^[0-9]{1,9}\.[0-9]{2}$/.test(order.count)||
     Number(order.count)<=0||
     typeof order.price!=="string"||!/^0\.[0-9]{4}$/.test(order.price)||
     Number(order.price)<=0||
     typeof order.client_order_id!=="string"||
     !/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(order.client_order_id))
    throw Error("monetary_fee_exit_order_shape_invalid");
  const connector:DbConnector=deps.connect??(()=>pool.connect() as unknown as Promise<DbClient>);
  const client=await connector();
  let committed=false;
  try{
   await client.query("BEGIN");
   await client.query("SET LOCAL lock_timeout='1000ms'");
   await client.query("SET LOCAL statement_timeout='15000ms'");
   const match=await client.query(FINAL_MONETARY_ACCOUNT_FENCE_SQL,[
    ownerUserId,executionAccountId,expectedSignerFingerprint,expectedPolicyHash,
    CANONICAL_FEE_SCHEDULE_URL,expectedFencingToken,expectedLeaseHolderId,
    expectedFeeDigest,STANDING_FEE_POLICY_VERSION,STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
   ]);
   if(match.rows.length!==1)throw Error("monetary_fee_final_account_or_kill_closed");
   const proof=await(deps.verify??verifyMonetaryFeeContract)("ORDER_ENTRY",ticker);
   if(!proof.ok||!proof.monetaryFeeAuthorized||proof.marketTicker!==ticker||
      proof.sourceDigest!==expectedFeeDigest)
     throw Error("monetary_fee_final_order_source_unverified");
   const response=await transport(request,init);
   await client.query("COMMIT");committed=true;
   return response;
  }finally{
   if(!committed){try{await client.query("ROLLBACK");}catch{}}
   client.release();
  }
 };
}
