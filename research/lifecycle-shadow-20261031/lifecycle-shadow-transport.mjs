/** Unwired qualification adapter. Never imports execution, DB, environment or a credential loader. */
import {constants, sign, KeyObject} from 'node:crypto';
export const LIFECYCLE_URL='wss://api.elections.kalshi.com/trade-api/ws/v2';
export const LIFECYCLE_PATH='/trade-api/ws/v2';
export const SUBSCRIPTION=JSON.stringify({id:1,cmd:'subscribe',params:{channels:['market_lifecycle_v2']}});
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const same=(a,b)=>a?.ownerId===b?.ownerId&&a?.accountId===b?.accountId&&a?.credentialBinding===b?.credentialBinding;
function validScope(s){return s&&ID.test(s.ownerId)&&ID.test(s.accountId)&&/^[a-f0-9]{64}$/.test(s.credentialBinding);}
export function nativeSocketFactory(url,headers){
 if(url!==LIFECYCLE_URL)throw Error('fixed_provider_required');
 if(process.versions.node.split('.')[0]!=='24')throw Error('unqualified_node_runtime');
 return new WebSocket(url,{headers});
}
/** Caller must obtain this existing owner-bound key through its reviewed loader; never a global fallback. */
export function createRsaPssSigner(scope,apiKeyId,key){
 if(!validScope(scope)||!ID.test(apiKeyId)||!(key instanceof KeyObject)||key.type!=='private'||!['rsa','rsa-pss'].includes(key.asymmetricKeyType)||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw Error('invalid_signer');
 const binding=Object.freeze({...scope});
 return Object.freeze({scope:binding,signHandshake:async timestamp=>({scope:binding,headers:{
  'KALSHI-ACCESS-KEY':apiKeyId,
  'KALSHI-ACCESS-TIMESTAMP':timestamp,
  'KALSHI-ACCESS-SIGNATURE':sign('sha256',Buffer.from(timestamp+'GET'+LIFECYCLE_PATH),{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).toString('base64'),
 }})});
}
export class LifecycleShadowTransport{
 #lastNow=-Infinity;#scope;#signer;#factory;#active;#clock;#timer;#clear;#random;#cooldown;#observer;#diagnostic;
 #socket=null;#timerId=null;#started=false;#stopped=false;#attempts=0;#generation=0;#deadline=0;#diagCount=0;#phaseDeadline=0;#sid=null;#subscribed=false;#frameTimes=[];#options;
 constructor({scope,signer,socketFactory,isAuthorized,observer={},diagnostic=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,random=Math.random,cooldownUntil=()=>0,maxDurationMs=900000,maxAttempts=6,maxFrameBytes=16384,maxFramesPerSecond=1000}){
  if(!validScope(scope)||!same(scope,signer?.scope)||typeof signer?.signHandshake!=='function'||typeof socketFactory!=='function'||typeof isAuthorized!=='function')throw Error('owner_bound_dependencies_required');
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>6||!Number.isFinite(maxDurationMs)||maxDurationMs<1000||maxDurationMs>1800000||!Number.isInteger(maxFrameBytes)||maxFrameBytes<256||maxFrameBytes>65536||!Number.isInteger(maxFramesPerSecond)||maxFramesPerSecond<1||maxFramesPerSecond>2000)throw Error('invalid_limits');
  this.#scope=Object.freeze({...scope});this.#signer=signer;this.#factory=socketFactory;this.#active=isAuthorized;this.#observer=observer;this.#diagnostic=diagnostic;this.#clock=now;this.#timer=setTimer;this.#clear=clearTimer;this.#random=random;this.#cooldown=cooldownUntil;
  this.#options={maxDurationMs,maxAttempts,maxFrameBytes,maxFramesPerSecond};
 }
 snapshot(){return Object.freeze({mode:'SHADOW_ONLY',executionAuthority:'NONE',started:this.#started,stopped:this.#stopped,attempts:this.#attempts,generation:this.#generation,subscribed:this.#subscribed,diagnosticsEmitted:this.#diagCount});}
 #emit(kind,reason){if(this.#diagCount++>=12){this.#diagCount=12;return;}try{this.#diagnostic(Object.freeze({kind,reason,attempt:this.#attempts,generation:this.#generation}));}catch{}}
 #notify(method,payload){try{const value=this.#observer[method]?.(Object.freeze(payload));if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});this.stop('observer_failed');return false;}return true;}catch{this.stop('observer_failed');return false;}}
 #time(){const value=this.#clock();if(!Number.isSafeInteger(value)||value<0||value<this.#lastNow){this.stop('invalid_clock');return null;}this.#lastNow=value;return value;}
 #allowed(){try{return this.#active(this.#scope)===true;}catch{return false;}}
 #schedule(delay){if(this.#stopped)return; if(this.#timerId!==null)this.#clear(this.#timerId);this.#timerId=this.#timer(()=>{this.#timerId=null;void this.#connect();},Math.max(0,delay));}
 start(){if(this.#started)return;this.#started=true;const now=this.#time();if(now===null)return;this.#deadline=now+this.#options.maxDurationMs;void this.#connect();}
 /** Revocation or cancellation is explicit; also rechecked each second while signing/connected. Cooldown has no socket; rechecked before signing. */
 stop(reason='cancelled'){
  if(this.#stopped)return;
  if(!['invalid_clock','cancelled','observer_failed','authorization_revoked','duration_limit','attempt_limit','invalid_cooldown','cooldown_exceeds_window','invalid_signed_scope','stale_handshake','provider_subscription_error'].includes(reason))reason='cancelled';
  this.#stopped=true;this.#subscribed=false;
  if(this.#timerId!==null)this.#clear(this.#timerId);this.#timerId=null;
  const socket=this.#socket;this.#socket=null;
  this.#notify('onInvalidated',{generation:this.#generation,reason,receivedAtMs:this.#lastNow});
  try{socket?.close(1000,'shadow closed');}catch{}
  this.#emit('stopped',reason);
 }
 #watch(generation){
  if(this.#stopped||generation!==this.#generation)return;
  if(!this.#allowed())return this.stop('authorization_revoked');
  const now=this.#time();if(now===null)return;
  if(now>=this.#deadline)return this.stop('duration_limit');
  if(!this.#subscribed&&now>=this.#phaseDeadline)return this.#failed(generation,'handshake_timeout');
  this.#timerId=this.#timer(()=>{this.#timerId=null;this.#watch(generation);},Math.min(1000,this.#deadline-now));
 }
 #failed(generation,reason){
  if(this.#stopped||generation!==this.#generation)return;
  const socket=this.#socket;this.#socket=null;this.#sid=null;this.#subscribed=false;
  if(this.#timerId!==null)this.#clear(this.#timerId);this.#timerId=null;
  // Advance immediately so error + close, delayed signing and old messages cannot cause parallel retries.
  this.#generation++;
  this.#notify('onInvalidated',{generation,reason,receivedAtMs:this.#lastNow});
  try{socket?.close(1000,'shadow reconnect');}catch{}
  this.#emit('disconnected',reason);
  if(this.#attempts>=this.#options.maxAttempts)return this.stop('attempt_limit');
  const base=Math.min(30000,1000*2**(this.#attempts-1));
  const jitter=Math.max(0,Math.min(1,Number(this.#random())||0));
  this.#schedule(base+Math.round(base*.25*jitter));
 }
 async #connect(){
  if(this.#stopped)return;
  if(!this.#allowed())return this.stop('authorization_revoked');
  const now=this.#time();if(now===null)return;if(now>=this.#deadline)return this.stop('duration_limit');
  let cooldown;try{cooldown=this.#cooldown();}catch{return this.stop('invalid_cooldown');}if(!Number.isFinite(cooldown))return this.stop('invalid_cooldown');
  if(cooldown>now){if(cooldown>=this.#deadline)return this.stop('cooldown_exceeds_window');return this.#schedule(cooldown-now);}
  if(this.#attempts>=this.#options.maxAttempts)return this.stop('attempt_limit');
  this.#attempts++;const generation=++this.#generation;this.#sid=null;this.#subscribed=false;this.#frameTimes=[];
  this.#phaseDeadline=Math.min(this.#deadline,now+10000);this.#watch(generation);
  const timestamp=String(Math.floor(now));
  let signed;
  try{signed=await this.#signer.signHandshake(timestamp);}catch{return this.#failed(generation,'signing_failed');}
  if(this.#stopped||generation!==this.#generation)return;
  if(!this.#allowed())return this.stop('authorization_revoked');
  if(!same(signed?.scope,this.#scope)||!signed.headers||Object.keys(signed.headers).sort().join(',')!=='KALSHI-ACCESS-KEY,KALSHI-ACCESS-SIGNATURE,KALSHI-ACCESS-TIMESTAMP'||signed.headers['KALSHI-ACCESS-TIMESTAMP']!==timestamp||!ID.test(signed.headers['KALSHI-ACCESS-KEY'])||typeof signed.headers['KALSHI-ACCESS-SIGNATURE']!=='string'||!/^[A-Za-z0-9+/]{16,4096}={0,2}$/.test(signed.headers['KALSHI-ACCESS-SIGNATURE']))return this.stop('invalid_signed_scope');
  const signedAt=this.#time();if(signedAt===null)return;if(signedAt>=this.#deadline)return this.stop('duration_limit');if(signedAt-now>5000)return this.stop('stale_handshake');
  try{this.#socket=this.#factory(LIFECYCLE_URL,Object.freeze({...signed.headers}));}catch{return this.#failed(generation,'socket_creation_failed');}
  const ws=this.#socket;
  if(!ws||typeof ws.addEventListener!=='function'||typeof ws.send!=='function'||typeof ws.close!=='function')return this.#failed(generation,'invalid_socket');
  let openSent=false;
  ws.addEventListener('open',()=>{
   if(this.#stopped||generation!==this.#generation||ws!==this.#socket)return;
   if(!this.#allowed())return this.stop('authorization_revoked');
   const openedAt=this.#time();if(openedAt===null)return;if(openedAt>=this.#deadline)return this.stop('duration_limit');if(openedAt>=this.#phaseDeadline)return this.#failed(generation,'handshake_timeout');
   if(openSent)return;openSent=true;
   try{ws.send(SUBSCRIPTION);}catch{return this.#failed(generation,'subscription_send_failed');}
  });
  ws.addEventListener('message',event=>{
   if(this.#stopped||generation!==this.#generation||ws!==this.#socket)return;
   if(!this.#allowed())return this.stop('authorization_revoked');
   const receipt=this.#time();if(receipt===null)return;if(receipt>=this.#deadline)return this.stop('duration_limit');if(!this.#subscribed&&receipt>=this.#phaseDeadline)return this.#failed(generation,'handshake_timeout');
   if(typeof event.data!=='string'||event.data.length>this.#options.maxFrameBytes||Buffer.byteLength(event.data,'utf8')>this.#options.maxFrameBytes)return this.#failed(generation,'frame_limit');
   this.#frameTimes=this.#frameTimes.filter(t=>receipt-t<1000);this.#frameTimes.push(receipt);
   if(this.#frameTimes.length>this.#options.maxFramesPerSecond)return this.#failed(generation,'message_rate_limit');
   let envelope;try{envelope=JSON.parse(event.data);}catch{return this.#failed(generation,'malformed_json');}
   if(envelope?.type==='error')return this.stop('provider_subscription_error');
   if(envelope?.type==='subscribed'){
    if(this.#subscribed||envelope.id!==1||envelope.msg?.channel!=='market_lifecycle_v2'||!Number.isSafeInteger(envelope.msg.sid)||envelope.msg.sid<0)return this.#failed(generation,'invalid_subscription');
    this.#sid=envelope.msg.sid;this.#subscribed=true;
    // Ack supplies sid only. It does not manufacture authenticated account capability or a sequence baseline.
    this.#notify('onSubscribed',{scope:this.#scope,generation,sid:this.#sid,receivedAtMs:receipt});return;
   }
   if(!this.#subscribed||envelope?.sid!==this.#sid||!['market_lifecycle_v2','event_lifecycle','event_fee_update'].includes(envelope?.type))return this.#failed(generation,'unexpected_envelope');
   // Forward all messages for this subscription. Consumer must validate seq before local market filtering.
   this.#notify('onEnvelope',{generation,sid:this.#sid,receivedAtMs:receipt,raw:event.data});
  });
  ws.addEventListener('error',()=>this.#failed(generation,'socket_error'));
  ws.addEventListener('close',()=>this.#failed(generation,'socket_closed'));
 }
}
