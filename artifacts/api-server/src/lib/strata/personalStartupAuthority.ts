import { checkContinuousBootstrap, hasContinuousGrantHistory } from "./continuousExecutionAuthorization";
import { deployedGitSha } from "./deployedGitSha";
import { verifyProtectiveExitStartupRelease } from "./protectiveExitStartupRelease";

type Queryable = { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
export type PersonalStartupAuthority =
  | { ok: true; startupSha: string; standingMode: boolean }
  | { ok: false; reason: string };

/**
 * Read-only authority check shared by the status view, ARM preflight and START.
 * A STOP is not a revocation: reuse the genuine current-build owner authority.
 * An expired/revoked standing grant never falls back to the legacy release.
 * This creates no approvals, changes no money or leases, and submits no orders.
 * START still independently verifies the signed exchange and execution gates.
 */
export async function verifyPersonalStartupAuthority(
  db: Queryable, ownerId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<PersonalStartupAuthority> {
  const exitRelease = await verifyProtectiveExitStartupRelease(db, ownerId, env);
  const startupSha = deployedGitSha(env);
  let standingMode = false;
  if (/^[a-f0-9]{40}$/.test(startupSha)) {
    try { standingMode = await hasContinuousGrantHistory(db, ownerId, startupSha); }
    catch { return { ok: false, reason: "standing_authority_unavailable" }; }
  }
  if (standingMode) {
    if (!await checkContinuousBootstrap(db, ownerId, startupSha))
      return { ok: false, reason: "standing_grant_not_current" };
    if (env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE !== "true")
      return { ok: false, reason: "protective_exit_release_disabled" };
  } else if (!exitRelease.ok) {
    return { ok: false, reason: exitRelease.reason };
  }
  return { ok: true, startupSha, standingMode };
}
