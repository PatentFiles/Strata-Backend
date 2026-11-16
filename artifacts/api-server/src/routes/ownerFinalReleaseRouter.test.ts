import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {createStrataAccess,verifySupabaseAccessToken} from '../lib/strata/supabaseAuth';
import {createProtectiveReleaseRouter} from './protectiveReleaseRouter';

test('owner final routes enforce real signed AAL2 middleware before any DB action',async()=>{
 const pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);
 const keys=createLocalJWKSet({keys:[{...jwk,alg:'RS256',use:'sig'}]}),supabaseUrl='https://synthetic.supabase.co';
 const access=createStrataAccess({verifyToken:value=>verifySupabaseAccessToken(value,{supabaseUrl,keys}),roleOf:async()=> 'STANDARD'});
 const app=express();app.use(express.json());app.use('/release',createProtectiveReleaseRouter(access.requireUser));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 const token=async(aal:string)=>new SignJWT({aal,role:'authenticated'}).setProtectedHeader({alg:'RS256'}).setSubject('11111111-1111-4111-8111-111111111111').setIssuer(supabaseUrl+'/auth/v1').setAudience('authenticated').setIssuedAt().setExpirationTime('2m').sign(pair.privateKey);
 try{
  for(const path of ['/owner-final-authorize','/owner-final-outcome']){
   for(const bearer of [undefined,'invalid',await token('aal1')]){
    const response=await fetch(base+'/release'+path,{method:path.endsWith('authorize')?'POST':'GET',headers:bearer?{Authorization:'Bearer '+bearer}:{}});
    assert.equal(response.status,401);
   }
  }
  // Real AAL2 reaches strict body validation, not a privileged bypass or DB.
  const allowed=await fetch(base+'/release/owner-final-authorize',{method:'POST',headers:{Authorization:'Bearer '+await token('aal2'),'Content-Type':'application/json'},body:'{}'});
  assert.equal(allowed.status,409);assert.match(allowed.headers.get('cache-control')??'',/no-store/);
  const scope={expectedSha:'a'.repeat(40),accountId:'synthetic-account',policyHash:'b'.repeat(64),qualificationId:'33333333-3333-4333-8333-333333333333',reviewId:'44444444-4444-4444-8444-444444444444'};
  const proof=await fetch(base+'/release/owner-final-authorize',{method:'POST',headers:{Authorization:'Bearer '+await token('aal2'),'Content-Type':'application/json'},body:JSON.stringify({...scope,confirmation:'I_AUTHORIZE_MY_ACCOUNT_FINAL_RELEASE_AFTER_SIGNED_QUALIFICATION_V1'})});
  const proofBody=await proof.json() as Record<string,unknown>;
  assert.equal(proof.status,409);assert.equal(proofBody.outcome,'PROVEN_NOT_COMMITTED');assert.deepEqual(proofBody.requestScope,scope);
  const outcome=await fetch(base+'/release/owner-final-outcome',{headers:{Authorization:'Bearer '+await token('aal2')}});
  assert.equal(outcome.status,200);assert.deepEqual(await outcome.json(),{outcome:'UNKNOWN'});
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
