import { Router, type IRouter, type RequestHandler } from "express";
import { sanitizePublic } from "../lib/v13-production/sanitize";
import { emptyUserExecutionView, type ControlAction, type UserExecutionView } from "../lib/strata/userExecutionScope";
import type { PolicyDraft, SharedPreset } from "../lib/strata/sharedPresets";
import type { KalshiUserRead } from "../lib/strata/kalshiUserRead";
import { emptyKalshiUserRead } from "../lib/strata/kalshiUserRead";
import { QUALIFICATION_CONFIRMATION, RESIDUAL_RISK_CONFIRMATION, type QualificationResult } from "../lib/strata/qualifyAdvancedApi";
import { readQualificationDiagnostics, type QualificationDiagnostic } from "../lib/strata/qualificationDiagnostics";
import type { AccountSetupNextRequirement } from "../lib/strata/accountCredentialProbe";
import type {
  AccountSetupNextAuthorizedAction,
  PublicAccountSetupAttempt,
} from "../lib/strata/accountSetupPreparation";

export interface UserCommissioningStatus {
  ready: boolean;
  executable: false;
  blockers: string[];
  subaccount1Exists: boolean | null;
  subaccount1Exchange2Exists: boolean | null;
  subaccount1SafeToCreate: boolean | null;
  subaccountEvidence: "kalshi_subaccount_balance_inventory" | null;
  provisioningKeyMetadataVerified: boolean | null;
  provisioningApiTier: string | null;
  provisioningSubaccountCreationEligible: boolean | null;
  subaccountCreationAuthorityPresent: boolean;
  subaccountCreationAuthorityVerified: boolean;
  subaccountCreationExecutionRoleAvailable: boolean;
  restrictedKeyMetadataVerified: boolean | null;
  restrictedKeyReadVerified: boolean;
  executionAccountExists: boolean;
  setupReason: string;
  nextRequirement: AccountSetupNextRequirement | null;
  operationPreparationAvailable: boolean;
  operationPreparations: PublicAccountSetupAttempt[];
  nextAuthorizedAction: AccountSetupNextAuthorizedAction | null;
}

export interface UserScopePort {
  migrationReady(): Promise<boolean>;
  settings(userId: string): Promise<UserExecutionView>;
  wallet(userId: string): Promise<KalshiUserRead>;
  control(userId: string, action: ControlAction): Promise<{ ok: boolean; reason?: string; view: UserExecutionView }>;
  safetyControl(userId: string, action: "STOP" | "DISARM" | "KILL"): Promise<{
    ok: boolean;
    reason?: string;
    executable: false;
    workerStarted: false;
    executionActive: false;
    view: UserExecutionView;
  }>;
  credentialStatus(userId: string): Promise<{ ok: boolean; reason: string; executable: false; roles: unknown[] }>;
  registerCredential(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false }>;
  revokeCredential(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false }>;
  verifyCredential(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false }>;
  authorizeFunding(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false; transferAttempted: false }>;
  recordFundingEvidence(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false; transferAttempted: false }>;
  authorizeOperation(userId: string, body: unknown): Promise<{
    ok: boolean;
    reason: string;
    attempted: false;
    executable?: false;
    idempotent?: boolean;
    attempt?: PublicAccountSetupAttempt | null;
  }>;
  executeOperation(userId: string, body: unknown): Promise<{
    ok: boolean;
    reason: string;
    attempted: boolean;
    executable: false;
  }>;
  commissioningStatus(userId: string): Promise<UserCommissioningStatus>;
  stake(userId: string, cents: number, revision: number | null): Promise<{ ok: boolean; reason?: string; view: UserExecutionView }>;
  presets(userId: string): Promise<SharedPreset[]>;
  savePreset(userId: string, body: unknown): Promise<{ ok: boolean; reason?: string; preset?: SharedPreset }>;
  updatePreset(userId: string, presetId: string, body: unknown): Promise<{ ok: boolean; reason?: string; preset?: SharedPreset }>;
  deletePreset(userId: string, presetId: string): Promise<{ ok: boolean; reason?: string }>;
  applyPreset(userId: string, presetId: string): Promise<{ ok: boolean; reason?: string; draft?: PolicyDraft; view: UserExecutionView }>;
  qualify(userId: string, body: unknown): Promise<QualificationResult>;
  diagnose(userId: string): Promise<QualificationDiagnostic>;
}

/** Fail closed. Does not read the legacy account and does not mutate Kalshi or the database. */
export function closedUserScopePort(): UserScopePort {
  const refused = async (userId: string) => ({ ok: false, reason: "user_scope_not_migrated", view: emptyUserExecutionView(userId) });
  return {
    migrationReady: async () => false,
    settings: async (userId) => emptyUserExecutionView(userId),
    wallet: async () => emptyKalshiUserRead(),
    control: async (userId) => refused(userId),
    safetyControl: async (userId) => ({ ...await refused(userId), executable: false, workerStarted: false, executionActive: false }),
    credentialStatus: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false, roles: [] }),
    registerCredential: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false }),
    revokeCredential: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false }),
    verifyCredential: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false }),
    authorizeFunding: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false, transferAttempted: false }),
    recordFundingEvidence: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false, transferAttempted: false }),
    authorizeOperation: async () => ({ ok: false, reason: "user_scope_not_migrated", attempted: false, executable: false }),
    executeOperation: async () => ({ ok: false, reason: "user_scope_not_migrated", attempted: false, executable: false }),
    commissioningStatus: async () => ({
      ready: false,
      executable: false,
      blockers: ["user_scope_not_migrated"],
      subaccount1Exists: null,
      subaccount1Exchange2Exists: null,
      subaccount1SafeToCreate: null,
      subaccountEvidence: null,
      provisioningKeyMetadataVerified: null,
      provisioningApiTier: null,
      provisioningSubaccountCreationEligible: null,
      subaccountCreationAuthorityPresent: false,
      subaccountCreationAuthorityVerified: false,
      subaccountCreationExecutionRoleAvailable: false,
      restrictedKeyMetadataVerified: null,
      restrictedKeyReadVerified: false,
      executionAccountExists: false,
      setupReason: "user_scope_not_migrated",
      nextRequirement: null,
      operationPreparationAvailable: false,
      operationPreparations: [],
      nextAuthorizedAction: {
        action: "resolve_account_setup_blocker",
        operation: null,
        endpoint: null,
        requiredConfirmation: null,
        effect: "user_scope_not_migrated",
        attemptId: null,
      },
    }),
    stake: async (userId) => refused(userId),
    presets: async () => [],
    savePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    updatePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    deletePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    applyPreset: async (userId) => refused(userId),
    qualify: async () => ({ status: "USER_SCOPE_CLOSED" }),
    diagnose: async () => ({ ...await readQualificationDiagnostics({ guard: null }), status: "USER_SCOPE_CLOSED" }),
  };
}

function subject(res: { locals: { strata?: { subject?: string } } }): string | null {
  const value = res.locals.strata?.subject;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ignoreForeignOwner(body: unknown): void {
  if (!body || typeof body !== "object") return;
  delete (body as Record<string, unknown>).owner_user_id;
  delete (body as Record<string, unknown>).target_user_id;
}

function qualificationRequest(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const copy = { ...(body as Record<string, unknown>) };
  for (const key of ["owner_user_id", "target_user_id", "api_key", "apiKey", "private_key", "privateKey", "pem"]) delete copy[key];
  return copy;
}

export function createUserExecutionRouter(requireUser: RequestHandler, port: UserScopePort): IRouter {
  const router: IRouter = Router();
  router.use(requireUser);
  const migrated = async (res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    try {
      if (await port.migrationReady()) return true;
    } catch {
      // A missing schema is a closed scope, not a process failure.
    }
    res.status(409).json({ error: "user_scope_not_migrated" });
    return false;
  };
  router.get("/bot-settings", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    if (!await migrated(res)) return;
    res.json(sanitizePublic(await port.settings(userId)));
  });
  router.get("/wallet", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.json(sanitizePublic(await port.wallet(userId)));
  });
  router.post("/control", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const action = req.body?.action;
    if (action !== "ARM" && action !== "DISARM" && action !== "START" && action !== "STOP" && action !== "KILL") {
      return void res.status(400).json({ error: "control_action_invalid" });
    }
    if (action === "STOP" || action === "DISARM" || action === "KILL") {
      const result = await port.safetyControl(userId, action);
      return void res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
    }
    if (!await migrated(res)) return;
    const result = await port.control(userId, action);
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.get("/commissioning", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.json(sanitizePublic(await port.commissioningStatus(userId)));
  });
  router.get("/credentials", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.json(sanitizePublic(await port.credentialStatus(userId)));
  });
  router.post("/credentials", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.registerCredential(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/credentials/revoke", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.revokeCredential(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/credentials/verify", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.verifyCredential(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/funding-authorization", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.authorizeFunding(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/funding-evidence", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.recordFundingEvidence(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/account-operations", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.authorizeOperation(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/account-operations/execute", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.executeOperation(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/stake", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const cents = req.body?.configuredStakeCents;
    const revision = req.body?.revision ?? null;
    if (typeof cents !== "number") return void res.status(400).json({ error: "stake_cents_not_integer" });
    const result = await port.stake(userId, cents, typeof revision === "number" ? revision : null);
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.get("/presets", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    if (!await migrated(res)) return;
    res.json(sanitizePublic({ presets: await port.presets(userId) }));
  });
  router.post("/presets", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const result = await port.savePreset(userId, req.body ?? {});
    res.status(result.ok ? 200 : 400).json(sanitizePublic(result));
  });
  router.post("/presets/:id", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const result = await port.updatePreset(userId, String(req.params.id), req.body ?? {});
    res.status(result.ok ? 200 : 403).json(sanitizePublic(result));
  });
  router.delete("/presets/:id", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    if (!await migrated(res)) return;
    const result = await port.deletePreset(userId, String(req.params.id));
    res.status(result.ok ? 200 : 403).json(sanitizePublic(result));
  });
  router.post("/presets/:id/apply", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const result = await port.applyPreset(userId, String(req.params.id));
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/qualify-advanced-api", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    const body = qualificationRequest(req.body);
    if (body.confirm !== QUALIFICATION_CONFIRMATION && body.confirm !== RESIDUAL_RISK_CONFIRMATION) {
      return void res.status(400).json({ status: "CONFIRMATION_REQUIRED" });
    }
    const result = await port.qualify(userId, body);
    const ok = result.status === "ADVANCED_VERIFIED" || result.status === "ALREADY_ADVANCED";
    res.status(ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.get("/qualification-diagnostics", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    for (const key of ["user_id", "owner_user_id", "target_user_id", "provider_connection_id", "order_id", "client_order_id", "ticker", "api_key", "apiKey", "private_key", "privateKey", "pem"]) {
      delete req.query[key];
    }
    const result = await port.diagnose(userId);
    res.status(result.status === "QUALIFICATION_DIAGNOSTIC_READY" ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/legacy/claim", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    res.status(409).json({ executable: false, reason: "legacy_claim_not_executed", ownerAssigned: false });
  });
  return router;
}
