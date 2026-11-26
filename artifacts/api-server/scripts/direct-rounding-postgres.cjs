const {Client}=require(require('node:path').resolve(__dirname,'../../../lib/db/node_modules/pg'));
const fs=require('fs'),assert=require('assert/strict');
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
if(!url||url!==process.env.DATABASE_URL)throw Error('disposable_database_required');
const parsed=new URL(url);if(!['postgres:','postgresql:'].includes(parsed.protocol)||parsed.search||parsed.hash||parsed.password||parsed.hostname!=='127.0.0.1'||parsed.username!=='v13_test'||!/^\/v13_disposable_[0-9]+$/.test(parsed.pathname))throw Error('disposable_database_target_denied');
const config={connectionString:url};
const c=new Client(config),a=new Client(config),b=new Client(config);
const owner='12345678-1234-1234-1234-123456789abc',id='strata-account-test-commissioned';
async function waiting(client){const pid=client.processID;const end=Date.now()+3000;while(Date.now()<end){const r=await c.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);if(r.rows[0]?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,10));}throw Error('expected database lock wait not observed');}
let passed=0;function pass(s){passed++;console.log('PASS '+s);}
async function rejects(sql,regex){try{await c.query(sql);throw Error('expected rejection '+sql);}catch(e){assert.match(e.message,regex);}}
async function main(){await c.connect();await a.connect();await b.connect();
const server=await c.query('SELECT current_database() AS db,current_user AS usr,host(inet_server_addr()) AS host,inet_server_port() AS port');assert.deepEqual(server.rows[0],{db:parsed.pathname.slice(1),usr:'v13_test',host:'127.0.0.1',port:Number(parsed.port)});
await c.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE rounding_reader;CREATE ROLE rounding_reviewer;CREATE SCHEMA private;
CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,commissioned boolean,subaccount bigint,exchange_index bigint,key_fingerprint text,kalshi_connection_id uuid);
INSERT INTO public.v13_production_account VALUES('${id}','${owner}',true,1,2,'${'a'.repeat(64)}','${owner}');`);
await c.query(fs.readFileSync(require('node:path').resolve(__dirname,'../../../docs/qualification/direct-rounding-authority.sql'),'utf8'));pass('migration applies on real PostgreSQL');
const insert=(gen,state='PENDING_REVIEW')=>`INSERT INTO private.strata_direct_rounding_authority(account_id,owner_user_id,scope_generation,documentation_policy_digest,execution_fingerprint,verification_fingerprint,state,review_record_digest,reviewed_by_user_id,issued_at,expires_at)VALUES('${id}','${owner}',${gen},'${'c'.repeat(64)}','${'a'.repeat(64)}','${'b'.repeat(64)}','${state}','${'d'.repeat(64)}','${owner}',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`;
await c.query(insert(1,'APPROVED'));pass('text account approved test fixture accepted');
await rejects(`UPDATE private.strata_direct_rounding_authority SET account_id='wrong'`,/identity is immutable/);
await rejects(`UPDATE private.strata_direct_rounding_authority SET documentation_policy_digest='${'e'.repeat(64)}'`,/only be revoked/);
await rejects(`DELETE FROM private.strata_direct_rounding_authority`,/cannot be deleted/);
await rejects(`TRUNCATE private.strata_direct_rounding_authority`,/cannot be truncated/);pass('identity terms DELETE TRUNCATE protected');
await a.query('BEGIN');await a.query(`SELECT id FROM public.v13_production_account WHERE id=$1 FOR UPDATE`,[id]);
let finished=false;const revoke=b.query(`UPDATE private.strata_direct_rounding_authority SET state='REVOKED',revoked_at=clock_timestamp() WHERE scope_generation=1`).then(()=>finished=true);
await waiting(b);assert.equal(finished,false);await a.query('COMMIT');await revoke;assert.equal(finished,true);pass('executor lock first blocks revocation until transaction completion');
await rejects(`UPDATE private.strata_direct_rounding_authority SET state='APPROVED',revoked_at=null WHERE scope_generation=1`,/revoked.*immutable/);
await c.query(insert(2,'APPROVED'));
await b.query('BEGIN');await b.query(`UPDATE private.strata_direct_rounding_authority SET state='REVOKED',revoked_at=clock_timestamp() WHERE scope_generation=2`);
await a.query('BEGIN');let acquired=false;const lock=a.query(`SELECT id FROM public.v13_production_account WHERE id=$1 FOR UPDATE`,[id]).then(()=>acquired=true);await waiting(a);assert.equal(acquired,false);await b.query('COMMIT');await lock;const state=await a.query(`SELECT state FROM private.strata_direct_rounding_authority WHERE scope_generation=2`);assert.equal(state.rows[0].state,'REVOKED');await a.query('COMMIT');pass('revocation first forces waiting executor fresh revoked read');
await c.query(insert(3,'APPROVED'));await c.query(insert(4));
const authority=await c.query(`SELECT * FROM private.strata_direct_rounding_authority r WHERE r.state='APPROVED' AND NOT EXISTS(SELECT 1 FROM private.strata_direct_rounding_authority later WHERE later.account_id=r.account_id AND later.scope_generation>r.scope_generation)`);assert.equal(authority.rowCount,0);pass('later pending permanently suppresses older approval');
await rejects(insert(2),/generation must increase/);
await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await rejects(insert(5),/require READ COMMITTED/);await c.query('ROLLBACK');pass('non READ COMMITTED writes rejected');
await a.query('BEGIN');await a.query(insert(5));let second=false;const higher=b.query(insert(6)).then(()=>second=true);await waiting(b);assert.equal(second,false);await a.query('COMMIT');await higher;pass('concurrent generations serialize');
await a.query('BEGIN');await a.query(insert(9));const lower=b.query(insert(8)).then(()=>({ok:true}),error=>({ok:false,error}));await waiting(b);await a.query('COMMIT');const rejected=await lower;assert.equal(rejected.ok,false);assert.match(rejected.error.message,/generation must increase/);pass('lower generation rejects after waiting for higher concurrent insert');
await c.query('SET ROLE anon');await rejects('SELECT * FROM private.strata_direct_rounding_authority',/permission denied/);await c.query('RESET ROLE');
await c.query(`GRANT USAGE ON SCHEMA private TO rounding_reader;GRANT SELECT ON private.strata_direct_rounding_authority TO rounding_reader;SET ROLE rounding_reader`);assert.equal((await c.query('SELECT * FROM private.strata_direct_rounding_authority')).rowCount,0);await rejects(insert(7),/permission denied/);await c.query('RESET ROLE');pass('anon denied and runtime read role cannot approve; RLS default denies rows');

await c.query(`CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,key_fingerprint text,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text);
INSERT INTO private.kalshi_connection_credentials VALUES('${owner}','${owner}','${'a'.repeat(64)}','restricted_execution',null,clock_timestamp(),'credential_verified'),('${owner}','${owner}','${'b'.repeat(64)}','verification',null,clock_timestamp(),'credential_verified');
UPDATE private.strata_direct_rounding_authority SET state='REVOKED',revoked_at=clock_timestamp() WHERE scope_generation=3;`);
await c.query(insert(10,'APPROVED'));
const registrySource=fs.readFileSync(require('node:path').resolve(__dirname,'../src/lib/strata/directRoundingRegistry.ts'),'utf8');
const exactSql=registrySource.match(/DIRECT_ROUNDING_AUTHORITY_SQL=`([\s\S]*?)`;/)[1];
assert.equal((await c.query(exactSql,[id,owner])).rowCount,1);
assert.equal((await c.query(exactSql,[id,'22345678-1234-1234-1234-123456789abc'])).rowCount,0);
await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assert.equal((await c.query(exactSql,[id,owner])).rowCount,0);await c.query('ROLLBACK');
await c.query(`UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp() WHERE role='verification'`);assert.equal((await c.query(exactSql,[id,owner])).rowCount,0);pass('exact production registry SQL joins actual text identity and rejects wrong owner isolation revoked credential');

await c.query(`UPDATE private.kalshi_connection_credentials SET revoked_at=null WHERE role='verification'`);
await a.query('BEGIN');assert.equal((await a.query(exactSql,[id,owner])).rowCount,1);let credentialRevoked=false;
const credentialRevoke=b.query(`UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp() WHERE role='verification'`).then(()=>credentialRevoked=true);
await waiting(b);assert.equal(credentialRevoked,false);await a.query('COMMIT');await credentialRevoke;pass('final registry credential row locks block verification revoke through transaction completion');
await c.query(`UPDATE private.kalshi_connection_credentials SET revoked_at=null WHERE role='verification'`);
await b.query('BEGIN');await b.query(`UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp() WHERE role='verification'`);
await a.query('BEGIN');const credentialRead=a.query(exactSql,[id,owner]);await waiting(a);await b.query('COMMIT');assert.equal((await credentialRead).rowCount,0);await a.query('COMMIT');pass('verification revoke first makes waiting final registry return no authority');
await c.query(`UPDATE private.kalshi_connection_credentials SET revoked_at=null WHERE role='verification';INSERT INTO private.kalshi_connection_credentials SELECT * FROM private.kalshi_connection_credentials WHERE role='verification'`);
assert.equal((await c.query(exactSql,[id,owner])).rowCount,2);pass('duplicate credential joins produce two rows for registry fail-closed rejection');
console.log('TOTAL '+passed+' PASSED');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await Promise.all([c.end(),a.end(),b.end()]);});
