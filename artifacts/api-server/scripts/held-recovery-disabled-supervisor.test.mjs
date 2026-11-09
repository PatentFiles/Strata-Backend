import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/strata/personalExecutionSupervisor.ts',import.meta.url),'utf8');
const start=source.indexOf('    session.worker.recoverUnreconciledEntry=async error=>{');
const end=source.indexOf('    session.executor.afterReconcile=',start);
assert(start>=0&&end>start);
// Execute the actual installed callback, stripped of TypeScript only. Disabled
// execution must return before touching any authority, transport or state object.
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
for(const enabled of [undefined,'false','TRUE','1'])test(`supervisor recovery flag ${enabled??'absent'} cannot mutate, read or install held paths`,async()=>{
 const session={worker:{}};
 const forbidden=new Proxy({}, {get(){throw Error('disabled_callback_touched_dependency');},set(){throw Error('disabled_callback_mutated_dependency');}});
 const context={session,process:{env:{STRATA_UNKNOWN_ENTRY_PROTECTIVE_RECOVERY_ENABLED:enabled}},recoveryAttempted:false,
  state:forbidden,db:forbidden,technicalRelease:forbidden,now(){throw Error('disabled_callback_read_clock');},Error};
 runInNewContext(code,context);
 assert.equal(await session.worker.recoverUnreconciledEntry(new Error('personal_exchange_history_unreconciled')),false);
 assert.equal(context.recoveryAttempted,false);
 assert.deepEqual(Object.keys(session.worker),['recoverUnreconciledEntry']);
});
