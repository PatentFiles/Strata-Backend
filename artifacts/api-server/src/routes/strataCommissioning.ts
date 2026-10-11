import { Router, type IRouter, type RequestHandler } from "express";
import { sanitizePublic } from "../lib/v13-production/sanitize";
import {
  STRATA_INDEX2_KEY_SCOPES,
  STRATA_INDEX2_REPLACEMENT_CONFIRMATION,
  commissioningStatus,
  fundingAuthorizationDecision,
  type BlockingSubaccountTransfer,
  type PolicyRead,
  planCommission,
  type CommissioningSnapshot,
  type SubaccountStatus,
} from "../lib/strata/commissioning";

export interface ExchangeCall {
  method: "GET" | "POST" | "DELETE";
  path: string;
}

export interface Index2GenerationResult {
  state: "blocked" | "generated" | "uncertain";
  reason: string;
  apiKeyId?: string;
  privateKey?: string;
  posts: number;
  privateKeyPersisted: false;
  verified: false;
  workerStarted: false;
  environmentChanged: false;
}

export interface SubaccountCreateResult {
  state: "blocked" | "created" | "uncertain";
  reason: string;
  posts: number;
  returnedSubaccount: number | null;
  workerStarted: false;
  environmentChanged: false;
  funded: false;
  commissioned: false;
}

export interface CommissioningPort {
  read(): Promise<CommissioningSnapshot>;
  readSubaccountStatus(): Promise<SubaccountStatus>;
  createSubaccount(confirmation: unknown): Promise<SubaccountCreateResult>;
  generateIndex2Key(confirmation: unknown): Promise<Index2GenerationResult>;
  replaceIndex2Key(confirmation: unknown): Promise<Index2GenerationResult>;
  verifySigner(): Promise<{ snapshot: CommissioningSnapshot; calls: ExchangeCall[] }>;
  verifyBoundary(): Promise<CommissioningSnapshot>;
  captureBoundary(): Promise<{
    snapshot: CommissioningSnapshot;
    calls: ExchangeCall[];
    blocked: boolean;
    reason: string;
    blockingTransfer?: BlockingSubaccountTransfer | null;
  }>;
  reconcileFunding(): Promise<{ state: string; reason: string; transferAttempted: false }>;
  fund(confirmation: unknown): Promise<{ state: string; reason: string; transferAttempted: boolean; attempts: number }>;
  verifyFee(): Promise<CommissioningSnapshot>;
  verifyCash(): Promise<CommissioningSnapshot>;
  readPolicy(): Promise<PolicyRead>;
  proposePolicy(body: unknown, actor: string): Promise<{ status: string; reason: string }>;
  approvePolicy(actor: string): Promise<{ status: string; reason: string; policyHash?: string }>;
  approveMinimumExit(micros: unknown, confirmation: unknown, actor: string): Promise<{ status: string; reason: string }>;
  commission(confirmation: unknown, actor: string): Promise<{
    status: "BLOCKED" | "COMMISSIONED" | "ALREADY_COMMISSIONED";
    blockers: string[];
    executionEnabled: false | null;
    killSwitch: true | null;
    commissioned: boolean | null;
    workerStarted: false;
    environmentChanged: false;
    accountCount: number;
  }>;
  arm(confirmation: unknown): Promise<{ status: string; reason: string; workerStarted: false; environmentChanged: false }>;
  disarm(confirmation: unknown): Promise<{ status: string; reason: string; emergencyStop: false }>;
}

const AUTHORITY_FIELDS = new Set([
  "executionEnabled", "killSwitch", "commissioned", "LIVE_EXECUTION_ENABLED",
  "V13_PRODUCTION_EXECUTION_ENABLED", "minimumExitMicros", "feeArtifactDigest",
  "keyFingerprint", "privateKey", "cashMicros", "commissioningDigest",
]);

function bodyRequestsAuthority(body: unknown, path: string): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return Object.keys(body).some((key) => {
    if (key === "minimumExitMicros" && path.endsWith("/minimum-exit/approve")) return false;
    return AUTHORITY_FIELDS.has(key);
  });
}

export function createStrataCommissioningRouter(
  authorize: RequestHandler,
  port: CommissioningPort,
): IRouter {
  const router: IRouter = Router();
  router.use(authorize);

  router.use((req, res, next) => {
    if (bodyRequestsAuthority(req.body, req.path)) {
      res.status(400).json(sanitizePublic({
        status: "BLOCKED",
        blockers: ["request_cannot_change_execution_authority"],
      }));
      return;
    }
    next();
  });

  router.get("/status", async (_req, res) => {
    try {
      res.json(sanitizePublic(commissioningStatus(await port.read())));
    } catch {
      res.status(503).json({ error: "Commissioning status is unavailable" });
    }
  });

  router.post("/verify-signer", async (_req, res) => {
    try {
      const result = await port.verifySigner();
      const unsafe = result.calls.some((call) => call.method !== "GET");
      if (unsafe) {
        res.status(409).json(sanitizePublic({
          status: "BLOCKED",
          blockers: ["signer_verification_must_be_get_only"],
        }));
        return;
      }
      res.json(sanitizePublic({
        ...commissioningStatus(result.snapshot),
        signedGetOnly: true,
        exchangeCalls: result.calls,
      }));
    } catch {
      res.status(503).json({ error: "Signer verification is unavailable" });
    }
  });

  router.post("/verify-boundary", async (_req, res) => {
    try {
      res.json(sanitizePublic(commissioningStatus(await port.verifyBoundary())));
    } catch {
      res.status(503).json({ error: "Boundary verification is unavailable" });
    }
  });

  router.get("/subaccount-status", async (_req, res) => {
    try {
      res.json(sanitizePublic(await port.readSubaccountStatus()));
    } catch {
      res.status(503).json({ error: "Subaccount status is unavailable" });
    }
  });

  router.post("/create-subaccount", async (req, res) => {
    try {
      const result = await port.createSubaccount(req.body?.confirm);
      const status = result.state === "created" ? 201
        : result.reason === "explicit_subaccount_confirmation_required" ? 400 : 409;
      res.status(status).json(sanitizePublic({
        ...result,
        followUp: result.state === "created"
          ? "Rerun GET /api/strata/commissioning/subaccount-status, then POST /api/strata/commissioning/capture-boundary."
          : undefined,
      }));
    } catch {
      res.status(503).json({ error: "Subaccount creation is unavailable" });
    }
  });

  router.post("/capture-boundary", async (_req, res) => {
    try {
      const result = await port.captureBoundary();
      const unsafe = result.calls.some((call) => call.method !== "GET");
      if (unsafe) {
        res.status(409).json(sanitizePublic({ status: "BLOCKED", blockers: ["boundary_capture_must_be_get_only"] }));
        return;
      }
      res.status(result.blocked ? 409 : 200).json(sanitizePublic({
        ...commissioningStatus(result.snapshot),
        blocked: result.blocked,
        reason: result.reason,
        exchangeCalls: result.calls,
        ...(result.blockingTransfer ? { blockingTransfer: result.blockingTransfer } : {}),
      }));
    } catch {
      res.status(503).json({ error: "Boundary capture is unavailable" });
    }
  });

  router.post("/funding/reconcile", async (_req, res) => {
    try {
      const result = await port.reconcileFunding();
      res.json(sanitizePublic({ ...result, transferAttempted: false as const }));
    } catch {
      res.status(503).json({ error: "Funding reconciliation is unavailable" });
    }
  });

  router.post("/fund", async (req, res) => {
    const decision = fundingAuthorizationDecision({
      confirmation: req.body?.confirm,
      liveExecutionEnabled: process.env.LIVE_EXECUTION_ENABLED,
      v13ProductionExecutionEnabled: process.env.V13_PRODUCTION_EXECUTION_ENABLED,
    });
    if (!decision.proceed) {
      res.status(409).json(sanitizePublic({
        state: "blocked",
        reason: decision.reason,
        transferAttempted: false,
        attempts: 0,
      }));
      return;
    }
    try {
      const result = await port.fund(req.body?.confirm);
      res.status(result.transferAttempted || result.state === "funded" || result.state === "uncertain" ? 200 : 409)
        .json(sanitizePublic(result));
    } catch {
      res.status(503).json({ error: "Funding is unavailable", transferAttempted: false });
    }
  });

  router.post("/verify-fee", async (_req, res) => {
    try {
      res.json(sanitizePublic(commissioningStatus(await port.verifyFee())));
    } catch {
      res.status(503).json({ error: "Fee verification is unavailable" });
    }
  });

  router.post("/verify-cash", async (_req, res) => {
    try {
      res.json(sanitizePublic(commissioningStatus(await port.verifyCash())));
    } catch {
      res.status(503).json({ error: "Cash precision verification is unavailable" });
    }
  });

  router.get("/policy", async (_req, res) => {
    try {
      res.json(sanitizePublic(await port.readPolicy()));
    } catch {
      res.status(503).json({ error: "Policy is unavailable" });
    }
  });

  router.post("/policy/propose", async (req, res) => {
    try {
      const actor = (res.locals.strata as { subject?: string } | undefined)?.subject ?? "";
      const result = await port.proposePolicy(req.body, actor);
      res.status(result.status === "PROPOSED" ? 200 : 400).json(sanitizePublic(result));
    } catch {
      res.status(503).json({ error: "Policy proposal is unavailable" });
    }
  });

  router.post("/policy/approve", async (_req, res) => {
    try {
      const actor = (res.locals.strata as { subject?: string } | undefined)?.subject ?? "";
      const result = await port.approvePolicy(actor);
      res.status(result.status === "APPROVED" ? 200 : 409).json(sanitizePublic(result));
    } catch {
      res.status(503).json({ error: "Policy approval is unavailable" });
    }
  });

  router.post("/minimum-exit/approve", async (req, res) => {
    try {
      const actor = (res.locals.strata as { subject?: string } | undefined)?.subject ?? "";
      const result = await port.approveMinimumExit(req.body?.minimumExitMicros, req.body?.confirm, actor);
      res.status(result.status === "APPROVED" ? 200 : 400).json(sanitizePublic(result));
    } catch {
      res.status(503).json({ error: "Minimum exit approval is unavailable" });
    }
  });

  router.post("/generate-index2-key", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    try {
      const result = await port.generateIndex2Key(req.body?.confirm);
      if (result.state === "generated" && result.apiKeyId && result.privateKey) {
        res.status(201).json({
          apiKeyId: result.apiKeyId,
          privateKey: result.privateKey,
          keyType: "rsa",
          subaccount: 1,
          scopes: [...STRATA_INDEX2_KEY_SCOPES],
          verified: false,
          workerStarted: false,
          environmentChanged: false,
          instructions: "Save apiKeyId in Railway as KALSHI_INDEX2_API_KEY_ID and privateKey as KALSHI_INDEX2_PRIVATE_KEY. This private key is shown once and is not stored. After Railway redeploys, POST /api/strata/commissioning/verify-signer must prove name Strata INDEX2, subaccount 1, scopes read and write::trade, a signed GET, and the balance on subaccount 1 exchange index 2. This response does not verify the key.",
        });
        return;
      }
      res.status(result.reason === "explicit_index2_generation_confirmation_required" ? 400 : 409).json(sanitizePublic({
        state: result.state,
        reason: result.reason,
        verified: false,
        keyMaterialReturned: false,
        workerStarted: false,
        environmentChanged: false,
      }));
    } catch {
      res.status(503).json({ error: "INDEX2 key generation is unavailable" });
    }
  });

  router.post("/replace-index2-key", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    if (req.body?.confirm !== STRATA_INDEX2_REPLACEMENT_CONFIRMATION) {
      res.status(400).json(sanitizePublic({
        state: "blocked",
        reason: "explicit_index2_replacement_confirmation_required",
        historicalPreserved: true,
        keyMaterialReturned: false,
        workerStarted: false,
        environmentChanged: false,
      }));
      return;
    }
    try {
      const result = await port.replaceIndex2Key(req.body?.confirm);
      if (result.state === "generated" && result.apiKeyId && result.privateKey) {
        res.status(201).json({
          apiKeyId: result.apiKeyId,
          privateKey: result.privateKey,
          keyType: "rsa",
          subaccount: 1,
          scopes: [...STRATA_INDEX2_KEY_SCOPES],
          verified: false,
          historicalPreserved: true,
          workerStarted: false,
          environmentChanged: false,
          instructions: "Save apiKeyId in Railway as KALSHI_INDEX2_API_KEY_ID and privateKey as KALSHI_INDEX2_PRIVATE_KEY. This private key is shown once and is not stored. Install it manually. This response does not fund, commission, arm, or start the worker.",
        });
        return;
      }
      res.status(409).json(sanitizePublic({
        state: result.state,
        reason: result.reason,
        verified: false,
        historicalPreserved: true,
        keyMaterialReturned: false,
        posts: result.posts,
        workerStarted: false,
        environmentChanged: false,
      }));
    } catch {
      res.status(503).json({ error: "INDEX2 key replacement is unavailable", historicalPreserved: true });
    }
  });

  router.post("/commission", async (req, res) => {
    if (req.body?.confirm !== "COMMISSION_WITHOUT_EXECUTION") {
      res.status(400).json(sanitizePublic({
        status: "BLOCKED",
        blockers: ["explicit_commission_confirmation_required"],
      }));
      return;
    }
    try {
      const actor = (res.locals.strata as { subject?: string } | undefined)?.subject ?? "";
      const result = await port.commission(req.body.confirm, actor);
      const planned = planCommission(await port.read());
      if (planned.plan && (planned.plan.executionEnabled !== false || planned.plan.killSwitch !== true)) {
        res.status(409).json(sanitizePublic({
          status: "BLOCKED",
          blockers: ["commission_plan_would_arm"],
        }));
        return;
      }
      res.status(result.status === "BLOCKED" ? 409 : 200).json(sanitizePublic(result));
    } catch {
      res.status(503).json({ error: "Commissioning is unavailable" });
    }
  });

  router.post("/arm", async (req, res) => {
    try {
      const result = await port.arm(req.body?.confirm);
      res.status(result.status === "ARMED" ? 200 : 409).json(sanitizePublic(result));
    } catch {
      res.status(503).json({ error: "Arming is unavailable" });
    }
  });

  router.post("/disarm", async (req, res) => {
    try {
      const result = await port.disarm(req.body?.confirm);
      res.status(result.status === "DISARMED" ? 200 : 409).json(sanitizePublic({
        ...result,
        emergencyStop: false,
      }));
    } catch {
      res.status(503).json({ error: "Disarm is unavailable" });
    }
  });

  return router;
}
