import {composeDirectAccountRoundingEvidence,type DirectRoundingOwnedDependencies} from './directAccountRoundingComposer';
import {currentDirectAccountRoundingEvidence,type DirectAccountRoundingEvidence,type DirectAccountRoundingIdentity} from './directAccountRoundingEvidence';
/** Session-owned cache. Refresh only in ordinary reconciliation, never final
 * transactional reads. No receipt, stale receipt or changed authority blocks
 * entry; there is no optimistic fallback once this mode is selected. */
export function createDirectRoundingRuntime(accountId:string,executionFingerprint:string,deps:DirectRoundingOwnedDependencies){
 let evidence:Readonly<DirectAccountRoundingEvidence>|null=null;
 let validated:{evidence:Readonly<DirectAccountRoundingEvidence>;currentScope:DirectAccountRoundingIdentity}|null=null;
 let refresh:Promise<boolean>|null=null;
 let nextRefreshAt=0;
 let generation=0;let validatedToken:object|undefined;
 const matches=(e:DirectAccountRoundingEvidence)=>e.accountId===accountId&&e.executionCredentialFingerprint===executionFingerprint;
 return {
  refresh():Promise<boolean>{
   if(refresh)return refresh;
   if(deps.now()<nextRefreshAt)return Promise.resolve(!!evidence);
   nextRefreshAt=deps.now()+10000;
   refresh=(async()=>{const result=await composeDirectAccountRoundingEvidence(accountId,deps);
    generation++;validated=null;validatedToken=undefined;evidence=result.ok&&matches(result.evidence)?result.evidence:null;return !!evidence;
   })().finally(()=>{refresh=null;});return refresh;
  },
  async read(scopeToken?:object){
   const attempt=++generation;validated=null;validatedToken=undefined;const pinned=evidence;
   if(!pinned)throw Error('direct_rounding_receipt_unavailable');
   const scope=await deps.readCurrentAuthority(accountId);
   if(attempt!==generation||!scope||evidence!==pinned||!matches(pinned)||!currentDirectAccountRoundingEvidence(pinned,scope,deps.now()))throw Error('direct_rounding_authority_changed_or_expired');
   validatedToken=scopeToken;validated=Object.freeze({evidence:pinned,currentScope:Object.freeze({...scope})});return validated;
  },
  assertWire(scopeToken?:object){
   if(!scopeToken||scopeToken!==validatedToken||!validated||validated.evidence!==evidence||!currentDirectAccountRoundingEvidence(validated.evidence,validated.currentScope,deps.now()))throw Error('direct_rounding_wire_authority_unverified');
  },
 };
}
