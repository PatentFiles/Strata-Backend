import test from "node:test";
import assert from "node:assert/strict";
import {legacyFeeHasCurrentOfficialCapture,EXPECTED_OFFICIAL_KALSHI_FEE_URL} from "./legacyOfficialFeeCaptureGate";
const now=Date.parse("2026-10-16T22:00:00.000Z");
const sha="a".repeat(64);
const capture=()=>({
  canonical_url:EXPECTED_OFFICIAL_KALSHI_FEE_URL,
  content_sha256:sha,
  storage_path:"official/kalshi.pdf",
  byte_length:281129,
  captured_at:"2026-10-16T21:00:00.000Z",
  expires_at:"2026-10-17T21:00:00.000Z",
});
test("exact nonexpired official provider capture corroborates legacy flag, without granting an approval",()=>{
 assert.equal(legacyFeeHasCurrentOfficialCapture(true,sha,[capture()],now),true);
});
test("zero official captures blocks legacy fee verification even when legacy flag and digest exist",()=>{
 assert.equal(legacyFeeHasCurrentOfficialCapture(true,sha,[],now),false);
});
test("wrong digest, source, expiry, malformed date, duplicate rows, missing bytes fail closed",()=>{
 const variants=[
  {...capture(),content_sha256:"b".repeat(64)},
  {...capture(),canonical_url:"https://operator.example/uploaded.pdf"},
  {...capture(),expires_at:"2026-10-16T20:00:00Z"},
  {...capture(),captured_at:"n/a"},
  {...capture(),captured_at:"2026-10-17T02:00:00Z"},
  {...capture(),byte_length:0},
  {...capture(),storage_path:""},
 ];
 for(const c of variants)assert.equal(legacyFeeHasCurrentOfficialCapture(true,sha,[c],now),false);
 for(const rows of [null,undefined,[capture(),capture()], [{}], "untrusted"])
  assert.equal(legacyFeeHasCurrentOfficialCapture(true,sha,rows,now),false);
 assert.equal(legacyFeeHasCurrentOfficialCapture(false,sha,[capture()],now),false);
 assert.equal(legacyFeeHasCurrentOfficialCapture(true,"malformed",[capture()],now),false);
 assert.equal(legacyFeeHasCurrentOfficialCapture(true,sha,[capture()],Number.NaN),false);
});
