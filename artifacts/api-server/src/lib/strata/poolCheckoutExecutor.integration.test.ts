import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {tradingSession,source,policy,USER,ACCOUNT} from './personalExecution.integration.test';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from './apiFeeSourceStage';
import {readOwnedEntryMarket} from './ownedEntryMarketRead';
import {probeCurrentKalshiFeeApi} from './twoSourceFeeEvidence';
// Dedicated disposable target ONLY: imports the existing 40 registered baseline
// tests, then runs this destructive empty-schema fixture last. Do not import
// this module from other integration suites. The imported fixture owns pool.end.
// Research-only: actual executor final-denial + real global-pool fee SQL.
// PREPARE fee authority and signed/public venue inputs remain explicit fixtures.
test('actual executor FINAL fee denial retains controlled pool queue in its existing dispatch event',async()=>{
 const {verifyReviewedApiFeeSourceStage}=await import('./apiFeeSourceStage');
 const {annotateFeeFailure}=await import('./feeFailureDiagnostics');
 const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
 const emptySchema=async()=>{
  // Isolated disposable cluster only. No positive private authority exists.
  await pool.query('DROP SCHEMA IF EXISTS private CASCADE; DROP SCHEMA IF EXISTS auth CASCADE');
  await pool.query(`CREATE SCHEMA private; CREATE SCHEMA auth;
   CREATE TABLE auth.users(id uuid,email text,email_confirmed_at timestamptz);
   CREATE TABLE private.role_assignments(email text,role text);
   CREATE TABLE private.strata_api_fee_source_grants(grant_id uuid,owner_user_id uuid,issuer_admin_id uuid,rate_decision_digest text,fee_model_version text,policy_version text,scope text,issued_at timestamptz,expires_at timestamptz,revoked_at timestamptz,authorized_stages text[],confirmation text);
   CREATE TABLE private.strata_api_fee_owner_consents(grant_id uuid,owner_user_id uuid,confirmed_at timestamptz,revoked_at timestamptz,confirmation text);
   CREATE TABLE private.strata_api_fee_rate_reviews(review_id uuid,owner_user_id uuid,reviewer_user_id uuid,rate_decision_digest text,fee_model_version text,scope text,signed_at timestamptz,expires_at timestamptz,revoked_at timestamptz,confirmation text);`);
 };
 const outcomes:any[]=[];
 for(const queued of [false,true]){
  const posts:string[]=[],s=await tradingSession(500,posts);await emptySchema();
  const sourceUrl='strata-api-reviewed://kxbtc15m/55555555-5555-4555-8555-555555555555';
  const approved={...policy(),maxQuoteAgeMs:5000,feePolicyVersion:API_SOURCE_POLICY_VERSION,feeFormulaVersion:API_SOURCE_FORMULA_VERSION,feeSourceUrl:sourceUrl};approved.policyHash=computeV13LiveMoneyPolicyHash(approved);
  await pool.query('UPDATE v13_live_money_policy SET max_quote_age_ms=5000,fee_policy_version=$1,fee_formula_version=$2,fee_source_url=$3,policy_hash=$4 WHERE id=$5',[approved.feePolicyVersion,approved.feeFormulaVersion,sourceUrl,approved.policyHash,approved.id]);
  const originalAt=s.now,anchor=performance.now(),clock=()=>originalAt+Math.floor(performance.now()-anchor);
  Object.defineProperty(s.executor,'now',{value:clock});
  const evaluationId=await source(originalAt),market='KXBTC15M-TEST-000',event='KXBTC15M-TEST';
  const close=new Date(originalAt+900000).toISOString(),open=new Date(originalAt-60000).toISOString();
  const pages:Record<string,unknown>={
   [`/markets/${market}`]:{market:{ticker:market,event_ticker:event,exchange_index:2,status:'active',open_time:open,close_time:close,expiration_time:close,expected_expiration_time:close,latest_expiration_time:close,price_level_structure:'deci_cent'}},
   [`/events/${event}`]:{event:{event_ticker:event,series_ticker:'KXBTC15M',exchange_index:2,fee_type_override:null,fee_multiplier_override:null}},
   '/series/KXBTC15M':{series:{ticker:'KXBTC15M',exchange_index:2,fee_type:'quadratic',fee_multiplier:1}},
   '/series/fee_changes?series_ticker=KXBTC15M&show_historical=false':{series_fee_change_arr:[]},
   [`/events/fee_changes?event_ticker=${event}&limit=100`]:{event_fee_changes:[],cursor:''},
  };
  const calls:string[]=[],observed:any[]=[],proofs:any[]=[];let dispatching=false,finalCalls=0,finalSigned=0,waited=0,denial='';
  s.executor.timingObserver=event=>{observed.push(event);};
  const fetchPublic=(async(input,init)=>{assert.equal(init?.method,'GET');const path=String(input).replace('https://external-api.kalshi.com/trade-api/v2','');assert.ok(path in pages);calls.push(path);return Response.json(pages[path]);}) as typeof fetch;
  const signed=s.exchange.readSnapshot!;Object.defineProperty(s.exchange,'readSnapshot',{value:async(...args:Parameters<typeof signed>)=>{if(dispatching)finalSigned++;return signed(...args);}});
  const binding={accountId:ACCOUNT,ownerId:USER,holderId:'queue-fixture',releaseSha:'a'.repeat(40),fence:'3',policyHash:approved.policyHash!};
  Object.defineProperty(s.exchange,'readMarket',{value:async(ticker:string,side:'YES'|'NO',context:any)=>readOwnedEntryMarket({
   market:ticker,side,context,now:clock,apiSource:true,activeMetadata:null,metadataScope:()=>binding,publicFetch:fetchPublic,
   verifyFee:async(_clock,read,capture)=>{
    if(!dispatching){const proof=await probeCurrentKalshiFeeApi(fetchPublic,clock,ticker,read,capture);assert.ok(proof.ok);return Date.parse(proof.liveVerifiedAt!);}
    finalCalls++;assert.ok(s.executor.ledger.currentTransaction(),'real final owned transaction is held');
    const holders=[];
    let pending:ReturnType<typeof verifyReviewedApiFeeSourceStage>|undefined;
    try{
     if(queued){for(let n=0;n<9;n++)holders.push(await pool.connect());assert.equal(pool.idleCount,0);assert.equal(pool.totalCount,10);}
     pending=verifyReviewedApiFeeSourceStage(USER,'ORDER_ENTRY',sourceUrl,ticker,{
      now:clock,sha:()=> 'a'.repeat(40),
      probe:async()=>{const proof=await probeCurrentKalshiFeeApi(fetchPublic,clock,ticker,read,capture);proofs.push({proof,before:JSON.stringify(proof)});return proof;},
     });
     if(queued){const start=performance.now();while(pool.waitingCount===0&&performance.now()-start<2000)await sleep(1);assert.equal(pool.waitingCount,1);await sleep(80);waited=performance.now()-start;holders.pop()!.release();}
     const checked=await pending;assert.equal(checked.ok,false);denial=checked.reason;assert.equal(denial,'standing_fee_lease_unavailable');
     throw annotateFeeFailure(new Error('api_fee_exact_market_source_unavailable'),{phase:'authorization',reason:'api_fee_order_market_mismatch'},checked);
    }finally{for(const h of holders)h.release();if(pending)await pending.catch(()=>{});}
   },
   readBook:async()=>({orderbook_fp:{yes_dollars:[['0.5000','100000']],no_dollars:[['0.5000','100000']]}}),
   readPublic:async()=>{throw Error('unexpected_public_fallback');},configuredStakeCents:500,policyVersion:approved.feePolicyVersion!,sourceUrl,formulaVersion:approved.feeFormulaVersion!,artifactDigest:'d'.repeat(64),policyHash:approved.policyHash!,
  })});
  const intent=await s.executor.prepareEntry(evaluationId);
  const before=(await pool.query('SELECT request,decision FROM v13_production_intent WHERE id=$1',[intent])).rows[0];
  const sourceBefore=(await pool.query('SELECT * FROM forward_test_evaluations WHERE id=$1',[evaluationId])).rows[0];
  dispatching=true;await assert.rejects(s.executor.dispatch(intent),/api_fee_exact_market_source_unavailable/);
  // Calling the same durable intent again must not repeat market/fee work.
  await s.executor.dispatch(intent);assert.equal(finalCalls,1);assert.equal(finalSigned,0);assert.equal(posts.length,0);
  await new Promise<void>(r=>setImmediate(r));
  const terminal=observed.filter(e=>e.stage==='dispatch'&&e.outcome==='proven_not_posted');assert.equal(terminal.length,1);
  const reads=terminal[0].feeAuthorityReads;assert.ok(reads);const review=reads.stages.find((r:any)=>r.operation==='fee_review_query'&&r.purpose==='FINAL_MARKET');
  const renewal=reads.stages.find((r:any)=>r.operation==='fee_standing_renewal_query'&&r.purpose==='FINAL_MARKET');
  for(const row of [review,renewal]){assert.equal(row.attempted,1);assert.equal(row.completed,1);assert.equal(row.poolCheckout.attempted,1);assert.equal(row.poolCheckout.completed,1);assert.equal(row.poolCheckout.rejected,0);}
  assert.equal(review.rejected,0);assert.equal(renewal.rejected,1);if(queued)assert.ok(review.poolCheckout.elapsedMs>=70);
  assert.ok(review.elapsedMs>=review.poolCheckout.elapsedMs-1);assert.equal(reads.stages.find((r:any)=>r.operation==='fee_public_probe').poolCheckout,undefined);
  for(const p of proofs)assert.equal(JSON.stringify(p.proof),p.before,'original fee proof and timestamp unchanged');
  const after=(await pool.query('SELECT state,terminal,reserved_micros,filled_hundredths,request,decision FROM v13_production_intent WHERE id=$1',[intent])).rows[0];
  assert.equal(after.state,'BLOCKED');assert.equal(after.terminal,true);assert.equal(after.reserved_micros,'0');assert.equal(Number(after.filled_hundredths),0);assert.deepEqual(after.request,before.request);assert.deepEqual(after.decision,before.decision);
  assert.deepEqual((await pool.query('SELECT * FROM forward_test_evaluations WHERE id=$1',[evaluationId])).rows[0],sourceBefore);
  const account=(await pool.query('SELECT cash_micros,reserved_micros,kill_switch,execution_enabled FROM v13_production_account WHERE id=$1',[ACCOUNT])).rows[0];assert.equal(account.cash_micros,'60000000000');assert.equal(account.reserved_micros,'0');assert.equal(account.kill_switch,false);assert.equal(account.execution_enabled,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM v13_production_intent WHERE account_id=$1',[ACCOUNT])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM v13_production_observation WHERE account_id=$1 AND kind='PROVEN_NOT_POSTED'",[ACCOUNT])).rows[0].n,1);
  outcomes.push({queued,waited,denial,review,renewal,account,publicReads:calls.length,sourceAgeMs:clock()-originalAt,dispatch:terminal[0].durationMs});
 }
 assert.deepEqual(outcomes[0].account,outcomes[1].account);assert.equal(outcomes[0].publicReads,outcomes[1].publicReads);
 console.log('ACTUAL_EXECUTOR_FINAL_POOL_DENIAL',JSON.stringify(outcomes));
});
