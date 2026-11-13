import type {Pool} from '@workspace/db';
import type {JWTVerifyGetKey} from 'jose';
import type {OwnerRecoveryRuntimeDependencies} from './ownerRecoveryRuntimeCandidate';
import type {ProductionRecoveryDependencies} from './ownerAtomicRecoveryCandidate';
/** Bootstrap-only assembly. No environment boolean or owner consent substitutes
 * for the protected verifier. Pools, trust verification and binding resolver are
 * installed by server code; never deserialize them from an HTTP request.
 * Does not create keys, grant roles, apply SQL, issue evidence or start trading. */
export function assembleOwnerRecoveryRuntime(config:{accountPool:Pool;sessionPool:Pool;supabaseUrl:string;keys:JWTVerifyGetKey;
 resolveMachineBinding:OwnerRecoveryRuntimeDependencies['resolveMachineBinding'];
 verifyLockedQualification:ProductionRecoveryDependencies['verifyLockedQualification']}):OwnerRecoveryRuntimeDependencies{
 if(config.accountPool===config.sessionPool)throw Error('separate_bounded_session_pool_required');
 if(typeof config.resolveMachineBinding!=='function'||typeof config.verifyLockedQualification!=='function')throw Error('protected_owner_recovery_verifiers_required');
 return {enabled:true,db:config.accountPool,sessionDb:config.sessionPool,supabaseUrl:config.supabaseUrl,keys:config.keys,
 resolveMachineBinding:config.resolveMachineBinding,
 release:{db:config.accountPool,supabaseUrl:config.supabaseUrl,keys:config.keys,verifyLockedQualification:config.verifyLockedQualification}};
}
