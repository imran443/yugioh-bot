import { config } from "dotenv";
import { createServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, applyEngineCardRemaps } from "@yugidraft/shared/db";
import { createBroadcaster, httpTransport } from "@yugidraft/shared/notify";
import { DUEL_1V1_ENGINE_ENV, DUEL_STANDARD_1V1_ENGINE_ENV, duel1v1EngineForMode, isDuelEngineChoice } from "@yugidraft/shared/duels";
import { loadCardDatabase } from "./cards.js";
import { verifyEngineBundle } from "./engine-bundle.js";
import { createDuelHost } from "./host.js";
import { createIssueSource } from "./presets/issue-source.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
config({ path: resolve(root, ".env") });
for (const key of [DUEL_1V1_ENGINE_ENV, DUEL_STANDARD_1V1_ENGINE_ENV]) {
  const value = process.env[key];
  const normalized = value?.trim().toLowerCase();
  if (normalized && !isDuelEngineChoice(normalized)) {
    console.warn(`[duel] Invalid ${key}=${JSON.stringify(value)}; expected legacy or pinned. Using the fallback.`);
  }
}
console.log(`[duel] 1v1 engines: Standard=${duel1v1EngineForMode("normal")}, Domain=${duel1v1EngineForMode("domain")}`);
const dataDirectory = resolve(root, process.env.DUEL_DATA_DIR ?? "data/duel-engine");
verifyEngineBundle(dataDirectory);
const db = openDatabase(resolve(root, process.env.DATABASE_PATH ?? "data/bot.sqlite"));
const migration = applyEngineCardRemaps(db, dataDirectory);
if (!migration.skipped) console.log(`[duel] Passcode migration applied for ${migration.remappedPasscodes} remaps`);
const cards = loadCardDatabase(dataDirectory);
const wsTransport = httpTransport({
  url: process.env.WS_INTERNAL_URL ?? "",
  secret: process.env.WS_INTERNAL_SECRET ?? "",
});
// The broadcaster logs a warning when the ws server rejects or cannot be reached; it never throws.
const broadcaster = createBroadcaster(wsTransport);
const archiveAfterMs = Number(process.env.DUEL_ARCHIVE_AFTER_MS);
const idleWorkerMs = Number(process.env.DUEL_IDLE_WORKER_MS);
const botStepMs = Number(process.env.DUEL_BOT_STEP_MS ?? 900);
const issuesDirectory = resolve(root, process.env.DUEL_ISSUES_DIR ?? ".status/issues");
const presetIssues = process.env.DUEL_SCENARIOS === "1" && existsSync(issuesDirectory) ? createIssueSource(issuesDirectory) : undefined;
const host = createDuelHost({
  db,
  dataDirectory,
  secret: process.env.DUEL_INTERNAL_SECRET ?? "",
  presetIssues,
  searchCards: (query) => cards.search(query),
  onChange: async (slug, guildId) => {
    await wsTransport.post("/internal/duel/changed", JSON.stringify({ slug, guildId }));
  },
  notifyTournament: async ({ kind, slug }) => {
    await broadcaster.tournament({ kind, slug });
  },
  archiveAfterMs: Number.isFinite(archiveAfterMs) ? archiveAfterMs : undefined,
  idleWorkerMs: Number.isFinite(idleWorkerMs) ? idleWorkerMs : undefined,
  // Base pause before a practice bot summon/set/activation; other actions scale from it. 0 answers instantly.
  botStepDelayMs: Number.isFinite(botStepMs) && botStepMs > 0 ? botStepMs : 0,
  // Rock-paper-scissors decides who goes first in game 1. DUEL_RPS_OPENING=0 turns it off.
  openingRps: process.env.DUEL_RPS_OPENING !== "0",
});
let closing = false;
function restarting(response: ServerResponse) {
  response.writeHead(503, { "content-type": "application/json", "connection": "close", "Retry-After": "2" });
  response.end(JSON.stringify({ error: "restarting" }));
}
const server = createServer(async (request, response) => {
  if (closing) {
    restarting(response);
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 64 * 1024) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Request too large" }));
        return;
      }
      chunks.push(chunk);
    }
    // An upload may have started before the shutdown signal arrived.
    if (closing) {
      restarting(response);
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const method = request.method ?? "GET";
    const result = await host.handle(new Request(`http://localhost${request.url ?? "/"}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
    }));
    response.writeHead(result.status, {
      ...Object.fromEntries(result.headers),
      ...(closing ? { connection: "close" } : {}),
    });
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    console.error("[duel] Request failed", error);
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Duel service request failed" }));
  }
});
const port = Number(process.env.DUEL_INTERNAL_PORT ?? 4003);
const bind = process.env.DUEL_INTERNAL_HOST ?? "127.0.0.1";
server.listen(port, bind, () => console.log(`[duel] Private server listening on http://${bind}:${port}`));

async function shutdown() {
  if (closing) {
    process.exit(0);
    return;
  }
  closing = true;
  const exitTimer = setTimeout(() => process.exit(0), 5000);
  exitTimer.unref();
  let exitCode = 0;
  try {
    const stopped = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    // Let active answers finish, then remove any socket still holding the listener open.
    const graceTimer = setTimeout(() => server.closeAllConnections(), 2500);
    graceTimer.unref();
    try {
      await stopped;
    } finally {
      clearTimeout(graceTimer);
      server.closeAllConnections();
    }
    // host.close() also waits for queued operations before terminating workers.
    await host.close();
    cards.close();
    db.close();
  } catch (error) {
    console.error("[duel] Shutdown failed", error instanceof Error ? error.name : "Unknown");
    exitCode = 1;
  } finally {
    clearTimeout(exitTimer);
    process.exit(exitCode);
  }
}
function onShutdownSignal(signal: "SIGTERM" | "SIGINT") {
  process.once(signal, () => process.exit(0));
  void shutdown();
}
process.once("SIGTERM", () => onShutdownSignal("SIGTERM"));
process.once("SIGINT", () => onShutdownSignal("SIGINT"));
