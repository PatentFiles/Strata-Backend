import test from "node:test";
import assert from "node:assert/strict";
import type {Request,Response} from "express";
import {protectiveHistoryPreviewHandler} from "./ownerProtectiveHistoryPreviewRoute";
import {protectiveHistoryPreviewEnabled,unavailableProtectiveHistory} from "../lib/strata/ownerProtectiveHistoryPreview";
const owner="11111111-1111-4111-8111-111111111111";
test("preview is disabled unless exact runtime build matches flag",()=>{
 assert.equal(protectiveHistoryPreviewEnabled({}),false);
 assert.equal(protectiveHistoryPreviewEnabled({RAILWAY_GIT_COMMIT_SHA:"a".repeat(40),STRATA_PROTECTIVE_HISTORY_PREVIEW_SHA:"b".repeat(40)}),false);
 assert.equal(protectiveHistoryPreviewEnabled({RAILWAY_GIT_COMMIT_SHA:"a".repeat(40),STRATA_PROTECTIVE_HISTORY_PREVIEW_SHA:"a".repeat(40)}),true);
});
test("only authenticated, explicit selector-free GET reads; redacts extras",async()=>{
 let calls=0;
 const route=protectiveHistoryPreviewHandler(()=>true,async who=>{
  assert.equal(who,owner);calls++;
  return {...unavailableProtectiveHistory(),order:"NOT_FOUND",secret:"never",orderId:"never"} as const;
 });
 async function run(method:string, subject=owner,query:Record<string,string>={},intent="inspect-protective-history"){
  let code=0,body:unknown;const headers:Record<string,string>={};
  const req={method,query,get:(k:string)=>k==="X-Strata-Read-Intent"?intent:undefined};
  const res={locals:{strata:subject?{subject}:undefined},setHeader:(k:string,v:string)=>{headers[k]=v;},status:(c:number)=>{code=c;return res},end:()=>{},json:(x:unknown)=>{body=x}};
  await route(req as unknown as Request,res as unknown as Response,()=>{throw Error("unexpected next")});
  assert.equal(headers["Cache-Control"],"private, no-store");
  return {code,body};
 }
 assert.equal((await run("GET","")).code,401);
 assert.equal((await run("POST")).code,405);
 assert.equal((await run("GET",owner,{owner:"other"})).code,400);
 assert.equal((await run("GET",owner,{},"")).code,400);
 assert.equal(calls,0);
 const r=await run("GET");assert.equal(calls,1);
 assert.deepEqual(r,{code:200,body:{...unavailableProtectiveHistory(),order:"NOT_FOUND"}});
});
