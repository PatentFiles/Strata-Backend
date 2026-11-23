/** Unmounted, verifier-only issuer contracts. The caller owns nonce lifetime and trust. */
import {createHash,verify,type KeyObject} from 'node:crypto';
const common=['issuerKeyId','accountScopeDigest','buildSha','nonce','stopRevisionDigest','issuedAtMs','observedAtMs','expiresAtMs','subaccount','exchangeIndex'] as const;
const obligationFields=[...common,'coverage','currentCutDigest','pendingCashItems'] as const;
const settlementFields=[...common,'coverage','settlementId','settlementStatus','settlementDigest'] as const;
const hex=(x:unknown,n=64):x is string=>typeof x==='string'&&x.length===n&&/^[0-9a-f]+$/.test(x);
const time=(x:unknown):x is number=>Number.isSafeInteger(x)&&(x as number)>=0;
const no=(reason:string)=>({ok:false as const,reason,holdCleared:false as const,tradingAuthorized:false as const});
const record=(x:unknown):Record<string,unknown>|null=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
const exact=(x:Record<string,unknown>,keys:readonly string[])=>Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export type CashCommonChallenge={accountScopeDigest:string;buildSha:string;nonce:string;stopRevisionDigest:string;issuedAtMs:number};
export type CurrentObligationsChallenge=CashCommonChallenge&{currentCutDigest:string};
export type PostedSettlementChallenge=CashCommonChallenge&{settlementId:string;settlementDigest:string};
export type CashIssuerPin={issuerKeyId:string;publicKey:KeyObject;accountScopeDigest:string;buildSha:string;notBeforeMs:number;expiresAtMs:number};
const authority={historicalCoverageVerified:false as const,authenticatedExchangeFlat:false as const,holdCleared:false as const,tradingAuthorized:false as const};
const read=(input:unknown,challenge:CashCommonChallenge,pins:readonly CashIssuerPin[],now:number,fields:readonly string[],domain:string)=>{
 const outer=record(input);
 if(!outer||!exact(outer,['payload','signature'])||typeof outer.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(outer.signature))return no('envelope_invalid');
 const p=record(outer.payload);
 if(!p||!exact(p,fields)||typeof p.issuerKeyId!=='string'||!/^[A-Za-z0-9:_-]{1,120}$/.test(p.issuerKeyId)||
    !hex(p.accountScopeDigest)||!hex(p.buildSha,40)||!hex(p.nonce)||!hex(p.stopRevisionDigest)||
    p.subaccount!==1||p.exchangeIndex!==2)return no('scope_invalid');
 if(p.accountScopeDigest!==challenge.accountScopeDigest||p.buildSha!==challenge.buildSha||p.nonce!==challenge.nonce||
    p.stopRevisionDigest!==challenge.stopRevisionDigest||p.issuedAtMs!==challenge.issuedAtMs)return no('challenge_mismatch');
 if(!time(now)||!time(p.issuedAtMs)||!time(p.observedAtMs)||!time(p.expiresAtMs)||
    p.issuedAtMs>p.observedAtMs||p.observedAtMs>now||p.expiresAtMs<=now||p.expiresAtMs-p.issuedAtMs>5000)return no('attestation_not_current');
 const selected=pins.filter(k=>k.issuerKeyId===p.issuerKeyId);
 if(selected.length!==1)return no('issuer_untrusted');
 const key=selected[0]!;
 if(key.accountScopeDigest!==challenge.accountScopeDigest||key.buildSha!==challenge.buildSha||
    !time(key.notBeforeMs)||!time(key.expiresAtMs)||key.notBeforeMs>p.issuedAtMs||key.expiresAtMs<p.expiresAtMs||
    key.publicKey.type!=='public'||key.publicKey.asymmetricKeyType!=='ed25519')return no('issuer_untrusted');
 const sig=Buffer.from(outer.signature,'base64url');
 if(sig.length!==64||sig.toString('base64url')!==outer.signature)return no('signature_invalid');
 // Each lane validates its scalar values before this canonical fixed-order encoding.
 const bytes=Buffer.from(JSON.stringify([domain,...fields.map(k=>p[k])]),'utf8');
 if(!verify(null,bytes,key.publicKey,sig))return no('signature_invalid');
 return {ok:true as const,digest:createHash('sha256').update(bytes).digest('hex'),observedAtMs:p.observedAtMs};
};
export function verifyCurrentObligationsProof(input:unknown,challenge:CurrentObligationsChallenge,pins:readonly CashIssuerPin[],now:number){
 try{
  const p=record(record(input)?.payload);
  if(!p||p.coverage!=='complete_all_current_pending_cash'||!hex(p.currentCutDigest)||
   p.currentCutDigest!==challenge.currentCutDigest||!time(p.pendingCashItems))return no('current_obligations_binding_invalid');
  const r=read(input,challenge,pins,now,obligationFields,'STRATA_CURRENT_OBLIGATIONS_V1');
  if(!r.ok)return r;
  return {ok:true as const,status:p.pendingCashItems===0?'attested_no_current_pending_cash':'attested_current_pending_cash_present',
   pendingCashItems:p.pendingCashItems,currentCutDigest:p.currentCutDigest,attestationDigest:r.digest,observedAtMs:r.observedAtMs,...authority};
 }catch{return no('verification_failed');}
}
export function verifyPostedSettlementProof(input:unknown,challenge:PostedSettlementChallenge,pins:readonly CashIssuerPin[],now:number){
 try{
  const p=record(record(input)?.payload);
  // Exact existing deployed ledger grammar, including fractional-period timestamps.
  if(!p||p.coverage!=='exact_posted_settlement'||p.settlementStatus!=='posted'||
   typeof p.settlementId!=='string'||!/^settlement:[A-Za-z0-9:._-]{1,200}$/.test(p.settlementId)||
   p.settlementId!==challenge.settlementId||!hex(p.settlementDigest)||p.settlementDigest!==challenge.settlementDigest)
    return no('posted_settlement_binding_invalid');
  const r=read(input,challenge,pins,now,settlementFields,'STRATA_POSTED_SETTLEMENT_V1');
  if(!r.ok)return r;
  return {ok:true as const,status:'attested_exact_settlement_posted',settlementPosted:true as const,
   attestationDigest:r.digest,observedAtMs:r.observedAtMs,...authority};
 }catch{return no('verification_failed');}
}
