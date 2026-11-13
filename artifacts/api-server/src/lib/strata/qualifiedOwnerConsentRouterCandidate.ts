import {Router} from 'express';
import {createCurrentOwnerSessionVerifier} from './ownerCurrentSessionCandidate';
import {verifySupabaseAccessToken} from './supabaseAuth';
import {createOwnerConsentRouter} from './ownerConsentRouterCandidate';
import {deployedGitSha} from './deployedGitSha';
type Binding={ok:true;releaseSha:string;evidenceDigest:string;validUntil:number;evidenceIssued:false;recoveryAuthorized:false;tradingAuthorized:false}|{ok:false;reason:string};
type Base=Omit<Parameters<typeof createOwnerConsentRouter>[0],'machineEvidenceDigest'|'machineValidUntil'>;
/** Only use a server-configured verifier backed by the actual qualification
 * byte adapter. Resolver is never accepted from HTTP/request JSON. No mounting,
 * recovery authority or implicit START; output remains consent only. */
export function createQualifiedOwnerConsentRouter(deps:Base&{resolveMachineBinding:(signal?:AbortSignal)=>Promise<Binding>}){
 const router=Router();
 const currentSession=createCurrentOwnerSessionVerifier({...deps,db:deps.sessionDb});
 let verificationPending=false;
 router.use(async(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(deps.enabled!==true){res.status(503).json({status:'owner_consent_feature_disabled',recoveryAuthorized:false,tradingAuthorized:false});return;}
  // Only the two consent endpoints trigger expensive verification. Unknown paths
  // never become a recovery or trading-control endpoint.
  if(req.method!=='POST'||!['/consent-challenge','/consent'].includes(req.path)){next();return;}
  if(!/^Bearer \S+$/i.test(req.header('authorization')??'')){res.status(401).json({status:'authenticated_owner_required'});return;}
  try{const token=(req.header('authorization')??'').split(' ')[1];const actor=await verifySupabaseAccessToken(token,deps);if(!await currentSession(token,actor.subject))throw Error('session');}catch{res.status(401).json({status:'authenticated_owner_required'});return;}
  if(verificationPending){res.status(429).json({status:'qualification_check_in_progress',recoveryAuthorized:false,tradingAuthorized:false});return;}
  verificationPending=true;
  const controller=new AbortController();
  const verification=Promise.resolve().then(()=>deps.resolveMachineBinding(controller.signal)).finally(()=>{verificationPending=false;});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const binding=await Promise.race([verification,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('qualification_timeout'));},15000);})]);
   if(!binding.ok||binding.releaseSha!==deployedGitSha()||!/^[a-f0-9]{64}$/.test(binding.evidenceDigest)||!Number.isSafeInteger(binding.validUntil)||binding.validUntil<=Date.now()||binding.evidenceIssued!==false||binding.recoveryAuthorized!==false||binding.tradingAuthorized!==false){res.status(409).json({status:'verified_machine_binding_unavailable',recoveryAuthorized:false,tradingAuthorized:false});return;}
   // Construct request-local scope so concurrent requests cannot swap bindings.
   createOwnerConsentRouter({...deps,machineEvidenceDigest:binding.evidenceDigest,machineValidUntil:binding.validUntil})(req,res,next);
  }catch{res.status(503).json({status:'machine_qualification_unavailable',recoveryAuthorized:false,tradingAuthorized:false});}
  finally{if(timer)clearTimeout(timer);}
 });
 return router;
}
