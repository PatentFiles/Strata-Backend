import { Router, type IRouter } from "express";
import healthRouter from "./health";
import kalshiRouter from "./kalshi";
import historyRouter from "./history";
import forwardTestRouter from "./forwardTest";
import phase4Router from "./phase4";
import microLiveRouter from "./microLive";
import productionRouter from "./production";
import strataRouter from "./strata";

const router: IRouter = Router();

router.use(healthRouter);
router.use(kalshiRouter);
router.use(historyRouter);
router.use(forwardTestRouter);
router.use(phase4Router);
router.use(microLiveRouter);
router.use(productionRouter);
router.use("/strata", strataRouter);

export default router;
