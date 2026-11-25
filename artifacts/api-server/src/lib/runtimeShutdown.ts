type ShutdownPorts={
 closeHttp:()=>Promise<void>;
 quiesce:()=>Promise<{stopped:boolean;managingExposure:boolean}>;
 flush:()=>Promise<boolean>;
 closePool:()=>Promise<void>;
 report:(reason:string)=>void;
 exit:(code:number)=>void;
};
/** Single-flight, deadline-bounded process drain. Existing protective exposure
 * is NOT released or declared flat; it retains its worker until the platform's
 * termination deadline. Operations must deploy only after stopped/flat proof. */
export function createRuntimeShutdown(ports:ShutdownPorts,deadlineMs=15000){
 let task:Promise<number>|null=null;
 return ()=>task??=(async()=>{
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const work=async()=>{
   const http=ports.closeHttp().then(()=>true,()=>false);
   const state=await ports.quiesce();
   if(!state.stopped){ports.report(state.managingExposure?'shutdown_protective_exposure_retained':'shutdown_worker_drain_unverified');return new Promise<number>(()=>{});}
   if(!await http)throw Error('shutdown_http_drain_failed');
   if(!await ports.flush())throw Error('shutdown_analytics_drain_incomplete');
   await ports.closePool();ports.report('shutdown_drained');return 0;
  };
  const code=await Promise.race([
   work().catch(()=>{ports.report('shutdown_drain_failed');return 1;}),
   new Promise<number>(resolve=>{timeout=setTimeout(()=>{ports.report('shutdown_deadline_reached');resolve(1);},deadlineMs);}),
  ]);
  if(timeout)clearTimeout(timeout);ports.exit(code);return code;
 })();
}
