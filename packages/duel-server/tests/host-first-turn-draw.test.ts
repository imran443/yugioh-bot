import { seedIdentity, seedUser } from "./helpers/identity.js";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import { isReplaySeed, seatCountFor, type DuelEngineView, type DuelFormat, type DuelMasterRule, type DuelMode, type DuelReplay, type DuelRoom } from "@yugidraft/shared/duels";
import { afterEach, expect, it, vi } from "vitest";
import { createEngineGame, type EngineGame } from "../src/engine.js";
import type { DuelHost } from "../src/host.js";
import { createTestDuelHost as createDuelHost, finishTestDiceOpening } from "./support/test-opening.js";
import { activeMultiScriptsHash, pinnedEngineVersion } from "../src/multi-scripts.js";
import { GameWorker } from "../src/worker-client.js";
import { getCurrentEngineResources } from "../src/engine-resource-resolver.js";
import { runJournalPrefix } from "../src/journal-runner.js";
import { loadSource, replaySource } from "../scripts/lib/replay-source.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";
import { describeWithCores, needs } from "./support/cores.js";

const SECRET = "first-draw-pin-test";
const seed = ["1", "2", "3", "4"];
const resources: Array<{ host: DuelHost; db: Database.Database }> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const { host, db } of resources.splice(0)) { await host.close(); db.close(); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function table(mode: DuelMode, format: DuelFormat, masterRule: DuelMasterRule = 5) {
  vi.stubEnv("MULTIPLAYER_TABLES", "1");
  // These tests use the pinned engine to check its saved draw rule.
  vi.stubEnv("DUEL_1V1_ENGINE", "pinned");
  const db = new Database(":memory:");
  migrate(db);
  const duels = createDuelService(db);
  const count = seatCountFor(format);
  const players = Array.from({ length: count }, (_, seat) => seedIdentity(db, { guildId: "g", name: `P${seat}`, userId: seedUser(db, `u${seat}`).userId, discordUserId: seedUser(db, `u${seat}`).discordUserId ?? `u${seat}` }).playerId);
  const session = duels.create({ guildId: "g", organizerPlayerId: players[0]!, name: "Draw rule pin", mode, format, masterRule,
    settings: { validateDeck: false, shuffleDeck: false, turnSeconds: 0 } });
  for (const player of players.slice(1)) duels.takeSeat(session.slug, "g", player);
  const decks = Array.from({ length: count }, () => ({ main: Array(40).fill(15025844), extra: [], side: [],
    ...(mode === "domain" ? { deckMaster: 48305365 } : {}) }));
  for (let seat = 0; seat < count; seat++) duels.setDeck(session.slug, "g", players[seat]!, decks[seat]!);
  const workers: GameWorker[] = [];
  const changes: Array<{ slug: string; guildId: string; status: string }> = [];
  const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], stallMs: 0,
    onChange: (slug, guildId) => { changes.push({ slug, guildId, status: duels.privateState(slug, guildId).session.status }); },
    pollIntervalMs: 60_000, createWorker: () => { const worker = new GameWorker(); workers.push(worker); return worker; } });
  resources.push({ host, db });
  const post = async (op: string, seat = 0, extra: Record<string, unknown> = {}): Promise<{ status: number; data: DuelRoom & DuelReplay & { error?: string; code?: string } }> => {
    const raw = JSON.stringify({ op, slug: session.slug, guildId: "g", playerId: players[seat], ...extra });
    const response = await host.handle(new Request("http://localhost/internal/duel", { method: "POST", body: raw,
      headers: { "x-announce-signature": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") } }));
    return finishTestDiceOpening(host, { op, slug: session.slug },
      { status: response.status, data: await response.json() as DuelRoom & DuelReplay & { error?: string; code?: string } }, () => post("view", seat, extra));
  };
  const bundle = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")).bundleVersion as string;
  const pin = pinnedEngineVersion(bundle, count, count > 2 ? activeMultiScriptsHash(DATA) : null);
  const options = { mode, format, masterRule: session.masterRule, settings: session.settings, decks, seed, dataDirectory: DATA };
  return { db, duels, session, decks, options, count, players, post, pin, bundle, workers, changes };
}

/** Old active recovery keeps its draw fallback. Detached engine tests can check the same historical prefix. */
async function journalFrames(t: Awaited<ReturnType<typeof table>>, viewer: number): Promise<DuelEngineView[]> {
  const state = t.duels.privateState(t.session.slug, "g");
  if (!isReplaySeed(state.seed)) throw new Error("Invalid test seed");
  const { engineIdentity, replayFork: _fork, ...setup } = state.setup ?? {};
  const frames: DuelEngineView[] = [];
  const result = await runJournalPrefix({
    source: { session: state.session, decks: state.decks, seed: state.seed, bundleVersion: state.bundleVersion!,
      setup, engineIdentity: engineIdentity ?? null, commands: state.commands },
    resources: { dataDirectory: DATA, bundleVersion: t.bundle }, prefixCount: state.commands.length,
    createWorker: () => new GameWorker(), checkpointSeat: viewer,
    onCheckpoint: ({ view }) => { frames.push(view); },
  });
  try { return frames; } finally { await result.worker.close(); }
}

function checkDraws(view: DuelEngineView, firstTurnDraw: boolean, actor: number) {
  for (let seat = 0; seat < view.seats.length; seat++) {
    const draws = Number(seat <= actor && (seat > 0 || firstTurnDraw));
    expect(view.seats[seat]!.hand, `seat ${seat}, turn ${actor + 1}`).toHaveLength(5 + draws);
    expect(view.seats[seat]!.deckCount).toBe(35 - draws);
    const draw = view.events.filter((event) => event.kind === "move" && event.reason === "draw"
      && event.seat === seat && event.zone?.sequence === 5);
    expect(draw, `DRAW seat ${seat}, turn ${actor + 1}`).toHaveLength(draws);
  }
}

const oldCases = [
  { mode: "domain", format: "1v1", firstTurnDraw: true },
  { mode: "domain", format: "1v1", firstTurnDraw: false },
  { mode: "domain", format: "tag", firstTurnDraw: false },
  { mode: "normal", format: "ffa3", firstTurnDraw: true },
  { mode: "normal", format: "ffa4", firstTurnDraw: true },
] satisfies Array<{ mode: DuelMode; format: DuelFormat; firstTurnDraw: boolean }>;
const newCases = (["normal", "domain"] as const).flatMap((mode) =>
  (["1v1", "tag", "ffa3", "ffa4"] as const).map((format) => ({ mode, format })));
// A 1v1 record with no engine name came from main and runs on the legacy engine. These records were made on the merged engine.
const mergedEngine = (format: DuelFormat) => (format === "1v1" ? { engine: "pinned" as const } : {});

const stableCases = [
  ...([1, 2, 3, 4, 5] as const).map((masterRule) => ({ mode: "normal" as const, format: "1v1" as const, masterRule })),
  { mode: "normal", format: "tag", masterRule: 5 },
  ...([1, 2, 3, 4] as const).map((masterRule) => ({ mode: "domain" as const, format: "1v1" as const, masterRule })),
] satisfies Array<{ mode: DuelMode; format: DuelFormat; masterRule: DuelMasterRule }>;

describeWithCores("first-turn draw survives real worker recovery and journal replay", [needs.standard(DATA), needs.domain(DATA),
  needs.installedMulti(DATA), ...needs.domainMulti(DATA, join(DATA, "ocgcore.multi-domain.wasm"))], () => {
  it.each([
    ...oldCases.map((test) => ({ ...test, saved: true })),
    ...(["1v1", "tag"] as const).map((format) => ({ mode: "domain" as const, format, firstTurnDraw: false, saved: false })),
  ])("$mode $format: an old-rule journal (saved=$saved) uses its rule on all replay paths", async ({ mode, format, firstTurnDraw, saved }) => {
    const t = await table(mode, format);
    // Record the old rule on the real engine, with real end-turn answers. The saved flag
    // is the same FIRST_TURN_DRAW bit used before d4338a2 for Standard FFA and Domain 1v1/Tag.
    const game: EngineGame = await createEngineGame({ ...t.options, ...{ firstTurnDraw } });
    const history: DuelEngineView[][] = [];
    const commands: Array<{ seat: number; command: { promptId: string; revision: number; answer: { choice: string } } }> = [];
    try {
      if (saved) {
        t.duels.activateRecorded(t.session.slug, "g", t.players[0]!, seed, t.pin, null,
          { firstTurnDraw, scriptErrorMode: "tolerant", ...mergedEngine(format) },
          getCurrentEngineResources(DATA, { mode, format, engine: "pinned" }).identity);
      } else {
        t.duels.activate(t.session.slug, "g", t.players[0]!, seed, t.pin, null, mergedEngine(format));
      }
      if (saved) expect(t.duels.privateState(t.session.slug, "g").setup).toMatchObject({ firstTurnDraw });
      else expect(t.duels.privateState(t.session.slug, "g").setup?.firstTurnDraw).toBeUndefined();
      for (let actor = 0; actor < t.count; actor++) {
        const views = Array.from({ length: t.count }, (_, viewer) => game.view(viewer));
        for (const view of views) checkDraws(view, firstTurnDraw, actor);
        history.push(views);
        const view = views[actor]!;
        expect(view.turnSeat).toBe(actor);
        expect(view.prompt?.options.some((option) => option.id === "to_ep")).toBe(true);
        const command = { promptId: view.prompt!.id, revision: view.revision, answer: { choice: "to_ep" } };
        game.answer(actor, command.promptId, command.answer);
        t.duels.recordCommand(t.session.slug, "g", actor, command, null);
        commands.push({ seat: actor, command });
      }
      history.push(Array.from({ length: t.count }, (_, viewer) => game.view(viewer)));
    } finally { game.close(); }
    // Recovery creates a fresh real worker. A second recovery follows a stopped worker.
    for (let recovery = 0; recovery < 2; recovery++) {
      for (let viewer = 0; viewer < t.count; viewer++) {
        const response = await t.post("view", viewer);
        expect(response.status, response.data.error).toBe(200);
        expect(response.data.engine).toEqual(history.at(-1)![viewer]);
      }
      await t.workers.at(-1)!.close();
    }
    t.duels.interrupt(t.session.slug, "g", "Test finished");
    for (let viewer = 0; viewer < t.count; viewer++) {
      const response = await t.post("replay", viewer);
      if (saved) expect(response.status, response.data.error).toBe(200);
      else expect(response).toMatchObject({ status: 409, data: { code: "ENGINE_UNAVAILABLE_FOR_SOURCE" } });
      const frames = saved ? response.data.frames.map(frame => frame.view) : await journalFrames(t, viewer);
      for (let step = 0; step <= commands.length; step++) {
        const expected = history[step]![viewer]!;
        expect(frames[step]).toMatchObject({ turn: expected.turn, turnSeat: expected.turnSeat,
          revision: expected.revision, seats: JSON.parse(JSON.stringify(expected.seats)) });
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "first-draw-journal-"));
    dirs.push(dir);
    const file = join(dir, "old-rule.json");
    writeFileSync(file, JSON.stringify({ format: "yugidraft-duel-journal/1", mode, tableFormat: format,
      masterRule: t.session.masterRule, seed, decks: t.decks, settings: t.session.settings,
      bundleVersion: t.pin, ...(saved ? { setup: { firstTurnDraw } } : {}), commands }));
    const replayed = await replaySource(loadSource(file), DATA, commands.length);
    expect(replayed.seats).toEqual(history.at(-1));
    const output = execFileSync("npx", ["tsx", "scripts/replay-journal.ts", file, "--data", DATA, "--json", "--views"],
      { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const cli = JSON.parse(output);
    expect(cli).toMatchObject({ ok: true, replayed: commands.length, total: commands.length, seatCount: t.count });
    for (let viewer = 0; viewer < t.count; viewer++) expect(cli.views[String(viewer)]).toEqual(history.at(-1)![viewer]);
  }, 120_000);

  it.each(newCases)("$mode $format: a new duel stores and restores the current draw rule", async ({ mode, format }) => {
    const t = await table(mode, format);
    const started = await t.post("start");
    expect(started.status, started.data.error).toBe(200);
    const firstTurnDraw = mode === "domain" && format !== "1v1";
    expect(t.duels.privateState(t.session.slug, "g").setup).toMatchObject({ firstTurnDraw });
    for (let viewer = 0; viewer < t.count; viewer++) checkDraws((await t.post("view", viewer)).data.engine!, firstTurnDraw, 0);
    const initial = Array.from({ length: t.count }, async (_, viewer) => (await t.post("view", viewer)).data.engine!);
    const views = await Promise.all(initial);
    await t.workers[0]!.close();
    for (let viewer = 0; viewer < t.count; viewer++) {
      const recovered = await t.post("view", viewer);
      expect(recovered.status, recovered.data.error).toBe(200);
      expect(recovered.data.engine).toEqual(views[viewer]);
    }
    t.duels.interrupt(t.session.slug, "g", "Test finished");
    for (let viewer = 0; viewer < t.count; viewer++) {
      const replay = await t.post("replay", viewer);
      expect(replay.status, replay.data.error).toBe(200);
      expect(replay.data.frames[0]!.view.seats).toEqual(views[viewer]!.seats);
    }
  }, 60_000);

  it.each(stableCases)("$mode MR$masterRule $format: an old record can infer the historical stock draw rule", async ({ mode, format, masterRule }) => {
    const t = await table(mode, format, masterRule);
    const firstTurnDraw = masterRule <= 2;
    const game = await createEngineGame({ ...t.options, firstTurnDraw });
    let initial: DuelEngineView[];
    let expected: DuelEngineView[];
    try {
      initial = Array.from({ length: t.count }, (_, viewer) => game.view(viewer));
      for (const view of initial) checkDraws(view, firstTurnDraw, 0);
      t.duels.activate(t.session.slug, "g", t.players[0]!, seed, t.pin, null, mergedEngine(format));
      expect(t.duels.privateState(t.session.slug, "g").setup?.firstTurnDraw).toBeUndefined();
      const view = game.view(0);
      const command = { promptId: view.prompt!.id, revision: view.revision, answer: { choice: "to_ep" } };
      game.answer(0, command.promptId, command.answer);
      t.duels.recordCommand(t.session.slug, "g", 0, command, null);
      expected = Array.from({ length: t.count }, (_, viewer) => game.view(viewer));
    } finally { game.close(); }
    for (let viewer = 0; viewer < t.count; viewer++) {
      const recovered = await t.post("view", viewer);
      expect(recovered.status, recovered.data.error).toBe(200);
      expect(recovered.data.engine).toEqual(expected[viewer]);
    }
    t.duels.interrupt(t.session.slug, "g", "Test finished");
    for (let viewer = 0; viewer < t.count; viewer++) {
      const replay = await t.post("replay", viewer);
      expect(replay).toMatchObject({ status: 409, data: { code: "ENGINE_UNAVAILABLE_FOR_SOURCE" } });
      const frames = await journalFrames(t, viewer);
      expect(frames[0]!.seats).toEqual(initial[viewer]!.seats);
      expect(frames[1]!.seats).toEqual(expected[viewer]!.seats);
    }
  }, 60_000);

  it.each((["normal", "domain"] as const).flatMap((mode) =>
    (["ffa3", "ffa4"] as const).map((format) => ({ mode, format }))))("$mode $format: a journal without a stored rule fails with a clear message", async ({ mode, format }) => {
    const t = await table(mode, format);
    t.duels.activate(t.session.slug, "g", t.players[0]!, seed, t.pin, null);
    const response = await t.post("view");
    expect(response.status).toBe(409);
    expect(response.data.error).toContain("first-turn draw rule was not saved");
    expect(t.workers).toHaveLength(0);
    expect(t.duels.privateState(t.session.slug, "g").session.status).toBe("interrupted");
    expect(t.changes).toEqual([{ slug: t.session.slug, guildId: "g", status: "interrupted" }]);
    const replay = await t.post("replay");
    expect(replay.status).toBe(409);
    expect(replay.data.code).toBe("ENGINE_UNAVAILABLE_FOR_SOURCE");
    const dir = mkdtempSync(join(tmpdir(), "first-draw-missing-"));
    dirs.push(dir);
    const file = join(dir, "missing-rule.json");
    writeFileSync(file, JSON.stringify({ format: "yugidraft-duel-journal/1", mode, tableFormat: format,
      masterRule: t.session.masterRule, seed, decks: t.decks, commands: [] }));
    expect(() => loadSource(file)).toThrow("first-turn draw rule was not saved");
    try {
      execFileSync("npx", ["tsx", "scripts/replay-journal.ts", file, "--data", DATA],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect.fail("The CLI must refuse an ambiguous journal");
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr)).toContain("first-turn draw rule was not saved");
    }
  }, 60_000);
});
