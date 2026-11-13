import { readAutoRule, saveAutoRule } from "../lib/strata/autoProfitWithdrawals";
import { readAutoWithdrawalMaintenance } from "../lib/strata/autoWithdrawalMaintenance";
import { Router, type IRouter, type RequestHandler } from "express";
import {
  CASHIER_SWEEP_CONFIRMATION, confirmManualSweep, listManualSweeps,
  quoteManualSweep, reconcileManualSweep, sweepAvailability, inspectCashierRouteReadOnly,
} from "../lib/strata/manualProfitWithdrawals";

/**
 * AAL2 is enforced by createStrataAccess.requireUser before this router.
 * All owner identities come from the verified token, never request fields.
 */
export function createManualProfitWithdrawalRouter(requireUser: RequestHandler): IRouter {
  const router: IRouter = Router();
  router.use(requireUser);
  const owner = (res: { locals: { strata?: { subject?: string } } }): string | null =>
    res.locals.strata?.subject ?? null;
  router.get("/availability", async (req, res) => {
    const id = owner(res);
    if (!id) { res.status(401).json({ error: "Unauthorized" }); return; }
    const text = String(req.query.minimumRetainedCents ?? "0");
    if (!/^(0|[1-9]\d{0,11})$/.test(text) || !Number.isSafeInteger(Number(text))) {
      res.status(400).json({ error: "invalid_minimum_retained_cash" }); return;
    }
    res.json(await sweepAvailability(id,Number(text)));
  });
  router.get("/", async (_req,res) => {
    const id=owner(res);
    if(!id){res.status(401).json({error:"Unauthorized"});return;}
    res.json({withdrawals:await listManualSweeps(id)});
  });
  router.get("/cashier-route", async(_req,res)=>{
    const id=owner(res);
    if(!id){res.status(401).json({error:"Unauthorized"});return;}
    res.json(await inspectCashierRouteReadOnly(id));
  });
  router.get("/automatic-maintenance", async(_req,res)=>{
    const id=owner(res);
    if(!id){res.status(401).json({error:"Unauthorized"});return;}
    res.json(await readAutoWithdrawalMaintenance(id));
  });
  router.get("/automatic-rule", async(_req,res)=>{
    const id=owner(res);
    if(!id){res.status(401).json({error:"Unauthorized"});return;}
    res.json(await readAutoRule(id));
  });
  router.post("/automatic-rule", async(req,res)=>{
    const id=owner(res);
    if(!id){res.status(401).json({error:"Unauthorized"});return;}
    res.json(await saveAutoRule(id,req.body));
  });
  router.post("/quote", async(req,res)=>{
    const id=owner(res);
    if(!id){res.status(401).json({error:"Unauthorized"});return;}
    res.json(await quoteManualSweep(id,req.body));
  });
  router.post("/confirm", async(req,res)=>{
    const id=owner(res);
    if(!id){res.status(401).json({error:"Unauthorized"});return;}
    res.json(await confirmManualSweep(id,req.body));
  });
  router.post("/reconcile", async(req,res)=>{
    const id=owner(res);
    if(!id){res.status(401).json({error:"Unauthorized"});return;}
    res.json(await reconcileManualSweep(id,req.body?.withdrawalId));
  });
  return router;
}
export { CASHIER_SWEEP_CONFIRMATION };
