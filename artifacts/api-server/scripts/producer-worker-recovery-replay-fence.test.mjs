import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

test('replay child strips caller credentials, production switches and injected Node options',()=>{
 assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.TZ,'UTC');
 assert.equal(process.env.DATABASE_URL,'postgresql://unused:unused@127.0.0.1:1/unused');
 for(const name of Object.keys(process.env))assert.doesNotMatch(name,/^(KALSHI|SUPABASE|STRATA|LIVE_EXECUTION|V13_PRODUCTION|NODE_OPTIONS)/);
});
test('replay fence rejects provider fetch, HTTP, TLS, TCP and UDP before I/O',()=>{
 const denied=/timing_recovery_replay_external_io_denied/;
 assert.throws(()=>fetch('https://example.invalid'),denied);
 assert.throws(()=>require('node:http').request('http://example.invalid'),denied);
 assert.throws(()=>require('node:https').get('https://example.invalid'),denied);
 assert.throws(()=>require('node:tls').connect({host:'127.0.0.1',port:1}),denied);
 const socket=new (require('node:net').Socket)();
 try{assert.throws(()=>socket.connect({host:'127.0.0.1',port:1}),denied);}finally{socket.destroy();}
 assert.throws(()=>require('node:dgram').createSocket('udp4'),denied);
});
