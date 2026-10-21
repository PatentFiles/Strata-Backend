import { pool } from "@workspace/db";
import { emergencyStopMicroLive, getMicroLiveState } from "../lib/microLive";
import { getPhase4State } from "../lib/shadowLive";
import { remoteJwks, verifySupabaseAccessToken } from "../lib/strata/supabaseAuth";
import {
  getLiveProductionSupervisor,
  readLatestProductionTrade,
  readProductionFills,
  readProductionOrders,
  readProductionPositions,
  readProductionStatus,
  readProductionTrades,
} from "../lib/v13-production/liveControl";
import { readForwardTestHistory, readForwardTestSettlementReference, readForwardTestStatus } from "./forwardTest";
import { createDatabaseCommissioningPort } from "../lib/strata/commissioningStore";
import { createDatabaseStakePort } from "../lib/strata/configuredStakeStore";
import { personalTradingControls } from "../lib/strata/sharedPersonalTradingControls";
import { createStrataRouter } from "./strataRouter";

let keys: ReturnType<typeof remoteJwks> | null = null;

function keysFor(url: string) {
  if (!keys) keys = remoteJwks(url);
  return keys;
}

async function roleOf(subject: string): Promise<string | null> {
  const { rows } = await pool.query<{ role: string }>(
    "SELECT role FROM public.profiles WHERE id = $1 LIMIT 1",
    [subject],
  );
  return rows[0]?.role ?? null;
}

const supervisor = () => getLiveProductionSupervisor();

export default createStrataRouter({
  verifyToken: async (token) => {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error("supabase_url_missing");
    return verifySupabaseAccessToken(token, { supabaseUrl: url, keys: keysFor(url) });
  },
  roleOf,
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
  stake: createDatabaseStakePort(() => supervisor().view().workerRunning),
  forwardTestStatus: () => readForwardTestStatus(),
  forwardTestHistory: () => readForwardTestHistory(),
  forwardTestSettlementReference: () => readForwardTestSettlementReference(),
  phase4State: () => getPhase4State(),
  microLiveState: () => getMicroLiveState(),
  emergencyStop: () => emergencyStopMicroLive(),
  commissioning: createDatabaseCommissioningPort(() => supervisor().view().workerRunning),
  userScope: personalTradingControls,
});
