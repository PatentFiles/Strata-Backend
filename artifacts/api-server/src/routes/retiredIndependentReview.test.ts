import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createProtectiveReleaseRouter} from './protectiveReleaseRouter';

// Coexistence is deliberate: older independently signed monetary/execution
// records remain readable and their genuine reviewer workflow remains
// operational until account-by-account owner opt-in is independently qualified.
// A malformed request grants nothing on either path.
test('owner and historical review routes authenticate and reject unsupported issue requests',async()=>{
 const app=express();app.use(express.json());
 app.use(createProtectiveReleaseRouter((req,res,next)=>{
  if(req.headers.authorization!=='test-owner')return void res.status(401).json({reason:'unauthorized'});
  res.locals.strata={subject:'11111111-1111-4111-8111-111111111111',role:'ADMIN'};
  next();
 }));
 const server=app.listen(0,'127.0.0.1');
 await new Promise<void>(r=>server.once('listening',r));
 try{
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  for(const path of ['/review','/standing-review','/authorize','/owner-standing-review','/owner-standing-review-revoke']){
   const unauth=await fetch(`http://127.0.0.1:${addr.port}${path}`,{method:'POST'});
   assert.equal(unauth.status,401,path);
   const denied=await fetch(`http://127.0.0.1:${addr.port}${path}`,{
    method:'POST',headers:{authorization:'test-owner','content-type':'application/json'},
    body:'{}',
   });
   assert.ok(denied.status===400||denied.status===403||denied.status===409||denied.status===410,
    `${path}: ${denied.status}`);
   const body=await denied.json() as Record<string,unknown>;
   assert.notEqual(body.ok,true,path);
   assert.notEqual(body.tradingAuthorized,true,path);
  }
 }finally{
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 }
});