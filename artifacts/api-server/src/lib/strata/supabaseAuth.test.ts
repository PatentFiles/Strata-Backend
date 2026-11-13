import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifySupabaseAccessToken } from "./supabaseAuth";

test("Supabase access tokens require a present, valid expiry as well as signature and MFA", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "RS256", use: "sig" }] });
  const supabaseUrl = "https://auth-test.supabase.co";
  const verify = (value: string) => verifySupabaseAccessToken(value, { supabaseUrl, keys });
  const token = (claims: Record<string, unknown>) => new SignJWT({ aal: "aal2", ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("11111111-1111-4111-8111-111111111111")
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .sign(privateKey);

  await assert.rejects(verify(await token({})), /missing required "exp" claim/);
  await assert.rejects(verify(await token({ exp: "never" })), /"exp" claim must be a number/);
  await assert.rejects(verify(await token({ exp: Math.floor(Date.now() / 1000) - 60 })), /"exp" claim timestamp check failed/);
  await assert.rejects(verify(await token({ exp: Math.floor(Date.now() / 1000) + 600, aal: "aal1" })), /aal/);
  assert.equal((await verify(await token({ exp: Math.floor(Date.now() / 1000) + 600 }))).aal, "aal2");
});
