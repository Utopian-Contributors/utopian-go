import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  // Everything the server keeps on disk, since a service may mount only one
  // volume: data/cache holds the token snapshot and logo thumbnails
  // (src/config.ts), data/social the profile, post and chat photos
  // (src/social/store.ts). On the container's own disk both went with every
  // deploy: each fresh box refetched ~1,700 logos in one burst, which the IPFS
  // gateways answer with 429s, and Postgres was left counting photos that no
  // longer existed.
  const dataVolume = volume("data-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const glisteningAdventure = service("glistening-adventure", {
    build: "bun run build",
    start: "bun run start",
    preDeploy: "bunx prisma migrate deploy",
    replicas: { "us-west2": 1 },
    domains: ["utopiango.com"],
    volumeMounts: { "/app/data": dataVolume },
    env: { BRAVE_API_KEY: preserve(), DATABASE_URL: preserve(), HELIUS_RPC_URL: preserve(), JUP_FEE_ACCOUNT: preserve(), JUP_FEE_ACCOUNT_USDC: preserve(), JUP_FEE_BPS: preserve(), JUP_REFERAL_ACCOUNT: preserve(), WALLET_KEY: preserve() },
  });

  return project("glistening-adventure", {
    resources: [Postgres, glisteningAdventure, postgresVolume, dataVolume],
  });
});
