/**
 * Separate administrator-authorized, audited operator-attested KXBTC15M
 * fee SOURCE release. Never claims Kalshi-signed PDF origin, grants an owner
 * policy, starts a worker, transfers money, or submits orders.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
const SHA="c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
const BUCKET="strata-official-fee-artifacts";
const PATH="operator-pending/kalshi-fee-schedule.pdf";
const TABLE="strata_fee_operator_approved_releases";
const CONFIRM="AUTHORIZE_OPERATOR_ATTESTED_FEE_SOURCE_WITH_LIVE_API_GUARD";
const REVOKE="REVOKE_OPERATOR_ATTESTED_FEE_RELEASE";
const ORIGIN=Deno.env.get("STRATA_WEB_ORIGIN")?.trim() ||
  "https://private-multi-asset-eviv.bolt.host";
const CORS={
  "access-control-allow-origin":ORIGIN,
  "access-control-allow-headers":"authorization, apikey, content-type, x-client-info, x-supabase-client-platform, x-supabase-client-version",
  "access-control-allow-methods":"GET, POST, OPTIONS",vary:"Origin",
};
const HEADERS={"content-type":"application/json","cache-control":"private, no-store",
  "x-content-type-options":"nosniff",...CORS};
const send=(status:number,data:Record<string,unknown>)=>
  new Response(JSON.stringify(data),{status,headers:HEADERS});
const fail=(status:number,reason:string)=>send(status,{ok:false,reason,
  approvedOfficialPdf:false,ownerPolicyApproved:false,tradingAuthorized:false});
const isRecord=(v:unknown):v is Record<string,unknown> =>
  !!v&&typeof v==="object"&&!Array.isArray(v);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function sha256(bytes:Uint8Array):Promise<string>{
  const copy=new Uint8Array(bytes);const digest=await crypto.subtle.digest("SHA-256",copy.buffer);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
const API="https://api.elections.kalshi.com/trade-api/v2";
async function getJson(path:string):Promise<Record<string,unknown>> {
  const url=API+path;
  const res=await fetch(url,{method:"GET",redirect:"error",cache:"no-store",
    signal:AbortSignal.timeout(8000),headers:{Accept:"application/json"}});
  if(res.status!==200||res.url!==url||
    res.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
    throw Error("kalshi_fee_api_unavailable");
  const n=Number(res.headers.get("content-length")??"0");
  if(!Number.isSafeInteger(n)||n>256000)throw Error("kalshi_fee_api_invalid");
  const bytes=new Uint8Array(await res.arrayBuffer());
  if(bytes.length<2||bytes.length>256000)throw Error("kalshi_fee_api_invalid");
  const parsed=JSON.parse(new TextDecoder().decode(bytes));
  if(!isRecord(parsed))throw Error("kalshi_fee_api_invalid");
  return parsed;
}
const timestamp=(x:unknown)=>typeof x==="string"&&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x)?
    Date.parse(x):NaN;
async function verifyLiveFee():Promise<boolean>{
  try{
    const listing=await getJson("/markets?series_ticker=KXBTC15M&status=open&limit=100");
    if(!Array.isArray(listing.markets)||listing.markets.length===0||listing.cursor)
      return false;
    const markets=listing.markets.filter(isRecord).filter(m=>
      (m.status==="open"||m.status==="active")&&
      Number.isFinite(timestamp(m.close_time))&&timestamp(m.close_time)>Date.now()&&
      typeof m.ticker==="string"&&/^KXBTC15M-[A-Za-z0-9-]+$/.test(m.ticker))
      .sort((a,b)=>timestamp(a.close_time)-timestamp(b.close_time));
    const market=markets[0];
    if(!market||markets[1]&&markets[1].close_time===market.close_time||
      typeof market.event_ticker!=="string")return false;
    const ticker=String(market.ticker),eventTicker=market.event_ticker;
    if(!/^KXBTC15M-[A-Za-z0-9-]+$/.test(eventTicker))return false;
    const [m,e,s,sc,ec]=await Promise.all([
      getJson("/markets/"+encodeURIComponent(ticker)),
      getJson("/events/"+encodeURIComponent(eventTicker)),
      getJson("/series/KXBTC15M"),
      getJson("/series/fee_changes?series_ticker=KXBTC15M&show_historical=false&limit=100"),
      getJson("/events/fee_changes?event_ticker="+encodeURIComponent(eventTicker)+
        "&show_historical=false&limit=100"),
    ]);
    if(!isRecord(m.market)||!isRecord(e.event)||!isRecord(s.series))return false;
    const mm=m.market,ev=e.event,ser=s.series;
    if(mm.ticker!==ticker||mm.event_ticker!==eventTicker||
      mm.close_time!==market.close_time||ev.event_ticker!==eventTicker||
      ev.series_ticker!=="KXBTC15M"||ser.ticker!=="KXBTC15M"||
      ser.fee_type!=="quadratic"||
      ![1,"1","1.0"].includes(ser.fee_multiplier as string|number)||
      ev.fee_type_override!=null||ev.fee_multiplier_override!=null||
      Object.keys(mm).some(k=>/fee|rebate/i.test(k)&&mm[k]!=null&&mm[k]!==false))return false;
    const close=timestamp(mm.close_time);
    const expiries=[mm.expiration_time,mm.latest_expiration_time,
      mm.expected_expiration_time].map(timestamp);
    if(!Number.isFinite(close)||expiries.some(x=>!Number.isFinite(x)||x<close))
      return false;
    const end=Math.max(close,...expiries);
    const safe=(data:Record<string,unknown>,key:string)=>
      (data.cursor===undefined||data.cursor==="")&&
      Array.isArray(data[key])&&(data[key] as unknown[]).length<=100&&
      (data[key] as unknown[]).every(c=>isRecord(c)&&typeof c.id==="string"&&
        Number.isFinite(timestamp(c.scheduled_ts))&&timestamp(c.scheduled_ts)>end);
    return safe(sc,"series_fee_change_arr")&&safe(ec,"event_fee_changes");
  }catch{return false;}
}
Deno.serve(async(req:Request):Promise<Response>=>{
  if(req.method==="OPTIONS")return req.headers.get("origin")===ORIGIN?
    new Response(null,{status:204,headers:CORS}):
    new Response(null,{status:403,headers:{vary:"Origin"}});
  if(req.method!=="GET"&&req.method!=="POST")return fail(405,"method_not_allowed");
  const url=new URL(req.url);
  if(url.search||url.pathname.split("/").pop()!=="strata-fee-approval")
    return fail(404,"unsupported_path");
  const endpoint=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),
    service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!endpoint||!anon||!service)return fail(503,"service_unavailable");
  const auth=req.headers.get("authorization")??"";
  const token=/^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(auth)?.[1];
  if(!token)return fail(401,"login_required");
  try{
    const userClient=createClient(endpoint,anon,{
      global:{headers:{Authorization:auth}},
      auth:{persistSession:false,autoRefreshToken:false},
    });
    const who=await userClient.auth.getUser(token);
    const user=who.data.user;
    if(who.error||!user?.id||!user.email_confirmed_at)return fail(401,"login_required");
    const admin=await userClient.rpc("strata_can_inspect_pending_fee_artifact");
    if(admin.error||admin.data!==true)return fail(403,"admin_required");
    const server=createClient(endpoint,service,{
      auth:{persistSession:false,autoRefreshToken:false},
    });
    const existing=await server.from(TABLE)
      .select("approval_id,candidate_id,expires_at,revoked_at")
      .is("revoked_at",null).gt("expires_at",new Date().toISOString())
      .order("approved_at",{ascending:false}).limit(2);
    if(existing.error)return fail(503,"approval_database_unavailable");
    const active=existing.data??[];
    if(req.method==="GET")return send(200,{
      ok:true,reason:"operator_attested_release_status_only",
      releaseApproved:active.length===1,
      releaseAmbiguous:active.length>1,
      approvalId:active.length===1?active[0].approval_id:null,
      releaseExpiresAt:active.length===1?active[0].expires_at:null,
      approvedOfficialPdf:false,ownerPolicyApproved:false,tradingAuthorized:false,
    });
    if(req.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
      return fail(415,"json_required");
    const raw=await req.text();
    if(raw.length>2800)return fail(413,"release_note_too_long");
    let body:unknown;
    try{body=JSON.parse(raw);}catch{return fail(400,"invalid_json");}
    if(!isRecord(body))return fail(422,"confirmation_required");
    const note=typeof body.note==="string"?body.note.trim():"";
    if(body.confirmation===REVOKE){
      const id=body.approvalId;
      if(typeof id!=="string"||!UUID.test(id)||note.length<10||note.length>300)
        return fail(422,"revocation_reason_required");
      const changed=await server.from(TABLE)
        .update({revoked_at:new Date().toISOString(),revocation_reason:note})
        .eq("approval_id",id).is("revoked_at",null)
        .select("approval_id").single();
      if(changed.error||!changed.data)return fail(409,"revocation_not_recorded");
      return send(200,{ok:true,reason:"fee_release_revoked",tradingAuthorized:false,
        approvedOfficialPdf:false,ownerPolicyApproved:false});
    }
    if(body.confirmation!==CONFIRM||note.length<100||note.length>1600)
      return fail(422,"explicit_release_review_and_note_required");
    if(active.length!==0)return fail(409,"active_release_already_recorded");
    const candidates=await server.from("strata_fee_operator_release_candidates")
      .select("release_id,content_sha256,reviewer_1,reviewer_2,expires_at")
      .eq("content_sha256",SHA).is("revoked_at",null)
      .gt("expires_at",new Date().toISOString())
      .order("recorded_at",{ascending:false}).limit(2);
    if(candidates.error||candidates.data?.length!==1)
      return fail(409,"one_current_candidate_required");
    const candidate=candidates.data[0];
    const reviews=await server.rpc("strata_two_operator_fee_reviews_valid",{
      first_review:candidate.reviewer_1,second_review:candidate.reviewer_2,
      expected_digest:SHA,
    });
    if(reviews.error||reviews.data!==true)return fail(409,"independent_reviews_not_current");
    const stored=await server.storage.from(BUCKET).download(PATH);
    if(stored.error||!stored.data||stored.data.size!==281129)
      return fail(409,"reviewed_pdf_unavailable");
    const bytes=new Uint8Array(await stored.data.arrayBuffer());
    if(bytes.length!==281129||
      new TextDecoder().decode(bytes.subarray(0,5))!=="%PDF-"||
      !new TextDecoder().decode(bytes.subarray(-2048)).includes("%%EOF")||
      await sha256(bytes)!==SHA)
      return fail(409,"reviewed_pdf_digest_mismatch");
    if(!await verifyLiveFee())return fail(409,"kalshi_live_market_fee_unverified");
    const checked=await server.rpc("strata_two_operator_fee_reviews_valid",{
      first_review:candidate.reviewer_1,second_review:candidate.reviewer_2,
      expected_digest:SHA,
    });
    if(checked.error||checked.data!==true||
      Date.parse(candidate.expires_at)<=Date.now())
      return fail(409,"release_candidate_expired_during_check");
    const approvedAt=new Date(),expiresAt=new Date(approvedAt.getTime()+24*3600000);
    const inserted=await server.from(TABLE).insert({
      candidate_id:candidate.release_id,content_sha256:SHA,
      released_by:user.id,reviewed_risks:note,release_confirmation:CONFIRM,
      approved_at:approvedAt.toISOString(),expires_at:expiresAt.toISOString(),
    }).select("approval_id,expires_at").single();
    if(inserted.error||!inserted.data)return fail(409,"fee_release_not_recorded");
    return send(201,{ok:true,reason:"operator_attested_fee_source_released_only",
      approvalId:inserted.data.approval_id,releaseExpiresAt:inserted.data.expires_at,
      provenanceType:"operator_attested_not_kalshi_signed",
      approvedOfficialPdf:false,ownerPolicyApproved:false,tradingAuthorized:false,
    });
  }catch{return fail(503,"fee_release_unavailable");}
});
