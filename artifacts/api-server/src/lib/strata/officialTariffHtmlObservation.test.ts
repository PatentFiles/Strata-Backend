import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_TARIFF_HTML_URL,parseOfficialTariffHtml,observeOfficialTariffHtml,
  isOfficialTariffCompleteForSeries,
} from "./officialTariffHtmlObservation";
const now=Date.parse("2026-10-24T15:45:00Z");
const fixture=(override:{total?:number;pages?:number;page?:number;range?:string;upcoming?:string;tickers?:string[]}={})=>{
 const tickers=override.tickers??["KXAAAGASM","KXBTCY"];
 return `<!doctype html><html><main>
 <h1>Fee schedule</h1><h2>Upcoming fee changes</h2>
 <p>${override.upcoming??"No upcoming fee changes scheduled."}</p>
 <h2>Standard fees</h2>
 <table><tbody><tr><td>Most markets</td><td>-</td><td>1</td>
 <td>${override.range??"$0.07 - $1.75"}</td><td>taker fees</td></tr></tbody></table>
 <h2>Non-standard fees</h2><p>The following series have additional fees or different multipliers</p>
 <table><tbody>${tickers.map(x=>`<tr><td><a href="/markets/${x}">${x}</a></td></tr>`).join("")}</tbody></table>
 <div>Page ${override.page??1} of ${override.pages??16} (${override.total??158} total series)</div>
 <p>Per page: 10 25 100</p></main></html>`;
};
test("realistic issuer site first page is honest evidence but cannot authorize a fee or live trade",()=>{
 const parsed=parseOfficialTariffHtml(fixture(),now);
 assert.equal(parsed.ok,true,JSON.stringify(parsed));
 if(!parsed.ok)return;
 assert.match(parsed.evidence.sourceSha256,/^[a-f0-9]{64}$/);
 assert.equal(parsed.evidence.standardTaker100ContractRange,"$0.07 - $1.75");
 assert.deepEqual(parsed.evidence.firstPageExceptionSeries,["KXAAAGASM","KXBTCY"]);
 assert.equal(parsed.evidence.renderedPages,16);
 assert.equal(parsed.evidence.advertisedExceptionCount,158);
 assert.equal(parsed.evidence.exactFormulaPublished,false);
 assert.equal(parsed.evidence.exceptionListComplete,false);
 assert.equal(parsed.evidence.sourceComplete,false);
 assert.equal(parsed.tradingAuthorized,false);
 assert.equal(parsed.reviewEligible,false);
 assert.equal(isOfficialTariffCompleteForSeries(parsed,"KXBTC15M"),false);
});
test("a complete list with a price range STILL does not prove the fee formula or rounding",()=>{
 const p=parseOfficialTariffHtml(fixture({pages:1,total:2}),now);
 assert.equal(p.ok,true);
 if(!p.ok)return;
 assert.equal(p.evidence.exceptionListComplete,true);
 assert.equal(p.evidence.exactFormulaPublished,false);
 assert.equal(p.evidence.sourceComplete,false);
 assert.equal(p.reviewEligible,false);
});
test("changed fee range, missing section, inconsistent pagination and repeated tickers refuse fabricated evidence",()=>{
 const bad=[
 fixture({range:"not a numeric fee"}),
 fixture().replace("<h2>Standard fees</h2>","<h2>unknown</h2>"),
 fixture().replace("Page 1 of 16 (158 total series)","Page 3 of 2 (158 total series)"),
 fixture({tickers:["KXBTCY","KXBTCY"]}),
 ];
 for(const html of bad){
  const p=parseOfficialTariffHtml(html,now);
  assert.equal(p.ok,false,html.slice(0,100));
  assert.equal(p.tradingAuthorized,false);
 }
});
test("scheduled fee changes are not silently treated as a stable complete tariff",()=>{
 const p=parseOfficialTariffHtml(fixture({pages:1,total:2,upcoming:"An upcoming change applies to KXBTC15M on Oct 25."}),now);
 assert.equal(p.ok,true);
 if(!p.ok)return;
 assert.equal(p.evidence.noUpcomingChanges,false);
 assert.equal(p.evidence.sourceComplete,false);
});
test("browser redirect, wrong origin, provider 429, stale fetch and bad content type all fail closed",async()=>{
 const fake=(status:number,url:string,contentType:string,body:string)=> (async (_url:string,init?:RequestInit)=>{
  assert.equal(_url,OFFICIAL_TARIFF_HTML_URL);
  assert.equal(init?.redirect,"manual");
  assert.equal(init?.cache,"no-store");
  return {status,redirected:false,url,headers:new Headers({"content-type":contentType}),text:async()=>body} as Response;
 }) as typeof fetch;
 const cases=[
  [429,OFFICIAL_TARIFF_HTML_URL,"text/html"],
  [302,OFFICIAL_TARIFF_HTML_URL,"text/html"],
  [200,"https://example.com/fee-schedule","text/html"],
  [200,OFFICIAL_TARIFF_HTML_URL,"application/json"],
 ] as const;
 for(const [status,url,ct] of cases){
  const p=await observeOfficialTariffHtml(fake(status,url,ct,fixture()),()=>now);
  assert.equal(p.ok,false);
  assert.equal(p.tradingAuthorized,false);
 }
 let calls=0;
 const stale=await observeOfficialTariffHtml(fake(200,OFFICIAL_TARIFF_HTML_URL,"text/html",fixture()),
  ()=>calls++===0?now:now+30_001);
 assert.equal(stale.ok,false);
 assert.equal(stale.tradingAuthorized,false);
 const good=await observeOfficialTariffHtml(fake(200,OFFICIAL_TARIFF_HTML_URL,"text/html",fixture()),()=>now);
 assert.equal(good.ok,true,JSON.stringify(good));
 assert.equal(good.tradingAuthorized,false);
});
