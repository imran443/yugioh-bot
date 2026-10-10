import { seedIdentity, seedUser } from "./helpers/identity.js";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "@yugidraft/shared/db";
import { seatCountFor, type DuelAnswer, type DuelCardInfo, type DuelDeck, type DuelEngineView, type DuelFormat, type DuelMasterRule, type DuelMode } from "@yugidraft/shared/duels";
import { createDuelService } from "@yugidraft/shared/services";
import type { DuelHost } from "../src/host.js";
import { createTestDuelHost as createDuelHost, finishTestDiceOpening } from "./support/test-opening.js";
import { buildPracticeBotDeck } from "../src/practice-bot.js";
import type { DuelGameWorker, GameOptions } from "../src/worker-client.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";

// DUEL_1V1_ENGINE chooses the engine of a NEW 1v1 table. The engine a table started on is saved with it, so recover and replay
// use that engine after the switch changes. Tables with 3 or 4 seats ignore the switch. A fake worker records what the host asks for.

const SECRET = "engine-switch-secret";
const MANIFEST = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { bundleVersion: string };

class FakeWorker implements DuelGameWorker {
  created: GameOptions | null = null;
  private stopped = false;
  get running() { return !this.stopped; }
  async create(options: GameOptions) { this.created = options; }
  async view(seat: number | null): Promise<DuelEngineView> {
    return {
      revision: 1, turn: 1, turnSeat: 0, phase: "main1",
      seats: Array.from({ length: seatCountFor(this.created?.format ?? "1v1") }, (_, index) => ({
        seat: index, lp: 8000, hand: [], deckCount: 35, extraCount: 0, extra: [], monsters: [], spells: [], graveyard: [], banished: [],
      })),
      prompt: seat === 0 ? { id: "p1", seat: 0, kind: "choice", title: "Main", options: [{ id: "to_ep", label: "End" }], context: { type: "action", phase: "main" } } : null,
      chain: [], events: [], log: [], result: null,
    } as unknown as DuelEngineView;
  }
  async answer(_seat: number, _promptId: string, _answer: DuelAnswer) {}
  async search(): Promise<DuelCardInfo[]> { return []; }
  async close() { this.stopped = true; }
}

const hosts: DuelHost[] = [];
const saved = { engine: process.env.DUEL_1V1_ENGINE, standard: process.env.DUEL_STANDARD_1V1_ENGINE, tables: process.env.MULTIPLAYER_TABLES };
beforeEach(() => {
  delete process.env.DUEL_1V1_ENGINE;
  delete process.env.DUEL_STANDARD_1V1_ENGINE;
  process.env.MULTIPLAYER_TABLES = "1";
});
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.close();
  for (const [key, value] of [["DUEL_1V1_ENGINE", saved.engine], ["DUEL_STANDARD_1V1_ENGINE", saved.standard], ["MULTIPLAYER_TABLES", saved.tables]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function post(host: DuelHost, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, any> }> {
  const raw = JSON.stringify(body);
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const response = await host.handle(new Request("http://localhost/internal/duel", {
    method: "POST",
    headers: { "content-type": "application/json", "x-announce-signature": signature },
    body: raw,
  }));
  return finishTestDiceOpening(host, body, { status: response.status, data: (await response.json()) as Record<string, any> },
    (next) => post(host, next));
}

function rotated(deck: DuelDeck, by: number): DuelDeck {
  return { ...deck, main: [...deck.main.slice(by), ...deck.main.slice(0, by)] };
}

function open() {
  const db = new Database(":memory:");
  migrate(db);
  const player = seedIdentity(db, { guildId: "g1", name: "P0", userId: seedUser(db, "u0").userId, discordUserId: seedUser(db, "u0").discordUserId ?? "u0" }).playerId;
  const duels = createDuelService(db);
  const workers: FakeWorker[] = [];
  const host = createDuelHost({
    db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], pollIntervalMs: 60_000,
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
  });
  hosts.push(host);
  return { db, player, duels, host, workers };
}

/** A full table: a human at seat 0 and a practice bot at every other seat. */
async function table(format: DuelFormat, mode: DuelMode = "normal", masterRule: DuelMasterRule = 5) {
  const t = open();
  const session = t.duels.create({ guildId: "g1", organizerPlayerId: t.player, name: "Duel", mode, format, masterRule });
  const organizer = { slug: session.slug, guildId: "g1", playerId: t.player };
  for (let seat = 1; seat < seatCountFor(format); seat += 1) {
    expect((await post(t.host, { op: "add-bot", ...organizer, seat })).status).toBe(200);
  }
  t.duels.setDeck(session.slug, "g1", t.player, rotated(buildPracticeBotDeck(mode, DATA), 1));
  return { ...t, session, organizer };
}

const setupOf = (duels: ReturnType<typeof open>["duels"], slug: string) => duels.privateState(slug, "g1").setup;

describe("DUEL_1V1_ENGINE on a new table", () => {
  it.each(["pinned", " Pinned "])("uses Standard override %j without changing Domain", async (override) => {
    process.env.DUEL_1V1_ENGINE = "legacy";
    process.env.DUEL_STANDARD_1V1_ENGINE = override;
    for (const mode of ["normal", "domain"] as const) {
      const t = await table("1v1", mode);
      expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
      const engine = mode === "normal" ? "pinned" : "legacy";
      expect(t.workers[0]!.created).toMatchObject({ engine, firstTurnDraw: false });
      expect(setupOf(t.duels, t.session.slug)).toMatchObject({ engine, firstTurnDraw: false });
    }
  });

  it("can roll Standard back to legacy while the global engine is pinned", async () => {
    process.env.DUEL_1V1_ENGINE = "pinned";
    process.env.DUEL_STANDARD_1V1_ENGINE = "legacy";
    const t = await table("1v1");
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("legacy");
    expect(setupOf(t.duels, t.session.slug)?.engine).toBe("legacy");
  });

  it.each(["", "banana"])("uses the global choice when the Standard override is %j", async (override) => {
    process.env.DUEL_1V1_ENGINE = "pinned";
    process.env.DUEL_STANDARD_1V1_ENGINE = override;
    const t = await table("1v1");
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("pinned");
  });

  it("reads the Standard override when a table starts", async () => {
    const t = await table("1v1");
    process.env.DUEL_STANDARD_1V1_ENGINE = "pinned";
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("pinned");
  });

  it.each((["normal", "domain"] as const).flatMap((mode) =>
    ([1, 2, 3, 4, 5] as const).map((masterRule) => ({ mode, masterRule })),
  ))("legacy $mode MR$masterRule: saves the current first-turn draw rule", async ({ mode, masterRule }) => {
    process.env.DUEL_1V1_ENGINE = "legacy";
    const t = await table("1v1", mode, masterRule);
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    const firstTurnDraw = mode === "normal" && masterRule <= 2;
    expect(t.workers[0]!.created).toMatchObject({ engine: "legacy", firstTurnDraw });
    expect(setupOf(t.duels, t.session.slug)).toMatchObject({ engine: "legacy", firstTurnDraw });
  });

  it.each([1, 2, 3, 4, 5] as const)("pinned Domain MR%s: saves no turn-1 draw", async (masterRule) => {
    process.env.DUEL_1V1_ENGINE = "pinned";
    const t = await table("1v1", "domain", masterRule);
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect(t.workers[0]!.created).toMatchObject({ engine: "pinned", firstTurnDraw: false });
    expect(setupOf(t.duels, t.session.slug)).toMatchObject({ engine: "pinned", firstTurnDraw: false });
  });

  it("starts a 1v1 table on the legacy engine when the switch is not set, and saves that", async () => {
    const t = await table("1v1");
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("legacy");
    expect(setupOf(t.duels, t.session.slug)?.engine).toBe("legacy");
  });

  it.each(["", "banana", "LEGACY "])("falls back to legacy for the value %j", async (value) => {
    process.env.DUEL_1V1_ENGINE = value;
    const t = await table("1v1");
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("legacy");
  });

  it.each(["pinned", " Pinned "])("starts a 1v1 table on the pinned engine when the switch is %j", async (value) => {
    process.env.DUEL_1V1_ENGINE = value;
    const t = await table("1v1");
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("pinned");
    expect(setupOf(t.duels, t.session.slug)?.engine).toBe("pinned");
  });

  it("reads the switch at each start, not once when the host is made", async () => {
    const t = await table("1v1");
    process.env.DUEL_1V1_ENGINE = "pinned";
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("pinned");
  });

  it.each<DuelFormat>(["tag", "ffa3", "ffa4"])("ignores the switch for a %s table: no engine name, no record", async (format) => {
    for (const value of ["legacy", "pinned"]) {
      process.env.DUEL_1V1_ENGINE = value;
      process.env.DUEL_STANDARD_1V1_ENGINE = value === "legacy" ? "pinned" : "legacy";
      const t = await table(format);
      expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
      expect(t.workers[0]!.created?.format).toBe(format);
      expect(t.workers[0]!.created).not.toHaveProperty("engine");
      expect(setupOf(t.duels, t.session.slug)?.engine).toBeUndefined();
    }
  });
});

describe("a saved 1v1 table keeps its engine", () => {
  /** A started table that no worker holds (the host was restarted): the next request recovers it. */
  async function activeTable(setup: Record<string, unknown> | undefined, mode: DuelMode = "normal", masterRule: DuelMasterRule = 5) {
    const t = await table("1v1", mode, masterRule);
    t.duels.activate(t.session.slug, "g1", t.player, ["1", "2", "3", "4"], MANIFEST.bundleVersion, null, setup);
    return t;
  }
  const view = (t: Awaited<ReturnType<typeof activeTable>>) => post(t.host, { op: "view", ...t.organizer });

  it.each(["legacy", "pinned", undefined] as const)("recovers saved Standard engine %s after its override changes", async (engine) => {
    process.env.DUEL_STANDARD_1V1_ENGINE = engine === "pinned" ? "legacy" : "pinned";
    const t = await activeTable(engine ? { engine } : undefined);
    expect((await view(t)).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe(engine ?? "legacy");
  });

  it("replays pinned Standard after the override is rolled back", async () => {
    process.env.DUEL_STANDARD_1V1_ENGINE = "pinned";
    const t = await table("1v1");
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect((await post(t.host, { op: "surrender", ...t.organizer })).status).toBe(200);
    process.env.DUEL_STANDARD_1V1_ENGINE = "legacy";
    const before = t.workers.length;
    expect((await post(t.host, { op: "replay", ...t.organizer })).status).toBe(200);
    const replayWorkers = t.workers.slice(before);
    expect(replayWorkers.length).toBeGreaterThan(0);
    for (const worker of replayWorkers) expect(worker.created?.engine).toBe("pinned");
  });

  it.each(([1, 2, 3, 4, 5] as const).flatMap((masterRule) =>
    [false, true].map((savedEngine) => ({ masterRule, savedEngine })),
  ))("legacy Domain MR$masterRule: infers the draw rule without a flag (saved engine=$savedEngine)", async ({ masterRule, savedEngine }) => {
    process.env.DUEL_1V1_ENGINE = "pinned";
    const t = await activeTable(savedEngine ? { engine: "legacy" } : undefined, "domain", masterRule);
    expect((await view(t)).status).toBe(200);
    expect(t.workers[0]!.created).toMatchObject({ engine: "legacy", firstTurnDraw: masterRule <= 2 });
  });

  it("legacy Domain MR5: replay keeps the saved no-draw rule after the switch changes", async () => {
    process.env.DUEL_1V1_ENGINE = "legacy";
    const t = await table("1v1", "domain");
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect((await post(t.host, { op: "surrender", ...t.organizer })).status).toBe(200);
    process.env.DUEL_1V1_ENGINE = "pinned";
    const before = t.workers.length;
    expect((await post(t.host, { op: "replay", ...t.organizer })).status).toBe(200);
    const replayWorkers = t.workers.slice(before);
    expect(replayWorkers.length).toBeGreaterThan(0);
    for (const worker of replayWorkers) expect(worker.created).toMatchObject({ engine: "legacy", firstTurnDraw: false });
  });

  it.each([
    ["legacy", "pinned"],
    ["pinned", "legacy"],
  ] as const)("recovers a table that started on %s with the switch at %s", async (started, now) => {
    process.env.DUEL_1V1_ENGINE = now;
    const t = await activeTable({ engine: started });
    expect((await view(t)).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe(started);
  });

  it("recovers a table with no record (made before the switch existed) on the legacy engine, also when the switch is pinned", async () => {
    process.env.DUEL_1V1_ENGINE = "pinned";
    const t = await activeTable(undefined);
    expect((await view(t)).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("legacy");
  });

  it("recovers a scenario table (it has startup scripts and no record) on the pinned engine", async () => {
    const t = await activeTable({ startupScripts: ["-- scenario"] });
    expect((await view(t)).status).toBe(200);
    expect(t.workers[0]!.created?.engine).toBe("pinned");
  });

  it("builds a replay on the engine the table started on, after the switch changed", async () => {
    process.env.DUEL_1V1_ENGINE = "legacy";
    const t = await table("1v1");
    expect((await post(t.host, { op: "start", ...t.organizer })).status).toBe(200);
    expect((await post(t.host, { op: "surrender", ...t.organizer })).status).toBe(200);
    process.env.DUEL_1V1_ENGINE = "pinned";
    const before = t.workers.length;
    const replay = await post(t.host, { op: "replay", ...t.organizer });
    expect(replay.status).toBe(200);
    const replayWorkers = t.workers.slice(before);
    expect(replayWorkers.length).toBeGreaterThan(0);
    for (const worker of replayWorkers) expect(worker.created?.engine).toBe("legacy");
  });
});
