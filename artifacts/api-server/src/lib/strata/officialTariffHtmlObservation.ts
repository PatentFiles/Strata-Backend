/**
 * #165: independent, issuer-origin HTTP observation of Kalshi's LIVE HTML fee
 * schedule. This is an evidence DIAGNOSTIC, NOT a monetary rate grant.
 *
 * The website presently paginates non-standard fees. A partial first page
 * cannot assert the absence of a KXBTC15M exception; the published standard
 * fee range alone is not an exact per-fill monetary rate or rounding rule.
 *
 * No SQL, credentials, user session, owner grant, fee cache, or exchange POST.
 */
import {createHash} from "node:crypto";

export const OFFICIAL_TARIFF_HTML_URL="https://kalshi.com/fee-schedule" as const;
const MAX_HTML_BYTES=750_000;
const MAX_AGE_MS=30_000;
const MARKET_SERIES=/^KXBTC15M$/;
const sha256=(input:string)=>createHash("sha256").update(input).digest("hex");
type Evidence={
  sourceUrl:typeof OFFICIAL_TARIFF_HTML_URL;
  sourceSha256:string;
  observedAt:string;
  standardTaker100ContractRange:string;
  firstPageExceptionSeries:readonly string[];
  advertisedExceptionCount:number;
  renderedPage:number;
  renderedPages:number;
  exactFormulaPublished:boolean;
  exceptionListComplete:boolean;
  noUpcomingChanges:boolean;
  sourceComplete:boolean;
  reviewEligible:false;
  tradingAuthorized:false;
};
type ErrorResult={ok:false;reason:string;tradingAuthorized:false;reviewEligible:false};
export type OfficialTariffHtmlResult={ok:true;reason:"official_tariff_observation_read_only";evidence:Evidence}&
  {tradingAuthorized:false;reviewEligible:false}|ErrorResult;
const deny=(reason:string):ErrorResult=>({ok:false,reason,tradingAuthorized:false,reviewEligible:false});
const htmlText=(raw:string)=>{
 const main=/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(raw)?.[1]??raw;
 return main.replace(/<!--[\s\S]*?-->/g," ")
  .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi," ")
  .replace(/<br\s*\/?\s*>/gi," ")
  .replace(/<[^>]*>/g," ")
  .replace(/&(?:amp|nbsp|lt|gt|quot|#39);/g,x=>({
    "&amp;":"&","&nbsp;":" ","&lt;":"<","&gt;":">",
    "&quot;":'"',"&#39;":"'",
  })[x]??x)
  .replace(/\s+/g," ").trim();
};
/** Strictly interpret one live first-party HTML response. Unrecognized layout
 * is a denial, rather than a default standard-fee conclusion. */
export function parseOfficialTariffHtml(raw:string,observedAtMs:number):OfficialTariffHtmlResult{
 if(!Number.isSafeInteger(observedAtMs)||observedAtMs<=0||
    raw.length<250||raw.length>MAX_HTML_BYTES)
   return deny("official_tariff_html_or_clock_invalid");
 const text=htmlText(raw);
 if(!/\bFee schedule\b/i.test(text)||
    !/<h2\b[^>]*>\s*Standard fees\s*<\/h2>/i.test(raw)||
    !/<h2\b[^>]*>\s*Non-standard fees\s*<\/h2>/i.test(raw)||
    !/\bMost markets\b/i.test(text))
   return deny("official_tariff_html_structure_unverified");
 const range=/\bMost markets\s+-\s+1\s+(\$\d+\.\d{2}\s*-\s*\$\d+\.\d{2})\s+taker fees\b/i.exec(text);
 if(!range)return deny("official_tariff_standard_fee_range_unverified");
 const pages=/\bPage\s+(\d+)\s+of\s+(\d+)\s*\(\s*(\d+)\s+total series\s*\)/i.exec(text);
 if(!pages)return deny("official_tariff_exception_pagination_unverified");
 const [page,totalPages,totalSeries]=pages.slice(1).map(Number);
 if(!page||!totalPages||page>totalPages||totalPages>500||
    !Number.isSafeInteger(totalSeries)||totalSeries<0||totalSeries>100_000)
   return deny("official_tariff_exception_pagination_invalid");
 // Extract only issuer-site non-standard links, bounded by the section.
 const section=/<h2\b[^>]*>\s*Non-standard fees\s*<\/h2>([\s\S]*?)(?:Page\s+\d+\s+of\s+\d+|<\/main>)/i.exec(raw)?.[1];
 if(!section)return deny("official_tariff_exception_section_missing");
 const tickers=[...section.matchAll(/href=["'](?:https:\/\/kalshi\.com)?\/markets\/(KX[A-Z0-9]+)["']/g)].map(m=>m[1]!);
 if(new Set(tickers).size!==tickers.length||tickers.length>1000)
   return deny("official_tariff_exception_list_ambiguous");
 const exceptionListComplete=page===1&&totalPages===1&&tickers.length===totalSeries;
 const noUpcomingChanges=/\bNo upcoming fee changes scheduled\./i.test(text);
 // The LIVE HTML presently only quotes a 100-contract fee RANGE, without
 // the complete formula and rounding semantics. We never infer 0.07 from it.
 const exactFormulaPublished=/\bfees\s*=\s*round\s+up\s*\(\s*M\s*[x×*]\s*0\.0[0-9]+\s*[x×*]\s*C\s*[x×*]\s*P\s*[x×*]\s*\(1\s*[-−]\s*P\)/i.test(text)&&
    /\bround(?:ing)?\b.+\b(?:cent|centicent)\b/i.test(text);
 const sourceComplete=exceptionListComplete&&noUpcomingChanges&&exactFormulaPublished;
 const evidence:Evidence={
   sourceUrl:OFFICIAL_TARIFF_HTML_URL,sourceSha256:sha256(raw),
   observedAt:new Date(observedAtMs).toISOString(),
   standardTaker100ContractRange:range[1]!.replace(/\s+/g," "),
   firstPageExceptionSeries:tickers,advertisedExceptionCount:totalSeries,
   renderedPage:page,renderedPages:totalPages,
   exactFormulaPublished,exceptionListComplete,noUpcomingChanges,sourceComplete,
   reviewEligible:false,tradingAuthorized:false,
 };
 return {ok:true,reason:"official_tariff_observation_read_only",
   evidence,reviewEligible:false,tradingAuthorized:false};
}
/** Fetch exactly the issuer's canonical HTML; never follow redirects, accept a
 * proxy-asserted URL or treat a cached/synthetic payload as live authority. */
export async function observeOfficialTariffHtml(
  fetchImpl:typeof fetch=globalThis.fetch, now:()=>number=Date.now,
):Promise<OfficialTariffHtmlResult>{
 const started=now();
 if(!Number.isSafeInteger(started)||started<=0)return deny("official_tariff_clock_invalid");
 let response:Response;
 try{
   response=await fetchImpl(OFFICIAL_TARIFF_HTML_URL,{
     method:"GET",redirect:"manual",cache:"no-store",
     headers:{Accept:"text/html"},signal:AbortSignal.timeout(8_000),
   });
 }catch{return deny("official_tariff_issuer_fetch_unavailable");}
 if(response.status===429)return deny("official_tariff_provider_rate_limited");
 if(response.status!==200||response.redirected||response.url!==OFFICIAL_TARIFF_HTML_URL||
    !/^text\/html\b/i.test(response.headers.get("content-type")??""))
   return deny("official_tariff_response_not_verifiable");
 const announced=Number(response.headers.get("content-length")??"0");
 if(!Number.isSafeInteger(announced)||announced<0||announced>MAX_HTML_BYTES)
   return deny("official_tariff_response_too_large");
 let raw:string;
 try{raw=await response.text();}catch{return deny("official_tariff_response_unreadable");}
 const completed=now();
 if(!Number.isSafeInteger(completed)||completed<started||
    completed-started>MAX_AGE_MS)return deny("official_tariff_response_stale");
 return parseOfficialTariffHtml(raw,completed);
}
export const isOfficialTariffCompleteForSeries=(r:OfficialTariffHtmlResult,series:string):false=>{
  // A complete first-party HTML snapshot is necessary but NOT sufficient:
  // individual series/event fee-change endpoints, signed owner scopes, the
  // full monetary formula and protected release proofs are separately required.
  // Deliberately no trading permission can be derived from this observation.
  void r;void MARKET_SERIES.test(series);
  return false;
};
