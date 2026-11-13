import pg from 'pg';
/** Dedicated bounded server pools. Construct only after protected trust setup;
 * construction is lazy (no query), and neither URL is accepted from a request.
 * No SSL downgrade, credential creation, grants, or fallback to DATABASE_URL. */
export function createOwnerRecoveryPools(config:{accountConnectionString:string;sessionConnectionString:string;issuerConnectionString?:string}){
 const parsed=(value:string)=>{
  const u=new URL(value);
  if(!['postgres:','postgresql:'].includes(u.protocol)||!u.hostname||!u.username)throw Error('explicit_recovery_database_identity_required');
  if(!['verify-full','verify-ca'].includes(u.searchParams.get('sslmode')??'')&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('verified_recovery_database_tls_required');
  return u;
 };
 const a=parsed(config.accountConnectionString),s=parsed(config.sessionConnectionString);
 if(a.hostname!==s.hostname||a.port!==s.port||a.pathname!==s.pathname)throw Error('recovery_pools_database_mismatch');
 if(a.username===s.username)throw Error('distinct_readonly_session_role_required');
 const issuer=config.issuerConnectionString?parsed(config.issuerConnectionString):null;
 if(issuer&&(issuer.hostname!==a.hostname||issuer.port!==a.port||issuer.pathname!==a.pathname||[a.username,s.username].includes(issuer.username)))throw Error('distinct_same_database_issuer_role_required');
 const common={max:1,idleTimeoutMillis:10000,connectionTimeoutMillis:1000,statement_timeout:1500,query_timeout:2000,allowExitOnIdle:true};
 const accountPool=new pg.Pool({...common,connectionString:config.accountConnectionString,application_name:'strata-owner-recovery'});
 const sessionPool=new pg.Pool({...common,connectionString:config.sessionConnectionString,application_name:'strata-owner-recovery-session',options:'-c default_transaction_read_only=on'});
 const issuerPool=issuer?new pg.Pool({...common,connectionString:config.issuerConnectionString,application_name:'strata-owner-recovery-issuer'}):undefined;
 // Idle socket faults must not become uncaught EventEmitter errors. Call sites
 // surface read failure, never reinterpret an unavailable connection as healthy.
 accountPool.on('error',()=>{});sessionPool.on('error',()=>{});issuerPool?.on('error',()=>{});
 return {accountPool,sessionPool,issuerPool,close:async()=>{await Promise.all([accountPool.end(),sessionPool.end(),issuerPool?.end()]);}};
}
