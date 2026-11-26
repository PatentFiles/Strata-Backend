import {requireProof} from './types';

/** Adjacent reads only, under the caller's existing account lock. A pending
 * reservation remains the first refusal; no stake/authority lock is moved. */
export const PREPARE_ENTRY_CAPACITY_SQL = `WITH pending AS MATERIALIZED (
 SELECT EXISTS(SELECT 1 FROM v13_production_intent WHERE account_id=$1 AND state='PREPARED') AS has_prepared
) SELECT has_prepared,
 CASE WHEN NOT has_prepared THEN (SELECT count(*)::text FROM v13_production_position WHERE account_id=$1 AND quantity_hundredths>0) END AS open,
 CASE WHEN NOT has_prepared THEN (SELECT coalesce(sum(basis_micros),0)::text FROM v13_production_position WHERE account_id=$1) END AS basis,
 CASE WHEN NOT has_prepared THEN (SELECT coalesce(sum(-least(pnl_micros,0)),0)::text FROM v13_production_event WHERE account_id=$1) END AS total_loss,
 CASE WHEN NOT has_prepared THEN (SELECT coalesce(sum(-least(pnl_micros,0)),0)::text FROM v13_production_event WHERE account_id=$1 AND occurred_at >= $2) END AS daily_loss
 FROM pending`;

export async function readPrepareEntryCapacity(
 query:(sql:string,params:unknown[])=>Promise<{rows:Record<string,unknown>[]}>,
 accountId:string,dayStart:Date,
):Promise<{open:string;basis:string;total_loss:string;daily_loss:string}> {
 const {rows}=await query(PREPARE_ENTRY_CAPACITY_SQL,[accountId,dayStart]);
 requireProof(Array.isArray(rows)&&rows.length===1&&rows[0]&&typeof rows[0].has_prepared==='boolean',
  'production_prepare_capacity_unverified');
 const row=rows[0];
 requireProof(row.has_prepared===false,'production_prepared_order_blocks_entry');
 for(const key of ['open','basis','total_loss','daily_loss'])requireProof(
  typeof row[key]==='string'&&/^(0|[1-9][0-9]*)$/.test(row[key] as string),
  'production_prepare_capacity_unverified');
 requireProof(Number.isSafeInteger(Number(row.open)),'production_prepare_capacity_unverified');
 return {open:row.open as string,basis:row.basis as string,total_loss:row.total_loss as string,daily_loss:row.daily_loss as string};
}
