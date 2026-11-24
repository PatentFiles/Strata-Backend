import { dedicatedSignerFingerprint } from "./commissioning";
import { SETUP_ROLE_ORDER, type SetupRole } from "./technicalSetupAdvance";

/** A single explicit consent covers ONLY create-only credential storage and
 * the bounded technical plan. Financial approvals and START are excluded. */
export const VERIFY_AND_COMMISSION = "VERIFY_AND_COMMISSION_TECHNICAL_SETUP_V1";
export type KeyInput = Readonly<{apiKeyId:string;privateKey:string}>;
export type MultiKeyInput = Readonly<{primary?:KeyInput;credentials:ReadonlyArray<KeyInput&{role:SetupRole}>}>;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
function key(v:unknown):KeyInput|null{
 if(!record(v)||Object.keys(v).some(k=>k!=="apiKeyId"&&k!=="privateKey"&&k!=="role")||
    typeof v.apiKeyId!=="string"||typeof v.privateKey!=="string")return null;
 const apiKeyId=v.apiKeyId.trim(),privateKey=v.privateKey.trim();
 if(!/^[A-Za-z0-9-]{8,128}$/.test(apiKeyId)||privateKey.length>8192||
    !dedicatedSignerFingerprint(apiKeyId,privateKey))return null;
 return {apiKeyId,privateKey};
}
export function parseMultiKeyInput(raw:unknown,owner:string):MultiKeyInput|null{
 if(!record(raw)||raw.expectedOwnerId!==owner||raw.confirmation!==VERIFY_AND_COMMISSION||
    Object.keys(raw).some(k=>!["expectedOwnerId","confirmation","primary","credentials"].includes(k))||
    !Array.isArray(raw.credentials)||raw.credentials.length>4)return null;
 const primary=raw.primary===undefined?undefined:key(raw.primary);
 if(raw.primary!==undefined&&!primary)return null;
 const credentials: Array<KeyInput&{role:SetupRole}>=[];
 for(const item of raw.credentials){
  const parsed=key(item);
  if(!parsed||!record(item)||!SETUP_ROLE_ORDER.includes(item.role as SetupRole))return null;
  credentials.push({...parsed,role:item.role as SetupRole});
 }
 if(new Set(credentials.map(c=>c.role)).size!==credentials.length||
    new Set([...(primary?[primary.apiKeyId]:[]),...credentials.map(c=>c.apiKeyId)]).size!==credentials.length+(primary?1:0))return null;
 return { ...(primary?{primary}:{}),credentials };
}

/** Membership is checked on a signed account-wide inventory. Matching
 * subaccount numbers alone do not prove that two keys belong to one member. */
export function inventoryContainsKeys(payload:unknown,ids:readonly string[]):boolean{
 if(!record(payload)||!Array.isArray(payload.api_keys))return false;
 const rows=payload.api_keys;
 return new Set(ids).size===ids.length&&ids.every(id=>rows.filter(v=>record(v)&&v.api_key_id===id).length===1);
}
