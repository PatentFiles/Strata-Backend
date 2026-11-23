/** Unmounted, read-only verification contract; no configured issuer, endpoint, or key. */
import {createHash,verify,type KeyObject} from 'node:crypto';
const fields=['issuerKeyId','accountScopeDigest','buildSha','nonce','stopRevisionDigest','issuedAtMs','observedAtMs',
 'expiresAtMs','subaccount','exchangeIndex','coverage','pendingCashItems','settlementId','settlementStatus','settlementPostedAtMs','settlementDigest'] as const;
const ident=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9:_-]{1,120}$/.test(x);
const hex=(x:unknown,n=64):x is string=>typeof x==='string'&&x.length===n&&/^[0-9a-f]+$/.test(x);
const time=(x:unknown):x is number=>Number.isSafeInteger(x)&&(x as number)>=0;
const no=(reason:string)=>({ok:false as const,reason,holdCleared:false as const,tradingAuthorized:false as const});
type Challenge={accountScopeDigest:string;buildSha:string;nonce:string;stopRevisionDigest:string;issuedAtMs:number;
 settlementId:string;settlementDigest:string};
type Pin={issuerKeyId:string;publicKey:KeyObject;accountScopeDigest:string;buildSha:string;notBeforeMs:number;expiresAtMs:number};
const record=(x:unknown):Record<string,unknown>|null=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
const exact=(x:Record<string,unknown>,keys:readonly string[])=>Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const maxAge=5000;
const domain='STRATA_CURRENT_PENDING_CASH_AND_POSTED_SETTLEMENT_V1';
/** The challenge and trust pins are code-owned, supplied independently of the
 * untrusted signed body. Caller must retire challenge nonce on use and compare
 * fresh STOP fences before/after. This stateless verifier cannot consume nonce. */
export function verifyCurrentCashIssuerProof(input:unknown,challenge:Challenge,pins:readonly Pin[],now:number){
 try{
  const outer=record(input);
  if(!outer||!exact(outer,['payload','signature'])||typeof outer.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(outer.signature))return no('envelope_invalid');
  const p=record(outer.payload);
  if(!p||!exact(p,fields)||!ident(p.issuerKeyId)||!ident(p.settlementId)||!hex(p.settlementDigest)||
    !hex(p.accountScopeDigest)||!hex(p.buildSha,40)||!hex(p.nonce)||!hex(p.stopRevisionDigest)||
    p.subaccount!==1||p.exchangeIndex!==2||p.coverage!=='complete_all_current_pending_cash_and_exact_posted_settlement'||
    p.settlementStatus!=='posted'||!time(p.pendingCashItems)||!time(p.settlementPostedAtMs)||p.settlementPostedAtMs===0)return no('scope_or_coverage_invalid');
  if(p.accountScopeDigest!==challenge.accountScopeDigest||p.buildSha!==challenge.buildSha||p.nonce!==challenge.nonce||
    p.stopRevisionDigest!==challenge.stopRevisionDigest||p.settlementId!==challenge.settlementId||
    p.settlementDigest!==challenge.settlementDigest||p.issuedAtMs!==challenge.issuedAtMs)return no('challenge_mismatch');
  if(!time(now)||!time(p.issuedAtMs)||!time(p.observedAtMs)||!time(p.expiresAtMs)||
    p.issuedAtMs>p.observedAtMs||p.settlementPostedAtMs>p.observedAtMs||p.observedAtMs>now||p.expiresAtMs<=now||p.expiresAtMs-p.issuedAtMs>maxAge)
   return no('attestation_not_current');
  const selected=pins.filter(k=>k.issuerKeyId===p.issuerKeyId);
  if(selected.length!==1)return no('issuer_untrusted');
  const key=selected[0]!;
  if(key.accountScopeDigest!==challenge.accountScopeDigest||key.buildSha!==challenge.buildSha||
    !time(key.notBeforeMs)||!time(key.expiresAtMs)||key.notBeforeMs>p.issuedAtMs||key.expiresAtMs<p.expiresAtMs||
    key.publicKey.type!=='public'||key.publicKey.asymmetricKeyType!=='ed25519')return no('issuer_untrusted');
  const sig=Buffer.from(outer.signature,'base64url');
  if(sig.length!==64||sig.toString('base64url')!==outer.signature)return no('signature_invalid');
  // Fixed order JSON tuple, documented canonical JS string encoding; every field
  // is a validated ASCII token or safe integer. No caller-supplied key material.
  const bytes=Buffer.from(JSON.stringify([domain,...fields.map(k=>p[k])]),'utf8');
  if(!verify(null,bytes,key.publicKey,sig))return no('signature_invalid');
  return {ok:true as const,status:p.pendingCashItems===0?'attested_no_current_pending_cash':'attested_current_pending_cash_present',
   attestationDigest:createHash('sha256').update(bytes).digest('hex'),observedAtMs:p.observedAtMs,
   pendingCashItems:p.pendingCashItems,settlementPostedAtMs:p.settlementPostedAtMs,settlementPosted:true as const,historicalCoverageVerified:false as const,
   authenticatedExchangeFlat:false as const,holdCleared:false as const,tradingAuthorized:false as const};
 }catch{return no('verification_failed');}
}
