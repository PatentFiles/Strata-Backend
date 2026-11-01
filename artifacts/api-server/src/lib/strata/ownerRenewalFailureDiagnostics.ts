/** Fixed, non-authorizing server-log vocabulary. Never serialize Error/message,
 * SQL, values, identities, credentials, HTTP bodies or arbitrary code fields. */
const phases=new Set(['preflight_authority','preflight_history','signed_history','transaction_begin',
 'locked_authority','locked_history','locked_evidence','authorization_write','audit_write','commit']);
const categories:Record<string,string>={
 '42703':'schema_contract','42P01':'schema_contract','42501':'database_permission',
 '55P03':'database_lock','57014':'database_timeout','40001':'transaction_conflict','40P01':'transaction_conflict',
 '23505':'database_constraint','23514':'database_constraint','23503':'database_constraint'};
export function ownerRenewalFailureDiagnostics(error:unknown,phase:unknown){
 let sqlState:string|null=null;
 try{const code=(error&&typeof error==='object'?(error as {code?:unknown}).code:null);
  if(typeof code==='string'&&Object.hasOwn(categories,code))sqlState=code;
 }catch{/* Hostile/unusual error objects must not replace the original refusal. */}
 return Object.freeze({version:1,phase:typeof phase==='string'&&phases.has(phase)?phase:'unknown',
  category:sqlState?categories[sqlState]!:'unclassified',sqlState});
}
