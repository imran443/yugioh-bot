import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = Number(process.env.NEOS_SMOKE_PORT ?? "5174");
const baseUrl = `http://${host}:${port}`;
const timeoutMs = Number(process.env.NEOS_SMOKE_TIMEOUT_MS ?? "45000");
const repoRoot = new URL("..", import.meta.url);
const neosDir = new URL("vendor/neos-ts/", repoRoot);
const viteBin = new URL("node_modules/vite/bin/vite.js", neosDir);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchUntilReady(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  throw lastError ?? new Error(`${url} did not become ready within ${timeoutMs}ms`);
}

function signalServer(server, signal) {
  try {
    process.kill(-server.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function stopServer(server) {
  if (serverClosed || server.exitCode !== null || server.signalCode !== null) {
    return;
  }

  const closed = new Promise((resolve) => {
    server.once("close", resolve);
  });

  signalServer(server, "SIGTERM");
  const killTimer = setTimeout(() => {
    if (!serverClosed && server.exitCode === null && server.signalCode === null) {
      signalServer(server, "SIGKILL");
    }
  }, 3000);

  try {
    await closed;
  } finally {
    clearTimeout(killTimer);
  }
}

if (!existsSync(viteBin)) {
  console.error("Neos Vite binary not found. Run `npm run setup:duel-web` before running this smoke test.");
  process.exit(1);
}

const server = spawn(
  process.execPath,
  [fileURLToPath(viteBin), "--host", host, "--port", String(port)],
  {
    cwd: fileURLToPath(neosDir),
    detached: true,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverClosed = false;
server.once("close", () => {
  serverClosed = true;
});

async function handleSignal(signal) {
  const exitCode = signal === "SIGINT" ? 130 : 143;
  await stopServer(server);
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void handleSignal("SIGINT");
});
process.once("SIGTERM", () => {
  void handleSignal("SIGTERM");
});

let output = "";
server.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  const pageResponse = await fetchUntilReady(baseUrl, timeoutMs);
  const html = await pageResponse.text();
  if (!html.includes('id="root"')) {
    throw new Error("Neos root HTML did not include the React root element");
  }

  const configResponse = await fetchUntilReady(`${baseUrl}/neos.config.json`, timeoutMs);
  const config = await configResponse.json();
  if (!Array.isArray(config.servers) || config.servers.length === 0) {
    throw new Error("neos.config.json did not expose any duel servers");
  }

  console.log(`Neos runtime smoke passed at ${baseUrl} with ${config.servers.length} configured servers`);
} catch (error) {
  console.error(output.trim());
  console.error(`Neos runtime smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopServer(server);
}
