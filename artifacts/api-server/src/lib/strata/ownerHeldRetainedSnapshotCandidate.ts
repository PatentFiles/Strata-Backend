import type {PoolClient} from '@workspace/db';
import type {Account} from '../v13-production/ledger';
import type {Snapshot,Request} from '../v13-production/types';
import {loadedMaterial} from './inAppProtectiveRelease';
import {readOwnedKalshiFeeds,getOwnedProductionKalshiJson,personalAccountSnapshot} from './personalExchangeRead';
/** Internal reader for reconcileHeldReaderCandidate; not an endpoint or issuer.
 * Caller must use its existing locked client and authenticate exact owner first.
 * No fresh connection, order submission, retry or partial-history success. */
export async function readRetainedSnapshotUnderLock(tx:PoolClient,a:Account,ownerId:string,providerGet:typeof getOwnedProductionKalshiJson=getOwnedProductionKalshiJson):Promise<Snapshot>{
 if(a.owner_user_id!==ownerId||a.subaccount!=='1'&&String(a.subaccount)!=='1'||String(a.exchange_index)!=='2')throw Error('retained_owner_scope_invalid');
 const rows=await tx.query<{request:Request}>('SELECT request FROM public.v13_production_intent WHERE account_id=$1 LIMIT 1001',[a.id]);
 if(rows.rows.length>1000)throw Error('retained_history_budget');
 const material=await loadedMaterial(tx,{...a,owner_id:ownerId});if(!material)throw Error('retained_signer_unavailable');
 const now=Date.now(),abort=new AbortController();let calls=0;const timer=setTimeout(()=>abort.abort(),5000);
 try{
 const get:typeof getOwnedProductionKalshiJson=async(...args)=>{if(++calls>7||abort.signal.aborted)throw Error('retained_provider_budget');return providerGet(args[0],args[1],args[2],args[3],args[4],ownerId,abort.signal);};
 const feeds=await readOwnedKalshiFeeds(material,now,get);
 if(!feeds.ok||!feeds.historicalCoverageComplete||Date.now()<now||Date.now()-now>=5000)throw Error('retained_complete_fresh_feeds_missing');
 const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:a.key_fingerprint},feeds,rows.rows.map(r=>r.request));
 if(!('identity' in snapshot))throw Error(snapshot.reason);
 return snapshot;
 }finally{clearTimeout(timer);}
}
