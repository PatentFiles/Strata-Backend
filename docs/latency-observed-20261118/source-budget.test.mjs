import test from 'node:test';
import assert from 'node:assert/strict';
// Read-only production evidence, application clocks (not delayed log ingestion).
const trace=Object.freeze({source:Date.parse('2026-11-18T13:45:35.953Z'),providerAge:1537,commit:Date.parse('2026-11-18T13:45:36.591Z'),dispatch:Date.parse('2026-11-18T13:45:39.063Z'),rejected:Date.parse('2026-11-18T13:45:40.728Z'),limit:5000});
test('original source has only 3463ms local processing budget',()=>{assert.equal(trace.limit-trace.providerAge,3463);assert.equal(trace.commit-trace.source,638);});
test('dispatch marker is not a posted order and leaves 353ms effective freshness',()=>{assert.equal(trace.limit-trace.providerAge-(trace.dispatch-trace.source),353);});
test('actual final guard expiry is sufficient without assuming changed source',()=>{const effective=trace.providerAge+trace.rejected-trace.source;assert.equal(effective,6312);assert.ok(effective>trace.limit);});
test('small proposed savings cannot establish resolution',()=>{for(const saved of [90,253,316,343,406])assert.ok(trace.providerAge+trace.rejected-trace.source-saved>trace.limit);});
