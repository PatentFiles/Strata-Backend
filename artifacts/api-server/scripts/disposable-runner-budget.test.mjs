import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const runner = readFileSync(new URL('./run-v13-disposable-postgres.mjs', import.meta.url), 'utf8');
const fn = runner.slice(runner.indexOf('function run('), runner.indexOf('\nconsole.info("ISOLATED_FINAL_OVERLAP_ENV"'));
function harness(fullSuite, result = {status: 0}) {
  const calls=[]; let tick=0;
  const context={fullSuite, process:{platform:'linux'}, api:'/isolated',env:{NODE_ENV:'test'},performance:{now:()=>{tick+=10;return tick}},spawnSync:(...args)=>{calls.push(args);return result}};
  vm.runInNewContext(`${fn}; this.invoke=run`,context);
  return {run:context.invoke,calls};
}
test('aggregate alone gets bounded twenty-minute override',()=>{
  const h=harness(true); const call=runner.match(/run\(process\.platform === "win32" \? "pnpm.cmd" : "pnpm", \["run", "test:v13-safety-all"\], \{ timeout: ([\d_]+) \}\);/);
  assert.ok(call); const budget=Number(call[1].replaceAll('_',''));assert.equal(budget,1_200_000);
  h.run('pnpm',['run','test:v13-safety-all'],{timeout:budget});assert.equal(h.calls[0][2].timeout,budget);
  assert.equal((runner.match(/1_200_000/g)||[]).length,1);
});
test('normal per-command limits remain unchanged',()=>{
  for(const [full,budget] of [[false,180_000],[true,600_000]]){const h=harness(full);h.run('node',['single-test']);assert.equal(h.calls[0][2].timeout,budget);assert.equal(h.calls[0][2].cwd,'/isolated');assert.equal(h.calls[0][2].env.NODE_ENV,'test');}
});
for(const [name,result,pattern] of [
 ['timeout',{status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT'}},/status=null, signal=SIGTERM, timedOut=true, timeoutMs=1200000, elapsedMs=10/],
 ['assertion failure',{status:1,signal:null},/status=1, signal=none, timedOut=false/],
 ['spawn failure',{status:null,signal:null,error:{code:'ENOENT'}},/status=null, signal=none, timedOut=false/],
 ['signal termination',{status:null,signal:'SIGKILL'},/status=null, signal=SIGKILL, timedOut=false/],
]) test(`${name} is never reported as success`,()=>{const h=harness(true,result);assert.throws(()=>h.run('pnpm',['run','test:v13-safety-all'],{timeout:1_200_000}),pattern);assert.equal(h.calls.length,1);});
test('both CI callers reserve bounded setup/cleanup time',()=>{
 for(const file of ['continuous-grant-safety.yml','market-discovery-safety.yml']){
  const yaml=readFileSync(new URL(`../../../.github/workflows/${file}`,import.meta.url),'utf8');
  const job=yaml.split(/\n  [a-zA-Z][\w-]*:\n/).find(x=>x.includes('--full-suite'));
  assert.ok(job);assert.match(job,/timeout-minutes: 30/);
 }
});
test('original cleanup, isolation and nested safety limits are retained',()=>{
 assert.match(runner,/finally \{[\s\S]*pg_ctl[\s\S]*Disposable cluster cleanup failed[\s\S]*rmSync\(root/);
 assert.match(runner,/statement_timeout=30000 -c lock_timeout=10000/);
 assert.match(runner,/MICRO_LIVE_TEST_TIMEOUT_MS: "45000"/);
 assert.match(runner,/offline_external_socket_denied/);assert.match(runner,/offline_external_fetch_denied/);
 assert.match(runner,/Never read ambient DATABASE_URL/);
 const workflow=readFileSync(new URL('../../../.github/workflows/continuous-grant-safety.yml',import.meta.url),'utf8');assert.match(workflow,/node --test artifacts\/api-server\/scripts\/disposable-runner-budget.test.mjs/);
});
