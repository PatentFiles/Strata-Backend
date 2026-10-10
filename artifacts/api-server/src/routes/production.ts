import {
  getLiveProductionSupervisor,
  readLatestProductionTrade,
  readProductionFills,
  readProductionOrders,
  readProductionPositions,
  readProductionStatus,
  readProductionTrades,
} from "../lib/v13-production/liveControl";
import { createProductionRouter } from "./productionRouter";

const supervisor = () => getLiveProductionSupervisor();

export default createProductionRouter({
  control: {
    start: () => supervisor().start(),
    stop: () => supervisor().stop(),
    view: () => supervisor().view(),
  },
  status: () => readProductionStatus(supervisor()),
  positions: readProductionPositions,
  orders: readProductionOrders,
  fills: readProductionFills,
  trades: readProductionTrades,
  latestTrade: readLatestProductionTrade,
});
