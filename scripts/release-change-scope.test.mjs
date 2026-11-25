import test from 'node:test';
import assert from 'node:assert/strict';
import {requiresRuntimeChecks,runtimeScope} from './release-change-scope.mjs';
test('only narrative docs avoid runtime jobs; required gate still always runs',()=>{
 assert.equal(requiresRuntimeChecks(['docs/audit.md','research/note.txt','README.md']),false);
 for(const file of ['docs/migration.sql','docs/fixture.json','docs/test.mjs','AGENTS.md','.github/workflows/check.yml','lib/db/src/index.ts','package.json','unknown.bin'])assert.equal(requiresRuntimeChecks(['docs/a.md',file]),true,file);
 assert.equal(requiresRuntimeChecks([]),true);
});
test('unavailable history or malformed revisions fail closed into full CI',()=>{
 assert.equal(runtimeScope('', 'a'.repeat(40)),true);
 assert.equal(runtimeScope('--help','b'.repeat(40)),true);
 assert.equal(runtimeScope('0'.repeat(40),'a'.repeat(40)),true);
});
