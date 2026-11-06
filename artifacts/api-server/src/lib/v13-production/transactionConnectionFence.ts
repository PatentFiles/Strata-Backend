import type {PoolClient} from '@workspace/db';

/** Transaction-owned observation, not a connectivity probe or renewed authority.
 * A partition not yet observed by pg cannot be detected synchronously here. */
export function transactionConnectionFence(tx:PoolClient) {
 const native=tx as PoolClient & {_queryable?:boolean;_ending?:boolean;_ended?:boolean;
  connection?:{stream?:{destroyed?:boolean}}};
 const events=typeof tx.on==='function'&&typeof tx.removeListener==='function';
 let active=true,broken=false,ended=false,cleaned=false;
 const onError=()=>{broken=true;};
 const onEnd=()=>{broken=true;ended=true;};
 const knownBroken=()=>broken||native._queryable===false||native._ending===true||
  native._ended===true||native.connection?.stream?.destroyed===true;
 if(events){tx.on('error',onError);tx.on('end',onEnd);}
 const remove=()=>{
  if(cleaned||!events)return;cleaned=true;
  tx.removeListener('error',onError);tx.removeListener('end',onEnd);
  tx.removeListener('end',remove);
 };
 return {
  assertLive(){
   // Native pg exposes these flags on the checked-out Client. Unknown wrappers
   // may still support non-wire transactions, but cannot attest ENTRY liveness.
   if(!active||!events||knownBroken()||native._queryable!==true||
      native._ending!==false||native._ended!==false||
      native.connection?.stream?.destroyed!==false)
    throw new Error('production_final_wire_connection_unavailable');
  },
  broken:knownBroken,
  close(){active=false;},
  /** Owner invokes only after release. pg-pool installs its idle error handler
   * synchronously. Destructive release keeps ours until the native end event. */
  cleanup(discard:boolean){
   active=false;
   if(!events||cleaned)return;
   if(ended||native._ended===true){remove();return;}
   if(discard||knownBroken())tx.on('end',remove);else remove();
  },
 };
}
