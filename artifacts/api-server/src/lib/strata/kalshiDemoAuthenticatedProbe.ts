/**
 * Authenticated KALSHI DEMO connection smoke-test. This is the ONLY allowed
 * remote host/path and method. Never use production secrets or print response
 * bodies (including private balances, positions, or key IDs).
 *
 * This provides real signed GET evidence WHEN separately provisioned demo
 * credentials are supplied. It DOES NOT authorize any order or commission.
 */
import {KALSHI_DEMO_ORIGIN,readSignedKalshiDemo} from "./kalshiDemoSignedReadOnly";

export const DEMO_BALANCE_PATH="/trade-api/v2/portfolio/balance" as const;
export type DemoConnectionEvidence={
  environment:"KALSHI_DEMO";
  host:typeof KALSHI_DEMO_ORIGIN;
  path:typeof DEMO_BALANCE_PATH;
  method:"GET";
  httpStatus:number|null;
  authenticated:boolean;
  responseShapeVerified:boolean;
  tradingAuthorized:false;
  credentialsExposed:false;
  reason:string;
};
type Transport=typeof fetch;
const evidence=(status:number|null,authenticated:boolean,shape:boolean,reason:string):
  DemoConnectionEvidence=>({
    environment:"KALSHI_DEMO",host:KALSHI_DEMO_ORIGIN,path:DEMO_BALANCE_PATH,
    method:"GET",httpStatus:status,authenticated,responseShapeVerified:shape,
    tradingAuthorized:false,credentialsExposed:false,reason,
  });

export async function probeAuthenticatedDemoBalance(input:{
  keyId:string;privateKeyPem:string;
  fetchImpl?:Transport;
  nowMs?:()=>number;
}):Promise<DemoConnectionEvidence>{
  const now=(input.nowMs??Date.now)();
  if(!Number.isSafeInteger(now)||now<=0)
    return evidence(null,false,false,"demo_clock_invalid");
  const expectedUrl=KALSHI_DEMO_ORIGIN+DEMO_BALANCE_PATH;
  let calls=0;
  const transport=async (
    url:string,
    init:{method:"GET";headers:Readonly<Record<string,string>>;redirect:"error"},
  )=>{
    if(url!==expectedUrl||init.method!=="GET"||init.redirect!=="error"||calls!==0)
      throw Error("demo_read_transport_scope_invalid");
    calls+=1;
    const res=await (input.fetchImpl??fetch)(expectedUrl,{
      method:"GET",redirect:"error",cache:"no-store",
      headers:{...init.headers,Accept:"application/json"},
      signal:AbortSignal.timeout(10_000),
    });
    const maxLength=Number(res.headers.get("content-length")??"0");
    if(!Number.isSafeInteger(maxLength)||maxLength>128_000)
      throw Error("demo_read_response_too_large");
    return {status:res.status,json:async()=>{
      if(res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/json")
        throw Error("demo_read_content_type_invalid");
      return res.json();
    }};
  };
  const result=await readSignedKalshiDemo({
    keyId:input.keyId,privateKeyPem:input.privateKeyPem,
    path:DEMO_BALANCE_PATH,timestampMs:now,transport,
  });
  if(!result.ok)
    return evidence(result.status,false,false,result.reason);
  const body=result.body;
  // Kalshi portfolio/balance should contain its numeric balance. A 200 from
  // the wrong service or an HTML login page cannot pass this check.
  const obj=body && typeof body==="object"&&!Array.isArray(body)
    ? body as Record<string,unknown> : null;
  const balance=obj?.balance;
  const validBalance=(typeof balance==="number"&&Number.isSafeInteger(balance)&&balance>=0)
    ||(typeof balance==="string"&&/^(0|[1-9][0-9]*)$/.test(balance));
  if(!validBalance)return evidence(200,true,false,"demo_balance_response_unverified");
  return evidence(200,true,true,"authenticated_demo_balance_get_verified");
}
