import type {Pool,PoolConfig} from 'pg';
import {poolConfig} from '../../../../../lib/db/src/poolConfig';

/** Advisory telemetry must never consume the financial execution pool.
 * Never statically import pg: the isolated pre-wire/no-send safety harness
 * deliberately forbids loading network libraries until an actual writer runs. */
export function telemetryWriterPoolConfig(connectionString:string,
 env:NodeJS.ProcessEnv=process.env):PoolConfig{
 return {...poolConfig(connectionString,env),max:1,
  application_name:'strata_live_telemetry_writer',
  connectionTimeoutMillis:1500,idleTimeoutMillis:10_000,
  allowExitOnIdle:true};
}
let telemetryPool:Pool|null=null;
let initializing:Promise<Pool>|null=null;
export async function dedicatedTelemetryPool():Promise<Pool>{
 if(telemetryPool)return telemetryPool;
 if(!initializing){
  initializing=(async()=>{
   const url=process.env.DATABASE_URL;
   if(!url)throw Error('live_telemetry_database_unavailable');
   // Lazy loading prevents advisory access to a network driver during the
   // protected order-path's offline safety replay.
   const {default:pg}=await import('pg');
   const instance=new pg.Pool(telemetryWriterPoolConfig(url));
   instance.on('error',()=>{
    try{console.warn('strata_telemetry_pool_background_error');}catch{}
   });
   telemetryPool=instance;
   return instance;
  })();
 }
 try{return await initializing;}
 finally{initializing=null;}
}
export async function closeTelemetryPool(){
 const current=telemetryPool;telemetryPool=null;
 if(current)await current.end();
}
