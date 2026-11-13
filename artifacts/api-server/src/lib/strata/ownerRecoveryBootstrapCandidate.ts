import type {ProtectedIssuerStage} from './ownerRecoveryServiceCandidate';
import {createOwnerRecoveryPools} from '@workspace/db/owner-recovery-pools';
import type {Pool} from '@workspace/db';
import type {JWTVerifyGetKey} from 'jose';
import type {OwnerRecoveryRuntimeDependencies} from './ownerRecoveryRuntimeCandidate';
import type {ProductionRecoveryDependencies} from './ownerAtomicRecoveryCandidate';
/** Bootstrap-only assembly. No environment boolean or owner consent substitutes
 * for the protected verifier. Pools, trust verification and binding resolver are
 * installed by server code; never deserialize them from an HTTP request.
 * Does not create keys, grant roles, apply SQL, issue evidence or start trading. */
export function assembleOwnerRecoveryRuntime(config:{accountPool:Pool;sessionPool:Pool;issuerPool?:Pool;stageScopedAuthority?:ProtectedIssuerStage;supabaseUrl:string;keys:JWTVerifyGetKey;
 resolveMachineBinding:OwnerRecoveryRuntimeDependencies['resolveMachineBinding'];
 verifyLockedQualification:ProductionRecoveryDependencies['verifyLockedQualification']}):OwnerRecoveryRuntimeDependencies{
 if(config.accountPool===config.sessionPool)throw Error('separate_bounded_session_pool_required');
 if(typeof config.resolveMachineBinding!=='function'||typeof config.verifyLockedQualification!=='function')throw Error('protected_owner_recovery_verifiers_required');
 if(Boolean(config.issuerPool)!==Boolean(config.stageScopedAuthority))throw Error('complete_protected_issuer_configuration_required');
 if(config.issuerPool&&(config.issuerPool===config.accountPool||config.issuerPool===config.sessionPool))throw Error('separate_protected_issuer_pool_required');
 const release={db:config.accountPool,supabaseUrl:config.supabaseUrl,keys:config.keys,verifyLockedQualification:config.verifyLockedQualification};
 return {enabled:true,db:config.accountPool,sessionDb:config.sessionPool,supabaseUrl:config.supabaseUrl,keys:config.keys,
 resolveMachineBinding:config.resolveMachineBinding,
 release,...(config.issuerPool&&config.stageScopedAuthority?{issuance:{release,issuerDb:config.issuerPool,sessionDb:config.sessionPool,stageScopedAuthority:config.stageScopedAuthority}}:{})};
}

/** Called by server initialization only after actual protected verifiers are
 * installed. URLs are explicit server secrets, never request body/env fallback. */
export function bootstrapOwnerRecoveryRuntime(config:Omit<Parameters<typeof assembleOwnerRecoveryRuntime>[0],'accountPool'|'sessionPool'|'issuerPool'>&Parameters<typeof createOwnerRecoveryPools>[0]){
 if(typeof config.resolveMachineBinding!=='function'||typeof config.verifyLockedQualification!=='function')throw Error('protected_owner_recovery_verifiers_required');
 if(Boolean(config.issuerConnectionString)!==Boolean(config.stageScopedAuthority))throw Error('complete_protected_issuer_configuration_required');
 const pools=createOwnerRecoveryPools(config);
 return {dependencies:assembleOwnerRecoveryRuntime({...config,...pools}),close:pools.close};
}
