import {test} from "node:test";
import assert from "node:assert/strict";
import {createWalletDisplayReads} from "./walletDisplayReads";
test("concurrent owner display requests consume one exchange scan; copies cannot contaminate cache",async()=>{
 let release!:(x:{ok:boolean;cash:number})=>void,calls=0;
 const read=createWalletDisplayReads<{ok:boolean;cash:number}>({cacheable:x=>x.ok,now:()=>0});
 const load=()=>{calls++;return new Promise<{ok:boolean;cash:number}>(r=>release=r);};
 const a=read("owner:connection:key",load),b=read("owner:connection:key",load);
 await Promise.resolve();assert.equal(calls,1);release({ok:true,cash:25});
 const [x,y]=await Promise.all([a,b]);x.cash=999;assert.equal(y.cash,25);
 assert.equal((await read("owner:connection:key",load)).cash,25);assert.equal(calls,1);
});
test("expiry, signer rotation, connection and owner isolation force new reads",async()=>{
 let clock=0,calls=0;
 const read=createWalletDisplayReads({cacheable:()=>true,now:()=>clock});
 const load=async()=>++calls;
 assert.equal(await read("owner1:conn1:key1",load),1);
 clock=14999;assert.equal(await read("owner1:conn1:key1",load),1);
 clock=15000;assert.equal(await read("owner1:conn1:key1",load),2);
 assert.equal(await read("owner2:conn1:key1",load),3);
 assert.equal(await read("owner1:conn2:key1",load),4);
 assert.equal(await read("owner1:conn1:key2",load),5);
 clock=0;assert.equal(await read("owner1:conn1:key2",load),6);
});
test("provider failures and invalid responses are never cached",async()=>{
 const read=createWalletDisplayReads<number>({cacheable:x=>x>0});
 await assert.rejects(read("a",async()=>{throw Error("provider_failed");}),/provider_failed/);
 assert.equal(await read("a",async()=>0),0);
 assert.equal(await read("a",async()=>25),25);
});
test("capacity remains bounded without evicting a pending owner scan",async()=>{
 let release!:(x:number)=>void,calls=0;
 const read=createWalletDisplayReads<number>({cacheable:()=>true,maxEntries:1});
 const pending=read("a",()=>new Promise<number>(r=>release=r));
 await Promise.resolve();assert.equal(await read("b",async()=>3),3);
 const same=read("a",async()=>{calls++;return 9;});
 release(2);assert.equal(await pending,2);assert.equal(await same,2);assert.equal(calls,0);
});
