import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(resolve(root,p),'utf8');
const prefix='src/lib/strata/';
const combined=read(prefix+'restrictedCombinedRuntime.fixture.ts');
const protective=read(prefix+'restrictedProtectiveRuntime.fixture.ts');
const held=read(prefix+'heldSupervisorDispatch.postgres.fixture.ts');
const restart=read(prefix+'heldReconciliationFence.postgres.fixture.ts');
test('all combined fixtures and wrappers parse without executing database code',()=>{
 for(const name of ['restrictedCombinedRuntime.fixture','heldSupervisorDispatch.postgres.fixture',
  'heldReconciliationFence.postgres.fixture','heldReconciliationFence.postgres.test','restrictedCombinedRestart.postgres.test',
  'restrictedCombinedSuccessor.postgres.test','restrictedCombinedRevocation.postgres.test'])stripTypeScriptTypes(read(prefix+name+'.ts'));
});
test('combined DDL is fenced, additive and contains no blanket ACL expansion',()=>{
 assert.match(combined,/url===process\.env\.DATABASE_URL/);
 assert.ok(combined.includes('v13_test@127\\.0\\.0\\.1:\\d+\\/v13_disposable_\\d+$'));
 assert.ok(combined.indexOf('await assertCombinedTarget(setup)')<combined.indexOf('CREATE ROLE'));
 assert.match(combined,/await installRestrictedProtectiveRuntime\(setup,observe\)/);
 assert.doesNotMatch(combined,/GRANT .*ALL (?:TABLES|SEQUENCES|FUNCTIONS)|ALTER DEFAULT PRIVILEGES|DISABLE (?:TRIGGER|ROW LEVEL SECURITY)/);
 assert.doesNotMatch(combined,/openRestrictedStandingRenewal|installPlatformCapabilities/);
 assert.match(combined,/for\(const table of \[feeDelegation,technicalLease,technicalAudit\]\)/);
 assert.match(combined,/statement_timestamp\(\)-interval '6 minutes',statement_timestamp\(\)-interval '1 minute'/);
});
test('actual combined manifest excludes every mutable relation from lock-only denial',()=>{
 const base=protective.slice(protective.indexOf('const activityLockOnly='),protective.indexOf('type QueryFailure='));
 const manifest=combined.slice(combined.indexOf('export const combinedReadOnlyLocks'),combined.indexOf('async function assertCombinedTarget'));
 const run=new Function('assert','feeDelegation','technicalLease','technicalLeaseUpdateColumns',
  stripTypeScriptTypes(base+manifest).replace(/\bexport /g,'')+';assertCombinedClassification();return {lockOnly,updates,combinedReadOnlyLocks,combinedTechnicalUpdates};');
 const result=run(assert,'private.strata_api_fee_standing_delegations','private.strata_continuous_execution_technical_lease',['observed_at','expires_at','evidence_digest','fencing_token','generation']);
 assert.deepEqual(result.combinedTechnicalUpdates['private.strata_api_fee_standing_delegations'],['lease_expires_at']);
 assert.equal(Object.keys(result.combinedReadOnlyLocks).length,4);
 assert.ok(result.updates['public.v13_production_account'].includes('cash_micros'));
 assert.ok(result.updates['private.kalshi_account_worker_lease'].includes('heartbeat_at'));
});
test('restart extraction retains genuine runtime and selects seven original outcomes',()=>{
 assert.match(restart,/const db=restricted\?pool:new NativePool/);
 assert.match(restart,/const setup=restricted\?new NativePool/);
 assert.match(restart,/await installCombinedRestrictedRuntime\(setup\)/);
 assert.match(restart,/new ProductionLedger\(db,account\)/);
 assert.match(restart,/persistence:Pool=db/);
 assert.match(restart,/const c=await db.connect\(\),query=c.query.bind\(c\)/);
 assert.match(restart,/for\(const filled of \[0,100,300\]\)/);
 for(const name of ['missing exact position GET','lost protective reconciliation COMMIT acknowledgment','expired markerless PREPARED exit','PREPARED reservation retains'])assert.ok(restart.includes(name));
 assert.match(restart,/postAttempted,false/);
 assert.match(restart,/assert.rejects\(db.query\(`INSERT INTO public.v13_production_intent/);
 assert.match(read(prefix+'heldReconciliationFence.postgres.test.ts'),/runHeldReconciliationFence\(\)/);
 assert.match(read(prefix+'restrictedCombinedRestart.postgres.test.ts'),/runHeldReconciliationFence\(\{restricted:true\}\)/);
});
test('combined flow proves renewal before held mode and actual successor/refusal branches',()=>{
 assert.match(held,/seen.has\('technical_renewal'\)/);
 assert.match(held,/seen.has\('fee_renewal'\)/);
 assert.match(held,/external.holdFlatRead\(\)/);
 assert.ok(held.indexOf('heldTechnical=await technical()')<held.indexOf('const at=await acknowledgedEntry(setup)'));
 assert.match(held,/held mode must not renew continuous entry technical evidence/);
 assert.match(held,/seen.has\('successor_refused'\)/);
 assert.match(held,/financial\(\),financialBeforeRevocation/);
 assert.match(held,/worker never changes human authority bytes/);
 assert.match(held,/revocationDone&&!control.isScheduled/);
 assert.match(held,/assert.equal\(external.summary\(\).posts,0\)/);
});
test('only canonical isolated runs are wired; no production/runtime code or runner modification is needed',()=>{
 const scripts=JSON.parse(read('package.json')).scripts;
 assert.ok(scripts['test:v13-safety-all'].includes('pnpm run test:restricted-combined-worker'));
 for(const name of ['Restart','Successor','Revocation'])assert.ok(scripts['test:restricted-combined-worker'].includes(
  'node scripts/run-v13-disposable-postgres.mjs src/lib/strata/restrictedCombined'+name+'.postgres.test.ts'));
 assert.match(read('scripts/run-v13-disposable-postgres.mjs'),/no connected-database fallback exists/);
 assert.match(read('scripts/run-v13-disposable-postgres.mjs'),/offline_external_socket_denied/);
});
const observer=combined.slice(combined.indexOf('export function observeCombinedStatements'));
const observe=new Function(stripTypeScriptTypes(observer).replace('export ','')+';return observeCombinedStatements;')();
const sql='SELECT d.delegation_id::text,m.model_id::text,e.release_id::text';
test('native success observer preserves results, callback receiver, arguments and original failures',async()=>{
 const seen=new Set(),result={rows:[{synthetic:true}]},error=Object.assign(Error('NEVER_PRINT_VALUE'),{code:'42501'});
 const promise={query:async function(text,args){assert.equal(this,promise);assert.equal(text,sql);assert.deepEqual(args,['private dummy']);return result;}};
 observe(promise,seen);assert.equal(await promise.query(sql,['private dummy']),result);assert(seen.has('successor'));
 const receiver={},callback={query:(_sql,cb)=>{cb.call(receiver,null,result);return result;}};
 observe(callback,seen);assert.equal(callback.query(sql,function(err,value){assert.equal(this,receiver);assert.equal(err,null);assert.equal(value,result);}),result);
 const failure={query:async()=>{throw error;}};observe(failure,seen);await assert.rejects(failure.query(sql),e=>e===error);
 const sync={query:()=>{throw error;}};observe(sync,seen);assert.throws(()=>sync.query(sql),e=>e===error);
 const empty={query:async()=>({rows:[]})};observe(empty,seen);await empty.query(sql);assert(seen.has('successor_refused'));
 assert.deepEqual([...seen].sort(),['successor','successor_refused']);
});
