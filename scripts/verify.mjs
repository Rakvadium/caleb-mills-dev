#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const capture = path.join(root, "scripts", "capture.mjs");
const MODES = ["page", "mobile-nav"];
const READY_TIMEOUT_MS = 60_000;

if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
  console.error("verify needs a production build: run npm run build first");
  process.exit(1);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [nextBin, "start", "--port", String(port), "--hostname", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));

const results = [];
try {
  await waitForSite();
  for (const mode of MODES) {
    const code = await run(process.execPath, [capture, mode, "--base", base]);
    results.push([mode, code === 0]);
  }
} catch (error) {
  console.error(error.message);
  console.error(serverLog.slice(-4000));
  results.push(["server", false]);
} finally {
  stop(server);
}

for (const [name, passed] of results) {
  console.log(`${passed ? "pass" : "FAIL"}  ${name}`);
}
process.exit(results.every(([, passed]) => passed) ? 0 : 1);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: chosen } = probe.address();
      probe.close(() => resolve(chosen));
    });
  });
}

async function waitForSite() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`next start exited with code ${server.exitCode} before serving ${base}`);
    }
    try {
      const response = await fetch(`${base}/`);
      if (response.ok && (await response.text()).includes('id="projects"')) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${base} did not serve the portfolio within ${READY_TIMEOUT_MS / 1000}s`);
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function stop(child) {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}
