import {
  PRODUCTION_EXCHANGE_INDEX,
  PRODUCTION_SUBACCOUNT,
  REVIEWED_FUNDING_MICROS,
  commissioningStatus,
  planArm,
  planCommission,
  type AccountPlan,
  type CommissioningSnapshot,
  type CommissioningStatus,
} from "./commissioning";

/**
 * Phase 1 boundary. User-scoped commissioning resolves evidence for the
 * authenticated user only. It does not read Railway Kalshi credentials, open
 * Vault material, create subaccounts, transfer funds, place orders, arm, or
 * start a worker.
 */
export const PHASE1_APPROVED_OPERATIONS = ["read_commissioning_status"] as const;

export type Phase1Operation = (typeof PHASE1_APPROVED_OPERATIONS)[number];

/** Known roles. The list is not a required pair count; a connection may have any subset. */
export const KNOWN_CREDENTIAL_ROLES = [
  "provisioning",
  "verification",
  "account_setup_execution",
  "restricted_execution",
] as const;

export type KnownCredentialRole = (typeof KNOWN_CREDENTIAL_ROLES)[number];

export const LEGACY_KALSHI_CREDENTIAL_ENV_NAMES = [
  "KALSHI_INDEX2_API_KEY_ID",
  "KALSHI_INDEX2_PRIVATE_KEY",
  "KALSHI_PROVISIONING_API_KEY_ID",
  "KALSHI_PROVISIONING_PRIVATE_KEY",
  "KALSHI_VERIFIER_API_KEY_ID",
  "KALSHI_VERIFIER_API_PRIVATE_KEY",
  "KALSHI_API_KEY_ID",
  "KALSHI_API_PRIVATE_KEY",
] as const;

const CLIENT_OWNER_KEYS = [
  "owner_user_id",
  "ownerUserId",
  "target_user_id",
  "targetUserId",
  "user_id",
  "userId",
  "provider_connection_id",
  "providerConnectionId",
] as const;

export interface OwnedKalshiConnection {
  authenticatedUserId: string;
  financialAccountId: string;
  providerConnectionId: string;
}

export interface StoredCredentialRef {
  role: string;
  providerConnectionId: string;
  vaultSecretId: string;
  keyFingerprint: string | null;
  source: "vault_connection";
}

export interface ExecutionTarget {
  ownerUserId: string;
  providerConnectionId: string;
  executionAccountId: string | null;
  subaccount: number | null;
  exchangeIndex: number | null;
}

export interface AccountCredentialMaterial {
  keyId: string;
  privateKey: string;
}

export interface AccountCommissioningPorts {
  listOwnedConnections(authenticatedUserId: string): Promise<OwnedKalshiConnection[]>;
  listCredentialRefs(
    authenticatedUserId: string,
    providerConnectionId: string,
  ): Promise<StoredCredentialRef[]>;
  readExecutionTarget(
    authenticatedUserId: string,
    providerConnectionId: string,
  ): Promise<ExecutionTarget | null>;
  readSnapshot(
    authenticatedUserId: string,
    providerConnectionId: string,
  ): Promise<CommissioningSnapshot>;
  /**
   * Present for a later phase. Phase 1 refuses every materializing operation
   * before this is called.
   */
  openCredential(
    authenticatedUserId: string,
    ref: StoredCredentialRef,
  ): Promise<AccountCredentialMaterial | null>;
}

export interface AccountCommissioningContext {
  authenticatedUserId: string;
  financialAccountId: string;
  providerConnectionId: string;
  executionAccountId: string | null;
  subaccount: number | null;
  exchangeIndex: number | null;
  credentials: StoredCredentialRef[];
  approvedOperations: typeof PHASE1_APPROVED_OPERATIONS;
  executable: false;
}

export interface PublicAccountCommissioningContext {
  authenticatedUserId: string;
  financialAccountId: string;
  providerConnectionId: string;
  executionAccountId: string | null;
  subaccount: number | null;
  exchangeIndex: number | null;
  credentialRoles: string[];
  credentialFingerprints: Record<string, string | null>;
  approvedOperations: typeof PHASE1_APPROVED_OPERATIONS;
  executable: false;
}

export interface AccountCommissioningEvaluation {
  ok: boolean;
  reason: string;
  executable: false;
  armEnabled: false;
  workerStarted: false;
  context: PublicAccountCommissioningContext | null;
  status: CommissioningStatus | null;
  plan: AccountPlan | null;
  blockers: string[];
  legacyArmReason: string | null;
  reviewedFundingMicros: typeof REVIEWED_FUNDING_MICROS;
}

export function credentialSourceAllowed(source: string): source is "vault_connection" {
  return source === "vault_connection";
}

/** Fail closed with a stable reason. This is not an execution or credential error payload. */
export class AccountCommissioningRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "AccountCommissioningRefusal";
    this.reason = reason;
  }
}

export function phase1ExecutionDecision(arm: { ok: boolean; reason: string }): {
  executable: false;
  armEnabled: false;
  workerStarted: false;
  reason: string;
} {
  return {
    executable: false,
    armEnabled: false,
    workerStarted: false,
    reason: arm.ok ? "arm_not_enabled" : arm.reason,
  };
}

export function selectCredentialRef(
  context: AccountCommissioningContext,
  role: string,
): { ok: true; ref: StoredCredentialRef } | {
  ok: false;
  reason: "missing_credential" | "ambiguous_credential_role" | "foreign_credential" | "legacy_credential_fallback_refused";
} {
  const matches = context.credentials.filter((ref) => ref.role === role);
  if (matches.length === 0) return { ok: false, reason: "missing_credential" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous_credential_role" };
  const ref = matches[0];
  if (!ref || !credentialSourceAllowed(ref.source)) {
    return { ok: false, reason: "legacy_credential_fallback_refused" };
  }
  if (ref.providerConnectionId !== context.providerConnectionId) {
    return { ok: false, reason: "foreign_credential" };
  }
  return { ok: true, ref };
}

export async function useAccountCredential<T>(
  context: AccountCommissioningContext,
  role: string,
  ports: AccountCommissioningPorts,
  operation: string,
  _use: (material: AccountCredentialMaterial) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  void ports;
  void operation;
  void _use;
  const selected = selectCredentialRef(context, role);
  if (!selected.ok) return selected;
  return { ok: false, reason: "operation_not_enabled" };
}

export async function resolveAccountCommissioningContext(
  authenticatedUserId: string,
  ports: AccountCommissioningPorts,
  clientRequest?: unknown,
): Promise<{ ok: true; context: AccountCommissioningContext } | { ok: false; reason: string }> {
  void unusedClientOwner(clientRequest);
  if (!authenticatedUserId || authenticatedUserId !== authenticatedUserId.trim()) {
    return { ok: false, reason: "authenticated_user_required" };
  }
  let connections: OwnedKalshiConnection[];
  try {
    connections = await ports.listOwnedConnections(authenticatedUserId);
  } catch (error) {
    if (error instanceof AccountCommissioningRefusal) return { ok: false, reason: error.reason };
    throw error;
  }
  if (connections.length === 0) return { ok: false, reason: "owned_connection_missing" };
  if (connections.length > 1) return { ok: false, reason: "owned_connection_ambiguous" };
  const connection = connections[0];
  if (!connection || connection.authenticatedUserId !== authenticatedUserId) {
    return { ok: false, reason: "foreign_connection" };
  }
  let refs: StoredCredentialRef[];
  try {
    refs = await ports.listCredentialRefs(authenticatedUserId, connection.providerConnectionId);
  } catch (error) {
    if (error instanceof AccountCommissioningRefusal) return { ok: false, reason: error.reason };
    throw error;
  }
  const roles = new Set<string>();
  for (const ref of refs) {
    if (!credentialSourceAllowed(String(ref.source))) {
      return { ok: false, reason: "legacy_credential_fallback_refused" };
    }
    if (ref.providerConnectionId !== connection.providerConnectionId || !ref.vaultSecretId || !ref.role.trim()) {
      return { ok: false, reason: "foreign_credential" };
    }
    if (roles.has(ref.role)) return { ok: false, reason: "ambiguous_credential_role" };
    roles.add(ref.role);
  }
  let target: ExecutionTarget | null;
  try {
    target = await ports.readExecutionTarget(authenticatedUserId, connection.providerConnectionId);
  } catch (error) {
    if (error instanceof AccountCommissioningRefusal) return { ok: false, reason: error.reason };
    throw error;
  }
  if (target && (target.ownerUserId !== authenticatedUserId ||
      target.providerConnectionId !== connection.providerConnectionId)) {
    return { ok: false, reason: "foreign_execution_account" };
  }
  return {
    ok: true,
    context: {
      authenticatedUserId,
      financialAccountId: connection.financialAccountId,
      providerConnectionId: connection.providerConnectionId,
      executionAccountId: target?.executionAccountId ?? null,
      subaccount: target?.subaccount ?? null,
      exchangeIndex: target?.exchangeIndex ?? null,
      credentials: refs,
      approvedOperations: PHASE1_APPROVED_OPERATIONS,
      executable: false,
    },
  };
}

export async function evaluateAccountCommissioning(
  authenticatedUserId: string,
  ports: AccountCommissioningPorts,
  clientRequest?: unknown,
): Promise<AccountCommissioningEvaluation> {
  const resolved = await resolveAccountCommissioningContext(authenticatedUserId, ports, clientRequest);
  if (!resolved.ok) return refused(resolved.reason);
  let snapshot: CommissioningSnapshot;
  try {
    snapshot = await ports.readSnapshot(authenticatedUserId, resolved.context.providerConnectionId);
  } catch {
    return refused("snapshot_unavailable");
  }
  const decision = planCommission(snapshot);
  const status = commissioningStatus(snapshot);
  const blockers = [...decision.blockers];
  let plan = decision.plan;
  const target = resolved.context;
  if ((target.subaccount !== null && target.subaccount !== PRODUCTION_SUBACCOUNT) ||
      (target.exchangeIndex !== null && target.exchangeIndex !== PRODUCTION_EXCHANGE_INDEX)) {
    blockers.push("account_target_pair_mismatch");
    plan = null;
  }
  if (target.executionAccountId && snapshot.account.id && snapshot.account.id !== target.executionAccountId) {
    blockers.push("foreign_execution_account");
    plan = null;
  }
  const arm = phase1ExecutionDecision(planArm(snapshot, "ARM_V13_PRODUCTION"));
  return {
    ok: true,
    reason: plan ? "commissioning_plan_reused" : "commissioning_blocked",
    executable: false,
    armEnabled: false,
    workerStarted: false,
    context: publicContext(resolved.context),
    status,
    plan,
    blockers,
    legacyArmReason: arm.reason,
    reviewedFundingMicros: REVIEWED_FUNDING_MICROS,
  };
}

function publicContext(context: AccountCommissioningContext): PublicAccountCommissioningContext {
  return {
    authenticatedUserId: context.authenticatedUserId,
    financialAccountId: context.financialAccountId,
    providerConnectionId: context.providerConnectionId,
    executionAccountId: context.executionAccountId,
    subaccount: context.subaccount,
    exchangeIndex: context.exchangeIndex,
    credentialRoles: context.credentials.map((ref) => ref.role),
    credentialFingerprints: Object.fromEntries(context.credentials.map((ref) => [ref.role, ref.keyFingerprint])),
    approvedOperations: context.approvedOperations,
    executable: false,
  };
}

function refused(reason: string): AccountCommissioningEvaluation {
  return {
    ok: false,
    reason,
    executable: false,
    armEnabled: false,
    workerStarted: false,
    context: null,
    status: null,
    plan: null,
    blockers: [reason],
    legacyArmReason: null,
    reviewedFundingMicros: REVIEWED_FUNDING_MICROS,
  };
}

function unusedClientOwner(clientRequest: unknown): null {
  if (!clientRequest || typeof clientRequest !== "object") return null;
  const body = clientRequest as Record<string, unknown>;
  for (const key of CLIENT_OWNER_KEYS) void body[key];
  return null;
}
