import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {KalshiApiError} from "../kalshiAccountClient";
import {readOwnedKalshiFeeds,personalAccountSnapshot,emptySnapshot,type OwnedKalshiRead} from "./personalExchangeRead";
import {reconciledFlatEntryEvidence} from "./reconciledFlatEntryEvidence";
import {createProductionPersonalSession} from "./personalExecutionSupervisor";
import {dedicatedSignerFingerprint} from "./commissioning";

const NOW=1793828749033;
const ID={subaccount:1 as const,exchangeIndex:2 as const,keyFingerprint:"fixture-only"};
const CREDS={keyId:"fixture-only",privateKey:"fixture-only"};
const PATHS=["/trade-api/v2/portfolio/balance","/trade-api/v2/portfolio/orders",
 "/trade-api/v2/historical/orders","/trade-api/v2/portfolio/fills","/trade-api/v2/historical/fills",
 "/trade-api/v2/portfolio/positions","/trade-api/v2/portfolio/settlements"];
function good(path:string):Record<string,unknown>{
 if(path===PATHS[0])return {subaccount:1,exchange_index:2,balance_dollars:"25.0000"};
 return {[path===PATHS[5]?"market_positions":path.split("/").at(-1)!]:[]};
}
const failure={ok:false,reason:"personal_exchange_history_unreconciled"};
const feed=():OwnedKalshiRead=>({ok:true,historicalCoverageComplete:true,observedAtMs:NOW,
 cashMicros:"25000000",orders:[],fills:[],positions:[],settlements:[]});

for(let group=1;group<PATHS.length;group++)test(`malformed cursors in signed group ${group} fail before another GET`,async()=>{
 for(const cursor of [123,false,true,{},[],["next"]]){
  const calls:string[]=[];
  const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path)=>{
   calls.push(path);return path===PATHS[group]?{...good(path),cursor}:good(path);
  });
  assert.deepEqual(result,failure);assert.deepEqual(calls,PATHS.slice(0,group+1));
 }
});

test("malformed cursor on a later empty page cannot hide unvisited history",async()=>{
 const calls:string[]=[];let page=0;
 const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path)=>{
  calls.push(path);return path===PATHS[1]?{orders:[],cursor:++page===1?"next":42}:good(path);
 });
 assert.deepEqual(result,failure);assert.deepEqual(calls,[PATHS[0],PATHS[1],PATHS[1]]);
});

test("valid terminal cursor forms preserve the complete seven-feed result",async()=>{
 for(const cursor of [undefined,null,""]){
  const calls:string[]=[];
  const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path)=>{
   calls.push(path);return {...good(path),...(cursor===undefined?{}:{cursor})};
  });
  assert.deepEqual(result,feed());assert.deepEqual(calls,PATHS);
 }
});

test("opaque cursor is forwarded unchanged and all pages are included",async()=>{
 const cursor="token with spaces&+=/?";const calls:{path:string;query:string}[]=[];
 let page=0;
 const row={order_id:"historical-fixture",subaccount:1,exchange_index:2};
 const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path,query)=>{
  calls.push({path,query:query??""});
  if(path===PATHS[1])return ++page===1?{orders:[],cursor}:{orders:[row],cursor:""};
  return good(path);
 });
 assert.equal(result.ok,true);if(!result.ok)return;
 assert.equal(result.historicalCoverageComplete,true);assert.deepEqual(result.orders,[row]);
 assert.equal(result.observedAtMs,NOW);assert.equal(calls.length,8);
 assert.equal(calls[2].query,`?limit=200&subaccount=1&exchange_index=2&cursor=${encodeURIComponent(cursor)}`);
 assert.deepEqual(calls.map(c=>c.path),[PATHS[0],PATHS[1],...PATHS.slice(1)]);
});

test("only first-page archival 404 remains an explicitly incomplete diagnostic read",async()=>{
 for(const missing of [[PATHS[2]],[PATHS[4]],[PATHS[2],PATHS[4]]]){
  const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path)=>{
   if(missing.includes(path))throw new KalshiApiError("HTTP_ERROR",404);return good(path);
  });
  assert.equal(result.ok,true);if(!result.ok)continue;
  assert.equal(result.historicalCoverageComplete,false);
  assert.deepEqual(personalAccountSnapshot(ID,result,[]),failure);
  assert.deepEqual(emptySnapshot(ID,result),failure);
 }
});

test("archival 404 after an empty page with a cursor is truncation, not endpoint unavailability",async()=>{
 for(const target of [PATHS[2],PATHS[4]]){
  let page=0;const calls:string[]=[];
  const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path)=>{
   calls.push(path);if(path===target){if(++page===1)return {...good(path),cursor:"next"};throw new KalshiApiError("HTTP_ERROR",404);}
   return good(path);
  });
  assert.equal(result.ok,false);assert.equal("reason" in result&&result.reason,"kalshi_read_failed");
  assert.equal(calls.at(-1),target);assert.equal(calls.length,PATHS.indexOf(target)+2);
 }
});

test("false, absent, and malformed archival coverage cannot become complete snapshots",()=>{
 for(const coverage of [false,undefined,null,1,"true"]){
  const read={...feed(),historicalCoverageComplete:coverage} as OwnedKalshiRead;
  if(coverage===undefined)delete read.historicalCoverageComplete;
  assert.deepEqual(personalAccountSnapshot(ID,read,[]),failure);
  assert.deepEqual(emptySnapshot(ID,read),failure);
 }
});

test("explicit complete empty history still supplies flat evidence without changing proof bytes",async()=>{
 const snapshot=personalAccountSnapshot(ID,feed(),[]);assert.ok("identity" in snapshot);
 if(!("identity" in snapshot))return;
 assert.deepEqual(snapshot,{identity:ID,observedAtMs:NOW,complete:true,authenticated:true,historyFromMs:0,
  cashMicros:"25000000",cashExact:true,orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false});
 let queries=0;
 const eligible=await reconciledFlatEntryEvidence({query:async()=>{queries++;return {rows:[{
  reserved_micros:"0",cash_micros:"25000000",blocked_reason:null,kill_switch:false,execution_enabled:true,
  unresolved:"0",exits:"0",positions:"0",
 }]};}},{accountId:"fixture",ownerId:"fixture",snapshot,nowMs:NOW});
 assert.equal(eligible,true);assert.equal(queries,1);
});

test("unavailable archive plus current nonzero inventory still fails",async()=>{
 const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path)=>{
  if(path===PATHS[2])throw new KalshiApiError("HTTP_ERROR",404);
  if(path===PATHS[5])return {market_positions:[{ticker:"fixture",position_fp:"1.00"}]};
  return good(path);
 });assert.deepEqual(result,failure);
});

test("repeated cursors and the twenty-page cap still fail without further groups",async()=>{
 for(const repeated of [true,false]){
  let page=0;const calls:string[]=[];
  const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path)=>{
   calls.push(path);return path===PATHS[1]?{orders:[],cursor:repeated?"same":`next-${++page}`}:good(path);
  });
  assert.deepEqual(result,failure);assert.equal(calls.length,repeated?3:21);
  assert.equal(calls.includes(PATHS[2]),false);
 }
});

test("429 in every group still stops the signed scan with no retry or fanout",async()=>{
 for(let group=0;group<PATHS.length;group++){
  const calls:string[]=[];const result=await readOwnedKalshiFeeds(CREDS,NOW,async(_c,path)=>{
   calls.push(path);if(path===PATHS[group])throw new KalshiApiError("HTTP_ERROR",429);return good(path);
  });
  assert.deepEqual(result,{ok:false,reason:"kalshi_read_rate_limited"});assert.deepEqual(calls,PATHS.slice(0,group+1));
 }
});

test("actual supervisor cannot START from incomplete archive or invalid cursor evidence",async()=>{
 const key=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
 const material={keyId:"offline-fixture",privateKey:key};
 const fingerprint=dedicatedSignerFingerprint(material.keyId,material.privateKey);
 for(const invalid of ["archive404","numericCursor"]){
  let feeChecks=0;const reads:string[]=[],queries:string[]=[];
  const session=createProductionPersonalSession({async query(sql:string){
   queries.push(sql);
   if(sql.includes("personal-session:signer"))return {rows:[{
    key_fingerprint:fingerprint,credential_fingerprint:fingerprint,
    decrypted_secret:JSON.stringify({api_key_id:material.keyId,private_key:material.privateKey}),
    commissioned:true,execution_enabled:true,kill_switch:false,cash_precision_verified:true,
    cash_micros:"25000000",reserved_micros:"0",reconciled_at:new Date(NOW).toISOString(),
    fee_artifact_digest:"ab".repeat(32),policy_hash:"cd".repeat(32),fee_policy_version:"standing",
    fee_source_url:"https://kalshi.com/fees",fee_formula_version:"quadratic",policy_state:"APPROVED",
    configured_stake_cents:"100",subaccount:1,exchange_index:2,
   }]};
   if(sql.includes("live_execution_config"))return {rows:[{live_execution_enabled:true,manual_kill_switch:false}]};
   return {rows:[]};
  }},{now:()=>NOW,verifyFee:async()=>{feeChecks++;throw Error("fee_should_not_be_reached");},
   kalshiGet:async(_c,path)=>{reads.push(path);
    if(invalid==="archive404"&&path.includes("/historical/"))throw new KalshiApiError("HTTP_ERROR",404);
    if(invalid==="numericCursor"&&path===PATHS[1])return {...good(path),cursor:42};
    return good(path);
   },
  });
  const owner="11111111-1111-4111-8111-111111111111";
  const result=await session.start({userId:owner,accountId:"acct-coverage",action:"START"});
  assert.equal(result.ok,false);assert.equal(result.reason,"personal_exchange_history_unreconciled");
  assert.equal(feeChecks,0);assert.equal(session.isScheduled(owner,"acct-coverage"),false);
  assert.deepEqual(reads,invalid==="archive404"?PATHS:PATHS.slice(0,2));
  assert.ok(queries.every(sql=>!/^\s*(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT)\b/i.test(sql)),"no state mutation before refusal");
 }
});
