/** Isolated Kalshi DEMO signing + read-only evidence probe.
 * Never issues POST, never handles production credentials or places orders.
 * Demo credentials are separate from real-money Kalshi keys.
 */
import {createPrivateKey, sign, constants} from "node:crypto";

export const KALSHI_DEMO_ORIGIN = "https://external-api.demo.kalshi.co";
const ALLOWED_PATHS = new Set([
  "/trade-api/v2/portfolio/balance",
  "/trade-api/v2/portfolio/positions",
  "/trade-api/v2/portfolio/orders",
  "/trade-api/v2/portfolio/fills",
]);
export type DemoReadResult =
  | {ok:true;status:200;endpoint:string;body:unknown;environment:"KALSHI_DEMO";tradingAuthorized:false}
  | {ok:false;status:number|null;reason:string;environment:"KALSHI_DEMO";tradingAuthorized:false};

export function signKalshiDemoRead(input:{
  keyId:string;privateKeyPem:string;path:string;timestampMs:number;
}):Readonly<Record<string,string>>{
  const {keyId,privateKeyPem,path,timestampMs}=input;
  if(typeof keyId!=="string" || !/^[A-Za-z0-9_-]{8,128}$/.test(keyId) ||
    !ALLOWED_PATHS.has(path) || !Number.isSafeInteger(timestampMs) ||
    timestampMs<1_700_000_000_000)
    throw new Error("demo_read_identity_or_path_invalid");
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=="rsa" && key.asymmetricKeyType!=="ed25519")
    throw new Error("demo_signer_algorithm_unsupported");
  const preSign=Buffer.from(String(timestampMs)+"GET"+path,"utf8");
  const bytes=key.asymmetricKeyType==="rsa"
    ? sign("sha256",preSign,{key,padding:constants.RSA_PKCS1_PSS_PADDING,
        saltLength:constants.RSA_PSS_SALTLEN_DIGEST})
    : sign(null,preSign,key);
  return Object.freeze({
    "KALSHI-ACCESS-KEY":keyId,
    "KALSHI-ACCESS-TIMESTAMP":String(timestampMs),
    "KALSHI-ACCESS-SIGNATURE":bytes.toString("base64"),
  });
}
/** Strict transport injection permits offline tests and separately authorized
 * demo-only GET requests; callers cannot substitute an arbitrary host or POST.
 * Production order transport must never reuse this module.
 */
export async function readSignedKalshiDemo(input:{
  keyId:string;privateKeyPem:string;path:string;timestampMs:number;
  transport:(url:string,init:{method:"GET";headers:Readonly<Record<string,string>>;redirect:"error"})=>Promise<{
    status:number;json:()=>Promise<unknown>;
  }>;
}):Promise<DemoReadResult>{
  if(!ALLOWED_PATHS.has(input.path))
    return {ok:false,status:null,reason:"demo_endpoint_not_allowlisted",
      environment:"KALSHI_DEMO",tradingAuthorized:false};
  let headers:Readonly<Record<string,string>>;
  try{headers=signKalshiDemoRead(input);}
  catch{return {ok:false,status:null,reason:"demo_signature_unavailable",
    environment:"KALSHI_DEMO",tradingAuthorized:false};}
  try{
    const response=await input.transport(KALSHI_DEMO_ORIGIN+input.path,
      {method:"GET",headers,redirect:"error"});
    if(response.status!==200)
      return {ok:false,status:response.status,reason:"demo_get_non_200",
        environment:"KALSHI_DEMO",tradingAuthorized:false};
    return {ok:true,status:200,endpoint:input.path,body:await response.json(),
      environment:"KALSHI_DEMO",tradingAuthorized:false};
  }catch{return {ok:false,status:null,reason:"demo_get_unknown",
    environment:"KALSHI_DEMO",tradingAuthorized:false};}
}
