import pg,{type PoolConfig} from 'pg';
import {poolConfig} from '@workspace/db';

/** This pool is exclusively for lossy/advisory observation delivery.
 * It cannot exhaust the execution engine's shared PostgreSQL pool when the
 * observation FK is blocked by a concurrent financial-account transaction. */
export function telemetryWriterPoolConfig(connectionString:string,
 env:NodeJS.ProcessEnv=process.env):PoolConfig{
 return {...poolConfig(connectionString,env),max:1,
  application_name:'strata_live_telemetry_writer',
  connectionTimeoutMillis:1500,idleTimeoutMillis:10_000,
  allowExitOnIdle:true};
}
let telemetryPool:pg.Pool|null=null;
export function dedicatedTelemetryPool():pg.Pool{
 if(!telemetryPool){
  const url=process.env.DATABASE_URL;
  if(!url)throw Error('live_telemetry_database_unavailable');
  telemetryPool=new pg.Pool(telemetryWriterPoolConfig(url));
  telemetryPool.on('error',()=>{
   // Pool-level failures are advisory only; a later batch retries the same
   // idempotent UUID. Do not bring down a live trading worker.
   try{console.warn('strata_telemetry_pool_background_error');}catch{}
  });
 }
 return telemetryPool;
}
export async function closeTelemetryPool(){
 const current=telemetryPool;telemetryPool=null;
 if(current)await current.end();
}
