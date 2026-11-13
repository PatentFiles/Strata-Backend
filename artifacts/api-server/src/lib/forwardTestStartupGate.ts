/**
 * Pure startup preflight for the PAPER_ONLY market-evaluation producer.
 * This file has no database, network, signer or order execution dependencies.
 * The producer can generate candidate evaluations, never grant live authority.
 */
export interface ForwardTestStartupEnv {
  NODE_ENV?: string;
  V13_ENTRY_POLICY_RUNTIME_APPROVED?: string;
  FORWARD_TEST_WORKER_ENABLED?: string;
  FORWARD_TEST_PRODUCTION_WORKER_ENABLED?: string;
}

export type ForwardTestStartupReason =
  | "ready"
  | "unsupported_environment"
  | "entry_policy_approval_missing"
  | "entry_policy_approval_mismatch"
  | "production_signal_worker_disabled"
  | "development_signal_worker_disabled";

export interface ForwardTestStartupDecision {
  ready: boolean;
  reason: ForwardTestStartupReason;
  mode: "PAPER_ONLY";
}

/** A development flag can never enable production, and vice versa. */
export function isForwardTestWorkerEnabled(
  environment: string | undefined,
  developmentFlag: string | undefined,
  productionFlag: string | undefined,
): boolean {
  return environment === "development"
    ? developmentFlag === "true"
    : environment === "production" && productionFlag === "true";
}

/**
 * Exact-match review guard. No trimming, permissive coercion or fallback
 * to the development flag is allowed on production.
 */
export function forwardTestStartupDecision(
  env: ForwardTestStartupEnv,
  requiredEntryPolicyVersion: string,
): ForwardTestStartupDecision {
  const refused = (reason: Exclude<ForwardTestStartupReason, "ready">): ForwardTestStartupDecision =>
    ({ ready: false, reason, mode: "PAPER_ONLY" });
  if (env.NODE_ENV !== "production" && env.NODE_ENV !== "development") {
    return refused("unsupported_environment");
  }
  if (env.V13_ENTRY_POLICY_RUNTIME_APPROVED === undefined) {
    return refused("entry_policy_approval_missing");
  }
  if (env.V13_ENTRY_POLICY_RUNTIME_APPROVED !== requiredEntryPolicyVersion) {
    return refused("entry_policy_approval_mismatch");
  }
  if (!isForwardTestWorkerEnabled(
    env.NODE_ENV, env.FORWARD_TEST_WORKER_ENABLED, env.FORWARD_TEST_PRODUCTION_WORKER_ENABLED,
  )) {
    return refused(env.NODE_ENV === "production"
      ? "production_signal_worker_disabled" : "development_signal_worker_disabled");
  }
  return { ready: true, reason: "ready", mode: "PAPER_ONLY" };
}
