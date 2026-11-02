import { pool } from "@workspace/db";
import { createProductionPersonalSession } from "./personalExecutionSupervisor";
import { readPublicMetadataPrefetchConfig } from "./publicMetadataPrefetchConfig";
import { createDatabaseUserScopePort } from "./userScopeDatabase";

/**
 * One authoritative owner worker map per Railway process. Both HTTP controls
 * and server-side withdrawal maintenance MUST use this same supervisor.
 */
// Read once per process construction. Invalid advisory config keeps the legacy
// path and must not prevent the existing supervisor's recovery/protection.
const publicMetadataPrefetch = readPublicMetadataPrefetchConfig(
  process.env.STRATA_PUBLIC_METADATA_PREFETCH_ENABLED,
);
if (publicMetadataPrefetch.source === "invalid") {
  try {
    // One bounded diagnostic; never echo arbitrary environment content.
    console.warn("strata_public_metadata_prefetch_config_invalid", {enabled:false});
  } catch { /* Optional diagnostics cannot disable mandatory recovery. */ }
}
export const personalTradingSession = createProductionPersonalSession(pool, {
  publicMetadataPrefetch: publicMetadataPrefetch.enabled,
});
export const personalTradingControls = createDatabaseUserScopePort(pool, {
  session: personalTradingSession,
});
