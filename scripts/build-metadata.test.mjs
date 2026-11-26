import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureBuildMetadata} from './build-metadata.mjs';
test('source identity normalizes line endings but detects source and path changes',()=>{
 const root=mkdtempSync(join(tmpdir(),'strata-build-proof-'));
 try{mkdirSync(join(root,'src'));writeFileSync(join(root,'src/a.ts'),'const x=1;\r\n');
  const a=captureBuildMetadata(root,['src'],{});writeFileSync(join(root,'src/a.ts'),'const x=1;\n');
  assert.equal(captureBuildMetadata(root,['src'],{}).sourceSha256,a.sourceSha256);
  writeFileSync(join(root,'src/a.ts'),'const x=2;\n');assert.notEqual(captureBuildMetadata(root,['src'],{}).sourceSha256,a.sourceSha256);
  assert.equal(a.revision,null);assert.equal(a.tree,null);assert.equal(a.dirty,null);assert.equal(a.executionAuthority,'NONE');
  const provider=captureBuildMetadata(root,['src'],{RAILWAY_GIT_COMMIT_SHA:'a'.repeat(40)});
  assert.equal(provider.revision,'a'.repeat(40));assert.equal(provider.provenance,'provider-commit-at-build');assert.equal(provider.dirty,null);
  assert.equal(captureBuildMetadata(root,['src'],{GITHUB_SHA:'not-a-sha'}).revision,null);
  assert.throws(()=>captureBuildMetadata(root,['../'],{}),/build_source_outside_root/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
