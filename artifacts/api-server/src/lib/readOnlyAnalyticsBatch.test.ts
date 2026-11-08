import assert from "node:assert/strict";
import test from "node:test";
import { createSingleFlightAnalyticsBatch } from "./readOnlyAnalyticsBatch";
import { createSingleFlightAnalyticsCache } from "./readOnlyAnalyticsCache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const observe = <T>(promise: Promise<T>) => promise.then(
  value => ({ status: "fulfilled" as const, value }),
  reason => ({ status: "rejected" as const, reason }),
);
const rejectIs = async (promise: Promise<unknown>, expected: unknown) => {
  const outcome = await observe(promise);
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.equal(outcome.reason, expected);
};
const orders = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];

function batchFixture() {
  const jobs: Array<{ index: number; key: string | undefined; task: ReturnType<typeof deferred<number>> }> = [];
  let active = 0, maxActive = 0;
  const readers = [0, 1, 2].map(index => (key: string | undefined) => {
    const task = deferred<number>();
    active++; maxActive = Math.max(active, maxActive);
    const underlying = task.promise.then(
      value => { active--; return value; },
      error => { active--; throw error; },
    );
    jobs.push({ index, key, task });
    return underlying;
  });
  const read = createSingleFlightAnalyticsBatch(readers);
  return { read, jobs, active: () => active, maxActive: () => maxActive };
}

for (const order of orders) {
  test(`success preserves tuple order and coalesces through completion ${order}`, async () => {
    const f = batchFixture();
    const first = f.read("paper");
    for (let i = 0; i < 20; i++) assert.equal(f.read("paper"), first);
    await flush();
    assert.equal(f.jobs.length, 3);
    for (const index of order.slice(0, -1)) {
      f.jobs[index].task.resolve(index + 10);
      await flush();
      assert.equal(f.read("paper"), first);
      assert.equal(f.jobs.length, 3);
    }
    f.jobs[order[2]].task.resolve(order[2] + 10);
    assert.deepEqual(await first, [10,11,12]);
    await flush();
    const next = f.read("paper");
    assert.notEqual(next, first);
    await flush();
    assert.equal(f.jobs.length, 6);
    f.jobs.slice(3).forEach(job => job.task.resolve(job.index + 20));
    assert.deepEqual(await next, [20,21,22]);
    assert.equal(f.maxActive(), 3);
  });
}

for (let failedIndex = 0; failedIndex < 3; failedIndex++) {
  for (const reverse of [false, true]) {
    test(`failure ${failedIndex}, late sibling order reversed=${reverse}: prompt identity and no retry overlap`, async () => {
      const f = batchFixture();
      const first = f.read("paper");
      const outcomes = Array.from({ length: 30 }, () => observe(f.read("paper")));
      await flush();
      const error = { failedIndex, reason: "query rejected" };
      f.jobs[failedIndex].task.reject(error);
      await rejectIs(first, error); // Other queries are deliberately still pending.
      assert.equal(f.active(), 2);
      for (const outcome of await Promise.all(outcomes)) {
        assert.equal(outcome.status, "rejected");
        if (outcome.status === "rejected") assert.equal(outcome.reason, error);
      }
      const siblings = [0,1,2].filter(index => index !== failedIndex);
      if (reverse) siblings.reverse();
      for (let retry = 0; retry < 50; retry++) {
        assert.equal(f.read("paper"), first);
        await rejectIs(f.read("paper"), error);
      }
      assert.equal(f.jobs.length, 3);
      f.jobs[siblings[0]].task.reject(new Error("late sibling failure"));
      await flush();
      assert.equal(f.active(), 1);
      await rejectIs(f.read("paper"), error);
      assert.equal(f.jobs.length, 3);
      f.jobs[siblings[1]].task.resolve(9);
      await flush();
      const retry = f.read("paper");
      await flush();
      assert.equal(f.jobs.length, 6);
      f.jobs.slice(3).forEach(job => job.task.resolve(job.index));
      assert.deepEqual(await retry, [0,1,2]);
      assert.equal(f.active(), 0);
      assert.equal(f.maxActive(), 3);
    });
  }
}

for (let failedIndex = 0; failedIndex < 3; failedIndex++) {
  for (const failure of ["factory", "then-getter", "then-call"] as const) {
    test(`synchronous ${failure} failure at reader ${failedIndex} retains other started work`, async () => {
      const pending = deferred<number>();
      const error = new Error(`${failure}-${failedIndex}`);
      let starts = 0, assimilations = 0;
      const read = createSingleFlightAnalyticsBatch([0,1,2].map(index => () => {
        starts++;
        if (index !== failedIndex) return pending.promise;
        if (failure === "factory") throw error;
        if (failure === "then-getter") return Object.defineProperty({}, "then", { get() { throw error; } }) as PromiseLike<number>;
        return { then() { assimilations++; throw error; } } as PromiseLike<number>;
      }));
      let first!: Promise<number[]>;
      assert.doesNotThrow(() => { first = read("paper"); });
      await rejectIs(first, error);
      assert.equal(starts, 3);
      assert.equal(assimilations, failure === "then-call" ? 1 : 0);
      await rejectIs(read("paper"), error);
      assert.equal(starts, 3);
      pending.resolve(1);
      await flush();
      await rejectIs(read("paper"), error);
      assert.equal(starts, 6);
    });
  }
}

test("lazy thenables are assimilated once despite both result and drainage observers", async () => {
  const tasks = [deferred<number>(), deferred<number>(), deferred<number>()];
  const calls = [0,0,0];
  const read = createSingleFlightAnalyticsBatch(tasks.map((task, index) => () => ({
    then(onValue, onError) { calls[index]++; return task.promise.then(onValue, onError); },
  } as PromiseLike<number>)));
  const result = read();
  for (let i = 0; i < 50; i++) assert.equal(read(), result);
  await flush();
  assert.deepEqual(calls, [1,1,1]);
  tasks.forEach((task, index) => task.resolve(index));
  assert.deepEqual(await result, [0,1,2]);
  assert.deepEqual(calls, [1,1,1]);
});

test("thenable first settlement wins and rejection preserves undefined identity", async () => {
  let starts = 0;
  const read = createSingleFlightAnalyticsBatch([
    () => ({ then(resolve: (value: number) => void, reject: (reason: unknown) => void) {
      starts++; resolve(5); reject(new Error("ignored after resolve")); throw new Error("also ignored");
    } } as PromiseLike<number>),
    () => Promise.resolve("two"),
  ]);
  assert.deepEqual(await read(), [5,"two"]);
  assert.equal(starts, 1);
  const fail = createSingleFlightAnalyticsBatch([() => Promise.reject(undefined)]);
  await rejectIs(fail(), undefined);
  await flush();
  await rejectIs(fail(), undefined);
});

test("failure reason is first observed rejection, not first tuple index", async () => {
  const f = batchFixture();
  const result = f.read();
  await flush();
  const first = new Error("index 2 first"), second = new Error("index 0 later");
  f.jobs[2].task.reject(first);
  await rejectIs(result, first);
  f.jobs[0].task.reject(second);
  await rejectIs(f.read(), first);
  f.jobs[1].task.resolve(1);
  await flush();
});

test("caller timeout or cancellation does not drain or abort underlying shared reads", async () => {
  const f = batchFixture();
  const work = f.read("paper");
  const cancel = deferred<never>();
  const caller = Promise.race([work, cancel.promise]); // Only consumer races, never readers.
  const abort = new Error("caller gave up");
  cancel.reject(abort);
  await rejectIs(caller, abort);
  assert.equal(f.active(), 3);
  assert.equal(f.read("paper"), work);
  assert.equal(f.jobs.length, 3);
  f.jobs.forEach(job => job.task.resolve(job.index));
  assert.deepEqual(await work, [0,1,2]);
});

test("cancel request without actual query settlement holds key; confirmed settling cancellation permits retry", async () => {
  const f = batchFixture();
  const result = f.read("paper");
  await flush();
  const failure = new Error("first read failed");
  f.jobs[0].task.reject(failure);
  await rejectIs(result, failure);
  const controller = new AbortController();
  controller.abort(); // Represents cancellation request that does not settle raw work.
  for (let i = 0; i < 20; i++) await rejectIs(f.read("paper"), failure);
  assert.equal(f.active(), 2);
  assert.equal(f.jobs.length, 3);
  f.jobs[1].task.reject(controller.signal.reason); // Query callback confirms completion.
  await flush();
  assert.equal(f.active(), 1);
  assert.equal(f.read("paper"), result);
  f.jobs[2].task.reject(controller.signal.reason);
  await flush();
  const retry = f.read("paper");
  await flush();
  assert.equal(f.jobs.length, 6);
  f.jobs.slice(3).forEach(job => job.task.resolve(job.index));
  assert.deepEqual(await retry, [0,1,2]);
});

test("a never-settled query holds a failed key without a timeout bypass", async () => {
  const f = batchFixture();
  const result = f.read("paper");
  await flush();
  const error = new Error("database unavailable");
  f.jobs[0].task.reject(error); f.jobs[1].task.resolve(1);
  await rejectIs(result, error);
  for (let i = 0; i < 100; i++) await rejectIs(f.read("paper"), error);
  assert.equal(f.jobs.length, 3);
  assert.equal(f.active(), 1); // Deliberately never resolve the final bare Promise.
});

test("keys remain isolated, including unscoped undefined and the string 'undefined'", async () => {
  const f = batchFixture();
  const keys = [undefined, "undefined", "", "__proto__", "paper"];
  const results = keys.map(key => f.read(key));
  await flush();
  assert.equal(f.jobs.length, 15);
  keys.forEach((key, index) => assert.equal(f.read(key), results[index]));
  f.jobs.forEach((job, index) => job.task.resolve(index));
  assert.deepEqual(await Promise.all(results), [[0,1,2],[3,4,5],[6,7,8],[9,10,11],[12,13,14]]);
});

test("empty batch can succeed, release and be retried without retained values", async () => {
  const read = createSingleFlightAnalyticsBatch([] as const);
  const first = read();
  assert.deepEqual(await first, []);
  await flush();
  assert.notEqual(read(), first);
});

test("unchanged cache TTL begins at successful completion, expires exactly, and never serves stale on failure", async () => {
  const f = batchFixture();
  let now = 1_000;
  const read = createSingleFlightAnalyticsCache(() => f.read("paper"), 60_000, () => now);
  const first = read();
  await flush();
  now = 20_000;
  f.jobs.forEach(job => job.task.resolve(job.index + 1));
  assert.deepEqual(await first, [1,2,3]);
  now = 79_999;
  assert.deepEqual(await read(), [1,2,3]);
  assert.equal(f.jobs.length, 3);
  now = 80_000;
  const refresh = read();
  await flush();
  assert.equal(f.jobs.length, 6);
  const error = new Error("refresh failed");
  f.jobs[4].task.reject(error);
  await rejectIs(refresh, error);
  now = 1_000_000; // Neither expired success nor elapsed time releases draining work.
  for (let i = 0; i < 50; i++) await rejectIs(read(), error);
  assert.equal(f.jobs.length, 6);
  f.jobs[3].task.resolve(10); f.jobs[5].task.reject(new Error("late failure"));
  await flush();
  const retry = read();
  await flush();
  f.jobs.slice(6).forEach(job => job.task.resolve(job.index + 11));
  assert.deepEqual(await retry, [11,12,13]);
  now = 1_059_999;
  assert.deepEqual(await read(), [11,12,13]);
  assert.equal(f.jobs.length, 9);
  now = 1_060_000;
  const again = read();
  await flush();
  assert.equal(f.jobs.length, 12);
  f.jobs.slice(9).forEach(job => job.task.resolve(job.index + 21));
  assert.deepEqual(await again, [21,22,23]);
  assert.equal(f.maxActive(), 3);
});

test("contract boundary: a raced reader is not proof that physical work has stopped", async () => {
  let starts = 0, physicalActive = 0;
  const operations: Array<ReturnType<typeof deferred<number>>> = [];
  const timeouts: Array<ReturnType<typeof deferred<never>>> = [];
  const unsafeRead = createSingleFlightAnalyticsBatch([() => {
    starts++; physicalActive++;
    const operation = deferred<number>(), timeout = deferred<never>();
    operations.push(operation); timeouts.push(timeout);
    const physical = operation.promise.then(value => { physicalActive--; return value; });
    // Deliberate contract violation, not used by the repository implementation.
    return Promise.race([physical, timeout.promise]);
  }]);
  const first = unsafeRead("paper"); await flush();
  const error = new Error("client-only timeout"); timeouts[0].reject(error);
  await rejectIs(first, error); await flush();
  assert.equal(physicalActive, 1);
  const retry = unsafeRead("paper"); await flush();
  assert.equal(starts, 2); assert.equal(physicalActive, 2);
  operations[0].resolve(1); operations[1].resolve(2);
  assert.deepEqual(await retry, [2]);
  assert.equal(physicalActive, 0);
});
