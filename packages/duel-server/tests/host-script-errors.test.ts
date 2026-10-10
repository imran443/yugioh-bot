import { readFileSync } from "node:fs";
import { activeMultiScriptsHash, pinnedEngineVersion } from "../src/multi-scripts.js";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import type { DuelEngineView, DuelFormat, DuelMode } from "@yugidraft/shared/duels";
import { createDuelHost, type DuelHost } from "../src/host.js";
import { getCurrentEngineResources } from "../src/engine-resource-resolver.js";
import { topScriptErrors } from "../src/script-error-store.js";
import { reproOptions, attackAnswer } from "./helpers/script-error-repro.js";
import { queryErrorOptions } from "./helpers/query-error-repro.js";
import { chooseSurrenderedAnswer } from "../src/practice-bot.js";
import { seedIdentity, seedUser } from "./helpers/identity.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";
import { describeWithCores, needs } from "./support/cores.js";

const SECRET = "script-errors-test";
const hosts: DuelHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function request(host: DuelHost, body: Record<string, unknown>, expectedStatus = 200) {
  const raw = JSON.stringify(body);
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const response = await host.handle(new Request("http://local/internal/duel", { method: "POST", headers: { "content-type": "application/json", "x-announce-signature": signature }, body: raw }));
  const data = await response.json() as any;
  expect(response.status, JSON.stringify(data)).toBe(expectedStatus);
  return data;
}

// This fixture callback fails twice in one engine command. The worker keeps
// distinct ordinals; recovery and retry must not count either occurrence again.
function expectRuntimeOccurrences(db: Database.Database, duelId: number) {
  const rows = db.prepare("select command_hash, error_index from card_script_error_occurrences where duel_id = ? and code = 3743515 order by error_index").all(duelId);
  expect(rows).toHaveLength(2);
  const [first] = rows as Array<{ command_hash: string; error_index: number }>;
  expect(first!.command_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(rows).toEqual([1, 2].map(error_index => ({ command_hash: first!.command_hash, error_index })));
}

describeWithCores("script errors through host, worker and journal", [needs.standard(DATA), needs.domain(DATA), needs.installedMulti(DATA)], () => {
  it.each(["legacy", "pinned"] as const)("%s: logs fatal Lua diagnostics only on the host and never counts them", async (engine) => {
    const db = new Database(":memory:"); migrate(db);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const players = [0, 1].map(i => seedIdentity(db, { guildId: "g", name: `P${i}`, userId: seedUser(db, `fatal${i}`).userId }).playerId);
    const duels = createDuelService(db);
    const options = reproOptions();
    const session = duels.create({ guildId: "g", organizerPlayerId: players[0]!, name: "Fatal diagnostics", mode: "normal", settings: options.settings });
    duels.takeSeat(session.slug, "g", players[1]!);
    players.forEach((player, seat) => duels.setDeck(session.slug, "g", player, options.decks[seat]!));
    const version = JSON.parse(readFileSync(`${DATA}/manifest.json`, "utf8")).bundleVersion;
    duels.activate(session.slug, "g", players[0]!, options.seed, pinnedEngineVersion(version, 2, null), null, {
      engine, firstTurnDraw: false, startupScripts: [`local e=Effect.GlobalEffect()
        e:SetType(EFFECT_TYPE_FIELD|EFFECT_TYPE_CONTINUOUS) e:SetCode(EVENT_STARTUP)
        e:SetOperation(function() error("stack overflow: private_lua_diagnostic") end) Duel.RegisterEffect(e,0)`],
    });
    const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], pollIntervalMs: 60_000 });
    hosts.push(host);
    try {
      const result = await request(host, { op: "view", slug: session.slug, guildId: "g", playerId: players[0] }, 503);
      expect(JSON.stringify(result)).toContain("Engine script error:");
      expect(JSON.stringify(result)).not.toMatch(/stack overflow|private_lua_diagnostic/);
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toContainEqual(expect.objectContaining({ event: "card_script_fatal", duelId: session.id, engine, message: expect.stringContaining("stack overflow: private_lua_diagnostic"), traceback: expect.any(String) }));
      expect(topScriptErrors(db)).toEqual([]);
      expect(db.prepare("SELECT * FROM card_script_error_occurrences").all()).toEqual([]);
    } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); db.close(); }
  });
  it.each([["legacy", "1v1"], ["pinned", "1v1"], ["pinned", "ffa4"]] as const)("%s %s: repeated view failures stay private across answers, recovery and replay", async (engine, format) => {
    const db = new Database(":memory:"); migrate(db);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const players = Array.from({ length: format === "1v1" ? 2 : 4 }, (_, i) => seedIdentity(db, { guildId: "g", name: `P${i}`, userId: seedUser(db, `query${i}`).userId }).playerId);
    const duels = createDuelService(db);
    const options = queryErrorOptions(format);
    const session = duels.create({ guildId: "g", organizerPlayerId: players[0]!, name: "Query errors", mode: "normal", format, settings: options.settings });
    players.slice(1).forEach(player => duels.takeSeat(session.slug, "g", player));
    players.forEach((player, seat) => duels.setDeck(session.slug, "g", player, options.decks[seat]!));
    const version = JSON.parse(readFileSync(`${DATA}/manifest.json`, "utf8")).bundleVersion;
    duels.activateRecorded(session.slug, "g", players[0]!, options.seed, pinnedEngineVersion(version, players.length, format === "1v1" ? null : activeMultiScriptsHash(DATA)), null, {
      engine, scriptErrorMode: "tolerant", firstTurnDraw: false, startupScripts: options.startupScripts.map(script => script.content),
    }, getCurrentEngineResources(DATA, { mode: "normal", format, engine }).identity);
    const makeHost = () => { const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], pollIntervalMs: 60_000 }); hosts.push(host); return host; };
    let host = makeHost();
    const base = { slug: session.slug, guildId: "g" };
    const views = async (): Promise<DuelEngineView[]> => Promise.all(players.map(async player => (await request(host, { ...base, op: "view", playerId: player })).engine));
    try {
      for (let step = 0; step < 3; step++) {
        const current = await views();
        expect(await views()).toEqual(current);
        const seat = current.findIndex(view => view.prompt !== null);
        const view = current[seat]!;
        await request(host, { ...base, op: "respond", playerId: players[seat], command: { promptId: view.prompt!.id, revision: view.revision, answer: chooseSurrenderedAnswer(view.prompt!) } });
      }
      const live = await views();
      expect(live[0]!.events.filter(event => event.kind === "script-error")).toHaveLength(0);
      expect(live[0]!.result).toBeNull();
      expect(topScriptErrors(db)).toEqual([expect.objectContaining({ code: 15025844, count: 1 })]);
      await host.close(); hosts.splice(hosts.indexOf(host), 1);
      host = makeHost();
      expect(await views()).toEqual(live);
      expect(duels.privateState(session.slug, "g").commands).toHaveLength(3);
      expect(topScriptErrors(db)[0]?.count).toBe(1);
      duels.complete(session.slug, "g", 0, "Test replay completion");
      const replay = await request(host, { ...base, op: "replay", playerId: players[0] });
      expect(JSON.stringify(replay)).not.toMatch(/script-error|query_fixture_missing|c15025844\.lua/);
      expect(topScriptErrors(db)[0]?.count).toBe(1);
      expect(log.mock.calls.filter(([line]) => typeof line === "string" && line.includes('"event":"card_script_error"'))).toHaveLength(1);
    } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); db.close(); }
  }, 30_000);
  it.each([
    ["legacy", "1v1", "normal"], ["legacy", "1v1", "domain"],
    ["pinned", "1v1", "normal"], ["pinned", "1v1", "domain"],
    ["pinned", "ffa4", "normal"], ["pinned", "ffa4", "domain"],
  ] as const)("%s %s %s: accepts/journals the answer, deduplicates engine occurrence ordinals and recovers identically", async (engine, format: DuelFormat, mode: DuelMode) => {
    const db = new Database(":memory:");
    migrate(db);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const players = Array.from({ length: format === "1v1" ? 2 : 4 }, (_, i) => seedIdentity(db, { guildId: "g", name: `P${i}`, userId: seedUser(db, `script${i}`).userId }).playerId);
    const duels = createDuelService(db);
    const options = reproOptions(format, mode);
    const session = duels.create({ guildId: "g", organizerPlayerId: players[0]!, name: "Script error", mode, format, settings: options.settings });
    players.slice(1).forEach((player) => duels.takeSeat(session.slug, "g", player));
    players.forEach((player, seat) => duels.setDeck(session.slug, "g", player, options.decks[seat]!));
    const version = JSON.parse(readFileSync(`${DATA}/manifest.json`, "utf8")).bundleVersion;
    duels.activateRecorded(session.slug, "g", players[0]!, options.seed, pinnedEngineVersion(version, players.length, format === "1v1" ? null : activeMultiScriptsHash(DATA)), null, {
      engine, scriptErrorMode: "tolerant", firstTurnDraw: false, startupScripts: options.startupScripts!.map((script) => script.content),
    }, getCurrentEngineResources(DATA, { mode, format, engine }).identity);
    const makeHost = () => { const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], pollIntervalMs: 60_000 }); hosts.push(host); return host; };
    let host = makeHost();
    const base = { slug: session.slug, guildId: "g" };
    const views = async (): Promise<DuelEngineView[]> => Promise.all(players.map(async (player) => (await request(host, { ...base, op: "view", playerId: player })).engine));
    try {
      if (format === "ffa4") await request(host, { ...base, op: "surrender", playerId: players[3] });
      for (let step = 0; step < 80; step++) {
        const current = await views();
        if (current[0]!.events.some((event) => event.kind === "script-error")) break;
        const seat = current.findIndex((view) => view.prompt !== null);
        expect(seat).toBeGreaterThanOrEqual(0);
        const view = current[seat]!;
        await request(host, { ...base, op: "respond", playerId: players[seat], command: { promptId: view.prompt!.id, revision: view.revision, answer: attackAnswer(view.prompt!) } });
      }
      const live = await views();
      expectRuntimeOccurrences(db, session.id);
      expect(live[0]!.events.some((event) => event.kind === "script-error")).toBe(true);
      expect(live[0]!.result).toBeNull();
      expect(duels.privateState(session.slug, "g").commands.length).toBeGreaterThan(0);
      expect(topScriptErrors(db)).toEqual([expect.objectContaining({ code: 3743515, count: 2, last_duel_id: session.id })]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"card_script_error"'));
      // Server setting changes affect new duels; a recovery keeps the saved policy.
      await host.close(); hosts.splice(hosts.indexOf(host), 1);
      vi.stubEnv("DUEL_SCRIPT_ERRORS", "strict");
      host = makeHost();
      expect(await views()).toEqual(live);
      expect(topScriptErrors(db)[0]?.count).toBe(2);
      duels.complete(session.slug, "g", 0, "Test replay completion");
      const replay = await request(host, { ...base, op: "replay", playerId: players[0] });
      expect(JSON.stringify(replay)).toContain("Card script error:");
      expect(topScriptErrors(db)[0]?.count).toBe(2);
      expect(log.mock.calls.filter(([line]) => typeof line === "string" && line.includes('"event":"card_script_error"'))).toHaveLength(2);
    } finally {
      await host.close(); hosts.splice(hosts.indexOf(host), 1); db.close();
    }
  }, 30_000);
  it("discards a strict failed worker and deduplicates engine occurrence ordinals on retry", async () => {
    const db = new Database(":memory:");
    migrate(db);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const players = [0, 1].map((i) => seedIdentity(db, { guildId: "g", name: `P${i}`, userId: seedUser(db, `strict${i}`).userId }).playerId);
    const duels = createDuelService(db);
    const options = reproOptions();
    const session = duels.create({ guildId: "g", organizerPlayerId: players[0]!, name: "Strict script error", mode: "normal", format: "1v1", settings: options.settings });
    duels.takeSeat(session.slug, "g", players[1]!);
    players.forEach((player, seat) => duels.setDeck(session.slug, "g", player, options.decks[seat]!));
    const version = JSON.parse(readFileSync(`${DATA}/manifest.json`, "utf8")).bundleVersion;
    duels.activate(session.slug, "g", players[0]!, options.seed, pinnedEngineVersion(version, 2, null), null, {
      engine: "pinned", scriptErrorMode: "strict", firstTurnDraw: false, startupScripts: options.startupScripts!.map((script) => script.content),
    });
    const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], pollIntervalMs: 60_000 });
    hosts.push(host);
    const base = { slug: session.slug, guildId: "g" };
    const views = async (): Promise<DuelEngineView[]> => Promise.all(players.map(async (player) => (await request(host, { ...base, op: "view", playerId: player })).engine));
    try {
      for (let step = 0; step < 80; step++) {
        const before = await views();
        const seat = before.findIndex((view) => view.prompt !== null);
        expect(seat).toBeGreaterThanOrEqual(0);
        const view = before[seat]!;
        const body = { ...base, op: "respond", playerId: players[seat], command: { promptId: view.prompt!.id, revision: view.revision, answer: attackAnswer(view.prompt!) } };
        const triggering = view.prompt!.options.some((entry) => entry.id.startsWith("attack:"));
        const commandsBefore = duels.privateState(session.slug, "g").commands.length;
        await request(host, body, triggering ? 400 : 200);
        if (!triggering) continue;
        expect(await views()).toEqual(before);
        expectRuntimeOccurrences(db, session.id);
        expect(duels.privateState(session.slug, "g").commands).toHaveLength(commandsBefore);
        expect(topScriptErrors(db)[0]?.count).toBe(2);
        const retry = await request(host, body, 400);
        expect(JSON.stringify(retry)).toContain("Card script error (strict mode)");
        expect(JSON.stringify(retry)).not.toContain("3743515");
        expect(await views()).toEqual(before);
        expectRuntimeOccurrences(db, session.id);
        expect(topScriptErrors(db)[0]?.count).toBe(2);
        return;
      }
      throw new Error("Synthetic card condition did not fail");
    } finally {
      await host.close(); hosts.splice(hosts.indexOf(host), 1); db.close();
    }
  }, 30_000);

});
