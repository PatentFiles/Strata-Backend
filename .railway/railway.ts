import { defineRailway, project, service } from "railway/iac";

/**
 * One Strata backend process. Secrets stay in the Railway dashboard:
 * DATABASE_URL, STRATA_WEB_ORIGIN, and any Kalshi credentials.
 * Do not set live-execution flags here.
 */
export default defineRailway(() => {
  const api = service("strata-backend", {
    build:
      "corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build",
    start: "pnpm --filter @workspace/api-server run start",
    healthcheck: "/api/healthz",
    healthcheckTimeout: 100,
    replicas: 1,
    env: {
      NODE_ENV: "production",
      SUPABASE_URL: "https://wqsmfbzfbiilhtzpqbrb.supabase.co",
    },
  });

  return project("strata", {
    resources: [api],
  });
});
