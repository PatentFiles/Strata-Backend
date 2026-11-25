import { deployedGitSha } from "./deployedGitSha";

/** Exact source and digest are both independently reviewable, non-secret pins. */
export const PROTECTIVE_HISTORY_DIAGNOSTIC_SHA = "STRATA_PROTECTIVE_HISTORY_DIAGNOSTIC_SHA";
export const PROTECTIVE_HISTORY_DIAGNOSTIC_SOURCE_SHA256 = "STRATA_PROTECTIVE_HISTORY_DIAGNOSTIC_SOURCE_SHA256";
const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type DiagnosticBuild = Readonly<{
  revision: string | null;
  tree: string | null;
  dirty: boolean | null;
  provenance: string;
  version: string;
  sourceSha256: string;
  sourceFiles: number;
  digestPolicy: string;
  executionAuthority: string;
}>;
export type DiagnosticMode = "NORMAL" | "DIAGNOSTIC" | "REFUSE";

export function protectiveHistoryRuntimeMode(
  env: NodeJS.ProcessEnv, build: DiagnosticBuild | null,
): DiagnosticMode {
  const pin = env[PROTECTIVE_HISTORY_DIAGNOSTIC_SHA];
  const digest = env[PROTECTIVE_HISTORY_DIAGNOSTIC_SOURCE_SHA256];
  if (pin === undefined && digest === undefined) return "NORMAL";
  if (pin === undefined || digest === undefined || !FULL_SHA.test(pin) || !SHA256.test(digest) ||
      deployedGitSha(env) !== pin || !build || build.revision !== pin ||
      build.version !== "STRATA_BUILD_V1" || build.digestPolicy !== "sha256-path-length-lf-v1" ||
      build.executionAuthority !== "NONE" ||
      !Number.isSafeInteger(build.sourceFiles) || build.sourceFiles < 1 ||
      build.sourceSha256 !== digest) return "REFUSE";
  const cleanGit = build.provenance === "git-at-build" && build.dirty === false &&
    typeof build.tree === "string" && FULL_SHA.test(build.tree);
  // Hosted archive builds have no Git tree or dirty-state evidence. The
  // independently pinned source digest above is mandatory; do not invent
  // or accept contradictory Git metadata for this provider-only case.
  const providerArchive = build.provenance === "provider-commit-at-build" &&
    build.tree === null && build.dirty === null;
  return cleanGit || providerArchive ? "DIAGNOSTIC" : "REFUSE";
}

export function refuseOrdinaryStartupInDiagnosticMode(env: NodeJS.ProcessEnv): void {
  if (env[PROTECTIVE_HISTORY_DIAGNOSTIC_SHA] !== undefined ||
      env[PROTECTIVE_HISTORY_DIAGNOSTIC_SOURCE_SHA256] !== undefined)
    throw Error("protective_history_diagnostic_normal_runtime_forbidden");
}
