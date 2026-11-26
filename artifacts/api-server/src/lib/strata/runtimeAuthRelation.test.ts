import test from 'node:test';import assert from 'node:assert/strict';
import {runtimeAuthSql} from './runtimeAuthRelation';
test('restricted runtime changes only the code-owned relation, never predicates, identity or locks',()=>{
 const saved=process.env.STRATA_RESTRICTED_RUNTIME_AUTH;
 const query='SELECT u.id FROM auth.users u JOIN public.profiles p ON p.id=u.id WHERE u.id=$1::uuid AND p.role=$2 FOR SHARE OF u,p';
 try{
  delete process.env.STRATA_RESTRICTED_RUNTIME_AUTH;assert.equal(runtimeAuthSql(query),query);
  process.env.STRATA_RESTRICTED_RUNTIME_AUTH='true';
  assert.equal(runtimeAuthSql(query),query.replace('auth.users','private.strata_runtime_auth_user_v1'));
  assert.equal(runtimeAuthSql('SELECT x FROM public.auth_users WHERE id=$1'),'SELECT x FROM public.auth_users WHERE id=$1');
 }finally{if(saved===undefined)delete process.env.STRATA_RESTRICTED_RUNTIME_AUTH;else process.env.STRATA_RESTRICTED_RUNTIME_AUTH=saved;}
});
