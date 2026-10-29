import test from "node:test";
import assert from "node:assert/strict";
import { configuredPoolMax } from "./poolSizing";

test("pool size preserves existing default absent an operator override", () => {
  assert.equal(configuredPoolMax(undefined), 10);
});

test("pool size accepts only a bounded integer", () => {
  assert.equal(configuredPoolMax("4"), 4);
  assert.equal(configuredPoolMax("2"), 2);
  assert.equal(configuredPoolMax("10"), 10);
  for (const invalid of ["0","1","11","50","4.5","Infinity","-1","NaN"," 4 ",""]) {
    assert.equal(configuredPoolMax(invalid), 10);
  }
});
