import { createHash } from "node:crypto";
import type { CredentialDatabase } from "./accountCredentialStore";

export const ACCOUNT_SETUP_CONFIRMATIONS = {
  create_subaccount: "CREATE_ACCOUNT_SUBACCOUNT",
  generate_api_key: "GENERATE_ACCOUNT_API_KEY",
  provision_execution_account: "PROVISION_ACCOUNT_EXECUTION",
} as const;

export type AccountSetupOperation = keyof typeof ACCOUNT_SETUP_CONFIRMATIONS;
export type AccountSetupAttemptState =
  | "prepared"
  | "attempted"
  | "response_received"
  | "uncertain"
  | "completed"
  | "cancelled";

export type AccountSetupPlan =
  | {
    operation: "create_subaccount";
    exchangePath: "/trade-api/v2/portfolio/subaccounts";
    method: "POST";
    request: { exchange_index: 2 };
    expectedSubaccount: 1;
  }
  | {
    operation: "generate_api_key";
    exchangePath: "/trade-api/v2/api_keys/generate";
    method: "POST";
    request: {
      name: "STRATA_V13_SUBACCOUNT_1";
      key_type: "rsa";
      scopes: ["read", "write::trade"];
      subaccount: 1;
    };
    vaultDestination: "supabase_vault";
  }
  | {
    operation: "provision_execution_account";
    plannedExecutionAccountId: string;
    subaccount: 1;
    exchangeIndex: 2;
    commissioned: false;
    executionEnabled: false;
    killSwitch: true;
    cashPrecisionVerified: false;
  };

export interface PublicAccountSetupAttempt {
  attemptId: string;
  operation: AccountSetupOperation;
  state: AccountSetupAttemptState;
  plan: AccountSetupPlan;
  preparedAt: string;
  updatedAt: string;
}

export interface AccountSetupNextAuthorizedAction {
  action: string;
  operation: AccountSetupOperation | null;
  endpoint: string | null;
  requiredConfirmation: string | null;
  effect: string;
}

export interface PrepareAccountSetupResult {
  ok: boolean;
  reason: string;
  attempted: false;
  executable: false;
  idempotent: boolean;
  attempt: PublicAccountSetupAttempt | null;
}

/*
 * A prepared row is review evidence, not execution authority. Any separately
 * authorized future executor must lock the row, re-read every precondition,
 * move to attempted before its first Kalshi POST, and move to uncertain on an
 * ambiguous response without retrying. A successful one-time key response must
 * be Vault-stored and owner-bound atomically; response bodies and private key
 * material must never be written to this attempt table.
 */
const UPSERT_PREPARATION_SQL = `
  -- account-setup-attempt:prepare
  INSERT INTO private.kalshi_account_operation_attempts (
    owner_user_id,
    financial_account_id,
    provider_connection_id,
    operation,
    target_subaccount,
    target_exchange_index,
    authority_credential_id,
    authority_fingerprint,
    target_credential_id,
    target_fingerprint,
    planned_execution_account_id,
    plan,
    precondition_digest
  ) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, 1, 2, $5::uuid, $6,
    $7::uuid, $8, $9, $10::jsonb, $11
  )
  ON CONFLICT (provider_connection_id, operation)
  DO UPDATE SET
    authority_credential_id = EXCLUDED.authority_credential_id,
    authority_fingerprint = EXCLUDED.authority_fingerprint,
    target_credential_id = EXCLUDED.target_credential_id,
    target_fingerprint = EXCLUDED.target_fingerprint,
    planned_execution_account_id = EXCLUDED.planned_execution_account_id,
    plan = EXCLUDED.plan,
    precondition_digest = EXCLUDED.precondition_digest,
    prepared_at = CASE
      WHEN private.kalshi_account_operation_attempts.precondition_digest = EXCLUDED.precondition_digest
        THEN private.kalshi_account_operation_attempts.prepared_at
      ELSE now()
    END,
    updated_at = now()
  WHERE private.kalshi_account_operation_attempts.owner_user_id = EXCLUDED.owner_user_id
    AND private.kalshi_account_operation_attempts.financial_account_id = EXCLUDED.financial_account_id
    AND private.kalshi_account_operation_attempts.state = 'prepared'
  RETURNING id::text AS attempt_id,
            operation,
            state,
            plan,
            prepared_at::text AS prepared_at,
            updated_at::text AS updated_at,
            (xmax <> 0) AS reused
`;

const READ_ATTEMPT_SQL = `
  -- account-setup-attempt:read-one
  SELECT id::text AS attempt_id,
         owner_user_id::text AS owner_user_id,
         financial_account_id::text AS financial_account_id,
         operation,
         state,
         plan,
         prepared_at::text AS prepared_at,
         updated_at::text AS updated_at
  FROM private.kalshi_account_operation_attempts
  WHERE provider_connection_id = $1::uuid
    AND operation = $2
`;

const LIST_ATTEMPTS_SQL = `
  -- account-setup-attempt:list-owned
  SELECT id::text AS attempt_id,
         operation,
         state,
         plan,
         prepared_at::text AS prepared_at,
         updated_at::text AS updated_at
  FROM private.kalshi_account_operation_attempts
  WHERE owner_user_id = $1::uuid
    AND provider_connection_id = $2::uuid
  ORDER BY prepared_at, operation
`;

export function accountSetupPlan(
  operation: AccountSetupOperation,
  providerConnectionId: string,
): AccountSetupPlan {
  if (operation === "create_subaccount") {
    return {
      operation,
      exchangePath: "/trade-api/v2/portfolio/subaccounts",
      method: "POST",
      request: { exchange_index: 2 },
      expectedSubaccount: 1,
    };
  }
  if (operation === "generate_api_key") {
    return {
      operation,
      exchangePath: "/trade-api/v2/api_keys/generate",
      method: "POST",
      request: {
        name: "STRATA_V13_SUBACCOUNT_1",
        key_type: "rsa",
        scopes: ["read", "write::trade"],
        subaccount: 1,
      },
      vaultDestination: "supabase_vault",
    };
  }
  return {
    operation,
    plannedExecutionAccountId: plannedExecutionAccountId(providerConnectionId),
    subaccount: 1,
    exchangeIndex: 2,
    commissioned: false,
    executionEnabled: false,
    killSwitch: true,
    cashPrecisionVerified: false,
  };
}

export function accountSetupPreconditionDigest(value: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function prepareAccountSetupOperation(
  db: CredentialDatabase,
  input: {
    ownerUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    operation: AccountSetupOperation;
    authorityCredentialId: string;
    authorityFingerprint: string;
    targetCredentialId: string | null;
    targetFingerprint: string | null;
    plan: AccountSetupPlan;
    preconditionDigest: string;
  },
): Promise<PrepareAccountSetupResult> {
  try {
    return await db.transaction(async (client) => {
      const stored = await client.query(UPSERT_PREPARATION_SQL, [
        input.ownerUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.operation,
        input.authorityCredentialId,
        input.authorityFingerprint,
        input.targetCredentialId,
        input.targetFingerprint,
        input.operation === "provision_execution_account"
          ? input.plan.operation === "provision_execution_account"
            ? input.plan.plannedExecutionAccountId
            : null
          : null,
        JSON.stringify(input.plan),
        input.preconditionDigest,
      ]);
      if (stored.rows.length === 1) {
        const attempt = publicAttempt(stored.rows[0]);
        if (!attempt) throw new Error("operation_preparation_invalid");
        return prepared(attempt, stored.rows[0]?.reused === true);
      }
      const existing = await client.query(READ_ATTEMPT_SQL, [
        input.providerConnectionId,
        input.operation,
      ]);
      if (existing.rows.length !== 1) throw new Error("operation_preparation_not_recorded");
      if (text(existing.rows[0]?.owner_user_id) !== input.ownerUserId ||
          text(existing.rows[0]?.financial_account_id) !== input.financialAccountId) {
        return rejected("operation_owner_mismatch");
      }
      const attempt = publicAttempt(existing.rows[0]);
      if (!attempt) throw new Error("operation_preparation_invalid");
      return {
        ...rejected(retryReason(attempt.state)),
        attempt,
      };
    });
  } catch {
    return rejected("operation_preparation_not_recorded");
  }
}

export async function listOwnedAccountSetupAttempts(
  db: CredentialDatabase,
  ownerUserId: string,
  providerConnectionId: string,
): Promise<PublicAccountSetupAttempt[]> {
  const rows = await db.query(LIST_ATTEMPTS_SQL, [ownerUserId, providerConnectionId]);
  return rows.rows.map(publicAttempt).filter((row): row is PublicAccountSetupAttempt => row !== null);
}

function plannedExecutionAccountId(providerConnectionId: string): string {
  const suffix = createHash("sha256").update(`strata:v13:${providerConnectionId}:1:2`).digest("hex").slice(0, 24);
  return `strata-account-${suffix}`;
}

function retryReason(state: AccountSetupAttemptState): string {
  if (state === "attempted" || state === "response_received" || state === "uncertain") {
    return `operation_retry_blocked_${state}`;
  }
  if (state === "completed") return "operation_already_completed";
  if (state === "cancelled") return "operation_preparation_cancelled";
  return "operation_preparation_not_recorded";
}

function prepared(attempt: PublicAccountSetupAttempt, idempotent: boolean): PrepareAccountSetupResult {
  return {
    ok: true,
    reason: idempotent ? "operation_preparation_reused" : "operation_prepared_not_executed",
    attempted: false,
    executable: false,
    idempotent,
    attempt,
  };
}

function rejected(reason: string): PrepareAccountSetupResult {
  return {
    ok: false,
    reason,
    attempted: false,
    executable: false,
    idempotent: false,
    attempt: null,
  };
}

function publicAttempt(row: Record<string, unknown>): PublicAccountSetupAttempt | null {
  const attemptId = text(row.attempt_id);
  const operation = setupOperation(row.operation);
  const state = setupState(row.state);
  const preparedAt = text(row.prepared_at);
  const updatedAt = text(row.updated_at);
  const plan = setupPlan(row.plan);
  if (!attemptId || !operation || !state || !preparedAt || !updatedAt || !plan ||
      plan.operation !== operation) return null;
  return { attemptId, operation, state, plan, preparedAt, updatedAt };
}

function setupPlan(value: unknown): AccountSetupPlan | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const operation = setupOperation(record.operation);
  const request = record.request && typeof record.request === "object" &&
    !Array.isArray(record.request)
    ? record.request as Record<string, unknown>
    : null;
  if (operation === "create_subaccount" &&
      record.exchangePath === "/trade-api/v2/portfolio/subaccounts" &&
      record.method === "POST" &&
      request?.exchange_index === 2 &&
      record.expectedSubaccount === 1) {
    return {
      operation,
      exchangePath: "/trade-api/v2/portfolio/subaccounts",
      method: "POST",
      request: { exchange_index: 2 },
      expectedSubaccount: 1,
    };
  }
  if (operation === "generate_api_key" &&
      record.exchangePath === "/trade-api/v2/api_keys/generate" &&
      record.method === "POST" &&
      request?.name === "STRATA_V13_SUBACCOUNT_1" &&
      request.key_type === "rsa" &&
      Array.isArray(request.scopes) &&
      request.scopes.length === 2 &&
      request.scopes[0] === "read" &&
      request.scopes[1] === "write::trade" &&
      request.subaccount === 1 &&
      record.vaultDestination === "supabase_vault") {
    return {
      operation,
      exchangePath: "/trade-api/v2/api_keys/generate",
      method: "POST",
      request: {
        name: "STRATA_V13_SUBACCOUNT_1",
        key_type: "rsa",
        scopes: ["read", "write::trade"],
        subaccount: 1,
      },
      vaultDestination: "supabase_vault",
    };
  }
  const executionAccountId = text(record.plannedExecutionAccountId);
  if (operation === "provision_execution_account" &&
      executionAccountId &&
      record.subaccount === 1 &&
      record.exchangeIndex === 2 &&
      record.commissioned === false &&
      record.executionEnabled === false &&
      record.killSwitch === true &&
      record.cashPrecisionVerified === false) {
    return {
      operation,
      plannedExecutionAccountId: executionAccountId,
      subaccount: 1,
      exchangeIndex: 2,
      commissioned: false,
      executionEnabled: false,
      killSwitch: true,
      cashPrecisionVerified: false,
    };
  }
  return null;
}

function setupOperation(value: unknown): AccountSetupOperation | null {
  return value === "create_subaccount" ||
    value === "generate_api_key" ||
    value === "provision_execution_account"
    ? value
    : null;
}

function setupState(value: unknown): AccountSetupAttemptState | null {
  return value === "prepared" || value === "attempted" || value === "response_received" ||
    value === "uncertain" || value === "completed" || value === "cancelled"
    ? value
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
