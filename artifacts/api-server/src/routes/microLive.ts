import { getAuth } from "@clerk/express";
import { Router, type IRouter } from "express";
import {
  EmergencyStopMicroLiveBody,
  EmergencyStopMicroLiveResponse,
  GetMicroLiveStateResponse,
  GetMicroLiveFeeApprovalResponse,
  ArmMicroLiveBoundedRunBody,
  ArmMicroLiveBoundedRunResponse,
  PrepareNextMicroLiveBoundedRunBody,
  PrepareNextMicroLiveBoundedRunResponse,
  ResumeMicroLiveBoundedExitBody,
  ResumeMicroLiveBoundedExitResponse,
  ReviewMicroLiveFeePdfBody,
  ApproveMicroLiveFeePdfBody,
  RevokeMicroLiveFeeApprovalBody,
  ReconcileUncertainMicroLiveSubmissionBody,
  ReconcileUncertainMicroLiveSubmissionResponse,
  RecoverAndCancelUncertainExitBody,
  RecoverAndCancelUncertainExitResponse,
  ReconcileMicroLiveSettlementBody,
  ReconcileMicroLiveSettlementResponse,
} from "@workspace/api-zod";
import {
  emergencyStopMicroLive, getMicroLiveState, resolveStalePrimaryAccounting,
  armBoundedMicroLiveRun, resumeBoundedMicroLiveExitOnly,
  prepareNextBoundedMicroLiveRun, reviewPrimaryMicroLiveAccountBinding,
} from "../lib/microLive";
import {
  feeApprovalView, reviewFeeSchedulePdf, approveFeeSchedule, revokeFeeApproval,
  startFeeArtifactMonitor,
} from "../lib/microLiveFeeApproval";
import {
  reconcileUncertainSubmission,
  recoverAndCancelUncertainMicroLiveExit,
} from "../lib/microLiveRecovery";
import { reconcileMicroLiveSettlement } from "../lib/microLiveSettlement";
import { requirePhase4Admin } from "./phase4";

const router: IRouter = Router();

router.post("/micro-live/account-binding/review", requirePhase4Admin, async (req, res): Promise<void> => {
  if (process.env.NODE_ENV !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const body = req.body as { confirm?: unknown; reason?: unknown } | undefined;
  const actorId = getAuth(req).userId;
  if (!actorId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!body || Object.keys(body).sort().join(",") !== "confirm,reason" ||
      body.confirm !== true || typeof body.reason !== "string" ||
      body.reason.trim().length < 16 || body.reason.trim().length > 512) {
    res.status(400).json({ error: "Explicit confirmation and review reason are required" });
    return;
  }
  try {
    const result = await reviewPrimaryMicroLiveAccountBinding({ actorId, reason: body.reason });
    res.status(result.status === "blocked" ? 409 : 200).json(result);
  } catch {
    res.status(503).json({ error: "Primary account binding review unavailable" });
  }
});

// Integration tests run against isolated databases and use mocked fetches in
// focused module tests; never start a real-source monitor in that environment.
if (!process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA) startFeeArtifactMonitor();

router.get("/micro-live/fee-approval", requirePhase4Admin, async (_req, res): Promise<void> => {
  try {
    res.json(GetMicroLiveFeeApprovalResponse.parse(await feeApprovalView()));
  } catch {
    res.status(503).json({ error: "Standing fee-policy state is unavailable" });
  }
});

router.post("/micro-live/bounded-run/arm", requirePhase4Admin, async (req, res): Promise<void> => {
  if (process.env.NODE_ENV !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const input = ArmMicroLiveBoundedRunBody.safeParse(req.body);
  if (!input.success || Object.keys(req.body ?? {}).length !== 1 || input.data.confirm !== true) {
    res.status(400).json({ error: "Explicit confirmation is required" });
    return;
  }
  try {
    const result = ArmMicroLiveBoundedRunResponse.parse(await armBoundedMicroLiveRun());
    res.status(result.status === "blocked" ? 409 : 200).json(result);
  } catch {
    res.status(503).json({ error: "Bounded run could not be armed" });
  }
});

router.post("/micro-live/bounded-run/prepare-next", requirePhase4Admin, async (req, res): Promise<void> => {
  if (process.env.NODE_ENV !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const input = PrepareNextMicroLiveBoundedRunBody.safeParse(req.body);
  if (!input.success || Object.keys(req.body ?? {}).sort().join(",") !== "confirm,priorRunId,reason" ||
      input.data.confirm !== true || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.data.priorRunId) ||
      input.data.reason.trim().length < 16) {
    res.status(400).json({ error: "Explicit confirmation, prior run ID, and audit reason are required" });
    return;
  }
  const actorId = getAuth(req).userId;
  if (!actorId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = PrepareNextMicroLiveBoundedRunResponse.parse(
      await prepareNextBoundedMicroLiveRun({
        actorId, priorRunId: input.data.priorRunId, reason: input.data.reason.trim(),
      }));
    res.status(result.status === "blocked" ? 409 : 200).json(result);
  } catch {
    res.status(503).json({ error: "New bounded development run could not be prepared" });
  }
});

router.post("/micro-live/bounded-run/resume-exit", requirePhase4Admin, async (req, res): Promise<void> => {
  if (process.env.NODE_ENV !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const input = ResumeMicroLiveBoundedExitBody.safeParse(req.body);
  if (!input.success || Object.keys(req.body ?? {}).length !== 1 || input.data.confirm !== true) {
    res.status(400).json({ error: "Explicit confirmation is required" });
    return;
  }
  try {
    const result = ResumeMicroLiveBoundedExitResponse.parse(await resumeBoundedMicroLiveExitOnly());
    res.status(result.status === "blocked" ? 409 : 200).json(result);
  } catch {
    res.status(503).json({ error: "Exit-only recovery unavailable" });
  }
});

router.post("/micro-live/fee-review", requirePhase4Admin, async (req, res): Promise<void> => {
  const input = ReviewMicroLiveFeePdfBody.safeParse(req.body);
  if (!input.success || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data.pdfBase64)) {
    res.status(400).json({ error: "A base64 PDF under 2 MB is required" });
    return;
  }
  try {
    res.json(await reviewFeeSchedulePdf(Buffer.from(input.data.pdfBase64, "base64")));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "PDF could not be reviewed" });
  }
});

router.post("/micro-live/fee-approve", requirePhase4Admin, async (req, res): Promise<void> => {
  const input = ApproveMicroLiveFeePdfBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "Review ID and PDF digest are required" });
    return;
  }
  const actorId = getAuth(req).userId;
  if (!actorId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const approved = await approveFeeSchedule(input.data.reviewId, input.data.digest, actorId);
    if (!approved) {
      res.status(409).json({ error: "The PDF review changed or policy approval was blocked" });
      return;
    }
    res.json(GetMicroLiveFeeApprovalResponse.parse(approved));
  } catch (error) {
    const detail = error instanceof Error &&
      /^official_fee_schedule_|^approved_artifact_identity_invalid/.test(error.message)
      ? `Canonical fee artifact verification failed: ${error.message}`
      : "Standing fee policy could not be persisted";
    res.status(503).json({ error: detail });
  }
});

router.post("/micro-live/fee-revoke", requirePhase4Admin, async (req, res): Promise<void> => {
  const input = RevokeMicroLiveFeeApprovalBody.safeParse(req.body);
  if (!input.success || Object.keys(req.body ?? {}).length !== 1 || input.data.confirm !== true) {
    res.status(400).json({ error: "Explicit confirmation is required to revoke the standing fee policy" });
    return;
  }
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    await revokeFeeApproval();
    res.json(GetMicroLiveFeeApprovalResponse.parse(await feeApprovalView()));
  } catch {
    res.status(503).json({ error: "Standing fee policy could not be revoked" });
  }
});

router.get("/micro-live/state", requirePhase4Admin, async (_req, res): Promise<void> => {
  try {
    const response = GetMicroLiveStateResponse.safeParse(await getMicroLiveState());
    if (!response.success) {
      res.status(503).json({ error: "Micro-live state is invalid" });
      return;
    }
    res.json(response.data);
  } catch {
    res.status(503).json({ error: "Micro-live state is unavailable" });
  }
});

router.post("/micro-live/emergency-stop", requirePhase4Admin, async (req, res): Promise<void> => {
  const input = EmergencyStopMicroLiveBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "Invalid emergency-stop request" });
    return;
  }

  try {
    const response = EmergencyStopMicroLiveResponse.safeParse(await emergencyStopMicroLive());
    if (!response.success) {
      res.status(503).json({ error: "Micro-live state is invalid" });
      return;
    }
    res.json(response.data);
  } catch {
    res.status(503).json({ error: "Unable to persist micro-live emergency stop" });
  }
});

router.post("/micro-live/resolve-stale-accounting", requirePhase4Admin, async (req, res): Promise<void> => {
  const input: unknown = req.body;
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "expectedUnresolvedReason,resolutionReason" ||
      !("expectedUnresolvedReason" in input) ||
      input.expectedUnresolvedReason !== "startup_exchange_reconciliation_failed" ||
      !("resolutionReason" in input) || typeof input.resolutionReason !== "string" ||
      input.resolutionReason.trim().length < 16 || input.resolutionReason.trim().length > 512) {
    res.status(400).json({ error: "An explicit resolution reason and expected startup error are required" });
    return;
  }
  try {
    const actorId = getAuth(req).userId;
    if (!actorId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const result = await resolveStalePrimaryAccounting({
      actorId, expectedUnresolvedReason: input.expectedUnresolvedReason,
      resolutionReason: input.resolutionReason,
    });
    res.status(result.status === "resolved" ? 200 : 409).json(result);
  } catch {
    res.status(503).json({ error: "Accounting resolution could not be committed" });
  }
});

router.post("/micro-live/reconcile-uncertain", requirePhase4Admin, async (req, res): Promise<void> => {
  const input = ReconcileUncertainMicroLiveSubmissionBody.safeParse(req.body);
  if (!input.success || !/^[0-9a-f-]{36}$/i.test(input.data.orderId)) {
    res.status(400).json({ error: "A local order ID is required" });
    return;
  }
  try {
    const actorId = getAuth(req).userId;
    if (!actorId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const result = ReconcileUncertainMicroLiveSubmissionResponse.safeParse(
      await reconcileUncertainSubmission(input.data.orderId, actorId));
    if (!result.success) {
      res.status(503).json({ error: "Recovery result is invalid" });
      return;
    }
    res.status(result.data.status === "blocked" ? 409 : 200).json(result.data);
  } catch {
    res.status(503).json({ error: "Unable to reconcile uncertain submission" });
  }
});

router.post("/micro-live/recover-and-cancel-uncertain-exit", requirePhase4Admin, async (req, res): Promise<void> => {
  const input = RecoverAndCancelUncertainExitBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "A valid local order ID is required" });
    return;
  }
  try {
    const actorId = getAuth(req).userId;
    if (!actorId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const result = RecoverAndCancelUncertainExitResponse.safeParse(
      await recoverAndCancelUncertainMicroLiveExit(input.data.orderId, actorId));
    if (!result.success) {
      res.status(503).json({ error: "Recovery result is invalid" });
      return;
    }
    res.status(result.data.status === "blocked" ? 409 : 200).json(result.data);
  } catch {
    res.status(503).json({ error: "Unable to recover and cancel uncertain exit" });
  }
});

router.post("/micro-live/reconcile-settlement", requirePhase4Admin, async (req, res): Promise<void> => {
  const input = ReconcileMicroLiveSettlementBody.safeParse(req.body);
  if (!input.success || !/^[A-Za-z0-9:._-]{1,256}$/.test(input.data.positionId)) {
    res.status(400).json({ error: "A valid local position ID is required" });
    return;
  }
  try {
    const actorId = getAuth(req).userId;
    if (!actorId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const result = ReconcileMicroLiveSettlementResponse.safeParse(
      await reconcileMicroLiveSettlement(input.data.positionId, actorId));
    if (!result.success) {
      res.status(503).json({ error: "Settlement result is invalid" });
      return;
    }
    res.status(result.data.status === "blocked" ? 409 : 200).json(result.data);
  } catch {
    res.status(503).json({ error: "Unable to reconcile settlement" });
  }
});

export default router;