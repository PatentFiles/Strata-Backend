const {test}=require('node:test'),assert=require('node:assert/strict');const {verifyQualificationCandidate}=require('./verify-artifact.cjs');const {fixture}=require('./offline-fixture.cjs');
async function run(mutate,opts){const f=fixture(mutate,opts);return verifyQualificationCandidate(f.config,f.policyBytes,f.archiveBytes,f.transport,f.now,f.clock)}
test('authenticated metadata plus exact archive bytes verify only candidate',async()=>{const r=await run();assert.equal(r.ok,true);assert.equal(r.deployedBytesVerified,false);assert.equal(r.evidenceIssued,false);assert.equal(r.tradingAuthorized,false)});
for(const [name,mut] of Object.entries({source:m=>m.source.commit='0'.repeat(40),tree:m=>m.source.tree='0'.repeat(40),policy:m=>m.policySha256='0'.repeat(64),selfauthority:m=>m.evidenceIssued=true,checks:m=>m.checks[0].argv=['fake'],inventory:m=>m.bundle[0].sha256='bad',path:m=>m.bundle[0].path='../escape',duplicate:m=>m.bundle.push(m.bundle[0]),manifesthash:m=>m.bundleManifestSha256='0'.repeat(64)}))test(name+' mismatch rejects',async()=>assert.equal((await run(mut)).ok,false));
test('archive hash mismatch rejects',async()=>assert.equal((await run(()=>{},{wrongDigest:true})).reason,'archive_digest_mismatch'));
test('archive path traversal rejects without extraction',async()=>assert.equal((await run(()=>{},{name:'../qualification-candidate.json'})).reason,'archive_invalid'));

// A trusted hash must not turn an empty/malformed plan into qualification.
for(const [name,change] of Object.entries({
 emptyChecks:p=>p.checks=[], emptyBuild:p=>p.build=[], emptyCommand:p=>p.checks=[[]],
 emptyArgument:p=>p.checks=[['']], nonStringArgument:p=>p.checks=[[null]],
 excessiveChecks:p=>p.checks=Array.from({length:21},()=>['test']),
 emptySources:p=>p.sourceInputs=[], duplicateSources:p=>p.sourceInputs=['lock','lock'],
 traversingSource:p=>p.sourceInputs=['../lock'], absoluteBundle:p=>p.buildDirectory='/dist',
 nullArgument:p=>p.build=['node','bad\0argument']
}))test('invalid pinned policy '+name+' rejects before external reads',async()=>{
 const f=fixture(),p=JSON.parse(f.policyBytes);change(p);const bytes=Buffer.from(JSON.stringify(p));let reads=0;
 const r=await verifyQualificationCandidate({...f.config,policySha256:require('../verify.cjs').sha256(bytes)},bytes,f.archiveBytes,async()=>{reads++;throw Error('must not read')},f.now,f.clock);
 assert.equal(r.reason,'qualification_policy_invalid');assert.equal(reads,0);assert.equal(r.evidenceIssued,false);
});
