import {constants,createSign} from 'node:crypto';
import type {CredentialProbeMaterial} from './accountCredentialProbe';
const ORIGIN='https://external-api.kalshi.com';
const PATHS=new Set(['/trade-api/v2/api_keys','/trade-api/v2/portfolio/subaccounts/balances']);
/** Fixed production GET only. Injection is server/test-owned, never client data.
 * Reject redirects, HTTP errors, oversized responses, stale time and slow reads.
 * No retry, cache, alternative origin, query string or caller-provided headers. */
export function createDirectRoundingTransport(options:{fetch?:typeof fetch;now?:()=>number;timeoutMs?:number}={}){
 const fetcher=options.fetch??fetch,now=options.now??Date.now,timeout=options.timeoutMs??3000;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3000)throw Error('invalid_direct_read_timeout');
 return async(credential:CredentialProbeMaterial,path:string):Promise<unknown>=>{
  if(!PATHS.has(path))throw Error('direct_read_path_denied');
  const timestamp=now();if(!Number.isSafeInteger(timestamp)||timestamp<0)throw Error('invalid_direct_read_clock');
  const signer=createSign('sha256');signer.update(`${timestamp}GET${path}`);signer.end();
  const signature=signer.sign({key:credential.privateKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},'base64');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('direct_read_timeout'));},timeout);});
  try{return await Promise.race([deadline,(async()=>{
   const response=await fetcher(ORIGIN+path,{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal,headers:{'KALSHI-ACCESS-KEY':credential.keyId,'KALSHI-ACCESS-TIMESTAMP':String(timestamp),'KALSHI-ACCESS-SIGNATURE':signature,'Cache-Control':'no-store','Accept':'application/json'}});
   if(response.redirected||response.url&&response.url!==ORIGIN+path||!response.ok||response.status<200||response.status>=300)throw Error('direct_read_response_rejected');
   if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')||!response.body)throw Error('direct_read_content_rejected');
   const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144)throw Error('direct_read_body_limit');chunks.push(value);}}
   catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const finished=now();if(!Number.isSafeInteger(finished)||finished<0||finished<timestamp||finished-timestamp>timeout)throw Error('direct_read_clock_expired');
   return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  })()]);}finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
