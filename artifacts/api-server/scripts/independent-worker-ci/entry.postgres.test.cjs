'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const {Client}=createRequire(path.join(__dirname,'../../../../lib/db/package.json'))('pg');
const {assembly}=require('./load-replay-worker.cjs');
const scope={ownerId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',accountId:'account-a'};
const gate={...scope,revision:'fixture-1',fence:'fixture-fence-1',stop:false,unknown:false,revoked:false,positionId:null,heldMarket:null,maxAgeMs:5000};
const now=1660000001000;
const schema=`CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid NOT NULL);
CREATE TABLE public.strata_direct_entry_source(id text PRIMARY KEY,account_id text NOT NULL REFERENCES public.v13_production_account,
 market_ticker text NOT NULL,crossing_key text NOT NULL,observed_at timestamptz NOT NULL,oldest_source_at timestamptz NOT NULL,
 closes_at timestamptz NOT NULL,evidence_bytes text NOT NULL,evidence_sha256 text NOT NULL,
 CHECK(crossing_key=market_ticker||':first'),CHECK(oldest_source_at<=observed_at AND observed_at<closes_at),
 CHECK(evidence_sha256=encode(sha256(convert_to(evidence_bytes,'UTF8')),'hex')),UNIQUE(account_id,crossing_key));
CREATE FUNCTION public.fixture_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$;
CREATE TRIGGER fixture_source_immutable BEFORE UPDATE OR DELETE ON public.strata_direct_entry_source FOR EACH ROW EXECUTE FUNCTION public.fixture_entry_immutable();
ALTER TABLE public.strata_direct_entry_source ENABLE ROW LEVEL SECURITY;
CREATE ROLE direct_fixture_reader LOGIN;
GRANT SELECT ON public.v13_production_account,public.strata_direct_entry_source TO direct_fixture_reader;
CREATE POLICY direct_fixture_read ON public.strata_direct_entry_source FOR SELECT TO direct_fixture_reader USING(true);`;
test('committed direct ENTRY reaches the actual worker replay factory and rereads exact final proof on PG16', async()=>{
 const port=process.env.FIXTURE_PORT;
 assert.match(port??'',/^\d{4,5}$/);
 const local={host:'127.0.0.1',port:+port,database:'postgres',ssl:false,statement_timeout:2500};
 const write=new Client({...local,user:'fixture'}),read=new Client({...local,user:'direct_fixture_reader'});
 await write.connect();
 try{
  assert.match((await write.query('show server_version')).rows[0].server_version,/^16\./);
  await write.query(schema);
  await write.query('insert into public.v13_production_account values($1,$2),($3,$4)',[scope.accountId,scope.ownerId,'account-b','bbbbbbbb-cccc-dddd-eeee-ffffffffffff']);
  await read.connect();
  async function publish(id,account,oldest){
   const ticker='KXBTC15M-'+id.toUpperCase(),observed=now-100,closes=now+9000;
   const raw=JSON.stringify({version:1,account,ticker,evaluation:id,oldest,observed,closesAt:closes});
   await write.query(`insert into public.strata_direct_entry_source values($1,$2,$3,$4,to_timestamp($5::float8/1000),
    to_timestamp($6::float8/1000),to_timestamp($7::float8/1000),$8,$9)`,[id,account,ticker,ticker+':first',observed,oldest,closes,raw,createHash('sha256').update(raw).digest('hex')]);
  }
  let wall=now,authorized=gate;
  const heldForbidden=()=>{throw Error('ENTRY cannot read held data');};
  const statements=[];
  const wire=assembly();
  const open=()=>wire(scope,{now:()=>wall,gate:async()=>authorized,
   entrySelect:async(sql,values)=>{assert.match(sql,/^SELECT/);statements.push(sql);return read.query(sql,values);},
   heldDb:{query:heldForbidden},heldBinding:heldForbidden});
  const worker=open();
  const expect=(r,status,inspected)=>assert.deepEqual({...r},{status,inspected,submissionAuthorized:false});
  await publish('foreign','account-b',now-200);
  await publish('stale','account-a',now-5001);
  await write.query('BEGIN');
  await publish('valid','account-a',now-5000);
  expect(await worker.tick('valid'),'no_fresh_work',0);
  await write.query('COMMIT');
  expect(await worker.tick(),'observed_entry',1);
  assert.ok(statements.some(s=>/AND s\.id=\$4::text LIMIT 1$/.test(s)));
  expect(await worker.tick('valid'),'no_fresh_work',0);
  wall++;
  expect(await open().tick('valid'),'no_fresh_work',0);
  authorized={...gate,stop:true};
  expect(await worker.tick('valid'),'stopped_or_unverified',0);
  await assert.rejects(read.query('DELETE FROM public.strata_direct_entry_source'),/permission denied/);
  const {rows:[r]}=await read.query("select to_regclass('public.forward_test_evaluations') as p,to_regclass('public.v13_production_intent') as i");
  assert.deepEqual(r,{p:null,i:null});
 }finally{await read.end();await write.end();}
});
