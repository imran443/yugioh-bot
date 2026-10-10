import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import type { DuelEngineView } from "@yugidraft/shared/duels";
import { createDuelHost, type DuelHost } from "../src/host.js";
import { EngineLoopError } from "../src/engine-loop-error.js";
import { activeMultiScriptsHash, pinnedEngineVersion } from "../src/multi-scripts.js";
import type { DuelGameWorker } from "../src/worker-client.js";
import { seedIdentity, seedUser } from "./helpers/identity.js";

const SECRET = "engine-loop-test";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function fixture() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "host-engine-loop-"));
  writeFileSync(join(dataDirectory, "manifest.json"), JSON.stringify({ bundleVersion: "fixture" }));
  const db = new Database(":memory:"); migrate(db);
  let host: DuelHost | undefined;
  cleanups.push(async () => { await host?.close(); db.close(); rmSync(dataDirectory, { recursive: true, force: true }); });
  const players = [0, 1, 2].map(seat => seedIdentity(db, { guildId: "g", name: `P${seat}`, userId: seedUser(db, `loop${seat}`).userId }).playerId);
  const service = createDuelService(db);
  const session = service.create({ guildId: "g", organizerPlayerId: players[0]!, name: "Loop", mode: "normal", format: "ffa3", settings: { validateDeck: false, turnSeconds: 0 } });
  players.slice(1).forEach(player => service.takeSeat(session.slug, "g", player));
  players.forEach(player => service.setDeck(session.slug, "g", player, { main: Array(40).fill(1), extra: [], side: [] }));
  service.activate(session.slug, "g", players[0]!, ["1", "2", "3", "4"], pinnedEngineVersion("fixture", 3, activeMultiScriptsHash(dataDirectory)), null, { firstTurnDraw: false });
  const worker: DuelGameWorker = {
    running: true, create: vi.fn(async () => {}), search: async () => [],
    view: vi.fn(async seat => ({
      revision: 0, mode: "normal", format: "ffa3", viewerSeat: seat, turn: 1, turnSeat: 0, phase: "main1", chainMode: "auto",
      prompt: seat === 0 ? { id: "p1", seat: 0, kind: "choice", title: "Main", options: [{ id: "to_ep", label: "End" }], context: { type: "action", phase: "main" } } : null,
      result: null, chain: [], events: [], log: [], seats: [0, 1, 2].map(seat => ({ seat, lp: 8000, deckCount: 40, extraCount: 0, handCount: 0, hand: [], monsters: [], spells: [], graveyard: [], banished: [], extra: [] })),
    } as DuelEngineView)),
    answer: vi.fn(async () => { throw new EngineLoopError(); }),
    eliminate: vi.fn(async () => { throw new EngineLoopError(); }),
    setChainMode: vi.fn(async () => { throw new EngineLoopError(); }),
    close: vi.fn(async () => { Object.assign(worker, { running: false }); }),
  };
  const spawn = vi.fn(() => worker);
  const changes = vi.fn();
  host = createDuelHost({ db, dataDirectory, secret: SECRET, searchCards: () => [], createWorker: spawn, onChange: changes,
    now: () => 100_000, pollIntervalMs: 60_000, stallMs: 0 });
  const post = async (body: Record<string, unknown>) => {
    const raw = JSON.stringify({ slug: session.slug, guildId: "g", playerId: players[0], ...body });
    const response = await host!.handle(new Request("http://localhost/internal/duel", { method: "POST", body: raw,
      headers: { "x-announce-signature": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") } }));
    return { status: response.status, data: await response.json() as any };
  };
  return { worker, spawn, changes, service, slug: session.slug, post };
}

describe("core loops end the host duel permanently", () => {
  it.each(["respond", "surrender", "chain-mode", "timeout", "recovery-answer", "recovery-create", "recovery-answer-with-loss", "recovery-create-with-loss", "recovery-create-with-surrender"] as const)(
    "%s: interrupts with an engine loop reason instead of retrying the same journal", async operation => {
      const t = fixture();
      const command = { promptId: "p1", revision: 0, answer: { choice: "to_ep" } };
      if (operation.endsWith("-loss")) {
        t.service.recordCommand(t.slug, "g", 0, { promptId: "eliminate:0", revision: 0, answer: {} }, null);
        vi.mocked(t.worker.eliminate!).mockResolvedValueOnce(undefined);
      }
      if (operation === "recovery-create-with-surrender") t.service.setSetup(t.slug, "g", { firstTurnDraw: false, surrenderedSeats: [0] });
      if (operation.startsWith("recovery-create")) vi.mocked(t.worker.create).mockRejectedValueOnce(new EngineLoopError());
      if (operation.startsWith("recovery-answer")) t.service.recordCommand(t.slug, "g", 0, command, null);
      if (operation === "timeout") {
        await t.post({ op: "view" });
        t.service.setClock(t.slug, "g", { turn: 1, remainingMs: [100, 100, 100], activeSeat: 0, startedAt: 0 });
      }
      const accepted = t.service.privateState(t.slug, "g").commands.length;
      const response = await t.post({ op: operation === "timeout" || operation.startsWith("recovery-") ? "view" : operation, command, mode: "off" });
      expect(response.status, JSON.stringify(response.data)).toBe(200);
      expect(response.data.session).toMatchObject({ status: "interrupted", winnerSeat: null, resultReason: expect.stringMatching(/engine loop/i) });
      expect(t.worker.close).toHaveBeenCalledOnce();
      expect(t.service.privateState(t.slug, "g").commands).toHaveLength(accepted);
      expect(t.changes).toHaveBeenCalledWith(t.slug, "g");
      for (let poll = 0; poll < 3; poll++) expect((await t.post({ op: "view" })).data.session.status).toBe("interrupted");
      expect(t.spawn).toHaveBeenCalledOnce();
      if (operation === "respond" || operation.startsWith("recovery-answer")) expect(t.worker.answer).toHaveBeenCalledOnce();
      if (operation === "surrender" || operation === "timeout") expect(t.worker.eliminate).toHaveBeenCalledOnce();
    },
  );
});
