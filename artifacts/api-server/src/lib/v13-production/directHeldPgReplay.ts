import {createHash} from 'node:crypto';

/** Disposable PostgreSQL held-position characterization, never a send path. */
export type DirectHeldReplayScope = Readonly<{
  owner:string; account:string; position:string; ticker:string; venue:string;
  side:'YES'|'NO'; release:string; policy:string;
}>;
type Row=Record<string,unknown>;
type DB=Readonly<{query(sql:string,values:unknown[]):Promise<{rows:Row[]}>}>;
type ReplayResult = Readonly<
 | {kind:'READY'; scope:DirectHeldReplayScope; sourceId:string; sourceDigest:string; quantityHundredths:string; oldestAtMs:number; expiresAtMs:number; observedAtMs:number; marketCloseMs:number; submissionAuthorized:false}
 | {kind:'REFUSED'|'UNKNOWN'; reason:string; submissionAuthorized:false}
>;
const no=(kind:'REFUSED'|'UNKNOWN',reason:string):ReplayResult=>Object.freeze({kind,reason,submissionAuthorized:false});
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
const TICKER=/^KXBTC15M-[A-Z0-9-]{1,90}$/;
const SHA=/^[0-9a-f]{40}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const fields=['owner','account','position','ticker','venue','side','release','policy'] as const;
const isText=(v:unknown,r=ID):v is string=>typeof v==='string'&&r.test(v);
const safeMs=(v:unknown)=>{
 const n=typeof v==='string'&&/^\d{1,16}$/.test(v)?Number(v):v;
 return typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:null;
};
function verified(scope:unknown):scope is DirectHeldReplayScope {
 if(!scope||typeof scope!=='object'||Array.isArray(scope))return false;
 const s=scope as Row;
 return ['owner','account','position','venue'].every(k=>isText(s[k]))&&isText(s.ticker,TICKER)&&
  (s.side==='YES'||s.side==='NO')&&isText(s.release,SHA)&&isText(s.policy,DIGEST);
}
function eq(a:DirectHeldReplayScope,b:unknown):boolean{
 return verified(b)&&fields.every(k=>a[k]===b[k]);
}

/** Statement only against pre-provisioned dedicated fixture relations. Locks pin
 * the source, held position and STOP/policy row for this read. No active-market
 * lookup, legacy/paper table, cursor, lease update, order or mutation. */
const EXACT_HELD_FIXTURE_SQL=`
WITH exact_held AS MATERIALIZED (
 SELECT o.id,o.original_scope,o.raw_strategy,p.qty AS quantity_hundredths,
 floor(extract(epoch FROM o.oldest_at)*1000)::bigint AS oldest_ms,
 floor(extract(epoch FROM o.observed_at)*1000)::bigint AS observed_ms,
 floor(extract(epoch FROM o.closes_at)*1000)::bigint AS closes_ms
 FROM detached_held.position p
 JOIN detached_held.account a ON a.id=p.account
 JOIN detached_held.observation o ON o.position=p.id
 WHERE current_user='held_fixture' AND current_database()='postgres' AND host(inet_server_addr())='127.0.0.1'
  AND p.id=$1 AND a.id=$2 AND a.owner=$3 AND p.ticker=$4 AND p.venue=$5 AND p.side=$6 AND a.policy=$7
  AND NOT a.stopped AND p.qty ~ '^[1-9][0-9]{0,7}$' AND o.id=$8
  AND o.original_scope=jsonb_build_object('owner',a.owner,'account',a.id,'position',p.id,'ticker',p.ticker,'venue',p.venue,'side',p.side,'release',$9::text,'policy',a.policy)
 FOR SHARE OF p,a,o
)
SELECT exact_held.*,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS clock_ms FROM exact_held`;
const strategyFields=['btc_price','target','signed_buffer','velocity','up_offer','down_offer'] as const;

/** Proof status is ephemeral and fixture-only. Explicit opt-in from a dedicated
 * disposable test caller, with its DB never shared with the worker's real roles. */
export async function replayDirectHeld(db:DB,scope:DirectHeldReplayScope,observationId:string,policyMaxAgeMs:number):Promise<ReplayResult>{
 if(!verified(scope)||!isText(observationId)||!Number.isSafeInteger(policyMaxAgeMs)||policyMaxAgeMs<1||policyMaxAgeMs>5000)
  return no('REFUSED','invalid_replay_inputs');
 const immutable=Object.freeze({owner:scope.owner,account:scope.account,position:scope.position,ticker:scope.ticker,venue:scope.venue,
  side:scope.side,release:scope.release,policy:scope.policy});
 try{
  const {rows}=await db.query(EXACT_HELD_FIXTURE_SQL,[immutable.position,immutable.account,immutable.owner,immutable.ticker,immutable.venue,
   immutable.side,immutable.policy,observationId,immutable.release]);
  if(rows.length!==1)return no('REFUSED','held_source_absent_or_stop');
  const row=rows[0]!;
  const oldest=safeMs(row.oldest_ms),observed=safeMs(row.observed_ms),closes=safeMs(row.closes_ms),now=safeMs(row.clock_ms);
  if(row.id!==observationId||!eq(immutable,row.original_scope)||!isText(row.quantity_hundredths,/^[1-9][0-9]{0,7}$/)||
     oldest===null||observed===null||closes===null||now===null||oldest>observed||observed>=closes||now<observed)
   return no('REFUSED','held_source_identity_or_clock_unproven');
  const allowedThrough=oldest+policyMaxAgeMs;
  if(!Number.isSafeInteger(allowedThrough)||now>allowedThrough||now>=closes)return no('REFUSED','held_source_expired');
  const s=row.raw_strategy as Row|null;
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).length!==strategyFields.length||
     !strategyFields.every(k=>typeof s[k]==='number'&&Number.isFinite(s[k])))
   return no('REFUSED','held_source_payload_unproven');
  const sourceDigest=createHash('sha256').update(JSON.stringify([
   'STRATA_DISPOSABLE_DIRECT_HELD_V1',observationId,fields.map(k=>immutable[k]),
   oldest,observed,closes,strategyFields.map(k=>s[k]),
  ])).digest('hex');
  return Object.freeze({kind:'READY',scope:immutable,sourceId:observationId,sourceDigest,quantityHundredths:row.quantity_hundredths,
   oldestAtMs:oldest,observedAtMs:observed,marketCloseMs:closes,expiresAtMs:Math.min(allowedThrough,closes-1),submissionAuthorized:false});
 }catch{return no('UNKNOWN','held_source_lookup_uncertain');}
}
