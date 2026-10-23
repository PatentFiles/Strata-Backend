import test from "node:test";
import assert from "node:assert/strict";
import { digest as v13Digest } from "../v13-production/types";
import { API_SOURCE_POLICY_VERSION, API_SOURCE_FORMULA_VERSION } from "./apiFeeSourceStage";
import {
  qualifyProtectiveRelease,attestProtectiveReleaseReview,
  authorizeProtectiveRelease,readReleaseOwner,protectiveReleaseStatus,
  REVIEW_CONFIRM,OWNER_CONFIRM,PROVISIONAL_REPAIR_CONFIRM,
} from "./inAppProtectiveRelease";
const OWNER="11111111-1111-4111-8111-111111111111";
const REVIEWER="22222222-2222-4222-8222-222222222222";
const SHA="a".repeat(40);
const DIGEST="b".repeat(64);
const QID="33333333-3333-4333-8333-333333333333";
const RID="44444444-4444-4444-8444-444444444444";
const emptySignedFeed=(override:Record<string,unknown>={})=>({
 ok:true as const,observedAtMs:Date.now(),cashMicros:"25000000",
 orders:[],fills:[],positions:[],settlements:[],...override,
});
const repairRequest={reviewId:RID,confirmation:OWNER_CONFIRM,
 provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM};
const account={id:"owner-execution-2",owner_id:OWNER,commissioned:true,policy_state:"APPROVED",
 cash_precision_verified:true,minimum_exit_micros:10000,fee_artifact_digest:DIGEST,
 fee_source_url:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 cash_micros:"25000000",key_fingerprint:"c".repeat(64),
 policy_id:"policy-v13",commissioning_digest:"c".repeat(64),kalshi_connection_id:QID,configured_stake_cents:100,
 max_entry_stake_cents:2500,max_entry_all_in_cents:3000};
type Row=Record<string,unknown>;
function fakeDb(input:{review?:boolean;duplicate?:boolean;permit?:boolean;badCash?:boolean;freeze?:string;unresolved?:boolean;fresh?:boolean;apiSource?:boolean}={}){
 const executed:string[]=[];
 const query=async(sql:string,_args?:unknown[]):Promise<{rows:Row[]}>=>{
  executed.push(sql);
  if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL"))return {rows:[]};
  if(sql.includes("FROM public.v13_production_account a")&&sql.includes("stake.configured_stake_cents"))return {rows:[{...account,blocked_reason:input.freeze??null,...(input.apiSource?{
    fee_source_url:"strata-api-reviewed://kxbtc15m/55555555-5555-4555-8555-555555555555",
    fee_policy_version:API_SOURCE_POLICY_VERSION,fee_formula_version:API_SOURCE_FORMULA_VERSION,
  }:{})}]};
  if(sql.includes("FROM public.v13_production_observation o"))return {rows:[{
    digest:v13Digest({accountId:String(account.id),policyId:String(account.policy_id),
      feeDigest:String(account.fee_artifact_digest),stakeCents:Number(account.configured_stake_cents),
      commissioningDigest:String(account.commissioning_digest??""),
      minimumExitMicros:Number(account.minimum_exit_micros)})
  }]};
  if(sql.includes("WITH unresolved_intents"))return {rows:[{n:"0"}]};
  if(sql.includes("FROM private.kalshi_connection_credentials c"))return {rows:[{
    decrypted_secret:JSON.stringify({api_key_id:"not-real",private_key:"offline-only"}),
  }]};
  if(sql.includes("AS intents,")||sql.includes(") intents,"))
   return {rows:[{intents:input.unresolved?"1":"0",events:"0",positions:"0",exit_reservations:"0"}]};
  // The guarded UPDATE embeds NOT EXISTS history subqueries; match writes
  // before generic SELECT history mocks or this test would falsely refuse.
  if(sql.includes("UPDATE public.v13_production_account"))return {rows:[{id:account.id}]};
  if(sql.includes("INSERT INTO public.v13_production_observation"))return {rows:[]};
  if(sql.includes("FROM public.v13_production_intent WHERE account_id"))return {rows:[]};
  if(sql.includes("INSERT INTO private.strata_protective_release_qualification"))
   return {rows:[{id:QID,expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("FROM private.strata_protective_release_qualification"))
   return {rows:[{qualification_id:QID,evidence_digest:DIGEST}]};
  if(sql.includes("FROM private.strata_protective_release_reviews")&&
     sql.includes("reviewer_user_id=$2"))return {rows:input.duplicate?[{review_id:RID}]:[]};
  if(sql.includes("INSERT INTO private.strata_protective_release_reviews"))
   return {rows:[{id:RID,expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("FROM public.v13_production_account")&&sql.includes("FOR UPDATE"))
   return {rows:[{id:account.id,execution_enabled:false,kill_switch:true,cash_micros:"25000000",
    blocked_reason:input.freeze??null,commissioned:true,cash_precision_verified:true,reserved_micros:"0",
    reconciled_at:new Date(Date.now()-(input.fresh===false?60_000:1000)).toISOString()}]};
  if(sql.includes("FROM public.live_execution_config"))return {rows:[{
    mode:"V13_PRODUCTION",live_execution_enabled:false,manual_kill_switch:true,
  }]};
  if(sql.includes("FROM private.strata_protective_release_reviews r")&&
     sql.includes("JOIN private.strata_protective_release_qualification"))
   return {rows:input.review===false?[]:[{review_id:RID,reviewer_user_id:REVIEWER,
     review_url:"https://github.com/PatentFiles/Strata-Backend/pull/107",
     evidence_digest:DIGEST,qualification_digest:DIGEST}]};
  if(sql.includes("FROM auth.users u JOIN public.profiles p"))return {rows:input.permit===false?[]:[{"?column?":1}]};
  if(sql.includes("FROM private.strata_protective_exit_release"))return {rows:[]};
  if(sql.includes("INSERT INTO private.strata_protective_exit_release"))
   return {rows:[{id:"55555555-5555-4555-8555-555555555555",expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("UPDATE public.live_execution_config"))return {rows:[{id:"singleton"}]};
  throw Error("unexpected_query");
 };
 const db={query,connect:async()=>({query,release(){executed.push("RELEASE")}})};
 return {db:db as never,executed};
}
test("PRODUCTION qualifier performs only owned GET and stores a digest, not a trading permission",async()=>{
 const h=fakeDb();
 let reads=0;
 const result=await qualifyProtectiveRelease(OWNER,{
  db:h.db,sha:()=>SHA,now:()=>Date.parse("2026-10-20T05:30:00Z"),
  readFeeds:(async()=>{reads++;return {ok:true,observedAtMs:Date.parse("2026-10-20T05:30:00Z"),
    cashMicros:"25000000",orders:[],fills:[],positions:[],settlements:[]}}) as never,
  verifyFee:(async()=>({ok:true,monetaryFeeAuthorized:true,sourceDigest:DIGEST})) as never,
 });
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(reads,1);
 assert.equal(result.ordersSubmitted,false);
 assert.equal(h.executed.filter(s=>s.includes("INSERT INTO")).length,1);
 assert.equal(h.executed.some(s=>/INSERT INTO (?:public\.v13_production_intent|private\.strata_protective_exit_release)/.test(s)),false);
});
test("Step 12 reports sanitized provider source reasons and still refuses missing or changed PDF digest",async()=>{
 const cases=[
  {fee:{ok:false,reason:"independent_official_fee_snapshot_expired"},
   expected:"release_fee_independent_official_fee_snapshot_expired"},
  {fee:{ok:false,reason:"official_fee_schedule_http_429"},
   expected:"release_fee_official_fee_schedule_http_429"},
  {fee:{ok:false,reason:"market_or_event_fee_override_unreviewed"},
   expected:"release_fee_market_or_event_fee_override_unreviewed"},
  {fee:{ok:true,sourceDigest:"c".repeat(64)},
   expected:"approved_fee_artifact_digest_changed"},
  {fee:{ok:true,sourceDigest:undefined},
   expected:"current_official_fee_digest_missing"},
  {fee:{ok:false,reason:"unsafe stack with=credentials&secret=must-not-echo"},
   expected:"release_fee_fee_preflight_unavailable"},
 ];
 for(const row of cases){
  const h=fakeDb();
  const result=await qualifyProtectiveRelease(OWNER,{
   db:h.db,sha:()=>SHA,now:()=>Date.parse("2026-10-20T05:30:00Z"),
   readFeeds:(async()=>({ok:true,observedAtMs:Date.parse("2026-10-20T05:30:00Z"),
    cashMicros:"25000000",orders:[],fills:[],positions:[],settlements:[]})) as never,
   verifyFee:(async()=>row.fee) as never,
  });
  assert.equal(result.ok,false,row.expected);
  assert.equal(result.reason,row.expected);
  assert.equal(result.ordersSubmitted,false);
  assert.equal(h.executed.some(s=>s.includes("INSERT INTO private.strata_protective_release_qualification")),false);
 }
});
test("Step 12 accepts a genuine reviewed API-source eligibility without a PDF capture",async()=>{
 const observed=Date.parse("2026-10-20T05:30:00Z"),h=fakeDb({apiSource:true});
 let pdfReads=0,apiReads=0;
 const r=await qualifyProtectiveRelease(OWNER,{
  db:h.db,sha:()=>SHA,now:()=>observed,
  readFeeds:(async()=>({ok:true,observedAtMs:observed,cashMicros:"25000000",
    orders:[],fills:[],positions:[],settlements:[]})) as never,
  verifyFee:(async()=>{pdfReads++;throw Error("PDF must not be used for API-reviewed source")}) as never,
  verifyApiFee:(async(owner:string,stage:string,url:string)=>{
   apiReads++;
   assert.equal(owner,OWNER);assert.equal(stage,"STEP_11");
   assert.equal(url,"strata-api-reviewed://kxbtc15m/55555555-5555-4555-8555-555555555555");
   return {ok:true,reason:"reviewed_api_fee_source_stage_current",identity:{
    grantId:"55555555-5555-4555-8555-555555555555",sourceUrl:url,
    digest:"f".repeat(64),feePolicyVersion:API_SOURCE_POLICY_VERSION,
    formulaVersion:API_SOURCE_FORMULA_VERSION,
    marketTicker:"KXBTC15M-26OCT200530",verifiedAtMs:observed,
   }};
  }) as never,
 });
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.ordersSubmitted,false);
 assert.equal(pdfReads,0);assert.equal(apiReads,1);
 assert.equal(h.executed.filter(x=>x.includes("INSERT INTO private.strata_protective_release_qualification")).length,1);
});
test("Step 12 denies a revoked, wrong or stale API fee-source review",async()=>{
 const observed=Date.parse("2026-10-20T05:30:00Z");
 for(const caseName of ["revoked","wrong_grant","stale"]){
  const h=fakeDb({apiSource:true});
  const r=await qualifyProtectiveRelease(OWNER,{
   db:h.db,sha:()=>SHA,now:()=>observed,
   readFeeds:(async()=>({ok:true,observedAtMs:observed,cashMicros:"25000000",
     orders:[],fills:[],positions:[],settlements:[]})) as never,
   verifyFee:(async()=>{throw Error("unexpected PDF request")}) as never,
   verifyApiFee:(async()=>{
    if(caseName==="revoked")return {ok:false,reason:"api_fee_grant_missing_invalid_or_expired"};
    return {ok:true,identity:{
     grantId:caseName==="wrong_grant"?"66666666-6666-4666-8666-666666666666":
      "55555555-5555-4555-8555-555555555555",
     sourceUrl:"strata-api-reviewed://kxbtc15m/55555555-5555-4555-8555-555555555555",
     digest:"f".repeat(64),feePolicyVersion:API_SOURCE_POLICY_VERSION,
     formulaVersion:API_SOURCE_FORMULA_VERSION,marketTicker:"KXBTC15M-26OCT200530",
     verifiedAtMs:caseName==="stale"?observed-60_000:observed,
    }};
   }) as never,
  });
  assert.equal(r.ok,false,caseName);
  assert.equal(r.ordersSubmitted,false);
  assert.equal(h.executed.some(s=>s.includes("INSERT INTO private.strata_protective_release_qualification")),false);
 }
});
test("owner-only qualification rejects stale exchange readings and expired provider journeys",async()=>{
 const observed=Date.parse("2026-10-20T05:30:00Z");
 const expired=fakeDb();
 const staleFeed=await qualifyProtectiveRelease(OWNER,{
  db:expired.db,sha:()=>SHA,now:()=>observed,
  readFeeds:(async()=>({
   ok:true,observedAtMs:observed-45_001,cashMicros:"25000000",
   orders:[],fills:[],positions:[],settlements:[],
  })) as never,
  verifyFee:(async()=>({ok:true,sourceDigest:DIGEST})) as never,
 });
 assert.equal(staleFeed.reason,"authenticated_production_read_stale");
 assert.equal(expired.executed.some(sql=>sql.includes("INSERT INTO private.strata_protective_release_qualification")),false);
 const slow=fakeDb();
 let observedClockCalls=0;
 const expiredFee=await qualifyProtectiveRelease(OWNER,{
  db:slow.db,sha:()=>SHA,
  now:()=>++observedClockCalls===1?observed:
    observedClockCalls===2?observed:observed+45_001,
  readFeeds:(async()=>({
   ok:true,observedAtMs:observed,cashMicros:"25000000",
   orders:[],fills:[],positions:[],settlements:[],
  })) as never,
  verifyFee:(async()=>({ok:true,sourceDigest:DIGEST})) as never,
 });
 assert.equal(expiredFee.reason,"authenticated_production_qualification_stale");
 assert.equal(slow.executed.some(sql=>sql.includes("INSERT INTO private.strata_protective_release_qualification")),false);
});
test("reviewer cannot impersonate account owner or use ordinary user role",async()=>{
 const h=fakeDb(),data={ownerUserId:OWNER,qualificationId:QID,
  reviewUrl:"https://github.com/PatentFiles/Strata-Backend/pull/107",
  note:"Reviewed the exact SHA, price floors, unknown orders, crash recovery, fees, owner isolation and signed production GET evidence.",
  confirmation:REVIEW_CONFIRM};
 assert.equal((await attestProtectiveReleaseReview(OWNER,"ADMIN",data,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal((await attestProtectiveReleaseReview(REVIEWER,"STANDARD",data,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal(h.executed.length,0);
});
test("authenticated distinct reviewer persists immutable evidence in transaction",async()=>{
 const h=fakeDb(),data={ownerUserId:OWNER,qualificationId:QID,
  reviewUrl:"https://github.com/PatentFiles/Strata-Backend/pull/107",
  note:"Reviewed the exact release SHA, official fee inputs, full provider history, cash and position reconciliation, signed exits, and no-retry crashes.",
  confirmation:REVIEW_CONFIRM};
 const r=await attestProtectiveReleaseReview(REVIEWER,"DEVELOPER",data,{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.ok(h.executed.indexOf("BEGIN")<h.executed.indexOf("COMMIT"));
 assert.equal(h.executed.some(s=>s.includes("UPDATE public.live_execution_config")),false);
});
test("owner acceptance is rejected if missing distinct reviewer or authenticated confirmation",async()=>{
 const h=fakeDb({review:false});
 const body={reviewId:RID,confirmation:OWNER_CONFIRM};
 assert.equal((await authorizeProtectiveRelease(OWNER,{...body,confirmation:"wrong"},{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal((await authorizeProtectiveRelease(OWNER,body,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal(h.executed.some(s=>s.includes("UPDATE public.live_execution_config")),false);
 assert.ok(h.executed.includes("ROLLBACK"));
});
test("owner consent inserts exact signed release then atomically enables account and global live flag",async()=>{
 const h=fakeDb();
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.ordersSubmitted,false);
 assert.equal("workerStarted" in r && r.workerStarted,false);
 const insert=h.executed.findIndex(s=>s.includes("INSERT INTO private.strata_protective_exit_release"));
 const accountUpdate=h.executed.findIndex(s=>s.includes("UPDATE public.v13_production_account"));
 const globalUpdate=h.executed.findIndex(s=>s.includes("UPDATE public.live_execution_config"));
 assert.ok(insert>0&&accountUpdate>insert&&globalUpdate>accountUpdate);
 assert.ok(h.executed.indexOf("COMMIT")>globalUpdate);
});

test("provisional freeze cannot be cleared without distinct explicit owner consent",async()=>{
 const h=fakeDb({freeze:"awaiting_account_commissioning"});
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"explicit_commissioning_repair_confirmation_required");
 assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
 assert.equal(h.executed.includes("COMMIT"),false);
});
test("any genuine freeze is immutable through commissioning recovery",async()=>{
 const h=fakeDb({freeze:"unknown_exchange_order"});
 const r=await authorizeProtectiveRelease(OWNER,{
  reviewId:RID,confirmation:OWNER_CONFIRM,provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM,
 },{db:h.db,sha:()=>SHA});
 assert.equal(r.reason,"account_risk_freeze_requires_independent_remediation");
 assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
});
test("owner-authorized recovery denies stale signed source, mismatched cash and any exchange exposure",async()=>{
 const cases=[
  {name:"stale exchange feed",feed:emptySignedFeed({observedAtMs:Date.now()-60_000}),
   reason:"commissioning_repair_live_cash_or_freshness_unverified"},
  {name:"cash mismatch",feed:emptySignedFeed({cashMicros:"24000000"}),
   reason:"commissioning_repair_live_cash_or_freshness_unverified"},
  {name:"exchange orders",feed:emptySignedFeed({orders:[{order_id:"unknown"}]}),
   reason:"commissioning_repair_live_exposure_unverified"},
  {name:"exchange open positions",feed:emptySignedFeed({positions:[{ticker:"KXBTC15M-TEST",position_fp:"1.00"}]}),
   reason:"commissioning_repair_live_exposure_unverified"},
  {name:"provider failure",feed:{ok:false as const,reason:"kalshi_read_failed"},
   reason:"commissioning_repair_live_exchange_read_unavailable"},
 ];
 for(const row of cases){
  const h=fakeDb({freeze:"awaiting_account_commissioning"});
  const r=await authorizeProtectiveRelease(OWNER,repairRequest,{
   db:h.db,sha:()=>SHA,
   // Avoid preconstructing stale transport timestamps for otherwise valid evidence.
   readFeeds:(async (_material:unknown,observedAtMs:number)=>{
    const feed=row.feed;
    return feed.ok
      ? {...feed,observedAtMs:row.name==="stale exchange feed"?feed.observedAtMs:observedAtMs}
      : feed;
   }) as never,
  });
  assert.equal(r.ok,false,row.name);
  assert.equal(r.reason,row.reason,row.name);
  assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false,row.name);
  assert.ok(h.executed.includes("ROLLBACK"),row.name);
 }
 const h=fakeDb({freeze:"awaiting_account_commissioning",unresolved:true});
 const r=await authorizeProtectiveRelease(OWNER,repairRequest,{
  db:h.db,sha:()=>SHA,readFeeds:(async()=>emptySignedFeed()) as never,
 });
 assert.equal(r.reason,"commissioning_repair_fresh_zero_exposure_unverified");
 assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
});
test("explicit owner reviewed repair refreshes real Kalshi evidence inside transaction even with old worker reconciliation",async()=>{
 const h=fakeDb({freeze:"awaiting_account_commissioning",fresh:false});
 // The signed provider read and the expected qualification clock refer to
 // ONE observation. Sampling Date.now() twice made this positive-path test
 // nondeterministic across millisecond boundaries.
 const observedAtMs=Date.now();
 let signedReads=0;
 const r=await authorizeProtectiveRelease(OWNER,repairRequest,{
  db:h.db,sha:()=>SHA,now:()=>observedAtMs,
  readFeeds:(async()=>{
   signedReads++;
   return emptySignedFeed({observedAtMs});
  }) as never,
 });
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(signedReads,1);
 assert.equal("provisionalFreezeRepaired" in r && r.provisionalFreezeRepaired,true);
 const providerMaterial=h.executed.findIndex(s=>s.includes("FROM private.kalshi_connection_credentials c"));
 const release=h.executed.findIndex(s=>s.includes("INSERT INTO private.strata_protective_exit_release"));
 const repair=h.executed.findIndex(s=>s.includes("SET blocked_reason=NULL"));
 const audit=h.executed.findIndex(s=>s.includes("OWNER_COMMISSIONING_FREEZE_REPAIR"));
 assert.ok(providerMaterial>=0&&release>providerMaterial&&repair>release&&audit>repair);
 assert.ok(h.executed.indexOf("COMMIT")>audit);
 assert.equal(h.executed.some(s=>s.includes("INSERT INTO public.v13_production_intent")),false);
 assert.ok(h.executed.some(s=>s.includes("statement_timestamp()-interval '15 seconds'")));
 assert.equal(h.executed.some(s=>s.includes("AND reconciled_at>now()-interval '15 seconds'")),false);
});

test("release account lookup binds the policy to both execution account and owner",async()=>{
  let sqlText="";
  const db={query:async(sql:string)=>{
    sqlText=sql;
    return {rows:[]};
  }};
  const result=await readReleaseOwner(db as never,OWNER);
  assert.deepEqual(result,{ok:false,reason:"owned_account_missing_or_ambiguous"});
  assert.match(sqlText,/p\.execution_account_id\s*=\s*a\.id/);
  assert.match(sqlText,/p\.created_by\s*=\s*a\.owner_user_id::text/);
});

test("owner SHA consent alone never reports a live technical protective-exit release",async()=>{
  const h=fakeDb();
  const query=(h.db as unknown as {query:(sql:string,params?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>}).query;
  let technicalSql="";
  const db={
    query:async(sql:string,params?:unknown[])=>{
      if(sql.includes("FROM private.strata_owner_sha_approvals")){
        return {rows:[{approval_id:RID}]};
      }
      if(sql.includes("SELECT release_id::text,expires_at FROM private.strata_protective_exit_release")){
        technicalSql=sql;
        return {rows:[]};
      }
      return query(sql,params);
    },
  };
  const status=await protectiveReleaseStatus(OWNER,OWNER,{db:db as never,sha:()=>SHA});
  assert.equal(status.ok,true,JSON.stringify(status));
  if(!("codeApprovalActive" in status && "releaseActive" in status)){
    throw new Error("release_status_shape_unavailable");
  }
  assert.equal(status.codeApprovalActive,true);
  assert.equal(status.releaseActive,false);
  assert.match(technicalSql,/expires_at>now\(\)\+interval '20 minutes'/);
  assert.match(technicalSql,/independent_reviewer_id<>\$2::uuid/);
  assert.match(technicalSql,/operator_approver_id<>independent_reviewer_id/);
});
