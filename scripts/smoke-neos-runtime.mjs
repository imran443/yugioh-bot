import { spawn } from "node:child_process";

const host = "127.0.0.1";
const port = Number(process.env.NEOS_SMOKE_PORT ?? "5174");
const baseUrl = `http://${host}:${port}`;
const timeoutMs = Number(process.env.NEOS_SMOKE_TIMEOUT_MS ?? "45000");

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
  if (server.exitCode !== null) {
    return;
  }

  const closed = new Promise((resolve) => {
    server.once("close", resolve);
  });

  signalServer(server, "SIGTERM");
  const killTimer = setTimeout(() => {
    if (server.exitCode === null) {
      signalServer(server, "SIGKILL");
    }
  }, 3000);

  try {
    await closed;
  } finally {
    clearTimeout(killTimer);
  }
}

const server = spawn(
  "npm",
  ["--prefix", "vendor/neos-ts", "run", "dev", "--", "--host", host, "--port", String(port)],
  {
    cwd: new URL("..", import.meta.url),
    detached: true,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

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
