import {requireProof} from './types';

/** Invocation-local history index, used only while the caller retains the
 * account lock. Laziness preserves the first original lookup boundary. */
export class ReconciliationEventDigests {
 private values:Map<string,string>|null=null;
 constructor(private readonly query:(sql:string,args:unknown[])=>Promise<{rows:Record<string,unknown>[]}>,
  private readonly accountId:string,private readonly eventIds:()=>string[]){}
 async read(id:string):Promise<{present:boolean;digest?:string}>{
  if(this.values===null){
   const ids=this.eventIds();
   const rows=ids.length?(await this.query(
    'SELECT event_id,digest FROM v13_production_event WHERE account_id=$1 AND event_id=ANY($2::text[])',
    [this.accountId,ids])).rows:[];
   requireProof(Array.isArray(rows),'production_event_digest_batch_unverified');
   const values=new Map<string,string>();
   for(const row of rows){
    requireProof(row&&typeof row.event_id==='string'&&typeof row.digest==='string'&&!values.has(row.event_id),
     'production_event_digest_batch_unverified');
    values.set(row.event_id,row.digest);
   }
   this.values=values;
  }
  return this.values.has(id)?{present:true,digest:this.values.get(id)}:{present:false};
 }
 /** Call only AFTER the corresponding INSERT succeeds in the same transaction.
  * Repeated new settlements then receive the same exact digest comparison as
  * a subsequent SELECT in the original per-event implementation. */
 inserted(id:string,value:string):void{
  requireProof(this.values!==null&&!this.values.has(id),'production_event_digest_batch_unverified');
  this.values.set(id,value);
 }
}
