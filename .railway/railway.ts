import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  // The token snapshot and logo thumbnails (src/config.ts). On the container's
  // own disk they went with every deploy, and each fresh box refetched ~1,700
  // logos in one burst, which the IPFS gateways answer with 429s.
  const cacheVolume = volume("cache-volume", { region: "us-west2", sizeMB: 500 });
  const glisteningAdventure = service("glistening-adventure", {
    build: "bun run build",
    start: "bun run start",
    preDeploy: "bunx prisma migrate deploy",
    replicas: { "us-west2": 1 },
    domains: ["utopiango.com"],
    volumeMounts: { "/app/.cache": cacheVolume },
    env: { BRAVE_API_KEY: preserve(), DATABASE_URL: preserve(), HELIUS_RPC_URL: preserve(), JUP_FEE_ACCOUNT: preserve(), JUP_FEE_ACCOUNT_USDC: preserve(), JUP_FEE_BPS: preserve(), JUP_REFERAL_ACCOUNT: preserve(), WALLET_KEY: preserve() },
  });

  return project("glistening-adventure", {
    resources: [Postgres, glisteningAdventure, postgresVolume, cacheVolume],
  });
});
