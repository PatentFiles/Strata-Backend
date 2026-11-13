import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {createProtectiveReleaseRouter} from './protectiveReleaseRouter';
test('retired independent issuance endpoints return410 after authentication and never expose an approval option',async()=>{
 const app=express();app.use(express.json());app.use(createProtectiveReleaseRouter((req,res,next)=>{
  if(req.headers.authorization!=='test-owner')return void res.status(401).json({reason:'unauthorized'});
  res.locals.strata={subject:'11111111-1111-4111-8111-111111111111',role:'ADMIN'};next();
 }));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try{const address=server.address();assert.ok(address&&typeof address!=='string');
  for(const path of ['/review','/standing-review','/authorize']){
   const unauth=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:'POST'});assert.equal(unauth.status,401);
   const r=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:'POST',headers:{authorization:'test-owner','content-type':'application/json'},body:'{}'});
   assert.equal(r.status,410);assert.deepEqual(await r.json(),{ok:false,reason:'independent_review_enrollment_retired_use_owner_self',ordersSubmitted:false});
  }
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
