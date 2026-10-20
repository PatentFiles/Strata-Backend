import assert from "node:assert/strict";
import test from "node:test";
import {ownedPositionHistoryQuery} from "./personalExchangeRead";

test("position evidence includes settled and unsettled traded-zero inventory on exact shard/account",()=>{
 const query=ownedPositionHistoryQuery();
 const params=new URLSearchParams(query);
 assert.equal(params.get("limit"),"200");
 assert.equal(params.get("subaccount"),"1");
 assert.equal(params.get("exchange_index"),"2");
 assert.equal(params.get("settlement_status"),"all");
 assert.equal(params.get("count_filter"),"position,total_traded");
 assert.equal(params.has("cursor"),false);
});
test("position history follows opaque cursor without touching account or filter fields",()=>{
 const cursor="event:2/zero?subaccount=0&exchange_index=0";
 const params=new URLSearchParams(ownedPositionHistoryQuery(cursor));
 assert.equal(params.get("cursor"),cursor);
 assert.deepEqual(params.getAll("subaccount"),["1"]);
 assert.deepEqual(params.getAll("exchange_index"),["2"]);
 assert.equal(params.get("count_filter"),"position,total_traded");
});
