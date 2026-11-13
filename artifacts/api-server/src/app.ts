import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import { v13DevelopmentStagingMiddleware } from "./lib/v13DevelopmentStaging";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import {
  createKeyProvisioningRouter, keyProvisioningEnabled,
} from "./routes/keyProvisioning";
import {
  createPairKeyProvisioningRouter, pairKeyProvisioningEnabled,
} from "./routes/pairKeyProvisioning";
import { createPairFundingRouter, pairFundingEnabled } from "./routes/pairFunding";
import {
  createPairCommissioningApprovalRouter, 
} from "./routes/pairCommissioningApproval";

const app: Express = express();
app.use(v13DevelopmentStagingMiddleware);

// This development-only route must run before the reflected CORS policy and
// pino-http. Neither its rendered secret page nor its response is logged.
if (keyProvisioningEnabled()) {
  app.use(
    "/api/admin/key-provisioning",
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
    express.urlencoded({ extended: false, limit: "1kb" }),
    createKeyProvisioningRouter(),
  );
}
if (pairKeyProvisioningEnabled()) {
  app.use(
    "/api/admin/index2-key-provisioning",
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
    express.urlencoded({ extended: false, limit: "1kb" }),
    createPairKeyProvisioningRouter(),
  );
}
if (pairFundingEnabled()) {
  app.use(
    "/api/admin/index2-pair-funding",
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
    express.urlencoded({ extended: false, limit: "1kb" }),
    createPairFundingRouter(),
  );
}
// Dedicated commissioning never writes the historical micro-live singleton.
app.use(
  "/api/admin/index2-pair-commissioning",
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
  express.json({ limit: "3mb" }),
  createPairCommissioningApprovalRouter(),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

const strataOrigins = (process.env.STRATA_WEB_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.startsWith("https://") || origin.startsWith("http://"));

function strataOriginAllowed(origin: string | undefined): boolean {
  if (!origin || strataOrigins.includes(origin)) return true;
  if (process.env.NODE_ENV === "production") return false;
  try {
    const url = new URL(origin);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return local && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    callback(null, strataOriginAllowed(origin));
  },
}));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.CLERK_SECRET_KEY) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

app.use("/api", router);

export default app;
