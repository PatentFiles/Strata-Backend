import {V13_CHAMPION_PARAMETER_SET} from '@workspace/v13-strategy';
import {WARREN_BOT} from '../strategies/warrenBotIdentity';

/** Export evidence, never execution authority. Historical attribution is
 * explicitly labelled as inferred unless the immutable event records a bot. */
export type HistoryBotSource =
  'RECORDED_OBSERVATION'|'RECORDED_INTENT'|'SELECTION_HISTORY_INFERRED'|
  'WARREN_REASON_INFERRED'|'UNATTRIBUTED';
type HistoryRow={row_id:string;observed_at:string;account_id:string;record_type:string;
  reason_code:string|null;details:Record<string,unknown>;[key:string]:unknown};
type Selection={execution_account_id:string;to_bot_id:string;approved_at:string;release_sha:string};
type Reader={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
const CHAMPION=V13_CHAMPION_PARAMETER_SET.id;
const isBot=(value:unknown):value is string=>value===CHAMPION||value===WARREN_BOT;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const clean=(value:unknown)=>isBot(value)?value:null;
const label=(bot:string|null)=>bot===WARREN_BOT?'Warren Buffett':bot===CHAMPION?'C52/C53':null;

/** Prefer an immutable execution source over a mutable current selection.
 * If the source lacks bot identity, a same-release historical selection can
 * help with research, but its result is never called a recorded fact. */
export function attributeBot(row:HistoryRow,selections:Selection[]):HistoryRow{
 const details=object(row.details)?row.details:{};
 const facts=object(details.facts)?details.facts:{};
 const recorded=row.record_type==='LIVE_DECISION'?clean(facts.botId):clean(details.botId);
 let bot=recorded;
 let source:HistoryBotSource=recorded?
  (row.record_type==='LIVE_DECISION'?'RECORDED_OBSERVATION':'RECORDED_INTENT'):'UNATTRIBUTED';
 if(!bot&&row.record_type==='LIVE_DECISION'&&typeof row.reason_code==='string'&&
   row.reason_code.startsWith('warren_')){
  bot=WARREN_BOT;source='WARREN_REASON_INFERRED';
 }
 if(!bot){
  const observed=Date.parse(row.observed_at),release=details.releaseSha;
  if(Number.isFinite(observed)&&typeof release==='string'){
   const candidates=selections.filter(s=>s.execution_account_id===row.account_id&&
      Number.isFinite(Date.parse(s.approved_at))&&Date.parse(s.approved_at)<observed);
   const latest=candidates.at(-1);
   if(latest&&latest.release_sha===release&&isBot(latest.to_bot_id)){
    bot=latest.to_bot_id;source='SELECTION_HISTORY_INFERRED';
   }
  }
 }
 return {...row,bot_id:bot,bot_name:label(bot),bot_source:source};
}

/** History selects only the already owner-scoped result page (<= 1000 rows).
 * This read does not discover other accounts, change money, or enrich an
 * immutable event with the current bot. If history is excessive, mark unknown
 * rather than accidentally assigning the wrong strategy. */
export async function attributeHistoryPage<T extends HistoryRow>(db:Reader,rows:T[]):Promise<
 (T&{bot_id:string|null;bot_name:string|null;bot_source:HistoryBotSource})[]>{
 if(!rows.length)return [];
 const needsHistory=rows.some(r=>{
  const d=r.details,f=object(d.facts)?d.facts:{};
  return !isBot(r.record_type==='LIVE_DECISION'?f.botId:d.botId)&&
   !(r.record_type==='LIVE_DECISION'&&r.reason_code?.startsWith('warren_'));
 });
 let selections:Selection[]=[];
 if(needsHistory){
  const ids=[...new Set(rows.map(r=>r.account_id))];
  const high=rows.reduce((m,r)=>Date.parse(r.observed_at)>Date.parse(m)?r.observed_at:m,rows[0].observed_at);
  const data=await db.query(`SELECT h.execution_account_id,h.to_bot_id,h.approved_at::text AS approved_at,h.release_sha
    FROM private.strata_owner_bot_selection_history h
    JOIN public.v13_production_account a ON a.id=h.execution_account_id AND a.owner_user_id=h.owner_user_id
    WHERE h.execution_account_id=ANY($1::text[]) AND h.approved_at<=$2::timestamptz
    ORDER BY h.approved_at ASC,h.revision ASC LIMIT 10001`,[ids,high]);
  if(data.rows.length<=10000)selections=data.rows as Selection[];
 }
 return rows.map(r=>attributeBot(r,selections) as T&{bot_id:string|null;bot_name:string|null;bot_source:HistoryBotSource});
}
