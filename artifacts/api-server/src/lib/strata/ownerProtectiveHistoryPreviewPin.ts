import {economicExitNotDischarged} from './economicExitDischargeScope';
import {createHash} from "node:crypto";
import {canonical} from "../v13-production/types";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BUILD=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
type Row=Record<string,unknown>;
type Db={query(sql:string,args:unknown[]):Promise<{rows:Row[]}>};
export const PIN_SQL=`
 SELECT a.id AS account_id,a.owner_user_id::text AS owner_id,a.kalshi_connection_id,
  a.key_fingerprint,r.reservation_id::text,r.order_request_json,r.order_digest,r.client_order_id,r.market_ticker,
  jsonb_build_array(a.xmin::text, w.xmin::text,w.fencing_token::text,
   fa.xmin::text,pc.xmin::text,c.xmin::text,c.vault_secret_id::text,
   r.xmin::text,i.xmin::text,p.xmin::text,i.id,p.id) AS revision
 FROM public.v13_production_account a
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id
  AND w.owner_user_id=a.owner_user_id AND w.credential_fingerprint=a.key_fingerprint
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id AND pc.id=w.provider_connection_id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id
  AND c.financial_account_id=fa.id AND c.provider_connection_id=pc.id
  AND c.key_fingerprint=a.key_fingerprint AND c.vault_secret_id=w.vault_secret_id
  AND c.role='restricted_execution' AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL
  AND c.verification_reason='credential_verified'
 JOIN private.strata_emergency_exit_reservations r ON r.execution_account_id=a.id AND r.owner_user_id=a.owner_user_id
  AND r.state='UNKNOWN' AND r.trading_authorized=false${economicExitNotDischarged("r.execution_account_id","r.client_order_id",true)}
  AND r.worker_holder_id=w.holder_id AND r.worker_fencing_token=w.fencing_token
 JOIN public.v13_production_intent i ON i.account_id=a.id AND i.client_order_id=r.client_order_id
  AND i.market=r.market_ticker AND i.kind='EXIT' AND i.state IN ('DISPATCHED','UNKNOWN') AND i.terminal=false
  AND i.dispatch_at IS NOT NULL AND i.exchange_order_id IS NULL
 JOIN public.v13_production_position p ON p.id=i.parent_id AND p.account_id=a.id
  AND p.market=r.market_ticker AND p.side=r.reducing_side
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
  AND fa.id=w.financial_account_id AND w.arm_requested=false
  AND ((w.state IN ('released','owned') AND w.account_kill=false) OR (w.state='killed' AND w.account_kill=true))
  AND (SELECT count(*) FROM private.strata_emergency_exit_reservations other
       WHERE other.execution_account_id=a.id AND other.state='UNKNOWN'${economicExitNotDischarged("other.execution_account_id","other.client_order_id",true)})=1
 LIMIT 2`;
export async function pinOwnerProtectiveHistory(db:Db, owner:string, release:string){
 if(!UUID.test(owner)||!BUILD.test(release))return null;
 const {rows}=await db.query(PIN_SQL,[owner]);
 if(rows.length!==1)return null;
 const row=rows[0]!,raw=row.order_request_json;
 if(row.owner_id!==owner||typeof row.account_id!=="string"||!UUID.test(String(row.reservation_id))||
   !DIGEST.test(String(row.key_fingerprint))||typeof raw!=="string"||raw.length>4096||
   createHash("sha256").update(raw).digest("hex")!==row.order_digest||
   !Array.isArray(row.revision)||row.revision.some(x=>x===null||x===undefined))return null;
 const order=JSON.parse(raw) as Row;
 if(order.client_order_id!==row.client_order_id||order.ticker!==row.market_ticker||
   order.reduce_only!==true||order.post_only!==false||order.time_in_force!=="immediate_or_cancel"||
   order.subaccount!==1||order.exchange_index!==2||
   !["ask","bid"].includes(String(order.side)))return null;
 return {row,order,digest:createHash("sha256").update(canonical({release,row})).digest("hex")};
}
