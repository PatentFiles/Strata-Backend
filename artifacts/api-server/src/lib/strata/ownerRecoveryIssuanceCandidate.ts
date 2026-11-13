import {verifySupabaseAccessToken} from './supabaseAuth';
import type {JWTVerifyGetKey} from 'jose';
/** Read-only, unmounted issuance boundary. No issuer implementation is supplied. */
export async function inspectOwnerRecoveryIssuance(token:string,challengeId:string,deps:{expectedScope:{accountId:string;action:'OWNER_RECOVERY';releaseSha:string;controlSequence:string};verifyRecentOwnerIntent?:(ownerId:string,challengeId:string)=>Promise<{ownerId:string;challengeId:string;verifiedAt:number;explicitConsent:boolean;sessionCurrent:boolean}|null>;supabaseUrl:string;keys:JWTVerifyGetKey;readChallenge:(id:string,ownerId:string)=>Promise<{ownerId:string;challengeId:string;accountId:string;action:string;releaseSha:string;controlSequence:string;expiresAt:number;revoked:boolean}|null>}){
 const deny=(reason:string)=>({ok:false as const,reason,evidenceIssued:false as const,recoveryAuthorized:false as const,tradingAuthorized:false as const,independentHumanReview:false as const});
 if(!token||!challengeId)return deny('authenticated_owner_challenge_required');
 let actor;try{actor=await verifySupabaseAccessToken(token,{supabaseUrl:deps.supabaseUrl,keys:deps.keys});}catch{return deny('owner_aal2_identity_unverified');}
 let challenge;try{challenge=await deps.readChallenge(challengeId,actor.subject);}catch{return deny('owner_challenge_unavailable');}
 if(!challenge||challenge.challengeId!==challengeId||Object.entries(deps.expectedScope).some(([k,v])=>(challenge as any)[k]!==v)||challenge.ownerId!==actor.subject||challenge.revoked||!Number.isSafeInteger(challenge.expiresAt)||challenge.expiresAt<=Date.now())return deny('owner_challenge_invalid');
 let intent;try{intent=await deps.verifyRecentOwnerIntent?.(actor.subject,challengeId);}catch{return deny('recent_owner_intent_unavailable');}
 if(!intent||intent.ownerId!==actor.subject||intent.challengeId!==challengeId||intent.explicitConsent!==true||intent.sessionCurrent!==true||!Number.isSafeInteger(intent.verifiedAt)||intent.verifiedAt>Date.now()||Date.now()-intent.verifiedAt>=300000)return deny('recent_owner_intent_unverified');
 // Genuine JWT verification does not establish trusted release evidence. Do NOT
 // convert owner AAL2 into independent review or create an admission evidence row.
 return deny('protected_release_assurance_issuer_not_configured');
}
