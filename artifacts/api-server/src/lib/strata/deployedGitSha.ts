/**
 * Railway injects RAILWAY_GIT_COMMIT_SHA at runtime when a deploy comes from
 * GitHub. https://docs.railway.com/variables/reference
 * This is not REVIEWED_RELEASE.commit.
 */
export const RAILWAY_DEPLOYED_SHA_ENV = "RAILWAY_GIT_COMMIT_SHA";
export const DEPLOYED_SHA_RUNTIME_UNAVAILABLE = "DEPLOYED_SHA_RUNTIME_UNAVAILABLE";

const FULL_GIT_SHA = /^[0-9a-fA-F]{40}$/;

export function deployedGitSha(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[RAILWAY_DEPLOYED_SHA_ENV];
  if (typeof value === "string" && FULL_GIT_SHA.test(value)) return value;
  return DEPLOYED_SHA_RUNTIME_UNAVAILABLE;
}

// The supported API entrypoint opts in before binding HTTP routes. There is
// no disable switch there; historical tests import workers without booting it.
let paperFreeApiRuntime=false;
export function activatePaperFreeApiRuntime(): void { paperFreeApiRuntime=true; }

/** The exact SHA option lets orders-off fixtures exercise the cutover as well. */
export function requireIndependentPaperCutover(env: NodeJS.ProcessEnv = process.env): boolean {
 const actual=deployedGitSha(env);
 return paperFreeApiRuntime || (actual!==DEPLOYED_SHA_RUNTIME_UNAVAILABLE&&
  env.STRATA_PAPER_ISOLATION_QUALIFIED_SHA===actual);
}
