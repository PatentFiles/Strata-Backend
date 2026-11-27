import {createHash} from "node:crypto";
import {attributeHistoryPage} from './historyBotAttribution';
import {pool,type Pool} from "@workspace/db";
import {parseLiveHistoryQuery,LiveHistoryRequestError,projectHistoryIntentBatchSql} from "./liveHistoryReadModel";

type Actor={subject:string;role:string|null};
type Phase="decisions"|"intents";
type Cursor={phase:Phase;at:string|null;id:string|null;watermark:string;binding:string};
type ExportRow={row_id:string;observed_at:string;account_id:string;record_type:string;
 reason_code:string|null;details:Record<string,unknown>;[key:string]:unknown};
function invalid():never{throw new LiveHistoryRequestError(400,"invalid_live_history_export_cursor");}
const encode=(v:Cursor)=>Buffer.from(JSON.stringify([1,v.phase,v.at,v.id,v.watermark,v.binding])).toString("base64url");
const validDate=(s:unknown):s is string=>typeof s==="string"&&s.length<=64&&Number.isFinite(Date.parse(s));
function decode(raw:unknown,binding:string):Cursor|null{
 if(raw===undefined)return null;
 if(typeof raw!=="string"||!raw.length||raw.length>2048)invalid();
 try{
  const a:unknown=JSON.parse(Buffer.from(raw,"base64url").toString("utf8"));
  if(!Array.isArray(a)||a.length!==6||a[0]!==1||!['decisions','intents'].includes(a[1])||a[5]!==binding||
   !validDate(a[4])||Date.parse(a[4])>Date.now()+60000||
   !(a[2]===null&&a[3]===null||validDate(a[2])&&typeof a[3]==="string"&&a[3].length>0&&a[3].length<=200&&/^[A-Za-z0-9._:-]+$/.test(a[3])))invalid();
  if(a[1]==="decisions"&&a[3]!==null&&!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(a[3]))invalid();
  return {phase:a[1],at:a[2],id:a[3],watermark:a[4],binding};
 }catch{invalid();}
}

// Direct keyset scan: no repeated whole-history aggregates or growing OFFSET.
// Existing owner/account/time indexes serve this path. Source order is explicitly
// decisions first, ledger second; timestamps and raw identifiers remain intact.
const DECISIONS=`SELECT 'decision:'||d.id::text AS row_id,d.observed_at::text AS observed_at,
 d.execution_account_id AS account_id,COALESCE(NULLIF(btrim(p.display_name),''),'Unnamed account') AS account_name,
 d.market_ticker AS market,d.direction,d.signal,d.outcome AS status,d.reason_code,d.reason_detail,d.strategy_version,
 'LIVE_DECISION'::text AS record_type,0 AS submitted_orders,'0'::text AS fill_count,
 NULL::text AS net_pnl_micros,NULL::text AS fee_micros,
 jsonb_build_object('decisionId',d.id,'stage',d.stage,'directSourceId',d.direct_source_id,
 'releaseSha',d.release_commit_sha,'policyHash',d.policy_hash,'policyRevision',d.policy_revision,
 'configuredStakeCents',d.configured_stake_cents,'allocationPreset',d.allocation_preset,
 'strategyParameterHash',d.strategy_parameter_hash,'facts',d.facts,'recordedAt',d.recorded_at) AS details
 FROM private.strata_live_decision_log_v1 d
 JOIN public.v13_production_account a ON a.id=d.execution_account_id AND a.owner_user_id=d.owner_user_id
 LEFT JOIN public.profiles p ON p.id=a.owner_user_id
 WHERE a.owner_user_id IS NOT NULL AND a.subaccount=1 AND a.exchange_index=2
 AND ($2::boolean OR a.owner_user_id=$1::uuid) AND ($3::text IS NULL OR a.id=$3)
 AND d.observed_at BETWEEN $4::timestamptz AND $5::timestamptz AND d.recorded_at<=$14::timestamptz
 AND ($6::text IS NULL OR d.outcome=$6) AND ($7::text IS NULL OR d.direction=$7)
 AND ($8::text IS NULL OR position(upper($8) in upper(d.market_ticker))>0)
 AND ($9::text IS NULL OR d.strategy_version=$9)
 AND ($10::text IS NULL OR position(lower($10) in lower(coalesce(d.reason_code,'')||' '||coalesce(d.reason_detail,'')))>0)
 AND ($11::timestamptz IS NULL OR (d.observed_at,d.id)<($11::timestamptz,$12::uuid))
 ORDER BY d.observed_at DESC,d.id DESC LIMIT $13`;

/** One bounded, owner-authenticated read transaction per batch. No production
 * credentials in cursors, no changes to financial records, and no long-lived
 * transaction while a slow browser writes to disk. Every batch rechecks admin
 * authority. Cursor binding detects accidental scope/filter changes, not grants.
 * Immutable decisions use recorded_at watermark; ledger values may advance
 * between batches. This is intentionally NOT called an atomic account snapshot.
 */
export async function readLiveHistoryExportBatch(actor:Actor,raw:Record<string,unknown>,db:Pick<Pool,"connect">=pool){
 const q=parseLiveHistoryQuery({...raw,cursor:undefined},actor,Date.now(),"export");
 const binding=createHash('sha256').update(JSON.stringify([actor.subject,q.scope,q.account,q.from,q.to,q.status,q.direction,q.market,q.strategy,q.reason,q.recordType])).digest('hex');
 const saved=decode(raw.cursor,binding);
 const c=await db.connect();let discard:Error|undefined;
 try{
  await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await c.query("SET LOCAL statement_timeout='4s'; SET LOCAL lock_timeout='500ms'");
  if(q.scope==="all"){
   const role=await c.query("SELECT role FROM public.profiles WHERE id=$1::uuid",[actor.subject]);
   if(role.rows.length!==1||role.rows[0]?.role!=="ADMIN")throw new LiveHistoryRequestError(403,"administrator_scope_required");
  }
  const watermark=saved?.watermark??(await c.query("SELECT clock_timestamp()::text AS cutoff")).rows[0]?.cutoff;
  if(!validDate(watermark))throw Error('live_history_export_cutoff_unavailable');
  const phase=saved?.phase??"decisions";
  const params=[actor.subject,q.scope==="all",q.account,q.from,q.to,q.status,q.direction,q.market,q.strategy,q.reason,saved?.at??null,saved?.id??null,q.limit+1,watermark];
  let rows:ExportRow[],nextCursor:string|null,scannedRows:number;
  if(phase==="decisions"){
   const result=q.recordType==='LEDGER_INTENT'?{rows:[]}:await c.query<ExportRow>(DECISIONS,params);
   rows=result.rows.slice(0,q.limit);scannedRows=rows.length;
   const last=rows.at(-1);
   nextCursor=result.rows.length>q.limit&&last?encode({phase,at:last.observed_at,id:last.row_id.slice(9),watermark,binding}):
    encode({phase:"intents",at:null,id:null,watermark,binding});
  }else if(q.recordType==='LIVE_DECISION'){
   rows=[];scannedRows=0;nextCursor=null;
  }else{
   // Page raw intent identities first. Financial projections and linked events
   // are evaluated only for this bounded batch, with the exact screen formulas.
   const result=await c.query<{id:string;at:string}>(`SELECT i.id,i.created_at::text AS at
    FROM public.v13_production_intent i JOIN public.v13_production_account a ON a.id=i.account_id
    WHERE a.owner_user_id IS NOT NULL AND a.subaccount=1 AND a.exchange_index=2
    AND ($2::boolean OR a.owner_user_id=$1::uuid) AND ($3::text IS NULL OR a.id=$3)
    AND i.created_at BETWEEN $4::timestamptz AND $5::timestamptz AND i.created_at<=$6::timestamptz
    AND ($7::timestamptz IS NULL OR (i.created_at,i.id)<($7::timestamptz,$8::text))
    ORDER BY i.created_at DESC,i.id DESC LIMIT $9`,
    [actor.subject,q.scope==="all",q.account,q.from,q.to,watermark,saved?.at??null,saved?.id??null,q.limit+1]);
   const candidates=result.rows.slice(0,q.limit);scannedRows=candidates.length;rows=[];
   if(candidates.length){
    const projection=await c.query(projectHistoryIntentBatchSql(),[
     actor.subject,q.scope==="all",q.account,q.from,q.to,q.status,q.direction,q.market,q.strategy,q.reason,null,null,q.limit,candidates.map(v=>v.id),q.recordType]);
    if(!Array.isArray(projection.rows[0]?.rows))throw Error('live_history_export_projection_unavailable');
    rows=projection.rows[0].rows;
   }
   const last=candidates.at(-1);
   nextCursor=result.rows.length>q.limit&&last?encode({phase,at:last.at,id:last.id,watermark,binding}):null;
  }
  const attributed=await attributeHistoryPage(c,rows);
  await c.query("COMMIT");
  return {version:"LIVE_HISTORY_EXPORT_V1" as const,scope:q.scope,from:q.from,to:q.to,recordType:q.recordType,watermark,phase,
   rows:attributed,scannedRows,nextCursor,order:"decisions_then_ledger_desc",
   consistency:"Decision journal is bounded by recording cutoff; ledger values are read per batch, not an atomic whole-account snapshot. Missing historical decisions are not reconstructed."};
 }catch(error){try{await c.query('ROLLBACK');}catch{discard=Error('live_history_export_rollback_failed');}throw error;}
 finally{c.release(discard);}
}