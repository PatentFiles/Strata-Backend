import test from 'node:test';import assert from 'node:assert/strict';
import {assessDurableFee,publicationTransition,verifyDurableOwnerFee,DURABLE_FEE_VERSION,type DurableModel} from './durableOwnerFeePolicy';
const fixtureClock=Date.parse("2026-10-15T22:00:00Z");
const marketTicker="KXBTC15M-26OCT15T2200";
function feeApiPages(){
 const close="2026-10-15T22:12:00Z", expiration="2026-10-15T22:13:00Z";
 return {
  "/markets?series_ticker=KXBTC15M&status=open&limit=100":{
   markets:[{ticker:marketTicker,event_ticker:marketTicker,close_time:close,status:"open"}],cursor:""},
  ["/markets/"+marketTicker]:{
   market:{ticker:marketTicker,event_ticker:marketTicker,close_time:close,status:"open",exchange_index:2,open_time:"2026-10-15T21:59:00Z",
   expiration_time:expiration,latest_expiration_time:expiration,expected_expiration_time:expiration}},
  ["/events/"+marketTicker]:{event:{event_ticker:marketTicker,series_ticker:"KXBTC15M",
   fee_type_override:null,fee_multiplier_override:null}},
  "/series/KXBTC15M":{series:{ticker:"KXBTC15M",exchange_index:2,
   fee_type:"quadratic",fee_multiplier:1}},
  "/series/fee_changes?series_ticker=KXBTC15M&show_historical=false":{
   series_fee_change_arr:[],cursor:""},
  ["/events/fee_changes?event_ticker="+marketTicker+"&limit=100"]:{
   event_fee_changes:[],cursor:""},
 } as Record<string,Record<string,unknown>>;
}
function kalshiFeed(pages:Record<string,Record<string,unknown>>):typeof fetch{
 return (async(request:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  assert.equal(init?.method,"GET");
  assert.equal(init?.redirect,"error");
  const url=String(request),base="https://external-api.kalshi.com/trade-api/v2";
  assert.ok(url.startsWith(base+"/"));
  return new Response(JSON.stringify(pages[url.slice(base.length)]??{}),{
   status:200,headers:{"content-type":"application/json"}});
 }) as typeof fetch;
}

const scope={owner:'11111111-1111-4111-8111-111111111111',account:'account',sha:'a'.repeat(40),policyHash:'b'.repeat(64)};
const model:DurableModel={...scope,digest:'c'.repeat(64),version:DURABLE_FEE_VERSION,formula:'standard-quadratic-0.07-v1',effectiveDate:'2026-07-07',approved:true,entryRevoked:false,integrityValid:true,knownPublicationChange:false,monitorState:'never_checked'};
const live={ok:true,ticker:marketTicker,verifiedAt:fixtureClock};
test('durable approved evidence has no recurring PDF lease, but does not claim current publication',()=>{const r=assessDurableFee(model,scope,'ENTRY',live,fixtureClock);assert.equal(r.ok,true);if(r.ok){assert.equal(r.publicationKnownCurrent,false);assert.equal(r.tradingAuthorized,false)}});
for(const intent of ['ENTRY','PROTECTIVE_EXIT'] as const){
 test(intent+' publication transport outage alone does not discard approved terms',()=>assert.equal(assessDurableFee({...model,monitorState:'unavailable'},scope,intent,live,fixtureClock).ok,true));
 for(const [key,value] of Object.entries({approved:false,integrityValid:false,knownPublicationChange:true,formula:'changed',digest:'bad',owner:'foreign',sha:'wrong'}))test(intent+' rejects '+key,()=>assert.equal(assessDurableFee({...model,[key]:value},scope,intent,live,fixtureClock).ok,false));
 test(intent+' fresh metadata missing/stale/future refuses without guessed fee bound',()=>{for(const m of [{...live,ok:false},{...live,verifiedAt:fixtureClock-5001},{...live,verifiedAt:fixtureClock+1}])assert.equal(assessDurableFee(model,scope,intent,m,fixtureClock).ok,false)});
}
test('entry revocation does not disable independent reduce-only fee proof',()=>{const revoked={...model,entryRevoked:true};assert.equal(assessDurableFee(revoked,scope,'ENTRY',live,fixtureClock).ok,false);assert.equal(assessDurableFee(revoked,scope,'PROTECTIVE_EXIT',live,fixtureClock).ok,true)});
test('known change latch cannot be cleared by stale matching response or429',()=>{const a=publicationTransition({knownChange:false,monitorState:'never_checked'},{kind:'verified_canonical_digest',digest:'d'.repeat(64)},model.digest);assert.equal(a.knownChange,true);const b=publicationTransition(a,{kind:'transport_unavailable'},model.digest);assert.equal(b.knownChange,true);assert.equal(publicationTransition(b,{kind:'verified_canonical_digest',digest:model.digest},model.digest).knownChange,true)});
test('malformed change evidence rejects',()=>assert.throws(()=>publicationTransition({knownChange:false,monitorState:'never_checked'},{kind:'verified_canonical_digest',digest:'bad'},model.digest)));
const row={owner_user_id:scope.owner,execution_account_id:scope.account,release_commit_sha:scope.sha,approved_policy_hash:scope.policyHash,official_source_digest:model.digest,policy_version:model.version,formula_version:model.formula,effective_date_text:model.effectiveDate,policy_state:'APPROVED',entry_revoked:false,genuine_source_verified:true,known_publication_change:false,monitor_state:'unavailable'};
test('locked durable row plus existing actual market verifier makes ZERO PDF calls',async()=>{process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';let calls=0;const fetcher=kalshiFeed(feeApiPages());const r=await verifyDurableOwnerFee({query:async sql=>{assert.match(sql,/FOR SHARE OF m,s,a,p/);return {rows:[row]}}},scope,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:async(...args)=>{calls++;assert.ok(!String(args[0]).includes('.pdf'));return fetcher(...args)}});assert.equal(r.ok,true,JSON.stringify(r));assert.ok(calls>0)});
test('real market multiplier change is refused without publication polling',async()=>{const pages=feeApiPages();(pages['/series/KXBTC15M'].series as Record<string,unknown>).fee_multiplier=2;const r=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:kalshiFeed(pages)});assert.equal(r.ok,false)});
test('missing/ambiguous durable state refuses',async()=>{for(const rows of [[],[row,row]])assert.equal((await verifyDurableOwnerFee({query:async()=>({rows})},scope,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:kalshiFeed(feeApiPages())})).ok,false)});
