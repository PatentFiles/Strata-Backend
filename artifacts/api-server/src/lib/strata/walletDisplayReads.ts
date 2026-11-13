/** Non-authoritative wallet DISPLAY reads only. Never use for entry evidence,
 * reconciliation, fee qualification, funding writes or protective exits. */
export function createWalletDisplayReads<T>(options:{
 ttlMs?:number;maxEntries?:number;now?:()=>number;cacheable:(value:T)=>boolean;
}){
 const ttl=options.ttlMs??15_000,cap=options.maxEntries??256,now=options.now??Date.now;
 const entries=new Map<string,{started:number;promise:Promise<T>;done:boolean}>();
 return async(key:string,load:()=>Promise<T>):Promise<T>=>{
  const t=now(),prior=entries.get(key);
  if(prior&&t>=prior.started&&(!prior.done||t-prior.started<ttl))
   return structuredClone(await prior.promise);
  if(prior)entries.delete(key);
  for(const [k,v]of entries)if(v.done&&(t<v.started||t-v.started>=ttl))entries.delete(k);
  // Never evict an in-flight read and create duplicate exchange work.
  if(entries.size>=cap)return structuredClone(await load());
  const entry:{started:number;promise:Promise<T>;done:boolean}={started:t,promise:Promise.resolve(null as T),done:false};
  entry.promise=Promise.resolve().then(load);
  entries.set(key,entry);
  try{
   const value=await entry.promise;
   entry.done=true;
   if(!options.cacheable(value)&&entries.get(key)===entry)entries.delete(key);
   return structuredClone(value);
  }catch(error){
   if(entries.get(key)===entry)entries.delete(key);
   throw error;
  }
 };
}
