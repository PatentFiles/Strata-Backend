import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {createUserExecutionRouter} from './userExecutionRouter';
test('durable routes authenticate before feature/body handling, never trust supplied actor',async()=>{
 const app=express();app.use(express.json());app.use(createUserExecutionRouter((req,res,next)=>{
 if(req.headers.authorization!=='synthetic-mfa-owner')return void res.status(401).json({reason:'unauthorized'});
 res.locals.strata={subject:'11111111-1111-4111-8111-111111111111',role:'USER'};next();},{} as never));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const previous=process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;delete process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;
 try{const a=server.address();assert.ok(a&&typeof a!=='string');
 for(const [method,path] of [['GET','status'],['GET','migration-preview'],['GET','outcome'],['GET','migration-outcome'],['POST','migrate'],['POST','consent'],['POST','revoke'],['POST','cancel-pending'],['GET','reauthorization-preview'],['GET','reauthorization-outcome'],['POST','reauthorize'],['POST','reauthorization-cancel']]){
 const url: string=`http://127.0.0.1:${a.port}/fees/durable/${path}`;assert.equal((await fetch(url,{method})).status,401,path);
 const response=await fetch(url,{method,headers:{authorization:'synthetic-mfa-owner','content-type':'application/json'},...(method==='POST'?{body:'{"ownerId":"forged"}'}:{})});
 assert.equal(response.headers.get('cache-control'),'private, no-store');const result=await response.json() as Record<string,unknown>;
 if(path==='cancel-pending'||path==='reauthorization-cancel'){assert.equal(response.status,409,path);assert.equal(result.outcome,'UNKNOWN',path);}
 else if(method==='POST'||path==='status'||path==='migration-preview'||path==='reauthorization-preview'){assert.equal(response.status,409,path);assert.equal(result.ok,false,path);}else assert.equal(result.outcome,'UNKNOWN',path);
 assert.notEqual(result.tradingAuthorized,true,path);}
 }finally{if(previous===undefined)delete process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;else process.env.STRATA_DURABLE_OWNER_FEE_ENABLED=previous;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
