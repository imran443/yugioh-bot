import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { migrate } from "@yugidraft/shared/db";
import { createSavedDeckService } from "@yugidraft/shared/services";
import type { DuelDeck, DuelMode } from "@yugidraft/shared/duels";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), savedActor: vi.fn(), duelActor: vi.fn(), callDuelHost: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/duel-host", () => ({ requireDuelActor: mocks.duelActor, callDuelHost: mocks.callDuelHost }));
vi.mock("@/lib/saved-decks", async original => ({
  ...await original<typeof import("../../src/lib/saved-decks")>(),
  requireSavedDeckActor: mocks.savedActor,
  loadDeckRegistrations: () => [],
}));

import { POST } from "../../app/api/decks/route";
import { GET, PUT } from "../../app/api/decks/[id]/route";

const MESSAGE = "You can't use a Spell or Trap as your Deck Master.";
const SPELL = 55144522;
const TRAP = 44095762;
const MONSTER = 46986414;
const EXTRA = 23995346;
let db: Database.Database;
let decks: ReturnType<typeof createSavedDeckService>;
const deck = (deckMaster?: number): DuelDeck => ({ main: [], extra: [], side: [], ...(deckMaster === undefined ? {} : { deckMaster }) });
const request = (mode: DuelMode, deckMaster?: number) => new Request("http://test/api/decks", {
  method: "POST", body: JSON.stringify({ name: "Imported deck", mode, deck: deck(deckMaster) }),
});
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

beforeEach(() => {
  vi.resetAllMocks();
  db = new Database(":memory:");
  migrate(db);
  db.prepare("insert into users(id, username, display_name) values (1, 'owner', 'Owner')").run();
  decks = createSavedDeckService(db);
  mocks.getDb.mockReturnValue(db);
  mocks.savedActor.mockResolvedValue({ ok: true, guildId: "g", ownerUserId: 1, discordUserId: null, decks });
  mocks.duelActor.mockResolvedValue({ ok: true, guildId: "g", playerId: 7 });
  mocks.callDuelHost.mockImplementation(async ({ deck: value }: { deck: DuelDeck }) =>
    value.deckMaster === SPELL || value.deckMaster === TRAP
      ? { ok: false, response: NextResponse.json({ error: MESSAGE }, { status: 400 }) }
      : { ok: true, data: { ok: true } });
});
afterEach(() => db.close());

describe("saved Domain Deck Master types", () => {
  it.each([SPELL, TRAP])("rejects %s on create, including an imported deck", async code => {
    const response = await POST(request("domain", code));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE });
    expect(decks.list("g", 1)).toEqual([]);
    expect(mocks.callDuelHost).toHaveBeenCalledWith({
      op: "validate-deck-master", guildId: "g", playerId: 7, mode: "domain", deck: deck(code),
    });
  });

  it.each([SPELL, TRAP])("rejects %s on update and keeps the stored deck", async code => {
    const saved = decks.create("g", 1, { name: "Original", mode: "domain", deck: deck(MONSTER) });
    const response = await PUT(request("domain", code), params(saved.id));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE });
    expect(decks.get(saved.id, "g", 1)).toEqual(saved);
  });

  it.each([MONSTER, EXTRA])("accepts monster %s on create and update", async code => {
    const created = await POST(request("domain", code));
    expect(created.status).toBe(201);
    const { deck: saved } = await created.json();
    const updated = await PUT(request("domain", code), params(saved.id));
    expect(updated.status).toBe(200);
    expect(decks.get(saved.id, "g", 1).deck.deckMaster).toBe(code);
  });

  it.each([SPELL, TRAP])("keeps an ignored master %s available in Normal mode", async code => {
    const created = await POST(request("normal", code));
    expect(created.status).toBe(201);
    const { deck: saved } = await created.json();
    expect((await PUT(request("normal", code), params(saved.id))).status).toBe(200);
    expect(mocks.duelActor).not.toHaveBeenCalled();
    expect(mocks.callDuelHost).not.toHaveBeenCalled();
  });

  it("saves an incomplete Domain deck without a master", async () => {
    expect((await POST(request("domain"))).status).toBe(201);
    expect(mocks.callDuelHost).not.toHaveBeenCalled();
  });

  it("returns a host failure and does not save an unchecked master", async () => {
    mocks.callDuelHost.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Host unavailable" }, { status: 503 }) });
    const response = await POST(request("domain", MONSTER));
    expect(response.status).toBe(503);
    expect(decks.list("g", 1)).toEqual([]);
  });

  it("does not save a master when the host response is invalid", async () => {
    mocks.callDuelHost.mockResolvedValue({ ok: true, data: {} });
    const response = await POST(request("domain", MONSTER));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Invalid engine response" });
    expect(decks.list("g", 1)).toEqual([]);
  });

  it("checks saved deck ownership before the host lookup", async () => {
    const response = await PUT(request("domain", SPELL), params(999));
    expect(response.status).toBe(404);
    expect(mocks.callDuelHost).not.toHaveBeenCalled();
  });

  it("keeps an old bad master readable without a host call or data change", async () => {
    const saved = decks.create("g", 1, { name: "Old", mode: "domain", deck: deck(SPELL) });
    const response = await GET(new Request("http://test/api/decks/1"), params(saved.id));
    expect(response.status).toBe(200);
    expect((await response.json()).deck.deck).toEqual(deck(SPELL));
    expect(decks.get(saved.id, "g", 1)).toEqual(saved);
    expect(mocks.callDuelHost).not.toHaveBeenCalled();
  });
});
