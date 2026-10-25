import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {captureIndependentOfficialFeeV5,readIndependentOfficialFeeV5,V5_URL,V5_VERSION} from "./independentOfficialFeeV5";
const owner="d06bc1ce-718b-42d1-8e3d-2779249661f2";
const account="strata-account-2e3180472d83df50f13ce7f9";
const t=Date.parse("2026-10-25T15:10:00Z");
test("V5 alternate egress is disabled by default, never accepts arbitrary accounts",async()=>{
 const disabled=await captureIndependentOfficialFeeV5(owner,{enabled:()=>false,target:()=>account});
 assert.equal(disabled.ok,false);
 assert.equal(disabled.ordersSubmitted,false);
 assert.equal((await readIndependentOfficialFeeV5({enabled:()=>true,target:()=>"attacker"})).ok,false);
});
test("shared issuer cooldown forbids any provider request",async()=>{
 const calls:string[]=[];
 const db={query:async(sql:string)=>{
   calls.push(sql.trim().slice(0,32));
   if(sql.includes("SELECT id FROM public.v13_production_account"))return {rows:[{id:account}]};
   if(sql.includes("FROM private.strata_railway_official_fee_capture_v5"))return {rows:[]};
   if(sql.includes("SELECT next_attempt_at FROM private.strata_railway_fee_retry_v5"))return {rows:[]};
   if(sql.includes("SET next_allowed_at=clock_timestamp()"))return {rows:[]};
   if(sql.includes("SELECT next_allowed_at"))return {rows:[{next_allowed_at:new Date(t+1800_000)}]};
   throw Error("unexpected SQL");
 }};
 let requests=0;
 const proof=await captureIndependentOfficialFeeV5(owner,{
   db,clock:()=>t,enabled:()=>true,target:()=>account,
   fetcher:(async()=>{requests++;throw Error("must not fetch");}) as typeof fetch,
 });
 assert.equal(proof.ok,false);
 assert.equal(proof.reason,"v5_issuer_shared_cooldown");
 assert.equal(requests,0);
 assert.ok(calls.length>=4);
});
test("a genuine provider 429 only persists issuer provenance and deadline, no capture/grant",async()=>{
 const calls:string[]=[];
 const db={query:async(sql:string)=>{
   calls.push(sql);
   if(sql.includes("SELECT id FROM public.v13_production_account"))return {rows:[{id:account}]};
   if(sql.includes("FROM private.strata_railway_official_fee_capture_v5"))return {rows:[]};
   if(sql.includes("SELECT next_attempt_at FROM private.strata_railway_fee_retry_v5"))return {rows:[]};
   if(sql.includes("SET next_allowed_at=clock_timestamp()"))return {rows:[{next_allowed_at:new Date(t+1800_000)}]};
   if(sql.includes("last_provider_http_status=$1"))return {rows:[{next_allowed_at:new Date(t+1800_000)}]};
   if(sql.includes("INSERT INTO private.strata_railway_fee_retry_v5"))return {rows:[]};
   throw Error("unexpected SQL");
 }};
 const outcome=await captureIndependentOfficialFeeV5(owner,{
   db,clock:()=>t,enabled:()=>true,target:()=>account,
   fetcher:(async(url)=>{assert.equal(url,V5_URL);
      return new Response(null,{status:429,headers:{"retry-after":"1800"}});}) as typeof fetch,
 });
 assert.equal(outcome.ok,false);
 assert.equal(outcome.reason,"v5_issuer_http_429");
 assert.equal(outcome.tradingAuthorized,false);
 assert.equal(outcome.ordersSubmitted,false);
 assert.ok(calls.some(q=>q.includes("last_provider_http_status=$1")));
 assert.ok(!calls.some(q=>q.includes("INSERT INTO private.strata_railway_official_fee_capture_v5")));
});
test("a real HTTP 200 with redirected source cannot be represented as issuer bytes",async()=>{
 const db={query:async(sql:string)=>{
   if(sql.includes("SELECT id FROM public.v13_production_account"))return {rows:[{id:account}]};
   if(sql.includes("FROM private.strata_railway_official_fee_capture_v5"))return {rows:[]};
   if(sql.includes("SELECT next_attempt_at FROM private.strata_railway_fee_retry_v5"))return {rows:[]};
   if(sql.includes("SET next_allowed_at=clock_timestamp()"))return {rows:[{next_allowed_at:new Date(t+1800_000)}]};
   if(sql.includes("last_provider_http_status=$1"))return {rows:[{next_allowed_at:new Date(t+1800_000)}]};
   if(sql.includes("INSERT INTO private.strata_railway_fee_retry_v5"))return {rows:[]};
   throw Error("must never insert a forged or redirected PDF");
 }};
 const response=new Response("%PDF- fake",{status:200,headers:{"content-type":"application/pdf"}});
 Object.defineProperty(response,"url",{value:"https://untrusted.example/pdf"});
 const out=await captureIndependentOfficialFeeV5(owner,{
  db,clock:()=>t,enabled:()=>true,target:()=>account,fetcher:(async()=>response) as typeof fetch});
 assert.equal(out.ok,false);
 assert.equal(out.reason,"v5_issuer_identity_or_type_invalid");
});
test("stored bytes must have original timestamp, expiry, exact digest and source kind",async()=>{
 const bogus=Buffer.alloc(128,65);
 const record={content_sha256:"a".repeat(64),original_bytes:bogus,byte_length:bogus.length,
   effective_date:"2026-07-07",captured_at:new Date(t-5000),expires_at:new Date(t+55*60_000-5000),
   canonical_url:V5_URL,source_kind:"railway_canonical_https_direct",policy_version:V5_VERSION};
 const db={query:async()=>({rows:[record]})};
 const out=await readIndependentOfficialFeeV5({db,clock:()=>t,enabled:()=>true,target:()=>account});
 assert.equal(out.ok,false);
 assert.equal(out.reason,"v5_issuer_capture_corrupted_or_expired");
});

test("real unchanged PDF fixture is parsed and recorded only with authenticated fixed-source HTTP 200",async()=>{
 const bytes=readFileSync("attached_assets/0_kalshi-fee-schedule_1790474920034.pdf");
 let persisted=false;
 const db={query:async(sql:string,args?:unknown[])=>{
   if(sql.includes("SELECT id FROM public.v13_production_account"))return {rows:[{id:account}]};
   if(sql.includes("FROM private.strata_railway_official_fee_capture_v5"))return {rows:[]};
   if(sql.includes("SELECT next_attempt_at FROM private.strata_railway_fee_retry_v5"))return {rows:[]};
   if(sql.includes("SET next_allowed_at=clock_timestamp()"))return {rows:[{next_allowed_at:new Date(t+1800_000)}]};
   if(sql.includes("last_provider_http_status=$1"))return {rows:[{next_allowed_at:new Date(t+1800_000)}]};
   if(sql.includes("INSERT INTO private.strata_railway_official_fee_capture_v5")){
     assert.equal(args?.[0],account);
     assert.equal(args?.[2],V5_URL);
     assert.equal(Buffer.isBuffer(args?.[4]),true);
     assert.equal((args?.[4] as Buffer).equals(bytes),true);
     assert.equal(args?.[6],"2026-07-07");
     persisted=true;
     return {rows:[{capture_id:1}]};
   }
   if(sql.includes("INSERT INTO private.strata_railway_fee_retry_v5"))return {rows:[]};
   throw Error("unexpected SQL");
 }};
 const resp=new Response(new Uint8Array(bytes),{status:200,headers:{
  "content-type":"application/pdf","content-length":String(bytes.length)}});
 Object.defineProperty(resp,"url",{value:V5_URL});
 const out=await captureIndependentOfficialFeeV5(owner,{
  db,clock:()=>t,enabled:()=>true,target:()=>account,
  fetcher:(async()=>resp) as typeof fetch});
 assert.equal(out.ok,true,JSON.stringify(out));
 assert.equal(persisted,true);
 if(out.ok){
   assert.equal(out.reason,"v5_genuine_railway_issuer_capture_recorded");
   assert.equal(out.tradingAuthorized,false);
   assert.equal(out.ordersSubmitted,false);
 }
});
