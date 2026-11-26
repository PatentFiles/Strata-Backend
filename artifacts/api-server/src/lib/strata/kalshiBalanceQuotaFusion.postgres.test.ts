import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import {BALANCE_RESERVATION_SQL,BALANCE_IDENTITY_RESERVATION_SQL,reserveKalshiBalanceReadSlot} from './kalshiBalanceQuota';
assert.match(process.env.V13_DISPOSABLE_DATABASE_URL??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
after(()=>pool.end());
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',fingerprint='a'.repeat(64);
const digest=(owner?:string)=>createHash('sha256').update(`strata:kalshi:balance:${owner?'member:'+owner:'member:unmapped-conservative'}:v1`).digest('hex');
const originalIdentity=`SELECT DISTINCT owner_user_id::text AS owner FROM private.kalshi_connection_credentials WHERE key_fingerprint=$1 AND revoked_at IS NULL AND verified_at IS NOT NULL AND verification_reason='credential_verified' LIMIT 2`;
async function bucket(){return (await pool.query('SELECT budget_key,extract(epoch FROM(next_slot_at-clock_timestamp()))*1000 remaining FROM private.strata_kalshi_balance_read_slots')).rows;}
test('native original and fused owner discovery produce identical exact hash bytes and initial reservation',async()=>{
 await pool.query(`CREATE SCHEMA IF NOT EXISTS private;
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,key_fingerprint text,revoked_at timestamptz,verified_at timestamptz,verification_reason text);
 CREATE TABLE private.strata_kalshi_balance_read_slots(budget_key text PRIMARY KEY,next_slot_at timestamptz NOT NULL);`);
 for(const [label,owners,status,expected] of [['mapped',[A],'verified',A],['same-owner aliases',[A,A],'verified',A],['ambiguous',[A,B],'verified',undefined],['missing',[],'verified',undefined],['revoked',[A],'revoked',undefined],['unverified',[A],'unverified',undefined]] as const){
  await pool.query('TRUNCATE private.kalshi_connection_credentials,private.strata_kalshi_balance_read_slots');
  for(const owner of owners)await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,CASE WHEN $3='revoked' THEN now() ELSE NULL END,CASE WHEN $3='unverified' THEN NULL ELSE now() END,'credential_verified')",[owner,fingerprint,status]);
  const ids=await pool.query(originalIdentity,[fingerprint]);const selected=ids.rows.length===1&&typeof ids.rows[0]?.owner==='string'?ids.rows[0].owner:undefined;
  const old=await pool.query(BALANCE_RESERVATION_SQL,[digest(selected)]);const oldBucket=await bucket();
  await pool.query('TRUNCATE private.strata_kalshi_balance_read_slots');
  const current=await pool.query(BALANCE_IDENTITY_RESERVATION_SQL,[fingerprint]);const newBucket=await bucket();
  assert.equal(newBucket[0].budget_key,oldBucket[0].budget_key,label);assert.equal(newBucket[0].budget_key,digest(expected),label);
  assert.equal(old.rows.length,1);assert.equal(current.rows.length,1);assert.ok(Number(current.rows[0].wait_ms)<100);assert.ok(Number(newBucket[0].remaining)>900&&Number(newBucket[0].remaining)<=1200);
 }
});
test('five concurrent fused reservations serialize on same slot and retain 1200ms spacing',async()=>{
 await pool.query('TRUNCATE private.kalshi_connection_credentials,private.strata_kalshi_balance_read_slots');
 await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,NULL,now(),'credential_verified')",[A,fingerprint]);
 const rows=await Promise.all(Array.from({length:5},()=>pool.query(BALANCE_IDENTITY_RESERVATION_SQL,[fingerprint])));
 const waits=rows.map(r=>Number(r.rows[0].wait_ms)).sort((a,b)=>a-b);
 for(let i=0;i<waits.length;i++)assert.ok(Math.abs(waits[i]-i*1200)<300,JSON.stringify(waits));
 assert.equal((await bucket()).length,1);
});
test('saturated original/fused queries refuse without advancing or reserving a slot',async()=>{
 await pool.query('TRUNCATE private.strata_kalshi_balance_read_slots');
 await pool.query("INSERT INTO private.strata_kalshi_balance_read_slots VALUES($1,clock_timestamp()+interval '20 seconds')",[digest(A)]);
 const before=(await pool.query('SELECT next_slot_at::text FROM private.strata_kalshi_balance_read_slots')).rows;
 assert.equal((await pool.query(BALANCE_RESERVATION_SQL,[digest(A)])).rows.length,0);
 assert.equal((await pool.query(BALANCE_IDENTITY_RESERVATION_SQL,[fingerprint])).rows.length,0);
 assert.deepEqual((await pool.query('SELECT next_slot_at::text FROM private.strata_kalshi_balance_read_slots')).rows,before);
});
test('explicit owner and missing fingerprint need no credential table and preserve original bucket',async()=>{
 await pool.query('DROP TABLE private.kalshi_connection_credentials');
 for(const [owner,fp] of [[A,fingerprint],[undefined,null]] as const){
  await pool.query('TRUNCATE private.strata_kalshi_balance_read_slots');
  await reserveKalshiBalanceReadSlot('fixture',owner,pool.query.bind(pool),fp);
  assert.equal((await bucket())[0].budget_key,digest(owner));
 }
 await assert.rejects(reserveKalshiBalanceReadSlot('fixture',undefined,pool.query.bind(pool),fingerprint),/does not exist/);
});
