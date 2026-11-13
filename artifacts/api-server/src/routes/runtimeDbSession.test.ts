import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import express from "express";
import {generateKeyPair, exportJWK, createLocalJWKSet, SignJWT} from "jose";
import {pool} from "@workspace/db";
import {createStrataAccess, verifySupabaseAccessToken} from "../lib/strata/supabaseAuth";
import {createUserExecutionRouter, closedUserScopePort} from "./userExecutionRouter";
import {SESSION_RELATIONS} from "../lib/strata/apiFeeRuntimeDbSession";

test("session route requires verified AAL2 and confirmed ADMIN, uses trusted subject and no-store", async () => {
  const actor = "22222222-2222-4222-8222-222222222222";
  const pair = await generateKeyPair("RS256");
  const jwk = await exportJWK(pair.publicKey);
  const keys = createLocalJWKSet({keys: [{...jwk, alg: "RS256", use: "sig"}]});
  const sign = (aal: string) => new SignJWT({aal}).setProtectedHeader({alg: "RS256"}).setSubject(actor)
    .setIssuer("https://example.supabase.co/auth/v1").setAudience("authenticated").setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
  const queries: Array<{text: string; values?: unknown[]}> = [];
  let allowed = false;
  let connects = 0;
  const original = pool.connect;
  pool.connect = (async () => {
    connects++;
    return {query: async (q: {text: string; values?: unknown[]}) => {
      queries.push(q);
      if (q.values) return {rows: [{is_admin: allowed}]};
      return {rows: [{current_role: "postgres", session_role: "postgres", search_path: "public", replication_role: "origin",
        row_security: "on", superuser: true, bypass_rls: true, schema_usage: true,
        ...Object.fromEntries(SESSION_RELATIONS.flatMap((_, i) => ["exists", "select", "insert", "update"].map(p => [`relation_${i}_${p}`, true])))}]};
    }, release() {}};
  }) as typeof pool.connect;
  const access = createStrataAccess({verifyToken: token => verifySupabaseAccessToken(token, {supabaseUrl: "https://example.supabase.co", keys}), roleOf: async () => "ADMIN"});
  const app = express();
  app.use("/me", createUserExecutionRouter(access.requireUser, closedUserScopePort()));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/me/fees/runtime-db-session-attestation?actorId=foreign`;
  try {
    for (const token of [undefined, "invalid", await sign("aal1")]) {
      const response = await fetch(url, {headers: token ? {authorization: `Bearer ${token}`} : {}});
      assert.equal(response.status, 401);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
    assert.equal(connects, 0);
    const token = await sign("aal2");
    const denied = await fetch(url, {headers: {authorization: `Bearer ${token}`}});
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0]?.values, [actor]);
    allowed = true;
    const response = await fetch(url, {headers: {authorization: `Bearer ${token}`}});
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.privateSchemaUsable, true);
    assert.ok(Array.isArray(body.tablePrivileges));
    assert.equal(body.tablePrivileges.length, 8);
    assert.equal(body.tradingAuthorized, false);
    assert.equal(body.accountFingerprint, undefined);
  } finally {
    pool.connect = original;
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});
