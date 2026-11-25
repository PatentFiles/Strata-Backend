import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {pinOwnerProtectiveHistory} from "./ownerProtectiveHistoryPreviewPin";
const owner="11111111-1111-4111-8111-111111111111", other="22222222-2222-4222-8222-222222222222",release="a".repeat(40);
const order={client_order_id:"opaque",ticker:"fixture",side:"ask",reduce_only:true,post_only:false,time_in_force:"immediate_or_cancel",subaccount:1,exchange_index:2};
const raw=JSON.stringify(order);
const row={account_id:"fixture",owner_id:owner,reservation_id:other,key_fingerprint:"e".repeat(64),order_request_json:raw,order_digest:createHash("sha256").update(raw).digest("hex"),client_order_id:"opaque",market_ticker:"fixture",revision:["1","2"]};
const db=(rows:Record<string,unknown>[])=>({query:async(sql:string,params:unknown[])=>{
 assert.match(sql,/^\s*SELECT/); assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE)\b/i); assert.deepEqual(params,[owner]); return {rows};
}});
test("owned stopped candidate only; other owner and absence refuse",async()=>{
 assert.ok(await pinOwnerProtectiveHistory(db([row]),owner,release));
 assert.equal(await pinOwnerProtectiveHistory(db([{...row,owner_id:other}]),owner,release),null);
 assert.equal(await pinOwnerProtectiveHistory(db([]),owner,release),null);
 assert.equal(await pinOwnerProtectiveHistory(db([row,row]),owner,release),null);
});
test("digest binds revision and build; changed request and unverifiable build refuse",async()=>{
 const a=await pinOwnerProtectiveHistory(db([row]),owner,release);
 for(const b of [await pinOwnerProtectiveHistory(db([{...row,revision:["1","3"]}]),owner,release),await pinOwnerProtectiveHistory(db([row]),owner,"b".repeat(40))])assert.notEqual(a?.digest,b?.digest);
 assert.equal(await pinOwnerProtectiveHistory(db([{...row,order_request_json:raw.replace("ask","bid")}]),owner,release),null);
 assert.equal(await pinOwnerProtectiveHistory(db([row]),owner,"main"),null);
});
