import { resolveAccountCommissioningContext, type AccountCommissioningPorts } from "./accountCommissioningContext";
import { accountFundingAuthorization } from "./accountCredentialLifecycle";
import type { CredentialDatabase } from "./accountCredentialStore";

export const RECORD_FUNDING_EVIDENCE_CONFIRMATION = "RECORD_ACCOUNT_FUNDING_EVIDENCE";

export interface AccountFundingResult {
  ok: boolean;
  reason: string;
  executable: false;
  transferAttempted: false;
  authorizedMicros: string | null;
  evidenceMicros: string | null;
}

const REVOKE_FUNDING_SQL = `
  -- account-funding:revoke
  UPDATE private.kalshi_account_funding
  SET revoked_at = now(), updated_at = now()
  WHERE owner_user_id = $1::uuid
    AND provider_connection_id = $2::uuid
    AND revoked_at IS NULL
`;

const INSERT_FUNDING_SQL = `
  -- account-funding:insert
  INSERT INTO private.kalshi_account_funding (
    owner_user_id, financial_account_id, provider_connection_id, authorized_micros
  ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint)
  RETURNING id::text AS id, authorized_micros::text AS authorized_micros
`;

const LOCK_FUNDING_SQL = `
  -- account-funding:lock
  SELECT id::text AS id, authorized_micros::text AS authorized_micros
  FROM private.kalshi_account_funding
  WHERE owner_user_id = $1::uuid
    AND provider_connection_id = $2::uuid
    AND revoked_at IS NULL
  FOR UPDATE
`;

const RECORD_EVIDENCE_SQL = `
  -- account-funding:evidence
  UPDATE private.kalshi_account_funding
  SET evidence_micros = $3::bigint,
      evidence_source = $4,
      evidence_observed_at = now(),
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND revoked_at IS NULL
    AND evidence_micros IS NULL
  RETURNING authorized_micros::text AS authorized_micros, evidence_micros::text AS evidence_micros
`;

const READ_FUNDING_SQL = `
  -- account-funding:read
  SELECT authorized_micros::text AS authorized_micros,
         evidence_micros::text AS evidence_micros
  FROM private.kalshi_account_funding
  WHERE owner_user_id = $1::uuid
    AND provider_connection_id = $2::uuid
    AND revoked_at IS NULL
`;

export async function persistAccountFundingAuthorization(
  db: CredentialDatabase,
  ports: AccountCommissioningPorts,
  input: {
    authenticatedUserId: string;
    confirmation: unknown;
    authorizedMicros: string;
    liveExecutionEnabled?: string;
    v13ProductionExecutionEnabled?: string;
  },
): Promise<AccountFundingResult> {
  const decision = accountFundingAuthorization(input);
  if (!decision.ok || !decision.authorizedMicros) {
    return funding(false, decision.reason, null, null);
  }
  const resolved = await resolveAccountCommissioningContext(input.authenticatedUserId, ports);
  if (!resolved.ok) return funding(false, resolved.reason, null, null);
  try {
    const stored = await db.transaction(async (client) => {
      await client.query(REVOKE_FUNDING_SQL, [
        input.authenticatedUserId,
        resolved.context.providerConnectionId,
      ]);
      const inserted = await client.query(INSERT_FUNDING_SQL, [
        input.authenticatedUserId,
        resolved.context.financialAccountId,
        resolved.context.providerConnectionId,
        decision.authorizedMicros,
      ]);
      if (inserted.rows.length !== 1) throw new Error("funding_not_recorded");
      return text(inserted.rows[0]?.authorized_micros);
    });
    return funding(true, "funding_authorized_not_transferred", stored, null);
  } catch {
    return funding(false, "funding_not_recorded", null, null);
  }
}

export async function persistAccountFundingEvidence(
  db: CredentialDatabase,
  ports: AccountCommissioningPorts,
  input: {
    authenticatedUserId: string;
    confirmation: unknown;
    evidenceMicros: string;
    evidenceSource: "kalshi_balance" | "kalshi_transfer";
  },
): Promise<AccountFundingResult> {
  if (input.confirmation !== RECORD_FUNDING_EVIDENCE_CONFIRMATION) {
    return funding(false, "explicit_authorization_required", null, null);
  }
  if (!/^\d+$/.test(input.evidenceMicros)) return funding(false, "funding_amount_invalid", null, null);
  const resolved = await resolveAccountCommissioningContext(input.authenticatedUserId, ports);
  if (!resolved.ok) return funding(false, resolved.reason, null, null);
  const locked = await db.query(LOCK_FUNDING_SQL, [
    input.authenticatedUserId,
    resolved.context.providerConnectionId,
  ]);
  if (locked.rows.length !== 1) return funding(false, "account_funding_not_authorized", null, null);
  const fundingId = text(locked.rows[0]?.id);
  const authorized = text(locked.rows[0]?.authorized_micros);
  if (!fundingId || !authorized) return funding(false, "account_funding_not_authorized", null, null);
  const recorded = await db.query(RECORD_EVIDENCE_SQL, [
    fundingId,
    input.authenticatedUserId,
    input.evidenceMicros,
    input.evidenceSource,
  ]);
  if (recorded.rows.length !== 1) return funding(false, "funding_evidence_not_recorded", authorized, null);
  const evidence = text(recorded.rows[0]?.evidence_micros);
  const reason = evidence === authorized ? "funding_evidence_recorded" : "account_funding_evidence_mismatch";
  return funding(evidence === authorized, reason, authorized, evidence);
}

export async function readAccountFunding(
  db: CredentialDatabase,
  ownerUserId: string,
  providerConnectionId: string,
): Promise<{ authorizedMicros: string | null; evidenceMicros: string | null }> {
  const rows = await db.query(READ_FUNDING_SQL, [ownerUserId, providerConnectionId]);
  if (rows.rows.length !== 1) return { authorizedMicros: null, evidenceMicros: null };
  return {
    authorizedMicros: text(rows.rows[0]?.authorized_micros),
    evidenceMicros: text(rows.rows[0]?.evidence_micros),
  };
}

function funding(
  ok: boolean,
  reason: string,
  authorizedMicros: string | null,
  evidenceMicros: string | null,
): AccountFundingResult {
  return { ok, reason, executable: false, transferAttempted: false, authorizedMicros, evidenceMicros };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
