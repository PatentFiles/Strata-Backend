import {pool} from "@workspace/db";
import {loadedMaterial} from "./inAppProtectiveRelease";
import {dedicatedSignerFingerprint} from "./commissioning";
import {deployedGitSha} from "./deployedGitSha";
import {pinOwnerProtectiveHistory} from "./ownerProtectiveHistoryPreviewPin";
import {inspectAuthenticatedProtectiveExitHistory} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
export const unavailableProtectiveHistory=()=>({
 order:"AMBIGUOUS_OR_UNVERIFIED",settlement:"UNVERIFIED",exposure:"UNVERIFIED",
 readOnly:true,accountingPosted:false,tradingAuthorized:false,
} as const);
export function protectiveHistoryPreviewEnabled(env=process.env){
 const build=deployedGitSha(env);
 return /^[a-f0-9]{40}$/.test(build)&&env.STRATA_PROTECTIVE_HISTORY_PREVIEW_SHA===build;
}
export async function ownerProtectiveHistoryPreview(owner:string){
 if(!protectiveHistoryPreviewEnabled())return unavailableProtectiveHistory();
 try{
  const build=deployedGitSha();
  const first=await pinOwnerProtectiveHistory(pool,owner,build);
  if(!first)return unavailableProtectiveHistory();
  const material=await loadedMaterial(pool,first.row);
  if(!material||dedicatedSignerFingerprint(material.keyId,material.privateKey)!==first.row.key_fingerprint)
   return unavailableProtectiveHistory();
  return await inspectAuthenticatedProtectiveExitHistory({
   ownerId:owner,accountId:String(first.row.account_id),reservationId:String(first.row.reservation_id),
   order:first.order as unknown as EmergencyExitOrder,material,
  },async()=>{
   if(!protectiveHistoryPreviewEnabled()||deployedGitSha()!==build)return null;
   const next=await pinOwnerProtectiveHistory(pool,owner,build);
   return next?.digest===first.digest?first.digest:null;
  });
 }catch{return unavailableProtectiveHistory();}
}
