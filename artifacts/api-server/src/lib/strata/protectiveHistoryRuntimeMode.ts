import { deployedGitSha } from "./deployedGitSha";

/** A single, revocable non-secret opt-in for the exact diagnostic executable. */
export const PROTECTIVE_HISTORY_DIAGNOSTIC_SHA = "STRATA_PROTECTIVE_HISTORY_DIAGNOSTIC_SHA";
const FULL_SHA = /^[a-f0-9]{40}$/;

export type DiagnosticBuild = Readonly<{
  revision: string | null;
  tree: string | null;
  dirty: boolean | null;
  provenance: string;
}>;
export type DiagnosticMode = "NORMAL" | "DIAGNOSTIC" | "REFUSE";

export function protectiveHistoryRuntimeMode(
  env: NodeJS.ProcessEnv, build: DiagnosticBuild | null,
): DiagnosticMode {
  const pin = env[PROTECTIVE_HISTORY_DIAGNOSTIC_SHA];
  if (pin === undefined) return "NORMAL";
  if (!FULL_SHA.test(pin) || deployedGitSha(env) !== pin ||
      build?.revision !== pin || build.provenance !== "git-at-build" ||
      build.dirty !== false || !build.tree || !FULL_SHA.test(build.tree)) return "REFUSE";
  return "DIAGNOSTIC";
}

export function refuseOrdinaryStartupInDiagnosticMode(env: NodeJS.ProcessEnv): void {
  if (env[PROTECTIVE_HISTORY_DIAGNOSTIC_SHA] !== undefined)
    throw Error("protective_history_diagnostic_normal_runtime_forbidden");
}
