/** Explicit authority types. Owner consent is never called an independent
 * review or machine attestation. Missing columns preserve legacy semantics. */
export const OWNER_SELF_REVIEW_CONFIRM='I_AUTHORIZE_OWNER_ONLY_STANDING_EXECUTION_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1';
export const INDEPENDENT_MODE='INDEPENDENT_V1',OWNER_SELF_MODE='OWNER_SELF_V1';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function standingAuthorityMatches(r:Record<string,unknown>,owner:string){
 const mode=r.review_authority??INDEPENDENT_MODE;
 return mode===INDEPENDENT_MODE?uuid.test(String(r.independent_reviewer_id))&&r.independent_reviewer_id!==owner:
 mode===OWNER_SELF_MODE&&r.independent_reviewer_id===null&&r.owner_authorizer_id===owner;
}
export function standingAuthoritySql(alias:string,owner:string){
 if(!/^[a-z]+$/.test(alias)||!(/^[a-z]+\.[a-z_]+$/.test(owner)||/^\$\d+::uuid$/.test(owner)))throw Error('static_authority_sql_only');
 return `((COALESCE(to_jsonb(${alias})->>'review_authority','INDEPENDENT_V1')='INDEPENDENT_V1' AND ${alias}.independent_reviewer_id<>${owner}) OR (to_jsonb(${alias})->>'review_authority'='OWNER_SELF_V1' AND ${alias}.independent_reviewer_id IS NULL AND to_jsonb(${alias})->>'owner_authorizer_id'=(${owner})::text))`;
}
export function sameStandingAuthoritySql(review='r',grant='g'){
 return `${review}.independent_reviewer_id IS NOT DISTINCT FROM ${grant}.independent_reviewer_id AND COALESCE(to_jsonb(${review})->>'review_authority','INDEPENDENT_V1')=COALESCE(to_jsonb(${grant})->>'review_authority','INDEPENDENT_V1') AND ${standingAuthoritySql(review,grant+'.owner_user_id')} AND ${standingAuthoritySql(grant,grant+'.owner_user_id')}`;
}

export type OwnerSelfEnrollmentScope={ownerId:string;accountId:string};
/** A server-controlled allow-list is bound to the actual release. Never derive
 * enrollment from the request account or fall back to a broader configuration
 * when the list is malformed. An empty configured list disables enrollment. */
export function configuredOwnerSelfScope(owner?:string,sha?:string,env:NodeJS.ProcessEnv=process.env):OwnerSelfEnrollmentScope|undefined{
 const configured=env.STRATA_OWNER_SELF_RELEASE_SCOPES_V1;
 if(configured===undefined){
  const ownerId=env.STRATA_OWNER_SELF_RELEASE_OWNER_ID,accountId=env.STRATA_OWNER_SELF_RELEASE_ACCOUNT_ID;
  return ownerId&&accountId?{ownerId,accountId}:undefined;
 }
 if(!owner||!uuid.test(owner)||!sha||!/^[a-f0-9]{40}$/.test(sha)||sha!==env.RAILWAY_GIT_COMMIT_SHA||configured.length>65536)return undefined;
 try{
  const rows:unknown=JSON.parse(configured);
  if(!Array.isArray(rows)||rows.length>256)return undefined;
  const owners=new Set<string>(),accounts=new Set<string>();
  let selected:OwnerSelfEnrollmentScope|undefined;
  for(const item of rows){
   if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='accountId,ownerId,releaseSha'||
      typeof item.ownerId!=='string'||!uuid.test(item.ownerId)||typeof item.accountId!=='string'||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.accountId)||item.releaseSha!==sha||
      owners.has(item.ownerId.toLowerCase())||accounts.has(item.accountId))return undefined;
   owners.add(item.ownerId.toLowerCase());accounts.add(item.accountId);
   if(item.ownerId===owner)selected={ownerId:item.ownerId,accountId:item.accountId};
  }
  return selected;
 }catch{return undefined;}
}
export function ownerSelfEnrollmentAllowed(owner:string,account:unknown,scope:OwnerSelfEnrollmentScope|undefined){
 return !!scope&&uuid.test(scope.ownerId)&&!!scope.accountId&&scope.ownerId===owner&&scope.accountId===account;
}
