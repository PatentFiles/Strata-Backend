import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {getScopedKalshiJson} from '../kalshiAccountClient';
const path='/trade-api/v2/portfolio/orders',host='https://external-api.kalshi.com';
test('already aborted recovery cannot sign or transmit',async()=>{
 let calls=0;const c=new AbortController();c.abort();
 await assert.rejects(getScopedKalshiJson({keyId:'fake',privateKey:'invalid'},path,'',async()=>{calls++;return new Response('{}');},host,undefined,c.signal));
 assert.equal(calls,0);
});
test('recovery cancellation reaches the original signed GET without transport wrapper',async()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048});
 const material={keyId:'test-key',privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
 const c=new AbortController();let calls=0,received:AbortSignal|null|undefined;
 const fake:typeof fetch=async(_url,init)=>{calls++;received=init?.signal;return await new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});};
 const pending=getScopedKalshiJson(material,path,'',fake,host,undefined,c.signal);
 await Promise.resolve();c.abort();await assert.rejects(pending);
 assert.equal(calls,1);assert.equal(received,c.signal);
});
