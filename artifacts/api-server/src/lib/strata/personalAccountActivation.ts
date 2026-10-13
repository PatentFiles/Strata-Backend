import { createHash } from "node:crypto";
import { getScopedKalshiJson } from "../kalshiAccountClient";
import { verifyCurrentFeeArtifact } from "../microLiveFeeArtifact";
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

export const COMMISSION_OWNED_ACCOUNT_CONFIRMATION = "COMMISSION_OWNED_STRATA_ACCOUNT";

type Queryable = {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};
type Transactional = Queryable & {
  connect?: () => Promise<Queryable & { release(): void }>;
};

const READINESS_SQL = `
  -- personal-activation:readiness
  SELECT a.id, a.commissioned, a.execution_enabled, a.kill_switch,
         a.cash_precision_verified, a.fee_artifact_digest, a.subaccount, a.exchange_index,
         a.key_fingerprint, a.policy_id,
         p.state AS policy_state, p.fee_policy_version, p.fee_source_url, p.fee_formula_version,
         stake.configured_stake_cents,
         c.key_fingerprint AS credential_fingerprint
  FROM v13_production_account a
  LEFT JOIN v13_live_money_policy p
    ON p.id = a.policy_id AND p.execution_account_id = a.id AND p.created_by = a.owner_user_id
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
      fee_artifact_digest = $4
  WHERE id = $1
    AND owner_user_id = $2::uuid
    AND owner_user_id IS NOT NULL
    AND subaccount = 1
    AND exchange_index = 2
    AND execution_enabled = false
    AND kill_switch = true
    AND cash_precision_verified = true
    AND policy_id IS NOT NULL
    AND (fee_artifact_digest IS NULL OR fee_artifact_digest = $4)
    AND (commissioned = false OR commissioning_digest = $3)
  RETURNING id
`;

export async function reportOwnedActivation(
  db: Queryable,
  ownerUserId: string,
): Promise<{ ok: true; accountId: string | null; blockers: string[]; readyForCommissioning: boolean; readyForLive: boolean }> {
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
    return { ok: true, accountId: null, blockers: ["activation_status_unproven"], readyForCommissioning: false, readyForLive: false };
  }
  if (rows.length !== 1) {
    return { ok: true, accountId: null, blockers: ["execution_account_missing"], readyForCommissioning: false, readyForLive: false };
  }
  const row = rows[0] ?? {};
  const blockers = activationBlockers(row, live[0]);
  const liveOnly = new Set(["account_not_commissioned", "execution_not_enabled", "account_kill_switch", "global_kill_switch", "live_execution_not_enabled"]);
  return {
    ok: true,
    accountId: text(row.id),
    blockers,
    readyForCommissioning: blockers.every((item) => liveOnly.has(item)),
    readyForLive: blockers.length === 0,
  };
}

export async function approveOwnedPolicyForUser(
  db: Transactional,
  input: {
    ownerUserId: string;
    executionAccountId: string;
    body: unknown;
    now?: Date;
    verifyFee?: typeof verifyCurrentFeeArtifact;
  },
): Promise<{ ok: boolean; reason: string }> {
  const parsed = policyBody(input.body, input.now ?? new Date());
  if (!parsed.ok) return parsed;
  const verifyFee = input.verifyFee ?? verifyCurrentFeeArtifact;
  const artifact = await verifyFee({
    digest: parsed.digest,
    policyVersion: parsed.fee.policyVersion,
    sourceUrl: parsed.fee.sourceUrl,
    formulaVersion: parsed.fee.formulaVersion,
  });
  if (!artifact.valid || artifact.digest !== parsed.digest) return { ok: false, reason: "fee_artifact_unverified" };
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
  return stored.ok ? { ok: true, reason: "policy_approved" } : stored;
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
  const report = await reportOwnedActivation(db, input.ownerUserId);
  const deferred = new Set([
    "account_not_commissioned", "fee_evidence_missing", "execution_not_enabled",
    "account_kill_switch", "global_kill_switch", "live_execution_not_enabled",
  ]);
  const blockers = report.blockers.filter((item) => !deferred.has(item));
  if (!report.accountId || blockers.length > 0) {
    return { ok: false, reason: blockers[0] ?? "execution_account_missing", blockers };
  }
  const policy = await db.query(READINESS_SQL, [input.ownerUserId]);
  const row = policy.rows[0];
  const verifyFee = input.verifyFee ?? verifyCurrentFeeArtifact;
  const artifact = await verifyFee({
    digest,
    policyVersion: text(row?.fee_policy_version) ?? "",
    sourceUrl: text(row?.fee_source_url) ?? "",
    formulaVersion: text(row?.fee_formula_version) ?? "",
  });
  if (!artifact.valid || artifact.digest !== digest) {
    return { ok: false, reason: "fee_artifact_unverified", blockers: ["fee_artifact_unverified"] };
  }
  const commissioningDigest = createHash("sha256").update(JSON.stringify({
    accountId: report.accountId,
    fingerprint: text(row?.key_fingerprint),
    fee: digest,
    policyId: text(row?.policy_id),
  })).digest("hex");
  const written = await db.query(COMMISSION_SQL, [report.accountId, input.ownerUserId, commissioningDigest, digest]);
  if ((written.rowCount ?? written.rows.length) !== 1) {
    return { ok: false, reason: "commissioning_not_applied", blockers: ["commissioning_not_applied"] };
  }
  return { ok: true, reason: "account_commissioned", blockers: [] };
}

function activationBlockers(row: Record<string, unknown>, gate: Record<string, unknown> | undefined): string[] {
  const blockers: string[] = [];
  if (text(row.key_fingerprint) === null || text(row.credential_fingerprint) !== text(row.key_fingerprint)) {
    blockers.push("restricted_signer_unverified");
  }
  if (Number(row.subaccount) !== 1 || Number(row.exchange_index) !== 2) blockers.push("account_target_pair_mismatch");
  if (row.policy_state !== "APPROVED" || !text(row.policy_id)) blockers.push("policy_not_approved");
  const stake = Number(row.configured_stake_cents);
  if (!Number.isSafeInteger(stake) || stake < 1) blockers.push("configured_stake_missing");
  if (!flag(row.cash_precision_verified)) blockers.push("cash_not_reconciled");
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

function policyBody(body: unknown, approvedAt: Date):
  | { ok: true; policyId: string; version: number; digest: string; limits: OwnedPolicyLimits; fee: OwnedPolicyFeeEvidence; champion: OwnedPolicyChampionEvidence; approvedAt: Date }
  | { ok: false; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "policy_limits_missing" };
  const row = body as Record<string, unknown>;
  if (row.confirmation !== APPROVE_OWNED_POLICY_CONFIRMATION) return { ok: false, reason: "explicit_authorization_required" };
  const policyId = text(row.policyId);
  const version = Number(row.version);
  const digest = text(row.feeArtifactDigest);
  if (!policyId || !Number.isSafeInteger(version) || version < 1 || !digest || !/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, reason: "policy_limits_missing" };
  }
  const limits = limitsOf(row.limits);
  const fee = feeOf(row.fee);
  const champion = championOf(row.champion);
  if (!limits || !fee || !champion) return { ok: false, reason: "policy_limits_missing" };
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
