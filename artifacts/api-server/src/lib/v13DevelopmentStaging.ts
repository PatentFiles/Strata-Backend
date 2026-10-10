import type { RequestHandler } from "express";
import { V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";

/** Development-only review boundary; never grants production authority. */
export function isV13DevelopmentStaged(
  environment = process.env.NODE_ENV,
  reviewedRevision = process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED,
): boolean {
  return environment === "development" && reviewedRevision !== V13_ENTRY_POLICY_VERSION;
}

/** Run before authentication, provisioning, market proxies and mutable routes. */
export const v13DevelopmentStagingMiddleware: RequestHandler = (req, res, next) => {
  if (!isV13DevelopmentStaged()) return next();
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.path === "/api/healthz") {
    res.status(200).json({
      status: "staged", entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
      paperWorkerEnabled: false, liveWorkerEnabled: false,
      readyForPaper: false, readyForLive: false,
    });
    return;
  }
  res.status(503).json({
    error: "development_entry_policy_review_required",
    entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
    message: "Development is staged: workers and application routes remain disabled pending separate review.",
  });
};
