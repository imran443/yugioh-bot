import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import type { ReplayForkSetup } from "../../src/duels/index.js";
import { createDuelService } from "../../src/services/duels.js";
import { seedIdentity } from "../helpers/identity.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const replayFork: ReplayForkSetup = {
  ownerUserId: 101, control: "all-manual",
  origin: { sourceSlug: "source", sourceVersion: "v1", frameId: "f0", step: 0, prefixCount: 0, prefixHash: "a".repeat(64),
    sourceSeats: [{ seat: 0, displayName: "A" }, { seat: 1, displayName: "B" }] },
};

function fixture(kind = "play", setup: unknown = null, format = "1v1") {
  const db = new Database(":memory:"); databases.push(db); migrate(db);
  const owner = seedIdentity(db, { userId: 101 });
  db.prepare(`insert into duels(guild_id,web_slug,name,organizer_player_id,mode,status,kind,setup_json,format)
    values('g','fixture','Fixture',?,'normal','active',?,?,?)`)
    .run(owner.playerId, kind, setup === null ? null : JSON.stringify(setup), format);
  return { db, owner, duels: createDuelService(db) };
}

describe("persisted duel kind and setup", () => {
  it("rejects an inconsistent play/setup pair before it can lose the fork metadata", () => {
    const db = new Database(":memory:"); databases.push(db); migrate(db);
    const owner = seedIdentity(db);
    const duels = createDuelService(db);
    const session = duels.create({ guildId: "g", organizerPlayerId: owner.playerId, name: "Play", mode: "normal" });
    db.prepare("update duels set setup_json = ? where id = ?").run(JSON.stringify({ replayFork }), session.id);
    expect(() => duels.get(session.slug, "g")).toThrow(/invalid/);
    expect(() => duels.privateState(session.slug, "g")).toThrow(/invalid/);
  });

  it("projects the stored kind without publishing private metadata", () => {
    const { duels } = fixture("replay-fork", { replayFork, engine: "legacy" });
    const session = duels.get("fixture", "g");
    expect(session.kind).toBe("replay-fork");
    expect(session).not.toHaveProperty("replayFork");
    expect(session).not.toHaveProperty("setup");
    expect(duels.privateState("fixture", "g").setup?.replayFork).toEqual(replayFork);
  });

  it.each([null, {}, { replayFork: { ...replayFork, control: "bot" } }, { replayFork, botPolicies: {} }])
    ("rejects invalid fork setup: %j", setup => {
      const { duels } = fixture("replay-fork", setup);
      expect(() => duels.get("fixture", "g")).toThrow(/invalid/);
      expect(() => duels.privateState("fixture", "g")).toThrow(/invalid/);
    });

  it("checks the origin seat count against the format", () => {
    const { duels } = fixture("replay-fork", { replayFork }, "ffa4");
    expect(() => duels.get("fixture", "g")).toThrow(/invalid/);
  });

  it.each([{ firstTurnDraw: "yes" }, { startupScripts: [1] }, { scriptErrorMode: "ignore" }, { engine: "unknown" }, { extraField: true }])
    ("rejects invalid saved fork engine rules: %j", rules => {
      const { duels } = fixture("replay-fork", { replayFork, ...rules });
      expect(() => duels.privateState("fixture", "g")).toThrow(/invalid/);
    });

  it("keeps creator and origin when a host setup update omits them", () => {
    const { duels } = fixture("replay-fork", { replayFork, engine: "legacy" });
    duels.setSetup("fixture", "g", { engine: "legacy", surrenderedSeats: [1] });
    expect(duels.privateState("fixture", "g").setup).toEqual({ replayFork, engine: "legacy", surrenderedSeats: [1] });
  });

  it.each([null, { replayFork: { ...replayFork, ownerUserId: 102 } },
    { replayFork: { ...replayFork, origin: { ...replayFork.origin, prefixCount: 1 } } },
    { botPolicies: { "1": "scripted" } }, { scenarioId: "scenario" }, { presetId: "preset" }])
    ("refuses to clear or change the fork mark and Manual setup: %j", setup => {
      const { duels } = fixture("replay-fork", { replayFork });
      expect(() => duels.setSetup("fixture", "g", setup)).toThrow();
      expect(duels.privateState("fixture", "g").setup?.replayFork).toEqual(replayFork);
    });

  it("accepts the unchanged metadata in a full saved-setup update", () => {
    const { duels } = fixture("replay-fork", { replayFork });
    duels.setSetup("fixture", "g", { replayFork, scriptErrorMode: "strict" });
    expect(duels.privateState("fixture", "g").setup).toEqual({ replayFork, scriptErrorMode: "strict" });
  });

  it("does not accept kind or fork setup through normal creation or activation", () => {
    const { duels, owner } = fixture();
    expect(() => duels.create({ guildId: "g", organizerPlayerId: owner.playerId, name: "Fake", mode: "normal", kind: "replay-fork" } as never)).toThrow();
    const lobby = duels.create({ guildId: "g", organizerPlayerId: owner.playerId, name: "Play", mode: "normal" });
    expect(() => duels.activate(lobby.slug, "g", owner.playerId, ["1", "2", "3", "4"], "v1", null, { replayFork })).toThrow();
  });
});
