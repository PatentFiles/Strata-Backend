import app from "./app";
import { logger } from "./lib/logger";
import { REVIEWED_RELEASE } from "./lib/strata/reviewedRelease";
import { isV13DevelopmentStaged } from "./lib/v13DevelopmentStaging";
import { startServerForwardTestWorker } from "./lib/forwardTestWorker";
import { startShadowObserver } from "./lib/shadowLive";
import { startFeeArtifactMonitor } from "./lib/microLiveFeeApproval";
import { verifyProductionShadowReads } from "./lib/productionShadowPreflight";
import { auditMicroLiveReadOnly, reconcileMicroLiveAtStartup } from "./lib/microLive";
import { establishOfficialFeeDigest } from "./lib/microLiveFeeArtifact";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, reviewedCommit: REVIEWED_RELEASE.commit, instances: 1 },
    "Server listening. Run one instance only so a second process cannot trade the same account.");
  if (isV13DevelopmentStaged()) {
    logger.info("Development staged: all background workers and exchange startup reads disabled pending revision review");
    return;
  }
  startFeeArtifactMonitor();
  if (process.env.NODE_ENV === "production" &&
      process.env.STRATA_FEE_BRIDGE_CANARY_ON_BOOT === "true") {
    // Explicitly enabled, GET-only production proof for the alternate fee
    // source. Do not write policy approvals, cash, risk limits, or trading flags.
    void establishOfficialFeeDigest().then((result) => {
      logger.info({
        verified: result.ok,
        reason: result.ok ? "canonical_pdf_strict_parser_verified" : result.reason,
        httpStatus: result.diagnostic.httpStatus,
        networkAttempts: result.diagnostic.networkAttempts,
      }, "Official Kalshi fee source canary completed; execution authority unchanged");
    }, (err: unknown) => {
      logger.error({ errorType: err instanceof Error ? err.name : "UnknownError" },
        "Official Kalshi fee source canary failed; execution authority unchanged");
    });
  }
  if (process.env.NODE_ENV === "production" &&
      process.env.SHADOW_LIVE_PRODUCTION_PREFLIGHT_ENABLED === "true" &&
      process.env.SHADOW_LIVE_PRODUCTION_ENABLED !== "true") {
    void verifyProductionShadowReads().then(
      () => logger.info("Production shadow GET-only preflight passed; observer remains disabled"),
      (error: unknown) => logger.error(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "Production shadow GET-only preflight failed; observer remains disabled",
      ),
    );
  }
  startShadowObserver();
  // Paper processing does not depend on the separately gated live recovery.
  startServerForwardTestWorker();
  void reconcileMicroLiveAtStartup().then((result) => {
    logger.info({ ready: result.ready, reason: result.reason },
      "Micro-live startup reconciliation barrier completed");
    if (["environment_flags_not_both_true", "database_flags_not_both_enabled",
      "micro_live_kill_switch_on"].includes(result.reason)) {
      void auditMicroLiveReadOnly().then((audit) => {
        logger.info({ reason: audit.reason },
          "Micro-live GET-only startup audit completed; execution remains blocked");
      }, (error: unknown) => {
        logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" },
          "Micro-live GET-only startup audit failed; execution remains blocked");
      });
    }
  }, (error: unknown) => {
    logger.error(
      { errorType: error instanceof Error ? error.name : "UnknownError" },
      "Micro-live startup reconciliation failed; execution remains blocked",
    );
  });
});
