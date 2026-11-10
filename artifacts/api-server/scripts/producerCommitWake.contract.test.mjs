import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const source=read('../src/lib/v13-production/producerCommitWake.postgres.test.ts');
// These are syntax/source contracts ONLY. No claim of executed PostgreSQL,
// producer commit behavior, scheduler races, account gates or reservation proof.
test('native integration candidate parses without executing database code',()=>{
 assert.ok(stripTypeScriptTypes(source));
});
test('native candidate pins canonical URL and actual server identity before setup',()=>{
 assert.match(source,/assert\.equal\(process\.env\.DATABASE_URL,url\)/);
 assert.match(source,/assert\.equal\(process\.env\.NODE_ENV,'test'\)/);
 assert.ok(source.includes('v13_test@127\\.0\\.0\\.1:\\d+\\/v13_disposable_\\d+$'));
 assert.match(source,/assert\.deepEqual\(actual,\{name:target\.pathname\.slice\(1\),username:'v13_test',host:'127\.0\.0\.1',port:Number\(target\.port\)\}\)/);
 assert.ok(source.indexOf('await assertTarget();',source.indexOf("test('native"))<source.indexOf("CREATE TABLE producer_commit_wake_probe"));
});
test('actual producer and scheduler are used without direct wake or tick injection',()=>{
 assert.match(source,/runForwardTestCycle\(\{owner,epoch:lease\.leaseEpoch,engineId:engine,feeds,clock:/);
 assert.match(source,/new ProductionLedger\(pool,account\)/);
 assert.match(source,/new ProductionExecutor\(ledger,exchange/);
 assert.match(source,/new ProductionWorker\(executor,60000/);
 assert.match(source,/await worker\.start\(\)/);
 assert.doesNotMatch(source,/notifyCommittedForwardSignal|worker\.tick\(|\.gate\s*=|\.reconcile\s*=|\.prepareEntry\s*=/);
 assert.match(source,/executor\.dispatch=async intent/); // Explicit stop before transport.
});
test('commit barrier is native and deferred, with a separate visibility client',()=>{
 for(const marker of ['CREATE CONSTRAINT TRIGGER','DEFERRABLE INITIALLY DEFERRED',
  'pg_advisory_xact_lock(166331,1)','pg_advisory_lock(166331,1)','pg_advisory_unlock(166331,1)',
  "scenario==='rollback'","scenario==='stop_before_commit'",'observer=await pool.connect()',
  'assert.notEqual(observerPid,blockerPid)','assert.equal(hints.length,0)',
  'producer_commit_wake_forced_rollback'])assert.ok(source.includes(marker),marker);
});
test('five-second admission, persisted reservation and zero transport remain explicit',()=>{
 assert.match(source,/maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:5000/);
 for(const marker of ['consumerNow=sourceAt+5001',"intent.state,'PREPARED'",'intent.evaluation_id,result.evaluationId',
  'BigInt(intent.reserved_micros)>0n',"e.sourceAgeMs===5001",'counters.submits,0','counters.cancels,0',
  'producer_commit_wake_submit_forbidden','producer_commit_wake_fetch_forbidden'])assert.ok(source.includes(marker),marker);
});
test('package keeps both prior suites and uses unchanged canonical native runner',()=>{
 const p=JSON.parse(read('../package.json')).scripts;
 for(const name of ['test:restricted-combined-worker','test:producer-worker-recovery-replay','test:producer-commit-wake']){
  assert.ok(p[name]);assert.ok(p['test:v13-safety-all'].includes('pnpm run '+name));
 }
 assert.equal(p['test:producer-commit-wake'],'node --test scripts/producerCommitWake.contract.test.mjs && node scripts/run-v13-disposable-postgres.mjs src/lib/v13-production/producerCommitWake.postgres.test.ts');
 const runner=read('./run-v13-disposable-postgres.mjs');
 assert.match(runner,/no connected-database fallback exists/);assert.match(runner,/offline_external_socket_denied/);
 assert.doesNotMatch(runner,/\.\.\.process\.env/);
});
