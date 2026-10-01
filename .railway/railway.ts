import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const dataVolume = volume("data-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const UtopianGoServer = service("UtopianGo Server", {
    source: github("Utopian-Contributors/utopian-go", { checkSuites: false }),
    build: "bun run build",
    start: "bun run start",
    preDeploy: "bunx prisma migrate deploy",
    replicas: { "us-west2": 1 },
    domains: ["utopiango.com"],
    networking: { privateNetworkEndpoint: "glistening-adventure" },
    volumeMounts: { "/app/data": dataVolume },
    env: { BRAVE_API_KEY: preserve(), DATABASE_URL: preserve(), HELIUS_RPC_URL: preserve(), JUP_FEE_ACCOUNT: preserve(), JUP_FEE_ACCOUNT_USDC: preserve(), JUP_FEE_BPS: preserve(), JUP_REFERAL_ACCOUNT: preserve(), WALLET_KEY: preserve() },
  });

  return project("glistening-adventure", {
    resources: [Postgres, UtopianGoServer, dataVolume, postgresVolume],
  });
});
