import assert from "node:assert/strict";
import test from "node:test";
import { aggregateForwardTestStatistics } from "./forwardTestRepository";
import { createSingleFlightAnalyticsCache } from "./readOnlyAnalyticsCache";
import { controls, forwardTestEvaluationTable, forwardTestWindowTable, forwardTestPositionTable } from "./readOnlyAnalyticsBatch.testDb";
const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
const resultRows = [[{ total: 73, triggers: 13, scout: 8, confirm: 5 }], [{ value: 17 }], [{ wins: 2, losses: 3, open: 1, completed: 5, pnl: -2.75 }]];
const expected = { wins: 2, losses: 3, evaluationCount: 73, windowsObserved: 17, triggerCount: 13, scoutTriggers: 8, confirmTriggers: 5, openPaperPositionCount: 1, completedPaperForwardTests: 5, cumulativePaperPnl: -2.75 };
async function rejectIs(p:Promise<unknown>,error:unknown){await p.then(()=>assert.fail("expected rejection"),actual=>assert.equal(actual,error));}

for (let failed = 0; failed < 3; failed++) {
  test(`actual repository + unchanged cache: sibling ${failed} failure cannot launch overlapping batches`, async () => {
    controls.reset();
    const read = createSingleFlightAnalyticsCache(() => aggregateForwardTestStatistics(`failure-${failed}`), 60_000);
    const first = read(); await flush();
    assert.equal(controls.jobs.length,3); assert.equal(controls.active,3);
    const error = new Error(`query-${failed}`);
    controls.jobs[failed].reject(error); await rejectIs(first,error);
    for(let i=0;i<30;i++) await rejectIs(read(),error);
    assert.equal(controls.jobs.length,3); assert.equal(controls.active,2);
    const siblings=[0,1,2].filter(i=>i!==failed);
    controls.jobs[siblings[0]].resolve(resultRows[siblings[0]]); await flush();
    await rejectIs(read(),error); assert.equal(controls.jobs.length,3);
    controls.jobs[siblings[1]].reject(new Error("later error")); await flush();
    const retry=read(); await flush(); assert.equal(controls.jobs.length,6);
    controls.jobs.slice(3).forEach((job,i)=>job.resolve(resultRows[i]));
    assert.deepEqual(await retry,expected); assert.equal(controls.maxActive,3);
    assert.deepEqual(controls.jobs.map(j=>j.thenCalls),[1,1,1,1,1,1]);
    assert.deepEqual(await read(),expected); assert.equal(controls.jobs.length,6);
  });
}

test("actual aggregate leaves projection, filter and direct fresh reads intact", async () => {
  controls.reset();
  const unscoped=aggregateForwardTestStatistics(); await flush();
  assert.deepEqual(controls.jobs.map(j=>j.table),[forwardTestEvaluationTable,forwardTestWindowTable,forwardTestPositionTable]);
  assert.deepEqual(controls.jobs.map(j=>Object.keys(j.fields)),[["total","triggers","scout","confirm"],["value"],["wins","losses","open","completed","pnl"]]);
  assert.equal(controls.jobs[2].where,undefined);
  controls.jobs.forEach((job,i)=>job.resolve(resultRows[i])); assert.deepEqual(await unscoped,expected); await flush();
  const fresh=aggregateForwardTestStatistics(); await flush(); assert.equal(controls.jobs.length,6);
  controls.jobs.slice(3).forEach((job,i)=>job.resolve(resultRows[i])); assert.deepEqual(await fresh,expected); await flush();
  const scoped=aggregateForwardTestStatistics("paper"); await flush(); assert.notEqual(controls.jobs[8].where,undefined);
  controls.jobs.slice(6).forEach((job,i)=>job.resolve(resultRows[i])); assert.deepEqual(await scoped,expected);
});

for(let failed=0;failed<3;failed++) {
  test(`actual aggregate handles synchronous construction failure at ${failed} without retry overlap`,async()=>{
    controls.reset(); const error = new Error("sync query builder"); controls.synchronousFailure={index:failed,error};
    const first=aggregateForwardTestStatistics(`sync-${failed}`); await rejectIs(first,error); await flush();
    assert.equal(controls.jobs.length,2); assert.equal(controls.active,2);
    await rejectIs(aggregateForwardTestStatistics(`sync-${failed}`),error); assert.equal(controls.jobs.length,2);
    controls.jobs.forEach(job=>job.reject(new Error("settle late work"))); await flush();
    const retry=aggregateForwardTestStatistics(`sync-${failed}`); await flush(); assert.equal(controls.jobs.length,5);
    controls.jobs.slice(2).forEach((job,i)=>job.resolve(resultRows[i])); assert.deepEqual(await retry,expected);
  });
}

test("distinct engine keys intentionally do not coalesce shared global scans",async()=>{
  controls.reset(); const a=aggregateForwardTestStatistics("a"), b=aggregateForwardTestStatistics("b"); await flush();
  assert.equal(controls.jobs.length,6); assert.equal(controls.maxActive,6);
  controls.jobs.forEach((job,i)=>job.resolve(resultRows[i%3])); assert.deepEqual(await a,expected); assert.deepEqual(await b,expected);
});
