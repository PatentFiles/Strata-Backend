export interface ProductionMasterState {
  count: number;
  mode: string | null;
  liveExecutionEnabled: boolean | null;
  manualKillSwitch: boolean | null;
}

export interface SqlClient {
  query: (text: string, values?: unknown[]) => Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
  }>;
}

const MODES = new Set(["PAPER_ONLY", "SHADOW_LIVE", "V13_PRODUCTION"]);

/** Database-equivalent fail-closed rule. Execution on requires V13_PRODUCTION and kill off. */
export function masterExecutionAllowed(
  mode: string,
  liveExecutionEnabled: boolean,
  manualKillSwitch: boolean,
): boolean {
  if (!MODES.has(mode)) return false;
  if ((mode === "PAPER_ONLY" || mode === "SHADOW_LIVE") && liveExecutionEnabled) return false;
  if (liveExecutionEnabled && manualKillSwitch) return false;
  return true;
}

export function masterIsFailClosed(master: ProductionMasterState): boolean {
  return master.count === 1 &&
    master.liveExecutionEnabled === false &&
    master.manualKillSwitch === true &&
    master.mode !== null &&
    masterExecutionAllowed(master.mode, false, true);
}

export function isProductionMasterReady(master: ProductionMasterState): boolean {
  return master.count === 1 &&
    master.mode === "V13_PRODUCTION" &&
    master.liveExecutionEnabled === true &&
    master.manualKillSwitch === false;
}

export const ARM_ACCOUNT_SQL = `UPDATE v13_production_account
      SET execution_enabled = true, kill_switch = false
      WHERE subaccount = 1 AND exchange_index = 2 AND commissioned = true
        AND execution_enabled = false AND kill_switch = true`;

export const ARM_MASTER_SQL = `UPDATE live_execution_config
      SET mode = 'V13_PRODUCTION', live_execution_enabled = true, manual_kill_switch = false, updated_at = now()
      WHERE id = 'singleton' AND live_execution_enabled = false AND manual_kill_switch = true`;

export const DISARM_ACCOUNT_SQL = `UPDATE v13_production_account
      SET execution_enabled = false, kill_switch = true
      WHERE subaccount = 1 AND exchange_index = 2 AND commissioned = true`;

export const DISARM_MASTER_SQL = `UPDATE live_execution_config
      SET live_execution_enabled = false, manual_kill_switch = true, updated_at = now()
      WHERE id = 'singleton'`;

async function rollback(client: SqlClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The failed statement may already have aborted the transaction.
  }
}

export async function armProductionAuthority(
  client: SqlClient,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await client.query("BEGIN");
  try {
    const account = await client.query(`SELECT id FROM v13_production_account
      WHERE subaccount = 1 AND exchange_index = 2 AND commissioned = true
        AND execution_enabled = false AND kill_switch = true
      FOR UPDATE`);
    if (account.rows.length !== 1) {
      await rollback(client);
      return { ok: false, reason: "production_account_not_disarmed" };
    }
    const master = await client.query(`SELECT mode, live_execution_enabled, manual_kill_switch
      FROM live_execution_config WHERE id = 'singleton' FOR UPDATE`);
    const row = master.rows[0];
    if (master.rows.length !== 1 || !row ||
        row.live_execution_enabled !== false || row.manual_kill_switch !== true ||
        typeof row.mode !== "string" || !masterExecutionAllowed(row.mode, false, true)) {
      await rollback(client);
      return { ok: false, reason: "production_master_not_fail_closed" };
    }
    const accountWrite = await client.query(ARM_ACCOUNT_SQL);
    if (accountWrite.rowCount !== 1) {
      await rollback(client);
      return { ok: false, reason: "production_account_arm_write_failed" };
    }
    const masterWrite = await client.query(ARM_MASTER_SQL);
    if (masterWrite.rowCount !== 1) {
      await rollback(client);
      return { ok: false, reason: "production_master_arm_write_failed" };
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch {
    await rollback(client);
    return { ok: false, reason: "production_arm_rolled_back" };
  }
}

export async function disarmProductionAuthority(
  client: SqlClient,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await client.query("BEGIN");
  try {
    const account = await client.query(`SELECT id FROM v13_production_account
      WHERE subaccount = 1 AND exchange_index = 2 AND commissioned = true
      FOR UPDATE`);
    if (account.rows.length !== 1) {
      await rollback(client);
      return { ok: false, reason: "production_account_missing" };
    }
    const master = await client.query(`SELECT id FROM live_execution_config
      WHERE id = 'singleton' FOR UPDATE`);
    if (master.rows.length !== 1) {
      await rollback(client);
      return { ok: false, reason: "production_master_singleton_required" };
    }
    const accountWrite = await client.query(DISARM_ACCOUNT_SQL);
    if (accountWrite.rowCount !== 1) {
      await rollback(client);
      return { ok: false, reason: "production_account_disarm_write_failed" };
    }
    const masterWrite = await client.query(DISARM_MASTER_SQL);
    if (masterWrite.rowCount !== 1) {
      await rollback(client);
      return { ok: false, reason: "production_master_disarm_write_failed" };
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch {
    await rollback(client);
    return { ok: false, reason: "production_disarm_rolled_back" };
  }
}
