import { smokeWorkerCard } from "./lib/new-card-smoke-pool.js";

if (!process.send) throw new Error("new-card-smoke-worker needs an IPC parent");
process.on("message", async (request: Parameters<typeof smokeWorkerCard>[0]) => {
  try { await smokeWorkerCard(request); }
  catch (error) { process.send?.({ kind: "fatal", error: error instanceof Error ? error.message : String(error) }); }
});
