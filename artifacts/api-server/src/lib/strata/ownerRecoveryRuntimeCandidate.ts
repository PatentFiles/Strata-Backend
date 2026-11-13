import {issueAndRecoverOwner,type OwnerRecoveryServiceDependencies} from './ownerRecoveryServiceCandidate';
import {recoverOwnerAtomicallyCandidate,type ProductionRecoveryDependencies} from './ownerAtomicRecoveryCandidate';
import {Router,json} from 'express';
import {createQualifiedOwnerConsentRouter} from './qualifiedOwnerConsentRouterCandidate';
import {createOwnerRecoveryRouter} from './ownerRecoveryRouterCandidate';
export type OwnerRecoveryRuntimeDependencies=Parameters<typeof createQualifiedOwnerConsentRouter>[0]&{release?:ProductionRecoveryDependencies;issuance?:OwnerRecoveryServiceDependencies};
/** Server composition, not release authority. Dependencies must originate in
 * bootstrap, never JSON/environment assertions of qualification. Consent,
 * historical outcome and held inspection use their existing authenticated paths.
 * The production recovery entry has no synthetic authority fallback. No issuer, ARM or START is reachable here. */
export function createOwnerRecoveryRuntimeRouter(deps?:OwnerRecoveryRuntimeDependencies){
 const router=Router();
 router.use((_req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  if(!deps||deps.enabled!==true){res.status(503).json({status:'owner_recovery_runtime_unconfigured',recoveryAuthorized:false,tradingAuthorized:false,stateChanged:false});return;}
  next();
 });
 if(deps){
  router.post('/recover',json({limit:'8kb',strict:true}),async(req,res)=>{
   const token=/^Bearer (\S+)$/i.exec(req.headers.authorization??'')?.[1];
   if(!token){res.status(401).json({status:'authenticated_owner_required',released:false,tradingAuthorized:false});return;}
   const body=req.body;
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||Object.keys(body).some(k=>!['accountId','requestId'].includes(k))){res.status(400).json({status:'exact_owner_request_required',released:false,tradingAuthorized:false});return;}
   try{const input={token,accountId:body.accountId,requestId:body.requestId};const result=deps.issuance?await issueAndRecoverOwner(input,deps.issuance):await recoverOwnerAtomicallyCandidate(input,deps.release);res.status(result.released===true?200:409).json(result);}
   catch{res.status(503).json({status:'owner_recovery_unavailable',released:false,tradingAuthorized:false,retryAuthorized:false});}
  });
  router.use(createQualifiedOwnerConsentRouter(deps));
  router.use(createOwnerRecoveryRouter(deps));
 }
 return router;
}
