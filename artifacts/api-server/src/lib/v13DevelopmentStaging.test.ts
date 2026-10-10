import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { isV13DevelopmentStaged, v13DevelopmentStagingMiddleware } from "./v13DevelopmentStaging";

test("only reviewed development revision releases staging; it never defines production authority", () => {
  assert.equal(isV13DevelopmentStaged("development", "missing"), true);
  assert.equal(isV13DevelopmentStaged("development", "v13-first-observed-cross-v1"), true);
  assert.equal(isV13DevelopmentStaged("development", V13_ENTRY_POLICY_VERSION), false);
  assert.equal(isV13DevelopmentStaged("production", "missing"), false);
  assert.equal(isV13DevelopmentStaged("test", "missing"), false);
});
function invoke(method: string, path: string) {
  let status = 0, body: unknown, next = 0;
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: (k: string, v: unknown) => { headers[k] = v; },
    status: (s: number) => { status = s; return res; },
    json: (b: unknown) => { body = b; return res; },
  };
  v13DevelopmentStagingMiddleware({ method, path } as Request, res as unknown as Response, () => { next++; });
  return { status, body, next, headers };
}
test("staged health is explicit and cannot reach authentication or application handlers", () => {
  const oldEnv = process.env.NODE_ENV, oldReview = process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
  try {
    process.env.NODE_ENV = "development"; delete process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
    const r = invoke("GET", "/api/healthz");
    assert.equal(r.status, 200); assert.equal(r.next, 0);
    assert.equal((r.body as { readyForLive: boolean }).readyForLive, false);
    assert.equal((r.body as { paperWorkerEnabled: boolean }).paperWorkerEnabled, false);
    for (const [method, path] of [["GET", "/api/kalshi/markets/open"], ["POST", "/api/micro-live/arm"],
      ["GET", "/api/__clerk/v1/client"], ["POST", "/api/admin/index2-pair-commissioning"],
      ["GET", "/api/forward-test/status"], ["HEAD", "/api/healthz"]]) {
      const blocked = invoke(method!, path!);
      assert.equal(blocked.status, 503); assert.equal(blocked.next, 0);
      assert.equal(blocked.headers["Cache-Control"], "no-store");
    }
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldReview === undefined) delete process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
    else process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED = oldReview;
  }
});
test("production requests still traverse existing authority controls unchanged", () => {
  const prior = process.env.NODE_ENV;
  try { process.env.NODE_ENV = "production"; assert.equal(invoke("POST", "/api/micro-live/arm").next, 1); }
  finally { if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior; }
});
