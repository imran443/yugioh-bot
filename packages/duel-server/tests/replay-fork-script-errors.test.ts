import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createScriptErrorRecorder, topScriptErrors } from "../src/script-error-store.js";
import { createAutoBlockPolicy } from "../src/script-error-autoblock.js";
import { prodScriptErrors } from "../src/prod-script-errors.js";
import type { DuelScriptError } from "../src/script-errors.js";
import { seedIdentity } from "./helpers/identity.js";

const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); });
const error: DuelScriptError = { code: 10, scriptFile: "c10.lua", line: 1, message: "Fixture error", index: 1,
  mode: "normal", format: "1v1", engine: "pinned", scriptErrorMode: "tolerant", commandHash: "fixture-command" };
function fixture() {
  const db = new Database(":memory:"); dbs.push(db); migrate(db);
  const players = [101, 102].map(userId => seedIdentity(db, { userId, guildId: "error-isolation", name: "Creator" }));
  const insert = db.prepare("insert into duels(id,guild_id,web_slug,name,organizer_player_id,mode,status,kind) values(?,'error-isolation',?,'Fixture',?,'normal','active',?)");
  for (let id = 1; id <= 3; id++) {
    insert.run(id, `fork-${id}`, players[id % 2]!.playerId, "replay-fork");
    db.prepare("insert into duel_seats(duel_id,seat,player_id,is_bot,ready) values(?,0,?,0,1)").run(id, players[id % 2]!.playerId);
  }
  insert.run(4, "real-play", players[0]!.playerId, "play");
  const time = Date.parse("2026-10-10T12:00:00Z"), hash = "a".repeat(64);
  const policy = createAutoBlockPolicy(db, { bundleVersion: "fixture", scriptHash: () => hash, now: () => time });
  return { db, policy, time, hash };
}

describe("fork script error isolation", () => {
  it("tags fork diagnostics without writing production occurrences, counts or automatic blocks", () => {
    const app = fixture(), log = vi.fn(), record = createScriptErrorRecorder(app.db, log, app.policy);
    for (let id = 1; id <= 3; id++) expect(record(id, error)).toBe(true);
    expect(topScriptErrors(app.db)).toEqual([]);
    expect(app.db.prepare("select * from card_script_error_occurrences").all()).toEqual([]);
    expect(app.policy.entries()).toEqual([]);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([1, 2, 3].map(duelId =>
      expect.objectContaining({ event: "replay_fork_script_error", duelKind: "replay-fork", duelId, code: 10 })));
    const restarted = createScriptErrorRecorder(app.db, log, app.policy);
    expect(restarted(1, error)).toBe(true);
    expect(topScriptErrors(app.db)).toEqual([]);
    expect(restarted(4, error)).toBe(true);
    expect(topScriptErrors(app.db)).toEqual([expect.objectContaining({ code: 10, count: 1, last_duel_id: 4 })]);
  });

  it("ignores stored fork samples in production queries and block thresholds", () => {
    const app = fixture();
    const insert = app.db.prepare(`insert into card_script_error_occurrences
      (duel_id,command_hash,error_index,code,resolved_code,created_at,script_hash,script_error_mode,engine_kind)
      values(?,'fixture',1,10,10,?,?,'tolerant','pinned-normal')`);
    for (let id = 1; id <= 4; id++) insert.run(id, new Date(app.time).toISOString(), app.hash);
    app.policy.consider(10, app.hash, "pinned-normal");
    expect(app.policy.entries()).toEqual([]);
    const cards = { deckCard: (code: number) => ({ code, name: "Fixture card", alias: 0 }), readScript: () => "return 10" };
    const result = prodScriptErrors(app.db, cards, new Map(), app.time);
    expect(result.cards).toEqual([expect.objectContaining({ code: 10, distinctDuels: 1, errorCount: 1, autoBlocked: false })]);
  });
});
