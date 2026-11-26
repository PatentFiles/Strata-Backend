import {readLiveHistoryExportBatch} from "../lib/strata/liveHistoryExport";
import { Router, type IRouter, type RequestHandler } from "express";
import {readLiveHistory,LiveHistoryRequestError} from "../lib/strata/liveHistoryReadModel";

/** Read-only authenticated ledger and live decision projection. */
export function createLiveHistoryRouter(requireUser: RequestHandler): IRouter {
  const router: IRouter = Router();
  const active=new Set<string>();
  const acquire=(subject:string)=>{if(active.has(subject)||active.size>=2)return false;active.add(subject);return true;};
  router.get("/live-history", requireUser, async (req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const actor=res.locals.strata as {subject:string;role:string|null}|undefined;
    if(!actor){res.status(401).json({error:"Unauthorized"});return;}
    if(!acquire(actor.subject)){res.setHeader('Retry-After','2');res.status(429).json({error:'history_read_busy'});return;}
    try{res.json(await readLiveHistory(actor,req.query));}
    catch(e){
      if(e instanceof LiveHistoryRequestError){res.status(e.status).json({error:e.message});return;}
      res.status(503).json({error:"live_history_unavailable"});
    }finally{active.delete(actor.subject);}
  });
  // Exports cannot monopolize the financial pool. Each batch releases its DB
  // client before the browser requests another; there is no unbounded queue.
  router.get("/live-history/export-batch",requireUser,async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const actor=res.locals.strata as {subject:string;role:string|null}|undefined;
    if(!actor){res.status(401).json({error:"Unauthorized"});return;}
    if(!acquire(actor.subject)){res.setHeader('Retry-After','2');res.status(429).json({error:'history_export_busy'});return;}
    try{const result=await readLiveHistoryExportBatch(actor,req.query);if(!res.destroyed)res.json(result);}
    catch(e){if(!res.destroyed){if(e instanceof LiveHistoryRequestError)res.status(e.status).json({error:e.message});else res.status(503).json({error:'live_history_export_unavailable'});}}
    finally{active.delete(actor.subject);}
  });
  return router;
}
