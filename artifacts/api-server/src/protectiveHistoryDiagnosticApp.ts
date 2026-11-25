import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import {
  DIAGNOSTIC_HEALTH_PATH, HISTORY_PREVIEW_PATH, isDiagnosticPreflight,
} from "./lib/strata/protectiveHistoryDiagnosticPolicy";

type Options = {
  origins: ReadonlySet<string>;
  buildSha: string;
  enabled: () => boolean;
  requireOwner: RequestHandler;
  preview: RequestHandler;
};

/** No general app/router, body parser, proxy, streaming path, or mutation port. */
export function createProtectiveHistoryDiagnosticApp(input: Options): Express {
  const app = express();
  app.disable("x-powered-by");
  const grantCors = cors({
    credentials: true,
    methods: ["GET"],
    allowedHeaders: ["Authorization", "X-Strata-Read-Intent"],
    origin: (origin, callback) => callback(null, !!origin && input.origins.has(origin)),
  });
  const preflight: RequestHandler = (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!input.enabled()) return void res.status(503).end();
    if (req.method !== "GET" && req.method !== "OPTIONS") {
      res.setHeader("Allow", "GET, OPTIONS");
      return void res.status(405).end();
    }
    // The raw URL is exact on purpose: no alternate path, slash or query.
    if (req.url !== DIAGNOSTIC_HEALTH_PATH && req.url !== HISTORY_PREVIEW_PATH)
      return void res.status(404).end();
    if (req.get("Transfer-Encoding") || Number(req.get("Content-Length") ?? 0) !== 0)
      return void res.status(400).end();
    if (req.method === "OPTIONS" && !isDiagnosticPreflight(req.get("Origin"), input.origins,
        req.get("Access-Control-Request-Method"), req.get("Access-Control-Request-Headers")))
      return void res.status(403).end();
    if (req.method === "GET" && req.get("Origin") && !input.origins.has(req.get("Origin")!))
      return void res.status(403).end();
    grantCors(req, res, next);
  };
  app.use(preflight);
  app.get(DIAGNOSTIC_HEALTH_PATH, (_req, res) => {
    res.json({ status: "ok", mode: "protective_history_diagnostic_only",
      deployedGitSha: input.buildSha, executionAuthority: "NONE" });
  });
  app.get(HISTORY_PREVIEW_PATH, input.requireOwner, input.preview);
  return app;
}
