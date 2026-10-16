import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { pool } from "@workspace/db";
import { inspectOperatorFeeCandidate } from "./operatorFeeCandidateRead";
import { probeCurrentKalshiFeeApi } from "./twoSourceFeeEvidence";
import { verifyOfficialFeePdfBytes } from "../microLiveFeeArtifact";

/**
 * Read-only cross-source inspection. An operator-attested candidate remains
 * non-authoritative for policy approval, commissioning and live execution.
 * Use this to explain which independent sources pass without retrying PDF HTTP429.
 */
export async function inspectCommissioningFeeEvidence(): Promise<{
  ok: boolean; reason: string; digest: string | null;
  operatorAttested: boolean; uploadedPdfBytesVerified: boolean;
  liveMarketFeesVerified: boolean; candidateExpiresAt: string | null;
  pdfProviderVerified: false; policyApproved: false;
  commissioningApproved: false; tradingAuthorized: false;
}> {
  const result = { ok: false, reason: "evidence_unavailable",
    digest: null as string | null, operatorAttested: false,
    uploadedPdfBytesVerified: false, liveMarketFeesVerified: false,
    candidateExpiresAt: null as string | null,
    pdfProviderVerified: false as const, policyApproved: false as const,
    commissioningApproved: false as const, tradingAuthorized: false as const };
  try {
    const candidate = await inspectOperatorFeeCandidate();
    if (!candidate.ok) return { ...result, reason: candidate.reason };
    result.candidateExpiresAt = candidate.expiresAt ?? null;
    const origin = process.env.SUPABASE_URL;
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!origin || !secret || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(origin))
      return { ...result, reason: "private_storage_credentials_unavailable" };
    const url = origin.replace(/\/$/, "") +
      "/storage/v1/object/authenticated/strata-official-fee-artifacts/operator-pending/kalshi-fee-schedule.pdf";
    const response = await fetch(url, {
      method: "GET", redirect: "error", cache: "no-store",
      headers: { Authorization: "Bearer " + secret, apikey: secret },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.url !== url ||
      response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/pdf")
      return { ...result, reason: "reviewed_private_pdf_unavailable" };
    const declared = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(declared) || declared !== 281129)
      return { ...result, reason: "reviewed_pdf_size_mismatch" };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== 281129 ||
      createHash("sha256").update(bytes).digest("hex") !==
        "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601")
      return { ...result, reason: "reviewed_pdf_digest_mismatch" };
    const reviewed = await verifyOfficialFeePdfBytes(bytes);
    if (!reviewed.ok) return { ...result, reason: "reviewed_pdf_formula_unverified" };
    result.uploadedPdfBytesVerified = true;
    result.digest = reviewed.digest;
    // Recheck release expiry after download and before API probe; no approval is made.
    if (! (await inspectOperatorFeeCandidate()).ok)
      return { ...result, reason: "candidate_expired_during_verification" };
    const market = await probeCurrentKalshiFeeApi();
    result.liveMarketFeesVerified = market.ok;
    result.operatorAttested = market.ok;
    return { ...result, ok: market.ok,
      reason: market.ok ? "operator_attested_fee_evidence_diagnostic_only" :
        "live_kalshi_market_fee_unverified" };
  } catch {
    return { ...result, reason: "cross_source_fee_evidence_unavailable" };
  }
}
