/** Additional build consent never changes an immutable model or its revocation state. */
export function durableReleaseMatch(shaParameter:'$2'|'$3'){
 return `(m.release_commit_sha=${shaParameter} OR EXISTS (
 SELECT 1 FROM private.strata_durable_fee_release_authorization ra
 WHERE ra.model_id=m.model_id AND ra.owner_user_id=m.owner_user_id
 AND ra.execution_account_id=m.execution_account_id AND ra.original_release_sha=m.release_commit_sha
 AND ra.release_commit_sha=${shaParameter} AND ra.policy_hash=m.approved_policy_hash
 AND ra.source_digest=m.official_source_digest AND ra.state='RECORDED'))`;
}
