import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyV3InitialSharedCapture} from './v3SharedCapturePrototype';
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

const owner='11111111-1111-4111-8111-111111111111',account='strata-account-aaaaaaaaaaaaaaaaaaaaaaaa';
const bytes=readFileSync('../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf');
const row=()=>({effective_date:'2026-07-07',original_bytes:bytes,content_sha256:createHash('sha256').update(bytes).digest('hex'),byte_length:bytes.length,
 captured_at:new Date(fixtureClock-1000).toISOString(),expires_at:new Date(fixtureClock-1000+55*60000).toISOString(),
 canonical_url:'https://kalshi.com/docs/kalshi-fee-schedule.pdf',source_kind:'railway_canonical_https_direct',policy_version:'issuer_pdf_55m_signed_api_recheck_v2'});
function deps(r:Record<string,unknown>=row(),pages=feeApiPages()) {return {enabled:true,target:account,clock:()=>fixtureClock,fetcher:kalshiFeed(pages),db:{query:async(sql:string,args?:unknown[])=>{assert.match(sql,/^SELECT/);assert.doesNotMatch(sql,/strata_claim|strata_record|UPDATE|INSERT|DELETE/);assert.deepEqual(args,[owner,account]);return {rows:[r]};}}};}
test('historical PDF fixture verifies source plus real market verifier; original capture time retained, no trading authority',async()=>{const r=await verifyV3InitialSharedCapture(owner,account,deps());assert.equal(r.ok,true,JSON.stringify(r));if(r.ok){assert.equal(r.tradingAuthorized,false);assert.equal(r.publicationFetchedNow,false);assert.equal(r.originalCapturedAt,row().captured_at);}});
for(const [label,patch] of Object.entries({digest:{content_sha256:'0'.repeat(64)},origin:{canonical_url:'https://other.invalid/a.pdf'},kind:{source_kind:'uploaded'},policy:{policy_version:'wrong'},future:{captured_at:new Date(fixtureClock+1).toISOString()},expired:{captured_at:new Date(fixtureClock-55*60000).toISOString(),expires_at:new Date(fixtureClock).toISOString()},extended:{expires_at:new Date(fixtureClock+56*60000).toISOString()},bytes:{original_bytes:Buffer.alloc(bytes.length)},length:{byte_length:0}}))test('reject '+label,async()=>{assert.equal((await verifyV3InitialSharedCapture(owner,account,deps({...row(),...patch}))).ok,false)});
test('missing capture refuses without provider PDF fallback',async()=>{const d=deps();d.db.query=async()=>({rows:[]});assert.equal((await verifyV3InitialSharedCapture(owner,account,d)).ok,false)});
test('feature off and foreign account refuse',async()=>{assert.equal((await verifyV3InitialSharedCapture(owner,account,{...deps(),enabled:false})).ok,false);assert.equal((await verifyV3InitialSharedCapture(owner,account,{...deps(),target:'other'})).ok,false)});
test('fresh API multiplier mismatch refuses',async()=>{const p=feeApiPages();(p['/series/KXBTC15M'].series as Record<string,unknown>).fee_multiplier=2;assert.equal((await verifyV3InitialSharedCapture(owner,account,deps(row(),p))).ok,false)});
test('capture expiring during market verification refuses',async()=>{const d=deps();let n=0;d.clock=()=>++n>1?fixtureClock+55*60000:fixtureClock;assert.equal((await verifyV3InitialSharedCapture(owner,account,d)).ok,false)});
test('production dependency injection refuses',async()=>{const old=process.env.NODE_ENV;process.env.NODE_ENV='production';try{assert.equal((await verifyV3InitialSharedCapture(owner,account,deps())).reason,'production_override_forbidden')}finally{process.env.NODE_ENV=old}});
test('hash-consistent but unreviewed PDF bytes still fail strict parser',async()=>{const b=Buffer.from('%PDF-1.7\n'+'not an official schedule '.repeat(20)+'\n%%EOF');const r={...row(),original_bytes:b,byte_length:b.length,content_sha256:createHash('sha256').update(b).digest('hex')};assert.equal((await verifyV3InitialSharedCapture(owner,account,deps(r))).ok,false)});
