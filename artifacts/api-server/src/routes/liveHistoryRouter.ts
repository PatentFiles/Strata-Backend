import {readLiveHistoryExportBatch} from "../lib/strata/liveHistoryExport";
import { Router, type IRouter, type RequestHandler } from "express";
import {readLiveHistory,LiveHistoryRequestError} from "../lib/strata/liveHistoryReadModel";

/** Read-only authenticated ledger and live decision projection. */
export function createLiveHistoryRouter(requireUser: RequestHandler): IRouter {
  const router: IRouter = Router();
  router.get("/live-history", requireUser, async (req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const actor=res.locals.strata as {subject:string;role:string|null}|undefined;
    if(!actor){res.status(401).json({error:"Unauthorized"});return;}
    try{res.json(await readLiveHistory(actor,req.query));}
    catch(e){
      if(e instanceof LiveHistoryRequestError){res.status(e.status).json({error:e.message});return;}
      res.status(503).json({error:"live_history_unavailable"});
    }
  });
  // Exports cannot monopolize the financial pool. Each batch releases its DB
  // client before the browser requests another; there is no unbounded queue.
  const active=new Set<string>();
  router.get("/live-history/export-batch",requireUser,async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const actor=res.locals.strata as {subject:string;role:string|null}|undefined;
    if(!actor){res.status(401).json({error:"Unauthorized"});return;}
    if(active.has(actor.subject)||active.size>=2){res.setHeader('Retry-After','2');res.status(429).json({error:'history_export_busy'});return;}
    active.add(actor.subject);
    try{const result=await readLiveHistoryExportBatch(actor,req.query);if(!res.destroyed)res.json(result);}
    catch(e){if(!res.destroyed){if(e instanceof LiveHistoryRequestError)res.status(e.status).json({error:e.message});else res.status(503).json({error:'live_history_export_unavailable'});}}
    finally{active.delete(actor.subject);}
  });
  return router;
}
