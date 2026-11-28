import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {poolConfig} from '@workspace/db/pool-config';
import {liveDecisionDeliveryStatus} from '../v13-production/liveDecisionAnalytics';

/** Optional capture-gap heartbeat on its OWN 1-connection pool, never on the
 * order-path connection pool. An outage cannot block order admission. */
export function startTelemetryCaptureHeartbeat(env:NodeJS.ProcessEnv=process.env){
 if(env.NODE_ENV!=='production'||env.STRATA_TELEMETRY_HEARTBEAT_ENABLED!=='true')
  return {async stop(){},enabled:false as const};
 if(!env.DATABASE_URL)throw Error('telemetry_heartbeat_database_missing');
 const instance=randomUUID();
 const db=new pg.Pool({...poolConfig(env.DATABASE_URL,env),max:1,
  connectionTimeoutMillis:1500,idleTimeoutMillis:10_000});
 let busy=false,stopping=false;
 const report=async()=>{
  if(busy||stopping)return;busy=true;
  try{
   const s=liveDecisionDeliveryStatus();
   await db.query(`INSERT INTO private.strata_telemetry_capture_health_v1
    (instance_id,accepted,confirmed,overflow,retry_exhausted,rejected,invalid,pending)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[instance,s.accepted,s.confirmed,s.overflow,
     s.retryExhausted,s.rejected,s.invalid,s.pending]);
  }catch{
   // A failed heartbeat is an explicit monitoring-gap signal in service logs.
   // It is not permission to mark the capture stream complete.
   console.warn('strata_telemetry_capture_heartbeat_failed');
  }finally{busy=false;}
 };
 const timer=setInterval(()=>{void report();},30_000);timer.unref();
 return {enabled:true as const,async stop(){
  stopping=true;clearInterval(timer);
  // Never extend the trading shutdown's safety deadline for advisory metrics.
  await Promise.race([db.end(),new Promise<void>(r=>setTimeout(r,1000))]);
 }};
}
