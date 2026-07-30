#!/usr/bin/env node
/**
 * Dev orchestrator: client watch (esbuild) + server (ts-node-dev).
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, label) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[${label}] killed (${signal})`);
    } else if (code && code !== 0) {
      console.error(`[${label}] exited ${code}`);
      shutdown(code);
    }
  });
  return child;
}

const children = [];

function shutdown(code = 0) {
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Client first so public/ exists before the server boots.
const build = spawn("node", ["scripts/build-client.mjs"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

build.on("exit", (code) => {
  // exit 1 = hard gzip budget fail; still boot dev so you can fix UI live
  if (code != null && code > 1) {
    shutdown(code);
  }

  children.push(
    run("node", ["scripts/build-client.mjs", "--watch"], "client"),
    run(
      "npx",
      ["ts-node-dev", "--respawn", "--env-file=.env", "src/server.ts"],
      "server",
    ),
  );
});
