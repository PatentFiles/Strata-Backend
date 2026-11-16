import {OWNER_SELF_REVIEW_CONFIRM} from './ownerSelfReviewMode';
export const OWNER_FINAL_RELEASE_CONFIRM='I_AUTHORIZE_MY_ACCOUNT_FINAL_RELEASE_AFTER_SIGNED_QUALIFICATION_V1';
/** Explicit alternate authority, never an independent-review impersonation.
 * References use to_jsonb so legacy schemas keep the independent branch only.
 * Consequential callers must hold the outer release row lock; the current owner review
 * is also locked here so revocation cannot race a final signed decision.
 */
export function protectiveAuthoritySql(alias:string,owner:string,account:string,policy:string){
 const identifier=/^[a-z]+(?:\.[a-z_]+)?$|^\$\d+::(?:uuid|text)$/;
 if(!/^[a-z]+$/.test(alias)||![owner,account,policy].every(x=>identifier.test(x)))throw Error('static_protective_authority_sql_only');
 return `((COALESCE(to_jsonb(${alias})->>'release_authority','INDEPENDENT_V1')='INDEPENDENT_V1'
 AND ${alias}.independent_reviewer_id<>${owner} AND ${alias}.operator_approver_id<>${alias}.independent_reviewer_id
 AND NOT EXISTS(SELECT 1 FROM private.strata_protective_exit_release oh
 WHERE oh.release_commit_sha=${alias}.release_commit_sha
 AND to_jsonb(oh)->>'release_authority'='OWNER_SELF_V1'
 AND to_jsonb(oh)->>'owner_authorizer_id'=(${owner})::text
 AND to_jsonb(oh)->>'execution_account_id'=(${account})::text))
 OR (to_jsonb(${alias})->>'release_authority'='OWNER_SELF_V1'
 AND ${alias}.independent_reviewer_id IS NULL AND ${alias}.operator_approver_id=${owner}
 AND to_jsonb(${alias})->>'owner_authorizer_id'=(${owner})::text
 AND to_jsonb(${alias})->>'execution_account_id'=(${account})::text
 AND to_jsonb(${alias})->>'policy_hash'=(${policy})::text
 AND EXISTS(SELECT 1 FROM private.strata_standing_execution_reviews osr
 WHERE osr.release_id::text=to_jsonb(${alias})->>'standing_review_id'
 AND osr.owner_user_id=${owner} AND osr.execution_account_id=${account}
 AND osr.release_commit_sha=${alias}.release_commit_sha AND osr.policy_hash=${policy}
 AND osr.state='approved' AND osr.revoked_at IS NULL
 AND to_jsonb(osr)->>'review_authority'='OWNER_SELF_V1'
 AND osr.independent_reviewer_id IS NULL AND to_jsonb(osr)->>'owner_authorizer_id'=(${owner})::text
 AND osr.confirmation='${OWNER_SELF_REVIEW_CONFIRM}' FOR SHARE OF osr)))`;
}
