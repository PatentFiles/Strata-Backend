import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {childEnvironment,networkFence,offlineTests} from './run-owner-unknown-recovery.mjs';
test('credential-stripped child never inherits ambient provider/database/CI settings',()=>{
 const env=childEnvironment('/safe/path','/safe/home','/safe/fence');
 assert.equal(env.DATABASE_URL,'postgresql://offline:offline@127.0.0.1:1/offline');
 assert.deepEqual(Object.keys(env).sort(),['PATH','HOME','NODE_ENV','TZ','PGTZ','DATABASE_URL','NODE_PATH','NODE_OPTIONS'].sort());
});
test('offline runner rejects socket, server and fetch attempts even if caught',()=>{
 for(const call of ["require('node:net').connect(1,'127.0.0.1')", "require('node:net').createServer().listen(0)", "fetch('https://example.invalid')"]){
  const r=spawnSync(process.execPath,['--eval',networkFence+'\ntry {'+call+';} catch {}'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(r.status,1);assert.match(r.stderr,/unknown_recovery_network_attempts=1/);
 }
});
test('all candidate and original denied-diagnostic guard suites remain registered',()=>{
 for(const name of ['Plan','Fence','Held','Service'])assert.ok(offlineTests.some(x=>x.endsWith('ownerUnknownRecovery'+name+'.test.ts')));
 assert.ok(offlineTests.some(x=>x.endsWith('ownerUnknownRecoveryRouter.test.ts')));
 assert.ok(offlineTests.some(x=>x.endsWith('ownerSignedExchangeReleaseProof.test.ts')));
 assert.ok(offlineTests.some(x=>x.endsWith('ownerStaleLeaseRecovery.test.ts')));
});
