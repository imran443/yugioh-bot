import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import { defaultDuelSettings, seatCountFor } from "@yugidraft/shared/duels";
import { createDuelHost, type DuelHost } from "../src/host.js";
import { cardScriptHash } from "../src/card-script-hash.js";
import { loadCardDatabase } from "../src/cards.js";
import { loadMultiScriptsFor } from "../src/multi-scripts.js";
import { seedIdentity, seedUser } from "./helpers/identity.js";
import { createHostDataFixture } from "./helpers/host-data-fixture.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    if (String(path).endsWith("/card-block-list.json")) return JSON.stringify([{ code: 89631139, reason: "Repeated script errors under investigation" }, { code: 77585513, reason: "Repeated script errors under investigation" }]);
    return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
  } };
});

const SECRET = "blocked-start";
let DATA: string;
beforeAll(() => {
  DATA = createHostDataFixture([
    { code: 89631139, name: "Blue-Eyes White Dragon" },
    { code: 77585513, name: "Jinzo", type: 33 },
    { code: 44095762, name: "Mirror Force", type: 4 },
    { code: 15025844, name: "Mystical Elf" },
    { code: 12580477, name: "Raigeki", type: 2 },
    { code: 53129443, name: "Dark Hole", type: 2 },
    { code: 14778250, name: "Celtic Guardian" },
    { code: 91152256, name: "Gemini Elf" },
    { code: 97017120, name: "Giant Rat", type: 33 },
    { code: 70781052, name: "Summoned Skull" },
    { code: 5318639, name: "Mystical Space Typhoon", type: 2 },
    { code: 72302403, name: "Swords of Revealing Light", type: 2 },
    { code: 60082869, name: "Dust Tornado", type: 4 },
    { code: 18144506, name: "Harpie's Feather Duster", type: 2 },
  ]);
});
afterAll(() => { rmSync(DATA, { recursive: true, force: true }); });
const hosts: DuelHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); vi.unstubAllEnvs(); });

async function post(host: DuelHost, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const result = await host.handle(new Request("http://local/internal/duel", { method: "POST", headers: { "content-type": "application/json", "x-announce-signature": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw }));
  return { status: result.status, data: await result.json() as any };
}

it.each((["1v1", "tag", "ffa3", "ffa4"] as const).flatMap((format) => (["normal", "domain"] as const).map((mode) => ({ format, mode }))))("$format $mode: refuses a saved blocked deck at start even when validation is disabled", async ({ format, mode }) => {
  vi.stubEnv("MULTIPLAYER_TABLES", "1");
  const db = new Database(":memory:");
  migrate(db);
  const players = Array.from({ length: seatCountFor(format) }, (_, i) => seedIdentity(db, { guildId: "g", name: `P${i}`, userId: seedUser(db, `block${i}`).userId }).playerId);
  const duels = createDuelService(db);
  const session = duels.create({ guildId: "g", organizerPlayerId: players[0]!, name: "Blocked", format, mode, settings: { ...defaultDuelSettings(mode), validateDeck: false, banlist: "none" } });
  players.slice(1).forEach((player) => duels.takeSeat(session.slug, "g", player));
  players.forEach((player) => duels.setDeck(session.slug, "g", player, { main: Array(40).fill(89631139), extra: [], side: [], ...(mode === "domain" ? { deckMaster: 89631139 } : {}) }));
  const createWorker = vi.fn(() => { throw new Error("Blocked deck must be refused before creating a core"); });
  const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], createWorker }); hosts.push(host);
  try {
    const result = await post(host, { op: "start", slug: session.slug, guildId: "g", playerId: players[0] });
    expect(result.status).toBe(400);
    expect(result.data.error).toContain("Blue-Eyes White Dragon is unavailable: Repeated script errors under investigation");
    expect(createWorker).not.toHaveBeenCalled();
    expect(duels.get(session.slug, "g").status).toBe("lobby");
    const details = await post(host, { op: "card-details", codes: [89631139], guildId: "g", playerId: players[0] });
    expect(details.status).toBe(200);
    expect(details.data.cards[0].unavailableReason).toBe("Repeated script errors under investigation");
  } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); db.close(); }
});


it("refuses a blocked preset board card before creating a session or core", async () => {
  vi.stubEnv("DUEL_SCENARIOS", "1");
  const db = new Database(":memory:"); migrate(db);
  const player = seedIdentity(db, { guildId: "g", name: "P0", userId: seedUser(db, "preset").userId }).playerId;
  const createWorker = vi.fn(() => { throw new Error("Blocked board must not create a core"); });
  const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], createWorker }); hosts.push(host);
  try {
    const result = await post(host, { op: "start-preset", presetId: "jinzo-stops-trap", guildId: "g", playerId: player });
    expect(result.status).toBe(400);
    expect(result.data.error).toContain("Jinzo is unavailable: Repeated script errors under investigation");
    expect(createWorker).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS n FROM duels").get()).toEqual({ n: 0 });
  } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); db.close(); }
});

it.each([
  { presetId: "raigeki-dark-hole-tag", code: 12580477, kind: "multi-normal" as const },
  { presetId: "dust-tornado-chain", code: 5318639, kind: "pinned-normal" as const },
])("$presetId checks its actual engine scope when 1v1 defaults to legacy", async ({ presetId, code, kind }) => {
  vi.stubEnv("DUEL_SCENARIOS", "1"); vi.stubEnv("MULTIPLAYER_TABLES", "1"); vi.stubEnv("DUEL_1V1_ENGINE", "legacy");
  const db = new Database(":memory:"); migrate(db);
  const player = seedIdentity(db, { guildId: "g", name: "P", userId: seedUser(db, presetId).userId }).playerId;
  db.prepare(`INSERT INTO card_script_auto_blocks (code, reason, blocked_at, distinct_duels, error_count, threshold, window_days, bundle_version, script_hash, engine_kind)
    VALUES (?, 'reason', CURRENT_TIMESTAMP, 3, 3, 3, 7, 'test', ?, ?)`)
    .run(code, cardScriptHash(loadCardDatabase(DATA), code, kind, kind === "multi-normal" ? loadMultiScriptsFor(DATA) : undefined), kind);
  const createWorker = vi.fn(() => { throw new Error("Blocked board must not create a core"); });
  const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], createWorker });
  try {
    const result = await post(host, { op: "start-preset", presetId, guildId: "g", playerId: player });
    expect(result.status).toBe(400);
    expect(result.data.error).toContain("is unavailable");
    expect(createWorker).not.toHaveBeenCalled();
  } finally { await host.close(); db.close(); }
});

it.each([
  { mode: "normal" as const, format: "tag" as const, kind: "multi-normal" as const },
  { mode: "domain" as const, format: "1v1" as const, kind: "legacy-domain" as const },
])("search and details use $kind room context without blocking Normal 1v1", async ({ mode, format, kind }) => {
  vi.stubEnv("DUEL_1V1_ENGINE", "legacy");
  const db = new Database(":memory:"); migrate(db);
  const player = seedIdentity(db, { guildId: "g", name: "P", userId: seedUser(db, kind).userId }).playerId;
  const session = createDuelService(db).create({ guildId: "g", organizerPlayerId: player, name: "Scoped", mode, format });
  const code = 18144506;
  db.prepare(`INSERT INTO card_script_auto_blocks (code, reason, blocked_at, distinct_duels, error_count, threshold, window_days, bundle_version, script_hash, engine_kind)
    VALUES (?, 'reason', CURRENT_TIMESTAMP, 3, 3, 3, 7, 'test', ?, ?)`)
    .run(code, cardScriptHash(loadCardDatabase(DATA), code, kind, kind === "multi-normal" ? loadMultiScriptsFor(DATA) : undefined), kind);
  const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [] });
  try {
    for (const op of ["card-query", "card-details"]) {
      const body = { op, guildId: "g", playerId: player, codes: [code], cardQuery: { text: String(code) } };
      expect((await post(host, body)).data.cards[0]).not.toHaveProperty("unavailableReason");
      expect((await post(host, { ...body, slug: session.slug })).data.cards[0].unavailableReason).toBe("Its effect script is being investigated");
      if (mode === "domain") expect((await post(host, { ...body, mode })).data.cards[0].unavailableReason).toBe("Its effect script is being investigated");
    }
  } finally { await host.close(); db.close(); }
});

it.each(["pinned-normal", "legacy-normal"] as const)("Standard override uses pinned admission rules for a %s block", async (kind) => {
  vi.stubEnv("DUEL_1V1_ENGINE", "legacy");
  vi.stubEnv("DUEL_STANDARD_1V1_ENGINE", "pinned");
  const db = new Database(":memory:"); migrate(db);
  const player = seedIdentity(db, { guildId: "g", name: "P", userId: seedUser(db, kind).userId }).playerId;
  const session = createDuelService(db).create({ guildId: "g", organizerPlayerId: player, name: "Standard override", mode: "normal" });
  const code = 18144506;
  db.prepare(`INSERT INTO card_script_auto_blocks (code, reason, blocked_at, distinct_duels, error_count, threshold, window_days, bundle_version, script_hash, engine_kind)
    VALUES (?, 'reason', CURRENT_TIMESTAMP, 3, 3, 3, 7, 'test', ?, ?)`)
    .run(code, cardScriptHash(loadCardDatabase(DATA), code, kind), kind);
  const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [] });
  try {
    for (const op of ["card-query", "card-details"]) {
      const body = { op, guildId: "g", playerId: player, codes: [code], cardQuery: { text: String(code) } };
      for (const context of [{}, { slug: session.slug }]) {
        const result = await post(host, { ...body, ...context });
        expect(result.status).toBe(200);
        if (kind === "pinned-normal") expect(result.data.cards[0].unavailableReason).toBe("Its effect script is being investigated");
        else expect(result.data.cards[0]).not.toHaveProperty("unavailableReason");
      }
    }
  } finally { await host.close(); db.close(); }
});
