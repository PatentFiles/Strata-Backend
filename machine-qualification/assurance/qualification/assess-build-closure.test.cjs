'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {assessBuildClosure}=require('./assess-build-closure.cjs');
const run=imports=>assessBuildClosure(Buffer.from(JSON.stringify({outputs:{'dist/index.mjs':{bytes:10,imports}}})));
test('captures imported externals, excludes Node builtins',()=>{const r=run([{path:'pg-native',external:true,kind:'require-call'},{path:'node:fs',external:true,kind:'import-statement'},{path:'fs',external:true,kind:'require-call'}]);assert.deepEqual(r.externalImports,['pg-native']);assert.equal(r.loadedBytesVerified,false);});
test('does not claim closure even with zero external imports',()=>{const r=run([]);assert.equal(r.completeRuntimeClosure,false);assert.equal(r.evidenceIssued,false);});
test('flags nonexternal output not present in exact metafile',()=>assert.deepEqual(run([{path:'worker.mjs',kind:'import-statement'}]).unresolvedOutputImports,['worker.mjs']));
test('bounded malformed inputs fail',()=>{for(const b of [Buffer.from('{}'),Buffer.from('{'),Buffer.alloc(4194305)])assert.equal(assessBuildClosure(b).ok,false);});
test('rejects malformed output shape',()=>assert.equal(assessBuildClosure(Buffer.from(JSON.stringify({outputs:{a:{bytes:1}}}))).ok,false));
