import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createDuelService, type DuelSetup } from "../../src/services/duels.js";
import type { DuelFormat } from "../../src/duels/index.js";
import { seedIdentity, seedUser } from "../helpers/identity.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const deck = (value: number) => ({ main: Array(40).fill(value), extra: [], side: [] });

function table(format: DuelFormat = "ffa4", values = [3, 1, 6, 4], botSeat?: number) {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db);
  const count = format === "ffa3" ? 3 : 4;
  const players = Array.from({ length: count + 1 }, (_, i) => seedIdentity(db, {
    guildId: "g", name: `Player ${i}`, ...seedUser(db, `u${i}`),
  }).playerId);
  const rollDie = vi.fn(() => values.shift()!);
  const duels = createDuelService(db, { rollDie });
  const session = duels.create({ guildId: "g", organizerPlayerId: players[0]!, name: "Dice", mode: "normal", format });
  for (let seat = 0; seat < count; seat++) {
    if (seat === botSeat) duels.addPracticeBot(session.slug, "g", players[0]!, deck(100 + seat), seat);
    else {
      if (seat) duels.takeSeat(session.slug, "g", players[seat]!, seat);
      duels.setDeck(session.slug, "g", players[seat]!, deck(100 + seat));
    }
  }
  return { db, duels, players, slug: session.slug, rollDie };
}

function serverSetup(): DuelSetup {
  return {
    firstTurnDraw: false,
    engineIdentity: {
      version: 1, coreFamily: "multi", mode: "normal", wasmHash: "a".repeat(64),
      wrapperVersion: "0.1.2", wrapperHash: "b".repeat(64), protocolVersion: "1",
      cardDatabaseHash: "c".repeat(64), cardRemapsHash: null, cardScriptsHash: "d".repeat(64),
      domainScriptHash: null, multiOverlayHash: "e".repeat(64), hostRuleVersion: "1",
    },

  };
}

describe("FFA opening seat move", () => {
  it("keeps validated server metadata through a dice setup rewrite", () => {
    const t = table();
    const saved = serverSetup();
    // A normal duel can carry a saved engine identity; forks cannot enter an opening.
    t.db.prepare("update duels set setup_json = ? where web_slug = ?").run(JSON.stringify(saved), t.slug);
    t.duels.startOpening(t.slug, "g", t.players[0]!, 1000);
    t.duels.settleOpening(t.slug, "g", 4000);
    const row = t.db.prepare("select setup_json from duels where web_slug = ?").get(t.slug) as { setup_json: string };
    expect(JSON.parse(row.setup_json)).toEqual(saved);
    expect(t.duels.privateState(t.slug, "g").setup).toEqual(saved);
    expect(createDuelService(t.db).privateState(t.slug, "g").setup).toEqual(saved);
  });

  it.each(["engineIdentity", "replayFork"] as const)("rejects caller-supplied %s without changing the saved setup", (key) => {
    const t = table();
    const saved = serverSetup();
    t.db.prepare("update duels set setup_json = ? where web_slug = ?").run(JSON.stringify(saved), t.slug);
    const changed = key === "engineIdentity" ? { ...saved.engineIdentity, wasmHash: "f".repeat(64) } : {};
    expect(() => t.duels.setSetup(t.slug, "g", { [key]: changed })).toThrow(
      key === "engineIdentity" ? "Recorded engine identity is immutable" : "Unknown duel setup field: replayFork",
    );
    const row = t.db.prepare("select setup_json from duels where web_slug = ?").get(t.slug) as { setup_json: string };
    expect(JSON.parse(row.setup_json)).toEqual(saved);
  });

  it("does not trust malformed stored identity or private fork metadata", () => {
    const t = table();
    const saved = serverSetup();
    t.db.prepare("update duels set setup_json = ? where web_slug = ?").run(JSON.stringify({
      ...saved, engineIdentity: { ...saved.engineIdentity, wasmHash: "invalid" },
      replayFork: { ...saved.replayFork, playerId: 9 },
    }), t.slug);
    expect(() => t.duels.privateState(t.slug, "g")).toThrow("Duel setup record is invalid");
  });

  it.each(["ffa3", "ffa4"] as const)("moves complete %s seat rows only at the last reveal deadline", (format) => {
    const t = table(format, format === "ffa3" ? [3, 1, 6] : [3, 1, 6, 4]);
    const before = t.duels.get(t.slug, "g");
    t.duels.startOpening(t.slug, "g", t.players[0]!, 1000);
    t.duels.settleOpening(t.slug, "g", 3999);
    expect(t.duels.get(t.slug, "g")).toEqual(before);
    t.duels.settleOpening(t.slug, "g", 4000);
    const order = format === "ffa3" ? [2, 0, 1] : [2, 3, 0, 1];
    expect(t.duels.get(t.slug, "g").seats.map((s) => s.playerId)).toEqual(order.map((i) => t.players[i]));
    const privateState = t.duels.privateState(t.slug, "g");
    expect(privateState.decks.map((d) => d.main[0])).toEqual(order.map((i) => 100 + i));
    for (const [seat, lobbySeat] of order.entries()) {
      expect(t.duels.room(t.slug, "g", t.players[lobbySeat]!)).toMatchObject({
        mySeat: seat, myDeck: deck(100 + lobbySeat), session: { seats: expect.any(Array) },
        opening: { phase: "start", order },
      });
    }
    const after = t.duels.get(t.slug, "g");
    t.duels.settleOpening(t.slug, "g", 9000);
    expect(t.duels.get(t.slug, "g")).toEqual(after);
    expect(t.rollDie).toHaveBeenCalledTimes(order.length);
  });

  it("keeps bots, readiness, decks, clocks and saved setup on their new seats", () => {
    const t = table("ffa4", [3, 1, 6, 4], 2);
    t.duels.setClock(t.slug, "g", { turn: 1, remainingMs: [1000, 2000, 3000, 4000], activeSeat: 3, startedAt: 100 });
    t.duels.setSetup(t.slug, "g", { presetId: "test", botPolicies: { "2": "scripted" }, surrenderedSeats: [1, 3], firstTurnDraw: false });
    t.duels.startOpening(t.slug, "g", t.players[0]!, 1000);
    t.duels.settleOpening(t.slug, "g", 4000);
    const state = t.duels.privateState(t.slug, "g");
    expect(state.session.seats[0]).toMatchObject({ seat: 0, playerId: null, isBot: true, ready: true });
    expect(state.decks[0]).toEqual(deck(102));
    expect(state.clock).toEqual({ turn: 1, remainingMs: [3000, 4000, 1000, 2000], activeSeat: 1, startedAt: 100 });
    expect(state.setup).toEqual({ presetId: "test", botPolicies: { "0": "scripted" }, surrenderedSeats: [3, 1], firstTurnDraw: false });
    // A new service after restart reads the same final setup and seat order.
    expect(createDuelService(t.db).privateState(t.slug, "g")).toEqual(state);
    t.duels.activate(t.slug, "g", t.players[0]!, ["seed"], "bundle", state.clock, state.setup);
    t.duels.complete(t.slug, "g", 2, "test");
    expect(t.duels.get(t.slug, "g").winnerPlayerId).toBe(t.players[0]);
  });

  it("rolls the same public view for players and spectators and freezes lobby edits", () => {
    const t = table("ffa3", [2, 2, 6, 1, 5]);
    const initial = t.duels.startOpening(t.slug, "g", t.players[0]!, 0);
    expect(t.duels.startOpening(t.slug, "g", t.players[0]!, 1000)).toEqual(initial);
    expect(t.rollDie).toHaveBeenCalledTimes(3);
    expect(() => t.duels.setDeck(t.slug, "g", t.players[1]!, deck(900))).toThrow(/fixed/);
    expect(() => t.duels.submitOpeningPick(t.slug, "g", 0, "rock", 1)).toThrow(/automatic/);
    expect(() => t.duels.submitOpeningChoice(t.slug, "g", 0, "first", 1)).toThrow(/automatic/);
    t.duels.settleOpening(t.slug, "g", 3000);
    const view = t.duels.room(t.slug, "g", t.players[0]!).opening!;
    expect(view).toMatchObject({ rounds: [{ round: 1, rolls: [2, 2, 6] }, { round: 2, rolls: [1, 5, null] }], order: [2, 1, 0] });
    const publicView = t.duels.room(t.slug, "g", t.players[3]!).opening!;
    expect({ ...publicView, serverNow: 0 }).toEqual({ ...view, serverNow: 0 });
    expect(t.duels.dueOpenings(5999, 10)).toEqual([]);
    expect(t.duels.dueOpenings(6000, 10)).toEqual([{ slug: t.slug, guildId: "g" }]);
  });

  it("rolls back the entire seat move if storing the settled opening fails", () => {
    const t = table();
    const before = t.duels.get(t.slug, "g");
    const initial = t.duels.startOpening(t.slug, "g", t.players[0]!, 1000);
    t.db.exec(`create trigger reject_settled before update of opening_json on duels
      when json_extract(new.opening_json, '$.phase') = 'start'
      begin select raise(abort, 'test failure'); end`);
    expect(() => t.duels.settleOpening(t.slug, "g", 4000)).toThrow(/test failure/);
    expect(t.duels.get(t.slug, "g")).toEqual(before);
    expect(t.duels.openingState(t.slug, "g")).toEqual(initial);
  });

  it.each(["parking", "placement"])("rolls back seats, clock, setup and opening when %s silently skips a row", (step) => {
    const t = table();
    t.duels.setClock(t.slug, "g", { turn: 1, remainingMs: [1000, 2000, 3000, 4000], activeSeat: 3, startedAt: 100 });
    t.duels.setSetup(t.slug, "g", { botPolicies: { "2": "scripted" }, surrenderedSeats: [1] });
    t.duels.startOpening(t.slug, "g", t.players[0]!, 1000);
    const before = t.duels.privateState(t.slug, "g");
    const initial = t.duels.openingState(t.slug, "g");
    t.db.exec(`create trigger skip_seat_move before update of seat on duel_seats
      when ${step === "parking" ? "old.seat = 0 and new.seat >= 4" : "new.seat = 3"}
      begin select raise(ignore); end`);
    expect(() => t.duels.settleOpening(t.slug, "g", 4000)).toThrow(/Dice seat move/);
    expect(t.duels.privateState(t.slug, "g")).toEqual(before);
    expect(t.duels.openingState(t.slug, "g")).toEqual(initial);
  });

  it("requires the organizer and rejects Tag openings", () => {
    const t = table();
    expect(() => t.duels.startOpening(t.slug, "g", t.players[1]!, 0)).toThrow(/organizer/);
    const tag = table("tag");
    expect(() => tag.duels.startOpening(tag.slug, "g", tag.players[0]!, 0)).toThrow();
  });
});
