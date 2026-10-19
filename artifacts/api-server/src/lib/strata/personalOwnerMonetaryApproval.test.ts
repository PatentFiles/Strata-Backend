import test from "node:test";
import assert from "node:assert/strict";
import { approveOwnedPolicyForUser } from "./personalAccountActivation";
import { APPROVE_OWNED_POLICY_CONFIRMATION } from "./personalPolicyApproval";
import type { verifyMonetaryFeeContract } from "./monetaryFeeContract";

const USER="11111111-1111-4111-8111-111111111111";
const ACCOUNT="owner-account-1";
const DIGEST="d".repeat(64);
function policy(confirmation:unknown=APPROVE_OWNED_POLICY_CONFIRMATION){
 return {confirmation,feeSourceKind:"kalshi_owner_verified_monetary_v1",
  policyId:"policy-owner-1",version:1,
  limits:{capitalLimitCents:2500,maxEntryStakeCents:150,
   maxEntryAllInCents:200,maxDailyLossCents:500,maxTotalLossCents:1500,
   maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:15000}};
}
const good=(async()=>({ok:true as const,reason:"provider_monetary_fee_schedule_and_market_verified",
 stage:"STEP_9" as const,marketTicker:"KXBTC15M-26OCT191145-45",
 sourceDigest:DIGEST,verifiedAt:"2026-10-19T15:35:00.000Z",
 monetaryFeeAuthorized:true as const,policyApproved:false as const,tradingAuthorized:false as const,
})) as unknown as typeof verifyMonetaryFeeContract;
test("owner monetary approval refuses unsigned request before any source access or DB write",async()=>{
 let calls=0;
 const verifier=(async()=>{calls++;throw Error("never called");}) as typeof verifyMonetaryFeeContract;
 const db={query:async()=>{throw Error("unexpected DB write");}};
 const outcome=await approveOwnedPolicyForUser(db,{ownerUserId:USER,executionAccountId:ACCOUNT,
  body:policy("not-owner-consent"),verifyMonetary:verifier});
 assert.equal(outcome.ok,false);assert.equal(outcome.reason,"explicit_authorization_required");
 assert.equal(calls,0);
});
test("valid authenticated owner policy persists only after complete monetary evidence",async()=>{
 const queries:{sql:string;params?:unknown[]}[]=[];
 const query=async(sql:string,params?:unknown[])=>{
  queries.push({sql,params});
  return {rows:sql.includes("owned-policy:approve")||sql.includes("owned-policy:link")?
   [{id:"policy-owner-1"}]:[],rowCount:1};
 };
 const db={query,connect:async()=>({query,release:()=>{}})};
 const outcome=await approveOwnedPolicyForUser(db,{
  ownerUserId:USER,executionAccountId:ACCOUNT,body:policy(),verifyMonetary:good});
 assert.equal(outcome.ok,true);assert.equal(outcome.reason,"policy_approved");
 assert.equal(outcome.feeArtifactDigest,DIGEST);
 assert.ok(queries.some(x=>x.sql.includes("owned-policy:approve")));
 assert.ok(queries.some(x=>x.sql.includes("owned-policy:link")));
 assert.ok(queries.some(x=>x.sql==="COMMIT"));
 assert.equal(queries.filter(x=>/INSERT INTO.*strata_api_fee_/i.test(x.sql)).length,0);
 const update=queries.find(x=>x.sql.includes("owned-policy:approve"))!;
 assert.ok(update.params?.includes("micro-live-standing-fee-policy-v1"));
 assert.ok(update.params?.includes("https://kalshi.com/docs/kalshi-fee-schedule.pdf"));
 assert.ok(update.params?.includes(USER));
});
test("denied monetary source performs no policy mutation despite correct owner checkbox",async()=>{
 let calls=0;
 const refuse=(async()=>({ok:false,reason:"official_fee_schedule_http_429",
  stage:"STEP_9",monetaryFeeAuthorized:false,
  policyApproved:false,tradingAuthorized:false})) as typeof verifyMonetaryFeeContract;
 const db={query:async()=>{calls++;throw Error("must not mutate");}};
 const outcome=await approveOwnedPolicyForUser(db,{
  ownerUserId:USER,executionAccountId:ACCOUNT,body:policy(),verifyMonetary:refuse});
 assert.equal(outcome.ok,false);
 assert.equal(outcome.reason,"official_fee_schedule_http_429");
 assert.equal(calls,0);
});
