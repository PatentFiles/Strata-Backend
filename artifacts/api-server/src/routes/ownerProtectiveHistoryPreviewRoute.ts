import type {RequestHandler} from "express";
import {ownerProtectiveHistoryPreview,protectiveHistoryPreviewEnabled} from "../lib/strata/ownerProtectiveHistoryPreview";
// Mount only after Strata's existing JWT AAL2 middleware. Never trust owner
// selectors, input evidence, or client-provided IDs. Opt-in header avoids passive GETs.
export function protectiveHistoryPreviewHandler(enabled=protectiveHistoryPreviewEnabled,inspect=ownerProtectiveHistoryPreview):RequestHandler{
 return async(req,res)=>{
  res.setHeader("Cache-Control","private, no-store");
  if(!enabled())return void res.status(404).end();
  if(typeof res.locals.strata?.subject!=="string")return void res.status(401).end();
  if(req.method!=="GET")return void res.status(405).end();
  if(req.get("X-Strata-Read-Intent")!=="inspect-protective-history"||Object.keys(req.query).length||
     req.get("Transfer-Encoding")||Number(req.get("Content-Length")??0)!==0)
   return void res.status(400).end();
  const r=await inspect(res.locals.strata.subject);
  // Explicit allowlisted categories; even a wrongly widened inspector cannot export raw records.
  const order=["EXACT_TERMINAL","NOT_FOUND"].includes(r.order)?r.order:"AMBIGUOUS_OR_UNVERIFIED";
  const settlement=["MATCHES_DELTA","PRESENT_UNVERIFIED","NOT_FOUND"].includes(r.settlement)?r.settlement:"UNVERIFIED";
  const exposure=r.exposure==="FLAT_ECHO"?r.exposure:"UNVERIFIED";
  res.status(200).json({order,settlement,exposure,readOnly:true,accountingPosted:false,tradingAuthorized:false});
 };
}
