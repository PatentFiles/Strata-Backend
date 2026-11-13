type Result={rows:Array<Record<string,unknown>>};
type Client={query:(sql:string,values?:unknown[])=>Promise<Result>;release:(destroy?:boolean)=>void};
/** Server timeout plus client destruction: a Promise timeout alone leaves work running. */
export function heldLifecycleBoundedQuery(connect:()=>Promise<Client>,sql:string,values:unknown[],
 timers:{set:(f:()=>void,ms:number)=>unknown;clear:(id:unknown)=>void}={set:(f,ms)=>setTimeout(f,ms),clear:id=>clearTimeout(id as ReturnType<typeof setTimeout>)}):Promise<Result>{
 return new Promise((resolve,reject)=>{
  let finished=false,release:((destroy?:boolean)=>void)|null=null;
  const finish=(error:unknown,result?:Result)=>{
   if(finished)return;finished=true;timers.clear(timer);release?.(!!error);
   if(error)reject(Error('held_lifecycle_db_failed'));else resolve(result!);
  };
  const timer=timers.set(()=>finish(Error('held_lifecycle_db_timeout')),2000);
  void connect().then(async client=>{
   if(finished){client.release(true);return;}
   release=destroy=>client.release(destroy);
   try{
    await client.query('BEGIN READ ONLY');if(finished)return;
    await client.query("SET LOCAL statement_timeout='1500ms'");if(finished)return;
    const result=await client.query(sql,values);if(finished)return;
    await client.query('COMMIT');finish(null,result);
   }catch(error){finish(error);}
  },error=>finish(error));
 });
}
