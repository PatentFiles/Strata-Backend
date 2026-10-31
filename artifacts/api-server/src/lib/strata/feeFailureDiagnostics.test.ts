import test from "node:test";
import assert from "node:assert/strict";
import {annotateFeeFailure,getFeeFailureDiagnostics} from "./feeFailureDiagnostics";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";
import {createEntryMetadataSnapshot} from "./entryMetadataSnapshot";
import {beginExecutionStage,type StageTiming} from "../v13-production/stageTiming";
const market="KXBTC15M-26OCT310215-15";
test("actual HTTP rejection retains only safe endpoint/status/reason through errors and logs",async()=>{
 const fetchImpl=(async()=>new Response("SECRET",{status:429,headers:{"retry-after":"60","content-type":"application/json"}})) as typeof fetch;
 const observation=await probeCurrentKalshiFeeApi(fetchImpl,Date.now,market);
 assert.equal(observation.ok,false);
 const d=getFeeFailureDiagnostics(observation)!;
 assert.deepEqual(d,{version:1,phase:"provider_transport",reason:"provider_http_rejected",endpoint:"market_detail",httpStatus:429});
 const error=annotateFeeFailure(Error("api_fee_exact_market_source_unavailable"),{phase:"authorization",reason:"api_fee_order_market_mismatch"},observation);
 const events:StageTiming[]=[];
 beginExecutionStage(e=>{events.push(e);},"fee_verification",{accountId:"a",mode:"LIVE"})("rejected",{error});
 await Promise.resolve();assert.equal(events[0]!.feeFailure,d);assert.ok(Object.isFrozen(d));
 assert.ok(!JSON.stringify(events).includes("SECRET"));
});
test("snapshot body/HTTP errors and local cooldown preserve real versus absent HTTP status",async()=>{
 const fetchImpl=(async()=>new Response("{}",{status:403,headers:{"content-type":"application/json"}})) as typeof fetch;
 let error:unknown;try{await createEntryMetadataSnapshot(market,fetchImpl).read('/markets/'+market);}catch(e){error=e;}
 assert.equal(getFeeFailureDiagnostics(error)?.httpStatus,403);
 assert.equal(getFeeFailureDiagnostics(error)?.endpoint,"market_detail");
 const limited=(async()=>new Response("{}",{status:429,headers:{"retry-after":"60","content-type":"application/json"}})) as typeof fetch;
 for(let i=0;i<2;i++){
  try{await createEntryMetadataSnapshot(market,limited).read('/markets/'+market);}catch(e){error=e;}
  assert.equal(getFeeFailureDiagnostics(error)?.httpStatus,i===0?429:null);
  assert.equal(getFeeFailureDiagnostics(error)?.reason,i===0?"provider_http_rejected":"provider_cooldown");
 }
});
test("arbitrary fields/raw strings and observer failures cannot alter decisions or escape whitelist",async()=>{
 const original={ok:false};const result=annotateFeeFailure(original,{phase:"SECRET",reason:"Bearer SECRET",path:"https://SECRET",httpStatus:NaN});
 assert.equal(result,original);assert.equal(JSON.stringify(result),'{"ok":false}');
 assert.deepEqual(getFeeFailureDiagnostics(result),{version:1,phase:"unknown",reason:"fee_failure_unclassified",endpoint:null,httpStatus:null});
 assert.equal(getFeeFailureDiagnostics({feeFailure:{reason:"SECRET"}}),undefined);
 assert.equal(getFeeFailureDiagnostics({...result}),undefined);
 const error=annotateFeeFailure(Error("rejected"),{phase:"database",reason:"standing_fee_lease_unavailable"});
 beginExecutionStage(()=>{throw Error("observer");},"fee_verification",{accountId:"a",mode:"LIVE"})("rejected",{error});
 beginExecutionStage(()=>Promise.reject(Error("observer")),"fee_verification",{accountId:"a",mode:"LIVE"})("rejected",{error});
 await Promise.resolve();await Promise.resolve();
});

test("invalid direct metadata body size cancels unread body and reports only safe observed status",async()=>{
 let cancelled=false;
 const fetchImpl=(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),
  {headers:{"content-type":"application/json","content-length":"256001"}})) as typeof fetch;
 const result=await probeCurrentKalshiFeeApi(fetchImpl,Date.now,market);
 assert.equal(result.ok,false);assert.equal(cancelled,true);
 assert.equal(getFeeFailureDiagnostics(result)?.httpStatus,200);
 assert.equal(getFeeFailureDiagnostics(result)?.reason,"provider_response_invalid");
});
