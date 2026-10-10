import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { defaultDuelSettings, type DuelDeck, type DuelMode } from "@yugidraft/shared/duels";
import { createDuelSeriesService, createDuelService } from "@yugidraft/shared/services";
import { createDuelHost, type DuelHost } from "../src/host.js";
import { inspectDeck } from "../src/deck-legality.js";
import { createHostDataFixture } from "./helpers/host-data-fixture.js";
import { seedIdentity } from "./helpers/identity.js";

const SECRET = "deck-master-type";
const MESSAGE = "You can't use a Spell or Trap as your Deck Master.";
const MONSTER = 46986414;
const SPELL = 55144522;
const TRAP = 44095762;
const TOKEN = 40703223;
const FILLER = 15025844;
const monsters = [
  { code: MONSTER, name: "Main monster", type: 0x11 },
  { code: 23995346, name: "Fusion monster", type: 0x41 },
  { code: 44508094, name: "Synchro monster", type: 0x2021 },
  { code: 84013237, name: "Xyz monster", type: 0x800021 },
  { code: 1861629, name: "Link monster", type: 0x4000021 },
  { code: 16178681, name: "Pendulum monster", type: 0x1000011 },
];
let dataDirectory: string;
let db: Database.Database;
let host: DuelHost;
let duels: ReturnType<typeof createDuelService>;
let playerId: number;
const settings = { ...defaultDuelSettings("domain"), validateDeck: false, banlist: "none" as const };
const deck = (deckMaster: number): DuelDeck => ({ main: Array(5).fill(FILLER), extra: [], side: [], deckMaster });

beforeAll(() => {
  dataDirectory = createHostDataFixture([
    ...monsters,
    { code: SPELL, name: "Spell", type: 0x2 },
    { code: TRAP, name: "Trap", type: 0x4 },
    { code: TOKEN, name: "Token", type: 0x4011 },
    { code: FILLER, name: "Filler" },
    { code: 55144523, name: "Spell", type: 0x2, alias: SPELL },
  ]);
});
afterAll(() => rmSync(dataDirectory, { recursive: true, force: true }));
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  playerId = seedIdentity(db).playerId;
  duels = createDuelService(db);
  host = createDuelHost({ db, dataDirectory, secret: SECRET, searchCards: () => [],
    createWorker: vi.fn(() => { throw new Error("These tests must not start an engine"); }) });
});
afterEach(async () => { await host.close(); db.close(); });

async function post(body: Record<string, unknown>) {
  const raw = JSON.stringify({ guildId: "g", playerId, ...body });
  return host.handle(new Request("http://local/internal/duel", {
    method: "POST", body: raw,
    headers: { "x-announce-signature": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") },
  }));
}
function room(mode: DuelMode = "domain") {
  return duels.create({ guildId: "g", organizerPlayerId: playerId, name: "Master type", mode, settings });
}

describe("Domain Deck Master saves", () => {
  it.each([SPELL, TRAP])("rejects %s before room persistence, even with other deck errors", async code => {
    const session = room();
    const original = deck(MONSTER);
    duels.setDeck(session.slug, "g", playerId, original);
    const response = await post({ op: "deck", slug: session.slug, deck: { ...deck(code), main: Array(61).fill(FILLER) } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE });
    expect(duels.room(session.slug, "g", playerId).myDeck).toEqual(original);
  });

  it.each(monsters)("saves $name in a Domain room", async ({ code }) => {
    const session = room();
    const response = await post({ op: "deck", slug: session.slug, deck: deck(code) });
    expect(response.status).toBe(200);
    expect(duels.room(session.slug, "g", playerId).myDeck).toEqual(deck(code));
  });

  it.each([SPELL, TRAP])("rejects %s in the saved-deck type operation", async code => {
    const response = await post({ op: "validate-deck-master", mode: "domain", deck: deck(code) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE });
  });

  it.each(["deck", "validate-deck-master"])("%s checks the engine type after mapping a catalog import id", async op => {
    const session = room();
    const importCode = 900000001;
    // A stale catalog type must not override the engine's Spell type.
    db.prepare(`insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
      values (?, 'Spell', 'Effect Monster', 'effect', 'i', 's', '[]', '2020-01-01')`).run(importCode);
    const response = await post({ op, slug: session.slug, mode: "domain", deck: deck(importCode) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE });
    expect(duels.room(session.slug, "g", playerId).myDeck).toBeNull();
  });

  it("rejects a Spell artwork passcode", async () => {
    const response = await post({ op: "validate-deck-master", mode: "domain", deck: deck(55144523) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE });
  });

  it.each(monsters)("accepts $name in the saved-deck type operation", async ({ code }) => {
    const response = await post({ op: "validate-deck-master", mode: "domain", deck: deck(code) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("keeps the Token rejection", async () => {
    const response = await post({ op: "validate-deck-master", mode: "domain", deck: deck(TOKEN) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Deck Master must be a playable monster card" });
  });

  it.each([SPELL, TRAP])("ignores %s in Normal mode type checks", async code => {
    const response = await post({ op: "validate-deck-master", mode: "normal", deck: deck(code) });
    expect(response.status).toBe(200);
  });

  it.each([SPELL, TRAP])("keeps an ignored master %s in a casual Normal room", async code => {
    const session = room("normal");
    const response = await post({ op: "deck", slug: session.slug, deck: deck(code) });
    expect(response.status).toBe(200);
    expect(duels.room(session.slug, "g", playerId).myDeck).toEqual(deck(code));
  });
});

describe("old Domain Deck Masters", () => {
  it.each([SPELL, TRAP])("reports %s, blocks ready, and keeps the stored deck", async code => {
    const session = room();
    const original = deck(code);
    duels.setDeck(session.slug, "g", playerId, original);
    duels.markUnready(session.slug, "g", playerId);
    const expected = { message: MESSAGE, cards: [{ section: "deckMaster", index: 0, code, name: code === SPELL ? "Spell" : "Trap" }] };
    expect(inspectDeck("domain", original, dataDirectory, settings).issues).toContainEqual(expected);
    const checked = await post({ op: "validate-deck", slug: session.slug, deck: original });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ issues: [expected] });
    const ready = await post({ op: "ready", slug: session.slug });
    expect(ready.status).toBe(400);
    expect(await ready.json()).toEqual({ error: MESSAGE });
    const stored = duels.room(session.slug, "g", playerId);
    expect(stored.myDeck).toEqual(original);
    expect(stored.session.seats[0].ready).toBe(false);
  });

  it("keeps the legality message for a non-playable monster", () => {
    expect(inspectDeck("domain", deck(TOKEN), dataDirectory, settings).issues).toContainEqual({
      message: "Deck Master must be a playable monster card",
      cards: [{ section: "deckMaster", index: 0, code: TOKEN, name: "Token" }],
    });
  });

  it.each([SPELL, TRAP])("blocks series Ready for the current stored master %s", async code => {
    const opponent = seedIdentity(db).playerId;
    const series = createDuelSeriesService(db);
    const { duel, series: info } = series.createChallenge({
      guildId: "g", challengerPlayerId: playerId, opponentPlayerId: opponent,
      bestOf: 3, ranked: false, mode: "domain", settings,
    });
    const original = { ...deck(code), side: [FILLER] };
    duels.setDeck(duel.slug, "g", playerId, original);
    duels.setDeck(duel.slug, "g", opponent, { ...deck(MONSTER), side: [FILLER] });
    // Shared persistence simulates a match saved before host type enforcement.
    duels.activate(duel.slug, "g", playerId, ["1"], "fixture", null);
    duels.complete(duel.slug, "g", 0, "fixture");
    // The next game's deck can differ from the completed room's deck.
    db.prepare("update duel_seats set deck_json = ? where duel_id = ? and player_id = ?")
      .run(JSON.stringify({ ...original, deckMaster: MONSTER }), duel.id, playerId);
    const before = series.get(info.id, "g");
    expect(before.status).toBe("between_games");
    expect(before.sideReady).toEqual([false, false]);
    const response = await post({ op: "series-ready", slug: duel.slug });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE });
    expect(series.get(info.id, "g")).toEqual(before);
    expect(series.sideState(info.id, "g", playerId).currentDeck).toEqual(original);
  });

  it.each([SPELL, TRAP])("rejects master %s before a series side-deck write", async code => {
    const opponent = seedIdentity(db).playerId;
    const series = createDuelSeriesService(db);
    const { duel, series: info } = series.createChallenge({
      guildId: "g", challengerPlayerId: playerId, opponentPlayerId: opponent,
      bestOf: 3, ranked: false, mode: "domain", settings,
    });
    const original = { ...deck(MONSTER), side: [FILLER] };
    duels.setDeck(duel.slug, "g", playerId, original);
    duels.setDeck(duel.slug, "g", opponent, original);
    duels.activate(duel.slug, "g", playerId, ["1"], "fixture", null);
    duels.complete(duel.slug, "g", 0, "fixture");
    const response = await post({ op: "series-side", slug: duel.slug, deck: { ...deck(code), main: Array(61).fill(FILLER) } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE });
    expect(series.sideState(info.id, "g", playerId).currentDeck).toEqual(original);
  });
});
