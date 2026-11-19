'use strict';
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {resolve} = require('node:path');
const fixtureDb = createRequire(resolve(__dirname, '../../../../lib/db/package.json'));
const table = `
CREATE SCHEMA detached_held;
CREATE TABLE detached_held.account(id text PRIMARY KEY,owner text NOT NULL,policy text NOT NULL,stopped boolean NOT NULL DEFAULT false, active text NOT NULL);
CREATE TABLE detached_held.position(id text PRIMARY KEY,account text NOT NULL REFERENCES detached_held.account(id),ticker text NOT NULL,venue text NOT NULL,side text NOT NULL,qty text NOT NULL);
CREATE TABLE detached_held.observation(id text PRIMARY KEY,position text NOT NULL REFERENCES detached_held.position(id),original_scope jsonb NOT NULL,
 raw_strategy jsonb NOT NULL, oldest_at timestamptz NOT NULL, observed_at timestamptz NOT NULL, closes_at timestamptz NOT NULL,
 CHECK(oldest_at<=observed_at AND observed_at<closes_at));
CREATE FUNCTION detached_held.observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'detached_evidence_immutable'; END $$;
CREATE TRIGGER detached_held_observation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON detached_held.observation FOR EACH STATEMENT EXECUTE FUNCTION detached_held.observation_immutable();
`;

async function verifyFixture(db,user) {
 const result=await db.query("SELECT current_user,host(inet_server_addr()) AS host,current_database() AS db,current_setting('server_version_num')::int AS version");
 const [proof]=result.rows;
 assert.equal(result.rows.length,1);
 assert.equal(proof.current_user,user);assert.equal(proof.host,'127.0.0.1');assert.equal(proof.db,'postgres');
 assert.ok(proof.version>=160000&&proof.version<170000,'expected PostgreSQL 16 disposable cluster');
}
/** Only the test runner's freshly created port is accepted. Do not use a default DSN. */
async function createHeldFixture(fixturePort) {
 if(!/^\d{2,5}$/.test(fixturePort??'') || Number(fixturePort)>65535 || process.env.NODE_ENV!=='test')throw Error('held replay requires the disposable fixture port');
 const {Pool}=fixtureDb('pg');
 const options={host:'127.0.0.1',port:Number(fixturePort),database:'postgres',ssl:false,max:2,connectionTimeoutMillis:1500};
 const bootstrap=new Pool({...options,user:'fixture'});
 try{
  await verifyFixture(bootstrap,'fixture');
  await bootstrap.query("CREATE ROLE held_fixture LOGIN; GRANT CREATE ON DATABASE postgres TO held_fixture");
 }finally{await bootstrap.end();}
 const db=new Pool({...options,user:'held_fixture'});
 return {
  db, close:()=>db.end(),
  async initialize(scope,strategy) {
   await verifyFixture(db,'held_fixture');
   await db.query(table);
   await db.query("INSERT INTO detached_held.account VALUES ($1,$2,$3,false,'KXBTC15M-ACTIVE')",[scope.account,scope.owner,scope.policy]);
   await db.query("INSERT INTO detached_held.position VALUES ($1,$2,$3,$4,$5,'137')",[scope.position,scope.account,scope.ticker,scope.venue,scope.side]);
   await db.query(`WITH w AS(SELECT clock_timestamp() AS now)
     INSERT INTO detached_held.observation
     SELECT 'native-held',$1,$2::jsonb,$3::jsonb,now-interval '120ms',now-interval '80ms',now+interval '5s' FROM w`,[scope.position,scope,strategy]);
  }
 };
}
module.exports={createHeldFixture};
