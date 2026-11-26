import {pool,type PoolClient} from '@workspace/db';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {digest,money,requireProof} from '../v13-production/types';

/** Deployment capability only. Customer consent and signed receipt checks remain
 * separate. An old binary or missing migration cannot enable cash movement. */
export const ownerCashTransfersEnabled=()=>process.env.STRATA_OWNER_CASH_TRANSFERS_V1_ENABLED==='true';
export async function assertCashTransferSchema(tx:Pick<PoolClient,'query'>){
 const r=await tx.query("SELECT to_regclass('private.strata_owner_cash_flow_receipt') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='v13_production_account' AND column_name='net_funding_micros') AS ready");
 requireProof(r.rows.length===1&&r.rows[0].ready===true,'cash_transfer_schema_not_ready');
}
/** Called ONLY after exact provider receipt, signed before/after cash, and the
 * stopped account are verified. The source journal must be marked complete in
 * THIS transaction. DB triggers independently bind journal, owner and amount.
 * No trade event, opening capital, risk policy, or realized P&L is edited. */
export async function recordOwnerCashFlow(tx:PoolClient,a:Account,input:{
 id:string;owner:string;direction:'TOPUP'|'WITHDRAWAL';providerId:string;
 beforeMicros:string;afterMicros:string;observedAtMs:number;evidence:unknown;
}){
 requireProof(a.owner_user_id===input.owner&&String(a.cash_micros)===input.beforeMicros&&
  a.net_funding_micros!==undefined&&a.reserved_micros==='0'&&
  Number.isSafeInteger(input.observedAtMs)&&input.observedAtMs<=Date.now()&&Date.now()-input.observedAtMs<=15000,
  'cash_flow_account_or_freshness_unverified');
 const ledger=new ProductionLedger(pool,a.id);
 await ledger.assertConservation(tx,a);
 const delta=money(input.afterMicros)-money(input.beforeMicros),before=money(a.net_funding_micros),after=before+delta;
 requireProof(input.direction==='TOPUP'?delta>0n:delta<0n,'cash_flow_direction_invalid');
 await tx.query(`INSERT INTO private.strata_owner_cash_flow_receipt(id,owner_user_id,execution_account_id,direction,
 provider_transfer_id,delta_micros,before_cash_micros,after_cash_micros,before_net_funding_micros,after_net_funding_micros,evidence_digest,observed_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
 [input.id,input.owner,a.id,input.direction,input.providerId,String(delta),input.beforeMicros,input.afterMicros,String(before),String(after),digest(input.evidence),new Date(input.observedAtMs)]);
 const updated=await tx.query(`UPDATE public.v13_production_account SET cash_micros=$3::bigint,net_funding_micros=$4::bigint,
 revision=revision+1,reconciled_at=$5 WHERE id=$1 AND owner_user_id=$2::uuid AND cash_micros=$6::bigint
 AND net_funding_micros=$7::bigint AND reserved_micros=0 RETURNING *`,
 [a.id,input.owner,input.afterMicros,String(after),new Date(input.observedAtMs),input.beforeMicros,String(before)]);
 requireProof(updated.rows.length===1,'cash_flow_account_changed');
 await ledger.assertConservation(tx,updated.rows[0] as Account);
 return updated.rows[0] as Account;
}
