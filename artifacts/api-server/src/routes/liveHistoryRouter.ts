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
  return router;
}
