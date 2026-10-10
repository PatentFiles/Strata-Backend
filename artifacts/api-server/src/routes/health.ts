import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { BUILD_RELEASE, V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from "@workspace/v13-strategy";
import path from "node:path";
import { buildReleaseIdentity } from "../../../../lib/v13-strategy/build-release.mjs";

const router: IRouter = Router();
const processRelease = BUILD_RELEASE.provenance !== "unavailable"
  ? BUILD_RELEASE
  : process.env.NODE_ENV === "development"
    ? buildReleaseIdentity(path.resolve(import.meta.dirname, "../../../.."))
    : BUILD_RELEASE;

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({
    status: "ok",
    release: {
      ...processRelease,
      championId: V13_CHAMPION_PARAMETER_SET.id,
      parameterHash: V13_CHAMPION_PARAMETER_HASH,
      scoutMaxCents: V13_CHAMPION_PARAMETER_SET.parameters.scoutMaxOffer * 100,
      confirmMaxCents: V13_CHAMPION_PARAMETER_SET.parameters.confirmMaxOffer * 100,
      executionAuthority: "NONE",
    },
  });
  res.json(data);
});

export default router;
