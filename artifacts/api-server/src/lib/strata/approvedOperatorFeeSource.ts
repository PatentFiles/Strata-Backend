import { pool } from "@workspace/db";
import {
  STANDARD_QUADRATIC_FEE_FORMULA_VERSION, type FeeArtifactVerification,
} from "../microLiveFeeArtifact";
import { probeCurrentKalshiFeeApi, REVIEWED_REFERENCE_PDF_SHA256 } from "./twoSourceFeeEvidence";

export const ATTESTED_FEE_POLICY_VERSION = "operator-attested-kxbtc15m-v1";
const SOURCE_PREFIX = "strata-operator-attested://KXBTC15M/";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SOURCE_RE = new RegExp("^strata-operator-attested://KXBTC15M/("+UUID+")/sha256/([0-9a-f]{64})$");
const SHA = REVIEWED_REFERENCE_PDF_SHA256;

export function feeSourceForApprovedRelease(approvalId: string): string | null {
  if (!new RegExp("^"+UUID+"$","i").test(approvalId)) return null;
  return SOURCE_PREFIX + approvalId.toLowerCase() + "/sha256/" + SHA;
}
export function parseAttestedFeeSource(sourceUrl: string, policyVersion: string,
  formulaVersion: string): { approvalId: string; digest: string } | null {
  if (policyVersion !== ATTESTED_FEE_POLICY_VERSION ||
      formulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION) return null;
  const match = SOURCE_RE.exec(sourceUrl);
  if (!match || match[2] !== SHA) return null;
  return { approvalId: match[1]!, digest: match[2]! };
}
type Approval = { approvalId: string; expiresAt: string };
/** The release ledger is service-only and completely distinct from the official capture ledger. */
async function readAttestedApproval(approvalId: string): Promise<Approval | null> {
  try {
    const found = await pool.query(`
      SELECT a.approval_id, a.expires_at
      FROM public.strata_fee_operator_approved_releases a
      JOIN public.strata_fee_operator_release_candidates c ON c.release_id=a.candidate_id
      JOIN public.strata_fee_operator_source_reviews r1 ON r1.review_id=c.reviewer_1
      JOIN public.strata_fee_operator_source_reviews r2 ON r2.review_id=c.reviewer_2
      JOIN auth.users u1 ON u1.id=r1.reviewer_user_id
      JOIN auth.users u2 ON u2.id=r2.reviewer_user_id
      JOIN auth.users ua ON ua.id=a.released_by
      WHERE a.approval_id=$1::uuid
        AND a.revoked_at IS NULL AND a.expires_at>now()
        AND a.evidence_kind='operator_attested_fee_source_release'
        AND a.series_ticker='KXBTC15M' AND a.content_sha256=$2
        AND a.release_confirmation='AUTHORIZE_OPERATOR_ATTESTED_FEE_SOURCE_WITH_LIVE_API_GUARD'
        AND c.revoked_at IS NULL AND c.content_sha256=$2
        AND c.evidence_kind='operator_attested_commissioning_candidate'
        AND c.reviewer_1<>c.reviewer_2
        AND r1.content_sha256=$2 AND r2.content_sha256=$2
        AND r1.review_kind='human_canonical_source_claim'
        AND r2.review_kind='human_canonical_source_claim'
        AND u1.id<>u2.id
        AND u1.email_confirmed_at IS NOT NULL AND u2.email_confirmed_at IS NOT NULL
        AND ua.email_confirmed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM private.role_assignments ra
          WHERE lower(btrim(ra.email))=lower(btrim(u1.email)) AND ra.role='ADMIN')
        AND EXISTS (SELECT 1 FROM private.role_assignments ra
          WHERE lower(btrim(ra.email))=lower(btrim(u2.email)) AND ra.role='ADMIN')
        AND EXISTS (SELECT 1 FROM private.role_assignments ra
          WHERE lower(btrim(ra.email))=lower(btrim(ua.email)) AND ra.role='ADMIN')
      LIMIT 2`, [approvalId, SHA]);
    if (found.rows.length!==1) return null;
    const row=found.rows[0]!;
    return { approvalId: String(row.approval_id),
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() :
        String(row.expires_at) };
  } catch { return null; }
}
export async function activeOperatorFeeRelease(): Promise<Approval | null> {
  try {
    const found = await pool.query(`SELECT approval_id FROM public.strata_fee_operator_approved_releases
      WHERE revoked_at IS NULL AND expires_at>now() ORDER BY approved_at DESC LIMIT 2`);
    if (found.rows.length!==1) return null;
    return readAttestedApproval(String(found.rows[0]!.approval_id));
  } catch { return null; }
}
export type AttestedFeeResult =
  | { ok: true; digest: string; sourceUrl: string; approvalId: string; checkedAt: string;
      marketTicker: string }
  | { ok: false; reason: string };
/** Fresh market-specific official API evidence plus live signed release. No PDF provenance claim. */
export async function verifyAttestedFeeIdentity(
  sourceUrl: string, policyVersion: string, formulaVersion: string,
  expectedDigest: string, marketTicker?: string,
): Promise<AttestedFeeResult> {
  const parsed=parseAttestedFeeSource(sourceUrl,policyVersion,formulaVersion);
  if (!parsed || parsed.digest!==expectedDigest) return {ok:false,reason:"attested_fee_identity_invalid"};
  if (!await readAttestedApproval(parsed.approvalId))
    return {ok:false,reason:"attested_fee_release_inactive"};
  const live=await probeCurrentKalshiFeeApi();
  if (!live.ok || !live.marketTicker ||
      (marketTicker!==undefined && live.marketTicker!==marketTicker))
    return {ok:false,reason:"attested_live_market_fee_unverified"};
  if (!await readAttestedApproval(parsed.approvalId))
    return {ok:false,reason:"attested_fee_release_expired_or_revoked"};
  return {ok:true,digest:SHA,sourceUrl,approvalId:parsed.approvalId,
    checkedAt:new Date().toISOString(),marketTicker:live.marketTicker};
}
export async function verifyOperatorFeeArtifact(input: {
  digest: string; policyVersion: string; sourceUrl: string; formulaVersion: string;
}, marketTicker?: string): Promise<FeeArtifactVerification> {
  const outcome=await verifyAttestedFeeIdentity(input.sourceUrl,input.policyVersion,
    input.formulaVersion,input.digest,marketTicker);
  return {
    status: outcome.ok ? "verified" : "unavailable",
    valid: outcome.ok, sourceUrl: input.sourceUrl,
    digest: outcome.ok ? outcome.digest : null,
    formulaVersion: input.formulaVersion,
    verifiedAt: outcome.ok ? Date.parse(outcome.checkedAt) : null,
    reason: outcome.ok ? "operator_attested_not_provider_verified" : outcome.reason,
  };
}
