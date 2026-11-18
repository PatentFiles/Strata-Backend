'use strict';
const {createHash}=require('node:crypto');
const BRADY_ACCOUNT='synthetic-commissioned-account';
/** Disabled integration candidate. resolve must be the server-created genuine
 * qualification resolver, never a client callback or request-provided proof.
 * It binds consent to machine evidence, not authority to recover or trade. */
function createAccountMachineBinding({accountId,ownerId},resolve,clock=Date.now){
 if(accountId!==BRADY_ACCOUNT||typeof ownerId!=='string'||!ownerId||typeof resolve!=='function')throw Error('commissioned_scope_required');
 return async function bind(challenge,signal){
  const deny=reason=>({ok:false,reason,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false});
  const start=clock();
  if(!challenge||challenge.accountId!==accountId||challenge.ownerId!==ownerId||challenge.action!=='OWNER_RECOVERY'||typeof challenge.challengeId!=='string'||!challenge.challengeId||!/^[a-f0-9]{40}$/.test(challenge.releaseSha)||typeof challenge.controlSequence!=='string'||!/^\d+$/.test(challenge.controlSequence)||!Number.isSafeInteger(start)||!Number.isSafeInteger(challenge.expiresAt)||challenge.expiresAt<=start||challenge.revoked!==false)return deny('owner_challenge_scope_invalid');
  // Copy before asynchronous verification; a caller cannot swap challenge scope.
  const scope={accountId,ownerId,action:'OWNER_RECOVERY',challengeId:challenge.challengeId,releaseSha:challenge.releaseSha,controlSequence:challenge.controlSequence};
  const expiresAt=challenge.expiresAt;
  let q;try{q=await resolve(signal);}catch{return deny('machine_qualification_unavailable');}
  const end=clock();
  if(signal?.aborted||!Number.isSafeInteger(end)||end<start||end>=expiresAt)return deny('binding_expired_or_cancelled');
  if(!q?.ok||q.releaseSha!==scope.releaseSha||q.consentBindingOnly!==true||q.evidenceIssued!==false||q.recoveryAuthorized!==false||q.tradingAuthorized!==false||!Number.isSafeInteger(q.validUntil)||end>=q.validUntil||!/^[a-f0-9]{64}$/.test(q.evidenceDigest)||!/^[a-f0-9]{64}$/.test(q.qualificationPolicySha256))return deny('machine_qualification_not_bound');
  const record={...scope,artifactDigest:q.evidenceDigest,qualificationPolicySha256:q.qualificationPolicySha256,validUntil:Math.min(expiresAt,q.validUntil)};
  return {ok:true,kind:'ACCOUNT_MACHINE_CONSENT_BINDING_CANDIDATE',...record,bindingDigest:createHash('sha256').update(JSON.stringify(record)).digest('hex'),consentBindingOnly:true,commissioningCurrentlyVerified:false,deployedBytesVerified:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false,independentHumanReview:false};
 };
}
module.exports={createAccountMachineBinding,BRADY_ACCOUNT};
