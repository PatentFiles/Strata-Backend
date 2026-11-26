import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {endpoint} from './capture.mjs';
import {makeFixedTlsDial} from './tls-dial.mjs';
function fixture(open=true) {
 let wire;
 class Fake extends EventEmitter {
   constructor(url,opts) {super(); wire=this; this.url=url; this.opts=opts; this.closed=0;
    if (open) queueMicrotask(()=>this.emit('open'));
   }
   send(data,opt,cb) {this.sent=data; cb();}
   terminate(){this.closed++;}
 }
 const ac=new AbortController();
 return {ac, dial:makeFixedTlsDial(Fake), wire:()=>wire, params:{url:endpoint,headers:{},followRedirects:false,signal:ac.signal}};
}
test('fixed endpoint: normal TLS, no redirects/compression, bounded one-send transport',async()=>{
 const t=fixture();
 await assert.rejects(t.dial({...t.params,url:'wss://example.invalid/'}),/scope/);
 await assert.rejects(t.dial({...t.params,followRedirects:true}),/scope/);
 assert.equal(t.wire(),undefined);
 const p=await t.dial(t.params);
 assert.equal(t.wire().url,endpoint);
 assert.deepEqual(t.wire().opts,{headers:{},rejectUnauthorized:true,minVersion:'TLSv1.2',followRedirects:false,perMessageDeflate:false,maxPayload:262144,handshakeTimeout:5000});
 await p.sendText('subscribe fixture');
 await assert.rejects(p.sendText('second'),/refused/);
 t.wire().emit('message',Buffer.from('first'),false);
 assert.equal(await p.nextText(),'first');
 const pending=p.nextText(); t.ac.abort();
 await assert.rejects(pending,/closed/);
 p.close(); assert.equal(t.wire().closed,1);
});
test('refuses oversized/binary or backlogged data and clears buffered frames',async()=>{
 for (const issue of ['binary','size','queue']) {
   const t=fixture(),p=await t.dial(t.params), w=t.wire();
   if (issue==='binary') w.emit('message',Buffer.from('fixture'),true);
   if (issue==='size') w.emit('message',Buffer.alloc(262145),false);
   if (issue==='queue') for (let i=0;i<17;i++) w.emit('message',Buffer.from('a'),false);
   await assert.rejects(p.nextText()); assert.equal(w.closed,1);
 }
});
test('aborts a stalled handshake without emitting connection internals',async()=>{
 const t=fixture(false), p=t.dial(t.params);
 t.ac.abort();
 await assert.rejects(p,/^Error: book_socket_closed$/);
 assert.equal(t.wire().closed,1);
});
