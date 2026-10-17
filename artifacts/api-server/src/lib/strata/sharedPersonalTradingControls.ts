import { pool } from "@workspace/db";
import { createProductionPersonalSession } from "./personalExecutionSupervisor";
import { createDatabaseUserScopePort } from "./userScopeDatabase";

/**
 * One authoritative owner worker map per Railway process. Both HTTP controls
 * and server-side withdrawal maintenance MUST use this same supervisor.
 */
export const personalTradingSession = createProductionPersonalSession(pool);
export const personalTradingControls = createDatabaseUserScopePort(pool, {
  session: personalTradingSession,
});
