/**
 * Legacy V13 commissioning evidence is NOT, by itself, proof that the
 * official Kalshi fee PDF was captured from the provider. The signed-in
 * owner's current fee authorization remains a separate mandatory gate.
 *
 * This predicate is necessary but not sufficient: only an exact, current,
 * provider-origin capture record may corroborate a legacy verified flag.
 * Never infer approval from an uploaded PDF or a successful diagnostic job.
 */
export const EXPECTED_OFFICIAL_KALSHI_FEE_URL =
  "https://kalshi.com/docs/kalshi-fee-schedule.pdf";
const SHA256=/^[0-9a-f]{64}$/;
type CaptureRow=Record<string,unknown>;
export function legacyFeeHasCurrentOfficialCapture(
  flag:unknown,digest:unknown,rows:unknown,nowMs:number,
):boolean{
  if(flag!==true || typeof digest!=="string" || !SHA256.test(digest) ||
     !Number.isSafeInteger(nowMs) || nowMs<=0 ||
     !Array.isArray(rows) || rows.length!==1)return false;
  const row:CaptureRow=rows[0];
  if(!row || typeof row!=="object" || Array.isArray(row) ||
     row.content_sha256!==digest ||
     row.canonical_url!==EXPECTED_OFFICIAL_KALSHI_FEE_URL ||
     typeof row.byte_length!=="number" || !Number.isSafeInteger(row.byte_length) || row.byte_length<1 ||
     typeof row.storage_path!=="string" || !row.storage_path ||
     !row.captured_at || !row.expires_at)return false;
  const start=Date.parse(String(row.captured_at));
  const expiry=Date.parse(String(row.expires_at));
  return Number.isFinite(start)&&Number.isFinite(expiry)&&
    start<=nowMs && expiry>nowMs && expiry>start;
}
