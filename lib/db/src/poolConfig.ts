import type {PoolConfig} from 'pg';

/** Remote connections always authenticate the database server. An explicit
 * private CA replaces the default trust roots when configured by operations.
 * Never fall back to encryption without identity verification. */
export function poolConfig(connectionString:string,env:NodeJS.ProcessEnv=process.env):PoolConfig {
 const url=new URL(connectionString);
 if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('database_protocol_invalid');
 const socketHost=url.searchParams.get('host');
 const unixSocket=url.hostname===''&&socketHost!==null&&socketHost.startsWith('/')&&!socketHost.startsWith('//')&&!socketHost.includes('\0')&&url.searchParams.getAll('host').length===1;
 // A query-string TCP host must never redirect a localhost/plaintext URL to a
 // remote server, or replace the hostname whose TLS identity was verified.
 if(url.searchParams.has('hostaddr')||(socketHost!==null&&!unixSocket))throw Error('database_host_override_not_supported');
 if(!url.hostname&&!unixSocket)throw Error('database_host_required');
 const local=unixSocket||['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 const mode=url.searchParams.get('sslmode');
 if(mode!==null&&!['disable','prefer','require','verify-ca','verify-full','no-verify'].includes(mode))
  throw Error('database_tls_mode_invalid');
 if(!local&&(mode==='disable'||mode==='no-verify'))throw Error('database_tls_verification_required');
 // pg-connection-string can otherwise overwrite the TLS object after validation.
 // File-based client certificates require a separately reviewed integration;
 // never open arbitrary paths supplied by a URL at application startup.
 for(const key of ['sslcert','sslkey','sslrootcert','uselibpqcompat','ssl'])
  if(url.searchParams.has(key))throw Error('database_tls_url_override_not_supported');
 url.searchParams.delete('sslmode');
 const config:PoolConfig={connectionString:url.toString(),max:10,
  idleTimeoutMillis:30_000,connectionTimeoutMillis:10_000};
 if(unixSocket&&mode!==null&&mode!=='disable')throw Error('database_unix_socket_tls_not_supported');
 const tls=!local||(mode!==null&&mode!=='disable');
 if(tls){
  const ca=env.STRATA_DATABASE_CA_CERT;
  if(ca!==undefined&&(!ca.includes('-----BEGIN CERTIFICATE-----')||ca.length>131072))
   throw Error('database_tls_ca_invalid');
  config.ssl={rejectUnauthorized:true,...(ca?{ca}:{}),servername:url.hostname.replace(/^\[|\]$/g,'')};
 }
 return config;
}
