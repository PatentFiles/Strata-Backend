import { pool } from "@workspace/db";
import {
  parseConfiguredStakeCents,
  stakeStatus,
  validateConfiguredStake,
  type ConfiguredStakeStatus,
  type StakeFacts,
} from "./configuredStake";

export interface StakeMutationResult {
  status: 200 | 400 | 409 | 503;
  body: ConfiguredStakeStatus & { reason?: string };
}

async function facts(workerRunning: boolean, query: { query: typeof pool.query } = pool): Promise<StakeFacts> {
  const { rows } = await query.query<{
    configured: number | null;
    revision: number | null;
    max_stake: number | null;
    cash: string | null;
    reserved: string | null;
    open: string;
    prepared: string;
    dispatched: string;
    unknown: string;
    unresolved: string;
  }>(`SELECT
      (SELECT configured_stake_cents FROM strata_configured_stake WHERE id='production') AS configured,
      (SELECT revision FROM strata_configured_stake WHERE id='production') AS revision,
      (SELECT p.max_entry_stake_cents FROM v13_live_money_policy p
        JOIN v13_production_account a ON a.policy_id=p.id
        WHERE p.state='APPROVED' LIMIT 1) AS max_stake,
      (SELECT cash_micros::text FROM v13_production_account LIMIT 1) AS cash,
      (SELECT reserved_micros::text FROM v13_production_account LIMIT 1) AS reserved,
      (SELECT count(*) FROM v13_production_position WHERE quantity_hundredths>0) AS open,
      (SELECT count(*) FROM v13_production_intent WHERE state='PREPARED') AS prepared,
      (SELECT count(*) FROM v13_production_intent WHERE state='DISPATCHED') AS dispatched,
      (SELECT count(*) FROM v13_production_intent WHERE state='UNKNOWN') AS unknown,
      (SELECT count(*) FROM v13_production_intent WHERE state NOT IN ('TERMINAL','BLOCKED')) AS unresolved`);
  const row = rows[0];
  const cash = row?.cash === null || row?.cash === undefined ? null : Number(row.cash);
  const reserved = row?.reserved === null || row?.reserved === undefined ? null : Number(row.reserved);
  const available = cash === null || reserved === null || !Number.isSafeInteger(cash) || !Number.isSafeInteger(reserved)
    ? null : Math.floor((cash - reserved) / 10_000);
  return {
    configuredStakeCents: row?.configured ?? null,
    revision: row?.revision ?? null,
    approvedMaxEntryStakeCents: row?.max_stake ?? null,
    availableCashCents: available !== null && available >= 0 ? available : null,
    workerRunning,
    openPositionCount: Number(row?.open ?? 0),
    preparedIntentCount: Number(row?.prepared ?? 0),
    dispatchedIntentCount: Number(row?.dispatched ?? 0),
    unknownIntentCount: Number(row?.unknown ?? 0),
    unresolvedOrderCount: Number(row?.unresolved ?? 0),
  };
}

export function createDatabaseStakePort(workerRunning: () => boolean) {
  return {
    async read(): Promise<ConfiguredStakeStatus> {
      return stakeStatus(await facts(workerRunning()));
    },
    async update(body: unknown): Promise<StakeMutationResult> {
      const raw = body && typeof body === "object" ? (body as { configuredStakeCents?: unknown }).configuredStakeCents : undefined;
      const parsed = parseConfiguredStakeCents(raw);
      if (!parsed.ok) {
        const current = stakeStatus(await facts(workerRunning()).catch(() => emptyFacts(workerRunning())));
        return { status: 400, body: { ...current, reason: parsed.reason, editable: false } };
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await facts(workerRunning(), client);
        const decision = validateConfiguredStake(current, parsed.cents);
        if (!decision.ok) {
          await client.query("ROLLBACK");
          return { status: decision.status, body: { ...stakeStatus(current), editable: false, reason: decision.reason, blockers: decision.blockers } };
        }
        const nextRevision = (current.revision ?? 0) + 1;
        const saved = await client.query(`INSERT INTO strata_configured_stake(id, configured_stake_cents, revision, updated_at)
          VALUES('production',$1,1,now())
          ON CONFLICT (id) DO UPDATE SET configured_stake_cents=$1, revision=strata_configured_stake.revision+1, updated_at=now()
          WHERE strata_configured_stake.revision=$2
          RETURNING revision`, [parsed.cents, current.revision]);
        if (saved.rows.length !== 1 || Number(saved.rows[0].revision) !== nextRevision) {
          await client.query("ROLLBACK");
          return { status: 409, body: { ...stakeStatus(current), editable: false, reason: "stake_revision_conflict", blockers: ["stake_revision_conflict"] } };
        }
        await client.query("COMMIT");
        return { status: 200, body: stakeStatus({ ...current, configuredStakeCents: parsed.cents, revision: nextRevision }) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function emptyFacts(workerRunning: boolean): StakeFacts {
  return {
    configuredStakeCents: null, revision: null, approvedMaxEntryStakeCents: null, availableCashCents: null,
    workerRunning, openPositionCount: 0, preparedIntentCount: 0, dispatchedIntentCount: 0, unknownIntentCount: 0,
    unresolvedOrderCount: 0,
  };
}
