import {createOwnerRecoveryPools} from '@workspace/db/owner-recovery-pools';
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

/** Called by server initialization only after actual protected verifiers are
 * installed. URLs are explicit server secrets, never request body/env fallback. */
export function bootstrapOwnerRecoveryRuntime(config:Omit<Parameters<typeof assembleOwnerRecoveryRuntime>[0],'accountPool'|'sessionPool'>&Parameters<typeof createOwnerRecoveryPools>[0]){
 if(typeof config.resolveMachineBinding!=='function'||typeof config.verifyLockedQualification!=='function')throw Error('protected_owner_recovery_verifiers_required');
 const pools=createOwnerRecoveryPools(config);
 return {dependencies:assembleOwnerRecoveryRuntime({...config,...pools}),close:pools.close};
}
