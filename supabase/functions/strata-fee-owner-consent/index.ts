/**
 * Owner-only fee-source consent. This is separate from owner policy approval,
 * commissioning, arm/kill controls and order execution. No financial mutation.
 * Never accepts an owner ID or grant identity except an exact grantId lookup
 * scoped to the user identified by Supabase Auth.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
const CONFIRMATION = "CONFIRM_OPERATOR_FEE_SOURCE_ONLY";
const ORIGIN = Deno.env.get("STRATA_WEB_ORIGIN")?.trim() ||
  "https://private-multi-asset-eviv.bolt.host";
const HEADERS = {
  "content-type":"application/json","cache-control":"private, no-store",
  "x-content-type-options":"nosniff","access-control-allow-origin":ORIGIN,
  "access-control-allow-headers":"authorization, apikey, content-type, x-client-info, x-supabase-client-platform, x-supabase-client-version",
  "access-control-allow-methods":"GET, POST, OPTIONS","vary":"Origin",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status:number, data:Record<string,unknown>) =>
  new Response(JSON.stringify(data), {status,headers:HEADERS});
const fail=(status:number, reason:string) => reply(status, {
  ok:false,reason,policyApproved:false,commissioningApproved:false,tradingAuthorized:false,
});
function record(v:unknown):v is Record<string,unknown> {
  return !!v&&typeof v==="object"&&!Array.isArray(v);
}
Deno.serve(async(req:Request):Promise<Response>=>{
  if(req.method==="OPTIONS")
    return req.headers.get("origin")===ORIGIN ?
      new Response(null,{status:204,headers:HEADERS}) :
      new Response(null,{status:403,headers:{vary:"Origin"}});
  if(req.method!=="GET"&&req.method!=="POST")return fail(405,"method_not_allowed");
  const url=new URL(req.url);
  if(url.search || url.pathname.split("/").pop()!=="strata-fee-owner-consent")
    return fail(404,"unsupported_path");
  if(req.method==="POST"&&req.headers.get("origin")!==ORIGIN)
    return fail(403,"origin_required");
  const endpoint=Deno.env.get("SUPABASE_URL"),
    anon=Deno.env.get("SUPABASE_ANON_KEY"),
    secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!endpoint||!anon||!secret)return fail(503,"service_unavailable");
  const auth=req.headers.get("authorization")??"";
  const token=/^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(auth)?.[1];
  if(!token)return fail(401,"login_required");
  try {
    const actor=createClient(endpoint,anon,{
      global:{headers:{Authorization:auth}},
      auth:{persistSession:false,autoRefreshToken:false},
    });
    const verified=await actor.auth.getUser(token);
    const owner=verified.data.user;
    if(verified.error||!owner?.id||!UUID.test(owner.id)||!owner.email_confirmed_at)
      return fail(401,"login_required");
    const service=createClient(endpoint,secret,{
      auth:{persistSession:false,autoRefreshToken:false},
    });
    const accounts=await service.from("v13_production_account").select("id")
      .eq("owner_user_id",owner.id).eq("subaccount",1).eq("exchange_index",2).limit(2);
    if(accounts.error||accounts.data?.length!==1)
      return fail(409,"owned_account_missing_or_ambiguous");
    if(req.method==="GET") {
      const consents=await service.schema("private").from("strata_fee_source_owner_consents")
        .select("consent_id,grant_id,confirmed_at,revoked_at")
        .eq("owner_user_id",owner.id).order("confirmed_at",{ascending:false}).limit(2);
      if(consents.error)return fail(503,"consent_status_unavailable");
      return reply(200,{ok:true,reason:"owner_consent_status_only",
        consents:(consents.data??[]).map(c=>({
          consentId:c.consent_id,grantId:c.grant_id,
          confirmedAt:c.confirmed_at,revoked:c.revoked_at!==null,
        })),
        policyApproved:false,commissioningApproved:false,tradingAuthorized:false});
    }
    if(req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/json")
      return fail(415,"json_required");
    const raw=await req.text();
    if(raw.length>900)return fail(413,"request_too_large");
    let body:unknown;
    try{body=JSON.parse(raw);}catch{return fail(400,"invalid_json");}
    if(!record(body) || body.confirmation!==CONFIRMATION ||
      typeof body.grantId!=="string" || !UUID.test(body.grantId))
      return fail(422,"explicit_owner_grant_consent_required");
    const grants=await service.schema("private").from("strata_fee_source_grants")
      .select("grant_id,release_id,owner_user_id,expires_at,revoked_at,authorized_stages")
      .eq("grant_id",body.grantId).eq("owner_user_id",owner.id)
      .is("revoked_at",null).gt("expires_at",new Date().toISOString()).limit(2);
    if(grants.error||grants.data?.length!==1)
      return fail(409,"current_owned_grant_required");
    const grant=grants.data[0]!;
    const stages=grant.authorized_stages;
    if(!Array.isArray(stages)||!["STEP_6","STEP_9","STEP_11","ORDER_ENTRY"]
      .every(s=>stages.includes(s)))return fail(409,"grant_stage_scope_insufficient");
    const release=await service.from("strata_fee_operator_release_candidates")
      .select("release_id,expires_at,revoked_at")
      .eq("release_id",grant.release_id).is("revoked_at",null)
      .gt("expires_at",new Date().toISOString()).limit(2);
    if(release.error||release.data?.length!==1)
      return fail(409,"operator_release_not_current");
    const existing=await service.schema("private").from("strata_fee_source_owner_consents")
      .select("consent_id,revoked_at").eq("owner_user_id",owner.id)
      .eq("grant_id",body.grantId).limit(2);
    if(existing.error)return fail(503,"consent_status_unavailable");
    if(existing.data?.length)return fail(409,"owner_consent_already_recorded_no_retry");
    const written=await service.schema("private").from("strata_fee_source_owner_consents")
      .insert({consent_id:crypto.randomUUID(),grant_id:grant.grant_id,
        owner_user_id:owner.id,release_id:grant.release_id,
        confirmation:CONFIRMATION,confirmed_at:new Date().toISOString()})
      .select("consent_id,confirmed_at").single();
    if(written.error||!written.data)return fail(409,"owner_consent_outcome_unverified");
    return reply(201,{ok:true,reason:"owner_source_consent_recorded_only",
      consentId:written.data.consent_id,confirmedAt:written.data.confirmed_at,
      policyApproved:false,commissioningApproved:false,tradingAuthorized:false});
  } catch {return fail(503,"consent_service_unavailable");}
});
