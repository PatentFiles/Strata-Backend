import type {PgPoolLike,PgClientLike} from "./accountCredentialStore";
import {technicalSetupResult,type TechnicalSetupResult} from "./technicalSetupAdvance";

/** Transaction-scoped advisory admission for the existing technical advance
 * endpoint. No session lock survives a crash or returned pooled connection.
 * This is NOT permission to execute a provider mutation: current work may
 * only verify credentials or prepare an operation in the existing journal.
 * Individual operation claims and owner/credential pins remain authoritative.
 */
const OWNER_NAMESPACE=1398030671;
const SLOT_NAMESPACE=1398030672;
const SLOTS=2;
const OWNER=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function withTechnicalSetupDatabaseAdmission(
  pool:PgPoolLike,owner:string,work:(checkpoint:()=>Promise<void>)=>Promise<TechnicalSetupResult>,
):Promise<TechnicalSetupResult>{
  if(!OWNER.test(owner))return technicalSetupResult("BLOCKED","technical_setup_scope_unverified");
  let client:PgClientLike|undefined,discard:Error|undefined,transaction=false,started=false;
  try{
    client=await pool.connect();
    await client.query("BEGIN");transaction=true;
    // Bound statements and an abandoned idle transaction; other requests use
    // separate connections, and the fixed global slots cap parked sessions.
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '90s'");
    const locked=await client.query("SELECT pg_try_advisory_xact_lock($1::int,hashtext($2::text)) AS locked",[OWNER_NAMESPACE,owner.toLowerCase()]);
    if(locked.rows.length!==1||locked.rows[0]?.locked!==true)
      return technicalSetupResult("BUSY","technical_setup_busy");
    let slot:number|null=null;
    for(let i=0;i<SLOTS;i++){
      const result=await client.query("SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS locked",[SLOT_NAMESPACE,i]);
      if(result.rows.length===1&&result.rows[0]?.locked===true){slot=i;break;}
    }
    if(slot===null)return technicalSetupResult("BUSY","technical_setup_busy");
    const session=client;
    // Confirm the current PostgreSQL backend still owns BOTH xact locks.
    // A lost/terminated connection cannot authorize another phase. Checking
    // the catalog avoids re-acquiring a lock in an accidentally new tx.
    const checkpoint=async()=>{
      const result=await session.query(`SELECT (
        EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
          AND granted AND objsubid=2 AND classid=$1::oid AND objid=(hashtext($2::text)::bigint & 4294967295)::oid)
        AND EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
          AND granted AND objsubid=2 AND classid=$3::oid AND objid=$4::oid)
      ) AS held`,[OWNER_NAMESPACE,owner.toLowerCase(),SLOT_NAMESPACE,slot]);
      if(result.rows.length!==1||result.rows[0]?.held!==true)throw Error("technical_setup_admission_lost");
    };
    await checkpoint();started=true;
    const result=await work(checkpoint);
    await checkpoint();
    return result;
  }catch{
    // Work may already have durably verified/prepared something. Never report
    // that it was rolled back by the admission transaction, and never retry it.
    discard=new Error("technical_setup_admission_unverified");
    return technicalSetupResult(started?"UNKNOWN":"BLOCKED",started?"technical_setup_outcome_unconfirmed":"technical_setup_admission_unverified");
  }finally{
    if(client){
      if(transaction){try{await client.query("ROLLBACK");}catch{discard=new Error("technical_setup_admission_release_unverified");}}
      client.release(discard);
    }
  }
}
