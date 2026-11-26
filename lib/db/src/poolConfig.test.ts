import {test} from 'node:test';
import assert from 'node:assert/strict';
import {poolConfig} from './poolConfig';
test('all remote modes verify TLS and preserve routing parameters',()=>{
 for(const mode of ['', '?sslmode=require','?sslmode=prefer','?sslmode=verify-ca','?sslmode=verify-full']){
  const c=poolConfig('postgresql://fixture:fixture@db.invalid:6543/fixture'+mode,{});
  assert.equal(typeof c.ssl,'object');assert.equal((c.ssl as {rejectUnauthorized:boolean}).rejectUnauthorized,true);
  assert.equal((c.ssl as {servername:string}).servername,'db.invalid');
  assert.equal(new URL(c.connectionString!).searchParams.has('sslmode'),false);
 }
 assert.equal(new URL(poolConfig('postgresql://db.invalid/fixture?application_name=strata',{}).connectionString!).searchParams.get('application_name'),'strata');
});
test('disposable loopback databases remain local and can use plaintext',()=>{
 for(const host of ['127.0.0.1','localhost','[::1]'])assert.equal(poolConfig('postgresql://'+host+'/fixture',{}).ssl,undefined);
 assert.equal(poolConfig('postgresql://127.0.0.1/fixture?sslmode=disable',{}).ssl,undefined);
 assert.equal((poolConfig('postgresql://localhost/fixture?sslmode=require',{}).ssl as {rejectUnauthorized:boolean}).rejectUnauthorized,true);
});
test('insecure remote modes and pg URL TLS overrides fail closed',()=>{
 for(const query of ['sslmode=disable','sslmode=no-verify','ssl=false','sslrootcert=anything','sslcert=anything','sslkey=anything','uselibpqcompat=true','sslmode=unknown'])
  assert.throws(()=>poolConfig('postgresql://db.invalid/fixture?'+query,{}),/database_tls_/);
 assert.throws(()=>poolConfig('https://db.invalid/fixture',{}),/database_protocol_invalid/);
 assert.throws(()=>poolConfig('postgresql://db.invalid/fixture',{STRATA_DATABASE_CA_CERT:'bad'}),/database_tls_ca_invalid/);
});

test('owned Unix sockets are local, while query TCP host overrides are refused',()=>{
 const u='postgresql:///analytics_drain?host=%2Ftmp%2Fowned-socket&user=fixture';
 assert.equal(poolConfig(u,{}).ssl,undefined);
 for(const u of ['postgresql://localhost/fixture?host=remote.invalid','postgresql://db.invalid/fixture?host=localhost','postgresql:///fixture?host=remote.invalid','postgresql:///fixture?host=%2Ftmp%2Fsocket&host=remote.invalid','postgresql://localhost/fixture?hostaddr=1.2.3.4'])
  assert.throws(()=>poolConfig(u,{}),/database_host_override/);
 assert.throws(()=>poolConfig('postgresql:///fixture',{}),/database_host_required/);
 assert.throws(()=>poolConfig(u+'&sslmode=require',{}),/database_unix_socket_tls/);
});
