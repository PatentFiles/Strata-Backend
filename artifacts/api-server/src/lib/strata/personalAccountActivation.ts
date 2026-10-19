import { createHash, randomUUID } from "node:crypto";
import { V13_CHAMPION_PARAMETER_HASH, V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { getScopedKalshiJson } from "../kalshiAccountClient";
import {
  CANONICAL_FEE_SCHEDULE_URL,
  establishOfficialFeeDigest,
  STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  STANDING_FEE_POLICY_VERSION,
  verifyCurrentFeeArtifact,
} from "../microLiveFeeArtifact";
import { persistOwnedCashReconciliation, RECORD_OWNED_CASH_CONFIRMATION } from "./personalCashReconciliation";
import {
  authorizeOwnedPolicy,
  persistOwnedPolicyApproval,
  APPROVE_OWNED_POLICY_CONFIRMATION,
  type OwnedPolicyChampionEvidence,
  type OwnedPolicyFeeEvidence,
  type OwnedPolicyLimits,
} from "./personalPolicyApproval";
import { PERSONAL_KALSHI_HOST, scopeEcho } from "./personalExchangeRead";
import { REVIEWED_RELEASE } from "./reviewedRelease";
import { digest } from "../v13-production/types";
import { verifyOwnerFeeSourceStage, parseOwnerFeeSource } from "./ownerFeeSourceStage";
import { OPERATOR_FEE_SOURCE_POLICY } from "./operatorFeeSourceAuthorization";
import { verifyReviewedApiFeeSourceStage, parseReviewedApiSource, API_SOURCE_POLICY_VERSION, API_SOURCE_FORMULA_VERSION } from "./apiFeeSourceStage";
import { PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 } from "./apiFeeRateReference";
import { verifyMonetaryFeeContract } from "./monetaryFeeContract";

export const COMMISSION_OWNED_ACCOUNT_CONFIRMATION = "COMMISSION_OWNED_STRATA_ACCOUNT";
export const REQUEST_OWNED_ACTIVATION_CONFIRMATION = "REQUEST_OWNED_ACCOUNT_ACTIVATION";
export const ENABLE_OWNED_EXECUTION_CONFIRMATION = "ENABLE_OWNED_ACCOUNT_EXECUTION";
export const ENABLE_SHARED_LIVE_CONFIRMATION = "ENABLE_SHARED_LIVE_INFRASTRUCTURE";

type Queryable = {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};
type Transactional = Queryable & {
  connect?: () => Promise<Queryable & { release(): void }>;
};

const READINESS_SQL = `
  -- personal-activation:readiness
  SELECT a.id, a.commissioned, a.execution_enabled, a.kill_switch,
         a.cash_precision_verified, a.cash_micros::text AS cash_micros,
         a.reconciled_at,
         (SELECT MAX(proof_at) FROM (
           SELECT t.completed_at AS proof_at FROM private.kalshi_owner_pilot_transfers t
             WHERE t.execution_account_id=a.id AND t.owner_user_id=a.owner_user_id
               AND t.state='completed' AND t.bot_after_cents >= 2500
           UNION ALL
           SELECT h.verified_at AS proof_at FROM private.kalshi_owner_historical_funding h
             WHERE h.execution_account_id=a.id AND h.owner_user_id=a.owner_user_id
               AND h.bot_after_cents=2500 AND h.primary_after_cents=0
         ) verified) AS verified_funding_at,
         a.fee_artifact_digest, a.subaccount, a.exchange_index,
         a.key_fingerprint, a.policy_id,
         p.state AS policy_state, p.fee_policy_version, p.fee_source_url, p.fee_formula_version,
         stake.configured_stake_cents,
         a.minimum_exit_micros,
         a.commissioning_digest,
         c.key_fingerprint AS credential_fingerprint,
         (SELECT count(*) FROM v13_production_observation o
           WHERE o.account_id = a.id AND o.kind = 'OWNER_ACTIVATION_REQUEST') AS activation_requests
  FROM v13_production_account a
  LEFT JOIN v13_live_money_policy p
    ON p.id = a.policy_id AND p.execution_account_id = a.id AND p.created_by = a.owner_user_id::text
  LEFT JOIN strata_configured_stake stake ON stake.execution_account_id = a.id
  LEFT JOIN private.kalshi_connection_credentials c
    ON c.owner_user_id = a.owner_user_id
   AND c.financial_account_id = a.kalshi_connection_id
   AND c.key_fingerprint = a.key_fingerprint
   AND c.role = 'restricted_execution'
   AND c.revoked_at IS NULL
   AND c.verified_at IS NOT NULL
   AND c.verification_reason = 'credential_verified'
  WHERE a.owner_user_id = $1::uuid AND a.owner_user_id IS NOT NULL
`;

const COMMISSION_SQL = `
  -- personal-activation:commission
  UPDATE v13_production_account
  SET commissioned = true,
      commissioning_digest = $3,
      fee_artifact_digest = $4,
      minimum_exit_micros = $5
  WHERE id = $1
    AND owner_user_id = $2::uuid
    AND owner_user_id IS NOT NULL
    AND subaccount = 1
    AND exchange_index = 2
    AND execution_enabled = false
    AND kill_switch = true
    AND cash_precision_verified = true
    AND cash_micros >= 25000000
    AND reconciled_at IS NOT NULL
    -- Authenticated Kalshi cash proof must be newly observed at commissioning,
    -- not a years-old reconciliation that merely postdates a funding receipt.
    AND reconciled_at BETWEEN now() - interval '15 minutes'
                          AND now() + interval '10 seconds'
    AND (
      EXISTS (
        SELECT 1 FROM private.kalshi_owner_pilot_transfers t
        WHERE t.execution_account_id = v13_production_account.id
          AND t.owner_user_id = v13_production_account.owner_user_id
          AND t.state='completed' AND t.bot_after_cents >= 2500
          AND v13_production_account.reconciled_at >= t.completed_at
      )
      OR EXISTS (
        SELECT 1 FROM private.kalshi_owner_historical_funding h
        WHERE h.execution_account_id = v13_production_account.id
          AND h.owner_user_id = v13_production_account.owner_user_id
          AND h.primary_after_cents=0 AND h.bot_after_cents=2500
          AND v13_production_account.reconciled_at >= h.verified_at
      )
    )
    AND policy_id IS NOT NULL
    AND (fee_artifact_digest IS NULL OR fee_artifact_digest = $4)
    AND (commissioned = false OR commissioning_digest = $3)
    AND $5::integer BETWEEN 1 AND 999999
    AND ($6::uuid IS NULL OR EXISTS (
      SELECT 1 FROM private.strata_fee_source_grants g
      JOIN private.strata_fee_source_owner_consents c
        ON c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id
      JOIN public.strata_fee_operator_release_candidates r
        ON r.release_id=g.release_id
      JOIN v13_live_money_policy p ON p.id=v13_production_account.policy_id
      WHERE g.grant_id=$6::uuid AND g.owner_user_id=$2::uuid
        AND g.revoked_at IS NULL AND g.expires_at>now()
        AND c.revoked_at IS NULL AND c.confirmation='CONFIRM_OPERATOR_FEE_SOURCE_ONLY'
        AND r.revoked_at IS NULL AND r.expires_at>now()
        AND r.content_sha256=g.reviewed_pdf_sha256 AND c.release_id=g.release_id
        AND g.authorized_stages @> ARRAY['STEP_11']::text[]
        AND p.state='APPROVED' AND p.fee_policy_version=g.policy_version
        AND p.fee_source_url='strata-operator-attested://kxbtc15m/' ||
          g.grant_id::text || '/' || g.release_id::text
    ))
  RETURNING id
`;

const COMMISSION_API_SQL = `
  -- personal-activation:commission
  UPDATE v13_production_account
  SET commissioned = true,
      commissioning_digest = $3,
      fee_artifact_digest = $4,
      minimum_exit_micros = $5
  WHERE id = $1
    AND owner_user_id = $2::uuid
    AND owner_user_id IS NOT NULL
    AND subaccount = 1
    AND exchange_index = 2
    AND execution_enabled = false
    AND kill_switch = true
    AND cash_precision_verified = true
    AND cash_micros >= 25000000
    AND reconciled_at IS NOT NULL
    -- Authenticated Kalshi cash proof must be newly observed at commissioning,
    -- not a years-old reconciliation that merely postdates a funding receipt.
    AND reconciled_at BETWEEN now() - interval '15 minutes'
                          AND now() + interval '10 seconds'
    AND (
      EXISTS (
        SELECT 1 FROM private.kalshi_owner_pilot_transfers t
        WHERE t.execution_account_id = v13_production_account.id
          AND t.owner_user_id = v13_production_account.owner_user_id
          AND t.state='completed' AND t.bot_after_cents >= 2500
          AND v13_production_account.reconciled_at >= t.completed_at
      )
      OR EXISTS (
        SELECT 1 FROM private.kalshi_owner_historical_funding h
        WHERE h.execution_account_id = v13_production_account.id
          AND h.owner_user_id = v13_production_account.owner_user_id
          AND h.primary_after_cents=0 AND h.bot_after_cents=2500
          AND v13_production_account.reconciled_at >= h.verified_at
      )
    )
    AND policy_id IS NOT NULL
    AND (fee_artifact_digest IS NULL OR fee_artifact_digest = $4)
    AND (commissioned = false OR commissioning_digest = $3)
    AND $5::integer BETWEEN 1 AND 999999
    AND ($6::uuid IS NULL OR EXISTS (
      SELECT 1 FROM private.strata_fee_source_grants g
      JOIN private.strata_fee_source_owner_consents c
        ON c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id
      JOIN public.strata_fee_operator_release_candidates r
        ON r.release_id=g.release_id
      JOIN v13_live_money_policy p ON p.id=v13_production_account.policy_id
      WHERE g.grant_id=$6::uuid AND g.owner_user_id=$2::uuid
        AND g.revoked_at IS NULL AND g.expires_at>now()
        AND c.revoked_at IS NULL AND c.confirmation='CONFIRM_OPERATOR_FEE_SOURCE_ONLY'
        AND r.revoked_at IS NULL AND r.expires_at>now()
        AND r.content_sha256=g.reviewed_pdf_sha256 AND c.release_id=g.release_id
        AND g.authorized_stages @> ARRAY['STEP_11']::text[]
        AND p.state='APPROVED' AND p.fee_policy_version=g.policy_version
        AND p.fee_source_url='strata-operator-attested://kxbtc15m/' ||
          g.grant_id::text || '/' || g.release_id::text
    ))
    AND (NOT EXISTS (
      SELECT 1 FROM v13_live_money_policy p
      WHERE p.id=v13_production_account.policy_id
        AND p.fee_source_url LIKE 'strata-api-reviewed://%'
    ) OR $7::uuid IS NOT NULL)
    AND ($7::uuid IS NULL OR EXISTS (
      SELECT 1 FROM private.strata_api_fee_source_grants g
      JOIN private.strata_api_fee_owner_consents c
        ON c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id
      JOIN v13_live_money_policy p ON p.id=v13_production_account.policy_id
      JOIN private.strata_api_fee_rate_reviews r1
        ON r1.owner_user_id=g.owner_user_id
        AND r1.rate_decision_digest=g.rate_decision_digest
      WHERE g.grant_id=$7::uuid AND g.owner_user_id=$2::uuid
        AND p.state='APPROVED'
        AND p.fee_policy_version='strata_api_fee_source_signed_review_v2'
        AND p.fee_source_url='strata-api-reviewed://kxbtc15m/' || g.grant_id::text
        AND g.rate_decision_digest=
          $8
        AND g.policy_version=p.fee_policy_version
        AND g.revoked_at IS NULL AND g.expires_at>now()+interval '12 seconds'
        AND c.revoked_at IS NULL AND c.confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'
        AND c.confirmed_at>=g.issued_at
        AND g.issuer_admin_id<>g.owner_user_id
        AND g.scope='KXBTC15M:INDEX2'
        AND g.confirmation='ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1'
        AND g.fee_model_version='kalshi_quadratic_007_whole_cent_conservative_reference_v1'
        AND r1.revoked_at IS NULL
        AND r1.expires_at>now()+interval '12 seconds'
        AND r1.signed_at<=g.issued_at
        AND r1.reviewer_user_id=g.issuer_admin_id
        AND r1.reviewer_user_id<>g.owner_user_id
        AND r1.confirmation='I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1'
        AND r1.scope=g.scope AND r1.fee_model_version=g.fee_model_version
        AND (SELECT count(*) FROM private.strata_api_fee_rate_reviews rx
             WHERE rx.owner_user_id=g.owner_user_id
               AND rx.rate_decision_digest=g.rate_decision_digest
               AND rx.reviewer_user_id=g.issuer_admin_id
               AND rx.scope=g.scope AND rx.fee_model_version=g.fee_model_version
               AND rx.confirmation='I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1'
               AND rx.revoked_at IS NULL AND rx.signed_at<=g.issued_at
               AND rx.expires_at>now()+interval '12 seconds')=1
        AND g.authorized_stages @> ARRAY['STEP_11']::text[]
        AND EXISTS(SELECT 1 FROM auth.users u JOIN private.role_assignments ra
          ON lower(btrim(u.email))=lower(btrim(ra.email))
          WHERE u.id=g.issuer_admin_id AND ra.role='ADMIN'
            AND u.email_confirmed_at IS NOT NULL)
        AND EXISTS(SELECT 1 FROM auth.users u JOIN private.role_assignments ra
          ON lower(btrim(u.email))=lower(btrim(ra.email))
          WHERE u.id=r1.reviewer_user_id AND ra.role='ADMIN'
            AND u.email_confirmed_at IS NOT NULL)
    ))
  RETURNING id
`;

export async function reportOwnedActivation(
  db: Queryable,
  ownerUserId: string,
  nowMs = Date.now(),
): Promise<{
  ok: true;
  accountId: string | null;
  blockers: string[];
  readyForCommissioning: boolean;
  readyForLive: boolean;
  activationRequested: boolean;
}> {
  let rows: Array<Record<string, unknown>> = [];
  let live: Array<Record<string, unknown>> = [];
  try {
    const found = await db.query(READINESS_SQL, [ownerUserId]);
    rows = found.rows;
    const gate = await db.query(
      "SELECT live_execution_enabled, manual_kill_switch FROM live_execution_config WHERE id = 'singleton'",
    );
    live = gate.rows;
  } catch {
    return { ok: true, accountId: null, blockers: ["activation_status_unproven"], readyForCommissioning: false, readyForLive: false, activationRequested: false };
  }
  if (rows.length !== 1) {
    return { ok: true, accountId: null, blockers: ["execution_account_missing"], readyForCommissioning: false, readyForLive: false, activationRequested: false };
  }
  const row = rows[0] ?? {};
  const blockers = activationBlockers(row, live[0], nowMs);
  const liveOnly = new Set(["account_not_commissioned", "execution_not_enabled", "account_kill_switch", "global_kill_switch", "live_execution_not_enabled"]);
  return {
    ok: true,
    accountId: text(row.id),
    blockers,
    readyForCommissioning: blockers.every((item) => liveOnly.has(item) || item === "minimum_exit_missing"),
    readyForLive: blockers.length === 0,
    activationRequested: Number(row.activation_requests) > 0,
  };
}

/**
 * Read-only, owner-scoped receipt for an already APPROVED C52/C53 policy.
 * It verifies the official fee schedule again instead of trusting a digest
 * cached in a browser session. It never approves, commissions or activates.
 */
export async function readOwnedApprovedFeeEvidence(
  db: Queryable,
  ownerUserId: string,
  establish: typeof establishOfficialFeeDigest = establishOfficialFeeDigest,
): Promise<{ ok: boolean; reason: string; feeArtifactDigest?: string; policyId?: string; version?: number }> {
  const result = await db.query(`
    SELECT p.id, p.version, p.state, p.entry_policy_version, p.strategy_parameter_hash,
           p.fee_policy_version, p.fee_source_url, p.fee_formula_version
    FROM v13_production_account a
    JOIN v13_live_money_policy p ON p.id = a.policy_id
      AND p.execution_account_id = a.id AND p.created_by = a.owner_user_id::text
    WHERE a.owner_user_id = $1::uuid
      AND a.owner_user_id IS NOT NULL AND a.subaccount = 1
      AND a.exchange_index = 2 AND p.state = 'APPROVED'
  `, [ownerUserId]);
  if (result.rows.length !== 1) return { ok: false, reason: "policy_not_approved" };
  const row = result.rows[0]!;
  if (text(row.entry_policy_version) !== V13_ENTRY_POLICY_VERSION ||
      text(row.strategy_parameter_hash) !== V13_CHAMPION_PARAMETER_HASH) {
    return { ok: false, reason: "production_entry_policy_revision_not_approved" };
  }
  const sourceUrl=text(row.fee_source_url) ?? "";
  const reviewedApi=parseReviewedApiSource(sourceUrl);
  if(reviewedApi){
    if(text(row.fee_policy_version)!==API_SOURCE_POLICY_VERSION ||
       text(row.fee_formula_version)!==API_SOURCE_FORMULA_VERSION)
      return {ok:false,reason:"api_fee_source_identity_invalid"};
    const verified=await verifyReviewedApiFeeSourceStage(ownerUserId,"STEP_9",sourceUrl);
    if(!verified.ok)return {ok:false,reason:verified.reason};
    const version=Number(row.version);
    if(!Number.isSafeInteger(version)||version<1)
      return {ok:false,reason:"policy_limits_missing"};
    return {ok:true,reason:"owned_policy_reviewed_api_fee_source_current",
      feeArtifactDigest:verified.identity.digest,policyId:String(row.id),version};
  }
  const altIdentity=parseOwnerFeeSource(sourceUrl);
  const altMode=text(row.fee_policy_version)===OPERATOR_FEE_SOURCE_POLICY &&
    text(row.fee_formula_version)===STANDARD_QUADRATIC_FEE_FORMULA_VERSION &&
    altIdentity!==null;
  if(altMode){
    const checked=await verifyOwnerFeeSourceStage(ownerUserId,"STEP_9",sourceUrl);
    if(!checked.ok)return {ok:false,reason:checked.reason};
    const version=Number(row.version);
    if(!Number.isSafeInteger(version)||version<1)
      return {ok:false,reason:"policy_limits_missing"};
    return {ok:true,reason:"owned_policy_operator_fee_source_current",
      feeArtifactDigest:checked.identity.digest,policyId:String(row.id),version};
  }
  if (text(row.fee_policy_version) !== STANDING_FEE_POLICY_VERSION ||
      sourceUrl !== CANONICAL_FEE_SCHEDULE_URL ||
      text(row.fee_formula_version) !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION) {
    return { ok: false, reason: "fee_artifact_unverified" };
  }
  // The production path verifies the PDF and live market once. Dependency-
  // injected isolated tests still exercise the original PDF-only interface.
  let verifiedDigest:string;
  if(establish===establishOfficialFeeDigest){
    const monetary=await verifyMonetaryFeeContract("STEP_11");
    if(!monetary.ok||!monetary.monetaryFeeAuthorized||!monetary.sourceDigest)
      return {ok:false,reason:monetary.reason};
    verifiedDigest=monetary.sourceDigest;
  }else{
    const proof=await establish();
    if(!proof.ok||!/^[a-f0-9]{64}$/.test(proof.digest))
      return {ok:false,reason:proof.ok?"fee_artifact_unverified":proof.reason};
    verifiedDigest=proof.digest;
  }
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) return { ok: false, reason: "policy_limits_missing" };
  return { ok: true, reason: "owned_policy_fee_verified", feeArtifactDigest: verifiedDigest,
    policyId: String(row.id), version };
}

export async function approveOwnedPolicyForUser(
  db: Transactional,
  input: {
    ownerUserId: string;
    executionAccountId: string;
    body: unknown;
    now?: Date;
    verifyFee?: typeof verifyCurrentFeeArtifact;
    verifyMonetary?: typeof verifyMonetaryFeeContract;
  },
): Promise<{ ok: boolean; reason: string; feeArtifactDigest?: string; retryAfterSeconds?: number }> {
  const parsed = policyBody(input.body, input.ownerUserId, input.now ?? new Date());
  if (!parsed.ok) return parsed;
  const request = input.body as Record<string,unknown>;
  const altRequested=request.feeSourceKind==="operator_attested_not_provider";
  const apiRequested=request.feeSourceKind==="kalshi_trade_api_fee_policy_v1";
  const ownerVerifiedRequested=request.feeSourceKind==="kalshi_owner_verified_monetary_v1";
  if(request.feeSourceKind!==undefined&&!altRequested&&!apiRequested&&!ownerVerifiedRequested)
    return {ok:false,reason:"fee_source_mode_not_supported"};
  let feeDigest: {ok:true;digest:string}|{ok:false;reason:string;retryAfterSeconds?:number};
  if(apiRequested){
    const verified=await verifyReviewedApiFeeSourceStage(input.ownerUserId,"STEP_9");
    if(!verified.ok)return {ok:false,reason:verified.reason};
    // Canonical reviewed source identity comes ONLY from signed service DB.
    parsed.fee={
      policyVersion:verified.identity.feePolicyVersion,
      sourceUrl:verified.identity.sourceUrl,
      formulaVersion:verified.identity.formulaVersion,
    };
    parsed.digest=verified.identity.digest;
    feeDigest={ok:true,digest:verified.identity.digest};
  }else if(altRequested){
    const verified=await verifyOwnerFeeSourceStage(input.ownerUserId,"STEP_9");
    if(!verified.ok)return {ok:false,reason:verified.reason};
    // Never trust source URL or provenance from an HTTP client.
    parsed.fee={
      policyVersion:verified.identity.policyVersion,
      sourceUrl:verified.identity.sourceUrl,
      formulaVersion:verified.identity.formulaVersion,
    };
    parsed.digest=verified.identity.digest;
    feeDigest={ok:true,digest:verified.identity.digest};
  }else if(ownerVerifiedRequested){
    // Existing authenticated owner's explicit policy consent is enforced by
    // policyBody. This branch verifies BOTH official monetary PDF evidence and
    // live exact-market API evidence; no synthetic technical review is minted.
    const current=await (input.verifyMonetary??verifyMonetaryFeeContract)("STEP_9");
    if(!current.ok || !current.monetaryFeeAuthorized || !current.sourceDigest)
      return {ok:false,reason:current.reason};
    if(parsed.digest && parsed.digest!==current.sourceDigest)
      return {ok:false,reason:"fee_artifact_unverified"};
    feeDigest={ok:true,digest:current.sourceDigest};
  }else{
    feeDigest=await resolveOwnedFeeDigest(parsed.digest,parsed.fee,input.verifyFee);
  }
  if (!feeDigest.ok) return feeDigest;
  const authorized = authorizeOwnedPolicy({
    ownerUserId: input.ownerUserId,
    executionAccountId: input.executionAccountId,
    policyId: parsed.policyId,
    version: parsed.version,
    confirmation: APPROVE_OWNED_POLICY_CONFIRMATION,
    limits: parsed.limits,
    fee: parsed.fee,
    champion: parsed.champion,
    approvedAt: parsed.approvedAt,
  });
  if (!authorized.ok) return authorized;
  if (!db.connect) return { ok: false, reason: "policy_approval_not_transactional" };
  const stored = await persistOwnedPolicyApproval({
    query: (text, params) => db.query(text, params),
    transaction: (work) => runTransaction(db, work),
  }, {
    ownerUserId: input.ownerUserId,
    executionAccountId: input.executionAccountId,
    policy: authorized.policy,
  });
  return stored.ok ? { ok: true, reason: "policy_approved", feeArtifactDigest: feeDigest.digest } : stored;
}

async function resolveOwnedFeeDigest(
  supplied: string | null,
  fee: OwnedPolicyFeeEvidence,
  verifyFee: typeof verifyCurrentFeeArtifact | undefined,
): Promise<{ ok: true; digest: string } | { ok: false; reason: string; retryAfterSeconds?: number }> {
  if (verifyFee) {
    if (!supplied) return { ok: false, reason: "fee_evidence_missing" };
    const artifact = await verifyFee({
      digest: supplied,
      policyVersion: fee.policyVersion,
      sourceUrl: fee.sourceUrl,
      formulaVersion: fee.formulaVersion,
    });
    if (!artifact.valid || artifact.digest !== supplied) return { ok: false, reason: "fee_artifact_unverified" };
    return { ok: true, digest: supplied };
  }
  const established = await establishOfficialFeeDigest();
  if (!established.ok) {
    // Never accept old/unverified evidence. Only disclose the backend's
    // sanitized retry delay so the Wallets UI can avoid hammering Kalshi.
    return {
      ok: false, reason: established.reason,
      ...(established.reason === "official_fee_schedule_http_429" ? {
        retryAfterSeconds: Math.max(60, Math.min(86_400,
          established.diagnostic.retryAfterSeconds ?? 60)),
      } : {}),
    };
  }
  if (supplied && supplied !== established.digest) return { ok: false, reason: "fee_artifact_unverified" };
  return { ok: true, digest: established.digest };
}

const CASH_SIGNER_SQL = `
  -- personal-activation:cash-signer
  SELECT a.id AS account_id, s.decrypted_secret
  FROM v13_production_account a
  JOIN private.kalshi_connection_credentials c
    ON c.owner_user_id = a.owner_user_id
   AND c.financial_account_id = a.kalshi_connection_id
   AND c.key_fingerprint = a.key_fingerprint
  JOIN vault.decrypted_secrets s ON s.id = c.vault_secret_id
  WHERE a.owner_user_id = $1::uuid
    AND a.owner_user_id IS NOT NULL
    AND a.subaccount = 1
    AND a.exchange_index = 2
    AND c.role = 'restricted_execution'
    AND c.revoked_at IS NULL
    AND c.verified_at IS NOT NULL
    AND c.verification_reason = 'credential_verified'
`;

export async function reconcileOwnedSubaccountCash(
  db: Queryable,
  input: {
    ownerUserId: string;
    confirmation: unknown;
    nowMs: number;
    get?: typeof getScopedKalshiJson;
  },
): Promise<{ ok: boolean; reason: string; transferAttempted: false }> {
  if (input.confirmation !== RECORD_OWNED_CASH_CONFIRMATION) {
    return { ok: false, reason: "explicit_authorization_required", transferAttempted: false };
  }
  const signer = await loadCashSigner(db, input.ownerUserId);
  if (!signer.ok) return { ok: false, reason: signer.reason, transferAttempted: false };
  const get = input.get ?? ((creds, path, query = "", fetchImpl = fetch) =>
    getScopedKalshiJson(creds, path, query, fetchImpl, PERSONAL_KALSHI_HOST));
  let subaccountBalance: unknown;
  let primaryBalance: unknown;
  try {
    [subaccountBalance, primaryBalance] = await Promise.all([
      get(signer.creds, "/trade-api/v2/portfolio/balance", "?subaccount=1&exchange_index=2"),
      get(signer.creds, "/trade-api/v2/portfolio/balance", ""),
    ]);
  } catch {
    return { ok: false, reason: "kalshi_read_failed", transferAttempted: false };
  }
  if (!scopeEcho(subaccountBalance)) {
    return { ok: false, reason: "account_target_pair_mismatch", transferAttempted: false };
  }
  const recorded = await persistOwnedCashReconciliation(db, {
    ownerUserId: input.ownerUserId,
    executionAccountId: signer.accountId,
    confirmation: input.confirmation,
    subaccount: 1,
    exchangeIndex: 2,
    observedAtMs: input.nowMs,
    nowMs: input.nowMs,
    maxAgeMs: 15_000,
    subaccountBalance,
    primaryBalance,
  });
  return { ok: recorded.ok, reason: recorded.reason, transferAttempted: false };
}

export async function commissionOwnedAccount(
  db: Queryable,
  input: {
    ownerUserId: string;
    confirmation: unknown;
    feeArtifactDigest: unknown;
    minimumExitMicros: unknown;
    verifyFee?: typeof verifyCurrentFeeArtifact;
  },
): Promise<{ ok: boolean; reason: string; blockers: string[] }> {
  if (input.confirmation !== COMMISSION_OWNED_ACCOUNT_CONFIRMATION) {
    return { ok: false, reason: "explicit_authorization_required", blockers: ["explicit_authorization_required"] };
  }
  const digest = typeof input.feeArtifactDigest === "string" ? input.feeArtifactDigest : "";
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, reason: "fee_evidence_missing", blockers: ["fee_evidence_missing"] };
  }
  const minimumExitMicros = Number(input.minimumExitMicros);
  if (!Number.isSafeInteger(minimumExitMicros) || minimumExitMicros < 1 || minimumExitMicros > 999_999) {
    return { ok: false, reason: "minimum_exit_missing", blockers: ["minimum_exit_missing"] };
  }
  const report = await reportOwnedActivation(db, input.ownerUserId);
  const deferred = new Set([
    "account_not_commissioned", "fee_evidence_missing", "execution_not_enabled",
    "account_kill_switch", "global_kill_switch", "live_execution_not_enabled", "minimum_exit_missing",
  ]);
  const blockers = report.blockers.filter((item) => !deferred.has(item));
  if (!report.accountId || blockers.length > 0) {
    return { ok: false, reason: blockers[0] ?? "execution_account_missing", blockers };
  }
  const policy = await db.query(READINESS_SQL, [input.ownerUserId]);
  const row = policy.rows[0];
  const policySource=text(row?.fee_source_url)??"";
  const operatorIdentity=parseOwnerFeeSource(policySource);
  const apiIdentity=parseReviewedApiSource(policySource);
  let alternateGrantId:string|null=null;
  let apiGrantId:string|null=null;
  if(apiIdentity){
    if(text(row?.fee_policy_version)!==API_SOURCE_POLICY_VERSION ||
       text(row?.fee_formula_version)!==API_SOURCE_FORMULA_VERSION)
      return {ok:false,reason:"api_fee_source_identity_invalid",
        blockers:["api_fee_source_identity_invalid"]};
    const checked=await verifyReviewedApiFeeSourceStage(input.ownerUserId,"STEP_11",policySource);
    if(!checked.ok||checked.identity.digest!==digest)
      return {ok:false,reason:checked.ok?"api_fee_digest_mismatch":checked.reason,
        blockers:[checked.ok?"api_fee_digest_mismatch":checked.reason]};
    apiGrantId=checked.identity.grantId;
  }else if(operatorIdentity){
    if(text(row?.fee_policy_version)!==OPERATOR_FEE_SOURCE_POLICY ||
       text(row?.fee_formula_version)!==STANDARD_QUADRATIC_FEE_FORMULA_VERSION)
      return {ok:false,reason:"fee_source_identity_invalid",blockers:["fee_source_identity_invalid"]};
    const checked=await verifyOwnerFeeSourceStage(input.ownerUserId,"STEP_11",policySource);
    if(!checked.ok||checked.identity.digest!==digest)
      return {ok:false,reason:checked.ok?"fee_digest_mismatch":checked.reason,
        blockers:[checked.ok?"fee_digest_mismatch":checked.reason]};
    alternateGrantId=checked.identity.grantId;
  } else if (text(row?.fee_policy_version)!==STANDING_FEE_POLICY_VERSION ||
             policySource!==CANONICAL_FEE_SCHEDULE_URL ||
             text(row?.fee_formula_version)!==STANDARD_QUADRATIC_FEE_FORMULA_VERSION) {
    return {ok:false,reason:"fee_source_identity_invalid",blockers:["fee_source_identity_invalid"]};
  }
  if (!operatorIdentity && !apiIdentity && input.verifyFee) {
    const artifact = await input.verifyFee({
      digest,
      policyVersion: text(row?.fee_policy_version) ?? "",
      sourceUrl: text(row?.fee_source_url) ?? "",
      formulaVersion: text(row?.fee_formula_version) ?? "",
    });
    if (!artifact.valid || artifact.digest !== digest) {
      return { ok: false, reason: "fee_artifact_unverified", blockers: ["fee_artifact_unverified"] };
    }
  } else if (!operatorIdentity && !apiIdentity) {
    // One source read establishes the PDF's monetary formula and live market
    // metadata. It does not grant commissioning consent.
    const monetary=await verifyMonetaryFeeContract("STEP_11");
    if(!monetary.ok||!monetary.monetaryFeeAuthorized||monetary.sourceDigest!==digest){
      const reason=monetary.ok?"fee_artifact_unverified":monetary.reason;
      return {ok:false,reason,blockers:[reason]};
    }
  }
  const commissioningDigest = createHash("sha256").update(JSON.stringify({
    accountId: report.accountId,
    fingerprint: text(row?.key_fingerprint),
    fee: digest,
    policyId: text(row?.policy_id),
  })).digest("hex");
  const written = await db.query(apiGrantId?COMMISSION_API_SQL:COMMISSION_SQL, [
    report.accountId, input.ownerUserId, commissioningDigest, digest, minimumExitMicros,
    alternateGrantId,
    ...(apiGrantId?[apiGrantId,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256]:[]),
  ]);
  if ((written.rowCount ?? written.rows.length) !== 1) {
    return { ok: false, reason: "commissioning_not_applied", blockers: ["commissioning_not_applied"] };
  }
  return { ok: true, reason: "account_commissioned", blockers: [] };
}

function activationBlockers(
  row: Record<string, unknown>, gate: Record<string, unknown> | undefined,
  nowMs: number,
): string[] {
  const blockers: string[] = [];
  if (text(row.key_fingerprint) === null || text(row.credential_fingerprint) !== text(row.key_fingerprint)) {
    blockers.push("restricted_signer_unverified");
  }
  if (Number(row.subaccount) !== 1 || Number(row.exchange_index) !== 2) blockers.push("account_target_pair_mismatch");
  if (row.policy_state !== "APPROVED" || !text(row.policy_id)) blockers.push("policy_not_approved");
  const stake = Number(row.configured_stake_cents);
  if (!Number.isSafeInteger(stake) || stake < 1) blockers.push("configured_stake_missing");
  // A pre-funding $0 read was historically flagged as "verified". Never
  // commission from that stale receipt: require positive cash and an owner-
  // scoped reconciliation at/after the independently verified $25 funding
  // evidence (new transfer receipt OR separate signed historical receipt).
  // Historical evidence alone can NEVER satisfy cash freshness.
  const cashMicros = Number(row.cash_micros);
  const reconciledAt = Date.parse(String(row.reconciled_at ?? ""));
  const fundedAt = Date.parse(String(row.verified_funding_at ?? ""));
  if (!flag(row.cash_precision_verified) ||
      !Number.isSafeInteger(cashMicros) || cashMicros < 25_000_000 ||
      !Number.isFinite(reconciledAt) || !Number.isFinite(fundedAt) ||
      reconciledAt < fundedAt ||
      // Freshness is required before the first irreversible commissioning
      // action. Existing commissioned accounts retain their independent
      // per-order exchange reconciliation and pre-POST safety checks.
      (!flag(row.commissioned) && (
        !Number.isFinite(nowMs) ||
        reconciledAt > nowMs + 10_000 ||
        nowMs - reconciledAt > 15 * 60_000
      ))) blockers.push("cash_not_reconciled");
  const exitMicros = Number(row.minimum_exit_micros);
  if (!Number.isSafeInteger(exitMicros) || exitMicros < 1 || exitMicros > 999_999) blockers.push("minimum_exit_missing");
  if (!/^[0-9a-f]{64}$/.test(text(row.fee_artifact_digest) ?? "")) blockers.push("fee_evidence_missing");
  if (!flag(row.commissioned)) blockers.push("account_not_commissioned");
  if (!flag(row.execution_enabled)) blockers.push("execution_not_enabled");
  if (flag(row.kill_switch)) blockers.push("account_kill_switch");
  const killOff = gate?.manual_kill_switch === false || gate?.manual_kill_switch === "f" || gate?.manual_kill_switch === "false";
  if (!gate || !killOff) blockers.push("global_kill_switch");
  const live = gate?.live_execution_enabled === true || gate?.live_execution_enabled === "t" || gate?.live_execution_enabled === "true";
  if (!live) blockers.push("live_execution_not_enabled");
  return blockers;
}

export async function requestOwnedAccountActivation(
  db: Queryable,
  input: { ownerUserId: string; confirmation: unknown },
): Promise<{ ok: boolean; reason: string; executionEnabled: false; killSwitchCleared: false; liveEnabled: false }> {
  const closed = { executionEnabled: false as const, killSwitchCleared: false as const, liveEnabled: false as const };
  if (input.confirmation !== REQUEST_OWNED_ACTIVATION_CONFIRMATION) {
    return { ok: false, reason: "explicit_authorization_required", ...closed };
  }
  const report = await reportOwnedActivation(db, input.ownerUserId);
  const deferred = new Set(["execution_not_enabled", "account_kill_switch", "global_kill_switch", "live_execution_not_enabled"]);
  const blockers = report.blockers.filter((item) => !deferred.has(item));
  if (!report.accountId || blockers.length > 0) {
    return { ok: false, reason: blockers[0] ?? "execution_account_missing", ...closed };
  }
  const unresolved = await db.query(
    `SELECT count(*)::text AS n FROM v13_production_intent
     WHERE account_id = $1 AND state IN ('DISPATCHED','UNKNOWN')`,
    [report.accountId],
  );
  if (Number(unresolved.rows[0]?.n ?? "0") > 0) {
    return { ok: false, reason: "production_uncertain_order_blocks_mutation", ...closed };
  }
  const row = (await db.query(READINESS_SQL, [input.ownerUserId])).rows[0] ?? {};
  const payload = {
    accountId: report.accountId,
    policyId: text(row.policy_id),
    feeDigest: text(row.fee_artifact_digest),
    stakeCents: Number(row.configured_stake_cents),
    commissioningDigest: text(row.commissioning_digest),
    minimumExitMicros: Number(row.minimum_exit_micros),
  };
  const evidence = digest(payload);
  const prior = await db.query(
    `SELECT digest FROM v13_production_observation
     WHERE account_id = $1 AND kind = 'OWNER_ACTIVATION_REQUEST'
     ORDER BY observed_at DESC LIMIT 1`,
    [report.accountId],
  );
  if (prior.rows[0]?.digest === evidence) {
    return { ok: true, reason: "activation_already_requested", ...closed };
  }
  await db.query(
    `INSERT INTO v13_production_observation(id, account_id, kind, payload, digest)
     VALUES ($1,$2,'OWNER_ACTIVATION_REQUEST',$3::jsonb,$4)`,
    [randomUUID(), report.accountId, JSON.stringify(payload), evidence],
  );
  return { ok: true, reason: "activation_requested", ...closed };
}

/** Enables execution for one owned account. Kill switches and the global live flag stay unchanged. */
export async function enableOwnedAccountExecution(
  db: Queryable,
  input: { executionAccountId: unknown; confirmation: unknown },
): Promise<{ ok: boolean; reason: string; globalFlagsChanged: false; killSwitchCleared: boolean; accountsTouched: number }> {
  const unchanged = { globalFlagsChanged: false as const, killSwitchCleared: false, accountsTouched: 0 };
  if (input.confirmation !== ENABLE_OWNED_EXECUTION_CONFIRMATION) {
    return { ok: false, reason: "explicit_authorization_required", ...unchanged };
  }
  const accountId = text(input.executionAccountId);
  if (!accountId) return { ok: false, reason: "execution_account_missing", ...unchanged };
  const found = await db.query(
    `SELECT a.owner_user_id::text AS owner_user_id, a.policy_id, a.fee_artifact_digest,
            a.commissioning_digest, a.minimum_exit_micros, a.commissioned, a.kill_switch, a.execution_enabled,
            stake.configured_stake_cents
     FROM v13_production_account a
     LEFT JOIN strata_configured_stake stake ON stake.execution_account_id = a.id
     WHERE a.id = $1 AND a.owner_user_id IS NOT NULL AND a.subaccount = 1 AND a.exchange_index = 2`,
    [accountId],
  );
  const row = found.rows[0];
  if (!row || !flag(row.commissioned)) return { ok: false, reason: "owned_execution_not_ready", ...unchanged };
  const payload = {
    accountId,
    policyId: text(row.policy_id),
    feeDigest: text(row.fee_artifact_digest),
    stakeCents: Number(row.configured_stake_cents),
    commissioningDigest: text(row.commissioning_digest),
    minimumExitMicros: Number(row.minimum_exit_micros),
  };
  const evidence = digest(payload);
  const prior = await db.query(
    `SELECT digest FROM v13_production_observation
     WHERE account_id = $1 AND kind = 'OWNER_ACTIVATION_REQUEST' AND digest = $2
     LIMIT 1`,
    [accountId, evidence],
  );
  if (prior.rows.length !== 1) return { ok: false, reason: "activation_request_missing", ...unchanged };
  if (flag(row.execution_enabled) && !flag(row.kill_switch)) {
    return { ok: true, reason: "owned_execution_already_enabled", ...unchanged };
  }
  if (!flag(row.kill_switch) || flag(row.execution_enabled)) {
    return { ok: false, reason: "owned_execution_not_ready", ...unchanged };
  }
  const written = await db.query(
    `UPDATE v13_production_account
     SET execution_enabled = true, kill_switch = false
     WHERE id = $1 AND owner_user_id IS NOT NULL AND commissioned = true
       AND kill_switch = true AND execution_enabled = false
       AND subaccount = 1 AND exchange_index = 2
     RETURNING id`,
    [accountId],
  );
  if ((written.rowCount ?? written.rows.length) !== 1) {
    return { ok: false, reason: "owned_execution_not_ready", ...unchanged };
  }
  return { ok: true, reason: "owned_execution_enabled", globalFlagsChanged: false, killSwitchCleared: true, accountsTouched: 1 };
}

/** Turns on the shared live flag only. It does not read or write any trading account. */
export async function enableSharedLiveInfrastructure(
  db: Queryable,
  input: { confirmation: unknown },
): Promise<{ ok: boolean; reason: string; accountsTouched: 0 }> {
  if (input.confirmation !== ENABLE_SHARED_LIVE_CONFIRMATION) {
    return { ok: false, reason: "explicit_authorization_required", accountsTouched: 0 };
  }
  const written = await db.query(
    `UPDATE live_execution_config
     SET live_execution_enabled = true, manual_kill_switch = false, updated_at = now()
     WHERE id = 'singleton' AND mode = 'V13_PRODUCTION'
       AND live_execution_enabled = false AND manual_kill_switch = true
     RETURNING id`,
  );
  if ((written.rowCount ?? written.rows.length) !== 1) {
    return { ok: false, reason: "shared_live_not_applied", accountsTouched: 0 };
  }
  return { ok: true, reason: "shared_live_enabled", accountsTouched: 0 };
}

function policyBody(body: unknown, ownerUserId: string, approvedAt: Date):
  | { ok: true; policyId: string; version: number; digest: string | null; limits: OwnedPolicyLimits; fee: OwnedPolicyFeeEvidence; champion: OwnedPolicyChampionEvidence; approvedAt: Date }
  | { ok: false; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "policy_limits_missing" };
  const row = body as Record<string, unknown>;
  if (row.confirmation !== APPROVE_OWNED_POLICY_CONFIRMATION) return { ok: false, reason: "explicit_authorization_required" };
  const policyId = text(row.policyId);
  const version = Number(row.version);
  const digest = text(row.feeArtifactDigest);
  if (digest && !/^[0-9a-f]{64}$/.test(digest)) return { ok: false, reason: "fee_artifact_unverified" };
  if (!policyId || !Number.isSafeInteger(version) || version < 1) {
    return { ok: false, reason: "policy_limits_missing" };
  }
  const limits = limitsOf(row.limits);
  const suppliedFee = feeOf(row.fee);
  const fee = suppliedFee ?? {
    policyVersion: STANDING_FEE_POLICY_VERSION,
    sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
    formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  };
  if (fee.sourceUrl !== CANONICAL_FEE_SCHEDULE_URL || fee.policyVersion !== STANDING_FEE_POLICY_VERSION ||
      fee.formulaVersion !== STANDARD_QUADRATIC_FEE_FORMULA_VERSION) {
    return { ok: false, reason: "fee_artifact_unverified" };
  }
  const suppliedChampion = championOf(row.champion);
  if (suppliedChampion && (suppliedChampion.evidenceHash !== V13_CHAMPION_PARAMETER_HASH ||
      suppliedChampion.reviewId !== REVIEWED_RELEASE.commit || suppliedChampion.selectedBy !== ownerUserId)) {
    return { ok: false, reason: "champion_evidence_mismatch" };
  }
  const champion = suppliedChampion ?? {
    reviewId: REVIEWED_RELEASE.commit,
    evidenceHash: V13_CHAMPION_PARAMETER_HASH,
    selectedBy: ownerUserId,
    selectedAt: new Date(approvedAt.getTime() - 1),
  };
  if (!limits) return { ok: false, reason: "policy_limits_missing" };
  return { ok: true, policyId, version, digest, limits, fee, champion, approvedAt };
}

function limitsOf(value: unknown): OwnedPolicyLimits | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const limits = {
    capitalLimitCents: Number(row.capitalLimitCents),
    maxEntryStakeCents: Number(row.maxEntryStakeCents),
    maxEntryAllInCents: Number(row.maxEntryAllInCents),
    maxDailyLossCents: Number(row.maxDailyLossCents),
    maxTotalLossCents: Number(row.maxTotalLossCents),
    maxQuoteAgeMs: Number(row.maxQuoteAgeMs),
    maxFeeEvidenceAgeMs: Number(row.maxFeeEvidenceAgeMs),
  };
  return Object.values(limits).every((item) => Number.isSafeInteger(item)) ? limits : null;
}

function feeOf(value: unknown): OwnedPolicyFeeEvidence | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const policyVersion = text(row.policyVersion);
  const sourceUrl = text(row.sourceUrl);
  const formulaVersion = text(row.formulaVersion);
  if (!policyVersion || !sourceUrl || !formulaVersion) return null;
  return { policyVersion, sourceUrl, formulaVersion };
}

function championOf(value: unknown): OwnedPolicyChampionEvidence | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const reviewId = text(row.reviewId);
  const evidenceHash = text(row.evidenceHash);
  const selectedBy = text(row.selectedBy);
  const selectedAt = new Date(typeof row.selectedAt === "string" ? row.selectedAt : "");
  if (!reviewId || !evidenceHash || !selectedBy || Number.isNaN(selectedAt.getTime())) return null;
  return { reviewId, evidenceHash, selectedBy, selectedAt };
}

async function runTransaction<T>(
  db: Transactional,
  work: (query: Queryable["query"]) => Promise<T>,
): Promise<T> {
  if (!db.connect) throw new Error("policy_approval_not_transactional");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work((text, params) => client.query(text, params));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* the original error remains */ }
    throw error;
  } finally {
    client.release();
  }
}

async function loadCashSigner(
  db: Queryable,
  ownerUserId: string,
): Promise<{ ok: true; accountId: string; creds: { keyId: string; privateKey: string } } | { ok: false; reason: string }> {
  try {
    const found = await db.query(CASH_SIGNER_SQL, [ownerUserId]);
    if (found.rows.length !== 1) return { ok: false, reason: "personal_signer_unavailable" };
    const accountId = text(found.rows[0]?.account_id);
    const creds = secret(found.rows[0]?.decrypted_secret);
    if (!accountId || !creds) return { ok: false, reason: "personal_signer_unavailable" };
    return { ok: true, accountId, creds };
  } catch {
    return { ok: false, reason: "personal_signer_unavailable" };
  }
}

function secret(value: unknown): { keyId: string; privateKey: string } | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const keyId = parsed.api_key_id;
    const privateKey = parsed.private_key;
    if (typeof keyId !== "string" || typeof privateKey !== "string" || !keyId || !privateKey) return null;
    return { keyId, privateKey };
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}
