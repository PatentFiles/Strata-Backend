import assert from 'node:assert/strict';import test from 'node:test';
import {createOwnerRecoveryPools} from '@workspace/db/owner-recovery-pools';
test('dedicated pools are bounded, separate and lazy; session defaults read-only',async()=>{
 const p=createOwnerRecoveryPools({accountConnectionString:'postgresql://recovery@127.0.0.1:55462/disposable',sessionConnectionString:'postgresql://session_reader@127.0.0.1:55462/disposable'});
 assert.notEqual(p.accountPool,p.sessionPool);for(const pool of [p.accountPool,p.sessionPool]){assert.equal(pool.options.max,1);assert.equal(pool.options.connectionTimeoutMillis,1000);assert.equal(pool.totalCount,0);}
 assert.equal(p.sessionPool.options.options,'-c default_transaction_read_only=on');await p.close();
});
test('no URL fallback, cross-database role substitution, shared roles or unverified remote TLS',()=>{
 for(const [a,s] of [['',''],['postgresql://a@remote/db','postgresql://b@remote/db'],['postgresql://a@127.0.0.1/one','postgresql://b@127.0.0.1/two'],['postgresql://a@127.0.0.1/db','postgresql://a@127.0.0.1/db']])assert.throws(()=>createOwnerRecoveryPools({accountConnectionString:a,sessionConnectionString:s}));
});

test('optional issuer pool is separately bounded and cannot reuse either login role',async()=>{
 const base={accountConnectionString:'postgresql://recovery@127.0.0.1:55462/disposable',sessionConnectionString:'postgresql://session_reader@127.0.0.1:55462/disposable'};
 assert.throws(()=>createOwnerRecoveryPools({...base,issuerConnectionString:base.accountConnectionString}));
 const p=createOwnerRecoveryPools({...base,issuerConnectionString:'postgresql://issuer@127.0.0.1:55462/disposable'});assert.equal(p.issuerPool?.options.max,1);assert.equal(p.issuerPool?.totalCount,0);await p.close();
});
