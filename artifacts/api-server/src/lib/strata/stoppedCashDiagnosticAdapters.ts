/** Offline diagnostic composition candidate. No application routing/config
 * changes, persistence, issuer authority or recovery function. */
import type {Request,Snapshot} from '../v13-production/types';
import {getOwnedProductionKalshiJson,personalAccountSnapshot} from './personalExchangeRead';
import {readBracketedSettledCash} from './settledCashBracket';

// Rebind the authenticated owner rather than forwarding the helper's
// discarded/undefined owner argument. Do not wrap the native fetch: normal
// balance and optional member quota bookkeeping remain active.
type ScopedGet=typeof getOwnedProductionKalshiJson;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
export function createStoppedCashBracketAdapter(options:{get?:ScopedGet;now?:()=>number}={}){
 const g=options.get??getOwnedProductionKalshiJson;
 return async(owner:string,creds:Parameters<ScopedGet>[0],at:number,requests:Request[],fingerprint:string):Promise<Snapshot|null>=>{
  if(!UUID.test(owner)||!HASH.test(fingerprint))return null;
  const get:ScopedGet=(c,path,q,_fetch,_host,_ignored,signal)=>g(c,path,q,undefined,undefined,owner,signal);
  const read=await readBracketedSettledCash(creds,at,{get,now:options.now});
  if(!read.ok)return null;
  const mapped=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:fingerprint},read,requests);
  return 'identity' in mapped?mapped:null;
 };
}

export type QueryOnly={query:(sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>};
type Client=QueryOnly&{release:(discard?:boolean)=>void};
/** Use one fresh snapshot for every database leg; never call this around the
 * Kalshi network bracket. On a failure remove the connection from the pool. */
export async function readStoppedCashDatabaseLeg<T>(connect:()=>Promise<Client>,work:(tx:QueryOnly)=>Promise<T>):Promise<T>{
 const client=await connect();let discard=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='1500ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='2s'");
  const read=await work({query:client.query.bind(client)});
  await client.query('COMMIT');
  return read;
 }catch{
  discard=true;try{await client.query('ROLLBACK');}catch{/* connection discarded */}
  throw Error('stopped_cash_readonly_database_leg_failed');
 }finally{client.release(discard);}
}
