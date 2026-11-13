import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {pool} from '@workspace/db';
import {requestQuantityHundredths} from '../v13-production/requestQuantity';

test('fractional EXIT SQL quantity parity and immutable no-send audit preserve legacy and reject mixed quantities',async()=>{
 assert.ok(process.env.V13_DISPOSABLE_DATABASE_URL,'isolated PostgreSQL required');
 const c=await pool.connect();
 const rewrite=(s:string)=>s.replaceAll('public.','fractional_public.').replaceAll('private.','fractional_private.').replaceAll('auth.','fractional_auth.');
 const q=(s:string,p?:unknown[])=>c.query(rewrite(s),p);
 const owner='11111111-1111-4111-8111-111111111111',fingerprint='a'.repeat(64),ticker='KXBTC15M-TEST-000';
 const base={action:'SELL',reduceOnly:true,timeInForce:'IOC',market:ticker,side:'YES',limitMicros:450000};
 const exact=(quantity:string)=>({...base,quantityVersion:'EXIT_HUNDREDTHS_V1',quantityHundredths:quantity});
 try{
 await q(`CREATE SCHEMA fractional_public;CREATE SCHEMA fractional_private;CREATE SCHEMA fractional_auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')THEN CREATE ROLE anon;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN CREATE ROLE authenticated;END IF;END $$;
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,key_fingerprint text,subaccount int,exchange_index int);
 CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text,parent_id text,kind text,state text,terminal boolean,client_order_id text,market text,side text,request jsonb,exchange_order_id text,filled_hundredths bigint,reserved_micros bigint);
 CREATE TABLE public.v13_production_position(id text PRIMARY KEY,account_id text,market text,side text,quantity_hundredths bigint);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY,owner_user_id uuid,holder_id text,fencing_token bigint,state text,credential_fingerprint text);`);
 await q('INSERT INTO auth.users VALUES($1)',[owner]);await q("INSERT INTO public.v13_production_account VALUES('main',$1,$2,1,2)",[owner,fingerprint]);
 await q("INSERT INTO private.kalshi_account_worker_lease VALUES('main',$1,'worker',7,'owned',$2)",[owner,fingerprint]);
 await q(readFileSync('../../sql/strata_emergency_exit_reservation_private.sql','utf8'));
 await q(readFileSync('../../sql/strata_protective_exit_local_no_send.sql','utf8'));
 await assert.rejects(q('SELECT private.strata_exit_request_quantity_hundredths($1::jsonb)',[JSON.stringify(exact('50'))]),{code:'42883'});
 const migration=readFileSync('../../sql/strata_protective_exit_fractional_quantity.sql','utf8');await q(migration);await q(migration); // reviewed replacement is idempotent
 const decode=async(value:unknown)=>(await q('SELECT private.strata_exit_request_quantity_hundredths($1::jsonb)::text AS quantity',[JSON.stringify(value)])).rows[0].quantity;
 for(const r of [exact('1'),exact('50'),exact('150'),exact('100000'),{...base,contracts:1},{...base,contracts:999999999}])assert.equal(await decode(r),requestQuantityHundredths(r).toString());
 for(const r of [null,[],{},exact('0'),exact('01'),exact('1.5'),exact('100001'),{...exact('50'),quantityHundredths:50},{...exact('50'),contracts:0},{...exact('50'),contracts:null},{...exact('50'),quantityVersion:'unknown'},{...exact('50'),action:'BUY'},{...exact('50'),reduceOnly:false},{...exact('50'),reduceOnly:'true'},{...exact('50'),timeInForce:'GTC'},
 {...base,contracts:0},{...base,contracts:-1},{...base,contracts:1.5},{...base,contracts:'1'},{...base,contracts:1000000000},{...base,contracts:1,quantityVersion:null}])assert.equal(await decode(r),null,JSON.stringify(r));
 for(const role of ['anon','authenticated'])assert.equal((await q("SELECT has_function_privilege($1,'private.strata_exit_request_quantity_hundredths(jsonb)','EXECUTE') AS allowed",[role])).rows[0].allowed,false);
 const fn=(await q("SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='private.strata_exit_request_quantity_hundredths(jsonb)'::regprocedure")).rows[0];assert.equal(fn.prosecdef,false);assert.equal(fn.provolatile,'i');assert.deepEqual(fn.proconfig,['search_path=pg_catalog']);
 for(const [quantity,legacy,side] of [['1',false,'YES'],['50',false,'YES'],['150',false,'YES'],['200',true,'YES'],['50',false,'NO']] as const){
 const sideQ=(sql:string,p?:unknown[])=>q(sql.replaceAll("'YES'","'"+side+"'"),p);
 await sideQ('BEGIN');
 try{
  const rid=randomUUID(),cid='v13p-'+randomUUID(),request={...(legacy?{...base,contracts:2}:exact(quantity)),clientOrderId:cid,side};
  await sideQ("INSERT INTO public.v13_production_intent VALUES('parent','main',NULL,'ENTRY','TERMINAL',true,'parent-client',$1,'YES','{}',NULL,0,0)",[ticker]);
  await sideQ("INSERT INTO public.v13_production_intent VALUES('exit','main','parent','EXIT','DISPATCHED',false,$1,$2,'YES',$3,NULL,0,0)",[cid,ticker,request]);
  await sideQ("INSERT INTO public.v13_production_position VALUES('parent','main',$1,'YES',$2)",[ticker,quantity]);
  await sideQ(`INSERT INTO private.strata_emergency_exit_reservations(reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,reducing_side,quantity_hundredths,order_digest,worker_holder_id,worker_fencing_token)
    VALUES($1,$2,'main',$3,$4,'YES',$5,$6,'worker',7)`,[rid,owner,ticker,cid,quantity,'b'.repeat(64)]);
  await sideQ("UPDATE private.strata_emergency_exit_reservations SET state='UNKNOWN' WHERE reservation_id=$1",[rid]);
  const audit=()=>sideQ(`INSERT INTO private.strata_protective_exit_local_no_send(reservation_id,owner_user_id,execution_account_id,client_order_id,order_digest,signer_fingerprint,market_ticker,reducing_side,quantity_hundredths,limit_micros,worker_holder_id,worker_fencing_token,reason,evidence_sha256)
    VALUES($1,$2,'main',$3,$4,$5,$6,'YES',$7,450000,'worker',7,'final_evidence_expired',$8)`,[rid,owner,cid,'b'.repeat(64),fingerprint,ticker,quantity,'c'.repeat(64)]);
  for(const mutation of [{quantityHundredths:'2',quantityVersion:'EXIT_HUNDREDTHS_V1'},{contracts:3},{action:'BUY'},{reduceOnly:false},{timeInForce:'GTC'}]){
   await sideQ('SAVEPOINT mutation');await sideQ("UPDATE public.v13_production_intent SET request=request||$1::jsonb WHERE id='exit'",[mutation]);await assert.rejects(audit(),{code:'23514'});await sideQ('ROLLBACK TO SAVEPOINT mutation');
  }
  await sideQ('SAVEPOINT takeover');await sideQ('UPDATE private.kalshi_account_worker_lease SET fencing_token=8');await assert.rejects(audit(),{code:'23514'});await sideQ('ROLLBACK TO SAVEPOINT takeover');
  await sideQ('SAVEPOINT overfill');await sideQ("UPDATE public.v13_production_intent SET filled_hundredths=1 WHERE id='exit'");await assert.rejects(audit(),{code:'23514'});await sideQ('ROLLBACK TO SAVEPOINT overfill');
  await audit();
  await sideQ('SAVEPOINT notblocked');await assert.rejects(sideQ("UPDATE private.strata_emergency_exit_reservations SET state='VOID' WHERE reservation_id=$1",[rid]),{code:'23514'});await sideQ('ROLLBACK TO SAVEPOINT notblocked');
  await sideQ("UPDATE public.v13_production_intent SET state='BLOCKED',terminal=true WHERE id='exit'");await sideQ("UPDATE private.strata_emergency_exit_reservations SET state='VOID' WHERE reservation_id=$1",[rid]);
  assert.equal((await sideQ("SELECT quantity_hundredths::text FROM public.v13_production_position WHERE id='parent'")).rows[0].quantity_hundredths,quantity);
  for(const sql of ["UPDATE private.strata_protective_exit_local_no_send SET quantity_hundredths=1", "DELETE FROM private.strata_protective_exit_local_no_send", "UPDATE private.strata_emergency_exit_reservations SET state='PREPARED'"]){await sideQ('SAVEPOINT immutable');await assert.rejects(sideQ(sql),{code:'23514'});await sideQ('ROLLBACK TO SAVEPOINT immutable');}
 }finally{await sideQ('ROLLBACK');}
 }
 }finally{c.release();await pool.end();}
});
