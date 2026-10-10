import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { seatCountFor, type DuelDeck, type DuelFormat, type EngineIdentity, type ForkOrigin, type ReplaySource } from "../../src/duels/index.js";
import * as services from "../../src/services/index.js";
import { createDuelService } from "../../src/services/duels.js";
import { createDuelSeriesService } from "../../src/services/duel-series.js";
import { seedIdentity } from "../helpers/identity.js";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function deck(seat: number): DuelDeck {
  const start = seat * 1000 + 1;
  return { main: Array.from({ length: 40 }, (_, i) => start + i), extra: [start + 100], side: [start + 200], deckMaster: start + 300 };
}

function fixture(format: DuelFormat = "1v1", path = ":memory:") {
  const db = new Database(path); databases.push(db);
  db.pragma("foreign_keys = on"); db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000"); migrate(db);
  const actor = { guildId: "fork-test", ...seedIdentity(db, { guildId: "fork-test", userId: 101, playerId: 9, name: "Creator" }) };
  const players = Array.from({ length: seatCountFor(format) }, (_, i) => seedIdentity(db, { guildId: actor.guildId, userId: 201 + i, name: `Source ${i}` }));
  const duels = createDuelService(db);
  const session = duels.create({ guildId: actor.guildId, organizerPlayerId: players[0]!.playerId, name: "Private source", mode: "domain", format,
    settings: { visibility: "private", turnSeconds: 600, validateDeck: false, shuffleDeck: false, startingLP: 9000, startingHand: 4, drawPerTurn: 2 } });
  for (let seat = 0; seat < players.length; seat++) {
    if (seat > 0) {
      duels.admit(session.slug, actor.guildId, players[seat]!.playerId, duels.room(session.slug, actor.guildId, players[0]!.playerId).inviteCode!);
      duels.takeSeat(session.slug, actor.guildId, players[seat]!.playerId);
    }
    duels.setDeck(session.slug, actor.guildId, players[seat]!.playerId, deck(seat));
  }
  const identity: EngineIdentity = {
    version: 1, coreFamily: format === "1v1" ? "legacy" : "multi", mode: "domain", wasmHash: "a".repeat(64),
    wrapperVersion: "fixture-wrapper", wrapperHash: "b".repeat(64), protocolVersion: "fixture-protocol", cardDatabaseHash: "c".repeat(64),
    cardRemapsHash: null, cardScriptsHash: "d".repeat(64), domainScriptHash: "e".repeat(64),
    multiOverlayHash: format === "1v1" ? null : "f".repeat(64), hostRuleVersion: "fixture-rules",
  };
  duels.activateRecorded(session.slug, actor.guildId, players[0]!.playerId, ["1", "2", "3", "18446744073709551615"], "saved-bundle", null,
    { engine: "legacy", firstTurnDraw: true, scriptErrorMode: "strict", startupScripts: ["first script", "second script"],
      scenarioId: "old-scenario", presetId: "old-preset", botPolicies: { "1": "old-policy" } }, identity);
  const commands = [
    { storedSeq: 2, seat: 0, command: { promptId: "p1", revision: 1, answer: { choice: "go" }, note: "Saved note" } },
    { storedSeq: 8, seat: players.length - 1, command: { promptId: "chain-mode:off", revision: 2, answer: {} } },
    { storedSeq: 11, seat: 1, command: { promptId: "eliminate:4", revision: 2, answer: {} } },
    { storedSeq: 19, seat: 0, command: { promptId: "p2", revision: 3, answer: { choice: "end" } } },
  ];
  const insert = db.prepare("insert into duel_commands(duel_id,seq,seat,command_json) values(?,?,?,?)");
  for (const entry of commands) insert.run(session.id, entry.storedSeq, entry.seat, JSON.stringify(entry.command));
  duels.setSetup(session.slug, actor.guildId, { ...duels.privateState(session.slug, actor.guildId).setup!, surrenderedSeats: [players.length - 1] });
  duels.interrupt(session.slug, actor.guildId, "Fixture stopped");
  vi.stubEnv("OWNER_USER_IDS", "101,102");
  const sourceState = duels.privateState(session.slug, actor.guildId);
  const { engineIdentity, replayFork: _fork, ...sourceSetup } = sourceState.setup!;
  const source: ReplaySource = { session: sourceState.session, decks: sourceState.decks, seed: sourceState.seed as ReplaySource["seed"],
    bundleVersion: sourceState.bundleVersion!, commands: sourceState.commands, setup: sourceSetup, engineIdentity: engineIdentity! };
  const origin: ForkOrigin = { sourceSlug: session.slug, sourceVersion: "source-version-1", frameId: "frame-1", step: 1, prefixCount: 2,
    prefixHash: services.hashReplayForkPrefix(source.commands.slice(0, 2)), sourceSeats: source.session.seats.map(seat => ({ seat: seat.seat, displayName: seat.displayName })) };
  const input = { actor, requestId: "request-1", cursorDigest: "b".repeat(64), source, origin };
  const retry = { actor, requestId: input.requestId, cursorDigest: input.cursorDigest, sourceSlug: origin.sourceSlug, sourceVersion: origin.sourceVersion };
  return { db, actor, players, duels, source, input, retry, forks: services.createReplayForkService(db) };
}

function sourceRows(app: ReturnType<typeof fixture>) {
  return {
    duel: app.db.prepare("select * from duels where id = ?").get(app.source.session.id),
    seats: app.db.prepare("select * from duel_seats where duel_id = ? order by seat").all(app.source.session.id),
    commands: app.db.prepare("select * from duel_commands where duel_id = ? order by seq").all(app.source.session.id),
    grants: app.db.prepare("select * from duel_invite_grants where duel_id = ?").all(app.source.session.id),
    series: app.db.prepare("select * from duel_series order by id").all(), matches: app.db.prepare("select * from matches order by id").all(),
  };
}

describe("atomic replay fork storage", () => {
  it("exports a dedicated fork storage service", () => {
    expect(services).toHaveProperty("createReplayForkService", expect.any(Function));
    expect(services).toHaveProperty("hashReplayForkPrefix", expect.any(Function));
  });

  it.each(["1v1", "tag", "ffa3", "ffa4"] as const)("copies exact engine inputs and no source identities for %s", format => {
    const app = fixture(format), before = sourceRows(app);
    const { session, reused } = app.forks.create(app.input);
    expect(reused).toBe(false);
    expect(session).toMatchObject({ kind: "replay-fork", status: "active", organizerPlayerId: app.actor.playerId, mode: "domain", format,
      masterRule: 5, bestOf: 1, ranked: false, seriesId: null, gameNumber: null, winnerPlayerId: null, settings: { visibility: "private" } });
    expect(session.slug).not.toBe(app.source.session.slug);
    const state = app.duels.privateState(session.slug, app.actor.guildId);
    expect(state.decks).toEqual(app.source.decks);
    expect(state.seed).toEqual(app.source.seed);
    expect(state.bundleVersion).toBe(app.source.bundleVersion);
    expect(state.commands).toEqual(app.source.commands.slice(0, 2));
    expect(app.db.prepare("select seq,seat,command_json,created_at from duel_commands where duel_id = ? order by seq").all(session.id))
      .toEqual(app.db.prepare("select seq,seat,command_json,created_at from duel_commands where duel_id = ? order by seq limit 2").all(app.source.session.id));
    expect(state.setup).toEqual({ engine: "legacy", firstTurnDraw: true, scriptErrorMode: "strict", startupScripts: ["first script", "second script"],
      engineIdentity: app.source.engineIdentity, replayFork: { ownerUserId: app.actor.userId, control: "all-manual", origin: app.input.origin } });
    expect(session.settings).toEqual({ ...app.source.session.settings, visibility: "private" });
    expect(session.seats.map(seat => [seat.seat, seat.playerId, seat.isBot])).toEqual(
      Array.from({ length: seatCountFor(format) }, (_, seat) => [seat, seat === 0 ? app.actor.playerId : null, seat !== 0]));
    expect(app.db.prepare("select clock_json, opening_json, invite_code, series_id, game_number from duels where id = ?").get(session.id))
      .toEqual({ clock_json: null, opening_json: null, invite_code: null, series_id: null, game_number: null });
    expect(app.db.prepare("select * from duel_invite_grants where duel_id = ?").all(session.id)).toEqual([]);
    expect(session).not.toHaveProperty("setup");
    expect(sourceRows(app)).toEqual(before);
    expect(app.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps loss commands from the prefix without copying final surrendered seats", () => {
    const app = fixture("ffa4");
    app.input.origin.prefixCount = 3;
    app.input.origin.prefixHash = services.hashReplayForkPrefix(app.source.commands.slice(0, 3));
    const { session } = app.forks.create(app.input);
    const state = app.duels.privateState(session.slug, app.actor.guildId);
    expect(state.commands[2]!.command.promptId).toBe("eliminate:4");
    expect(state.setup?.surrenderedSeats).toBeUndefined();
  });

  it("copies the opening prefix and appends new commands after copied sequence gaps", () => {
    const app = fixture();
    const { session } = app.forks.create(app.input);
    app.duels.recordCommand(session.slug, app.actor.guildId, 1, { promptId: "chain-mode:always", revision: 2, answer: {} }, null);
    expect(app.duels.privateState(session.slug, app.actor.guildId).commands.map(entry => entry.storedSeq)).toEqual([2, 8, 9]);
    expect(app.duels.privateState(session.slug, app.actor.guildId).setup?.replayFork?.origin.prefixCount).toBe(2);
    const openingInput = { ...app.input, requestId: "opening", origin: { ...app.input.origin, frameId: "opening", step: 0, prefixCount: 0,
      prefixHash: services.hashReplayForkPrefix([]) } };
    const opening = app.forks.create(openingInput);
    expect(app.duels.privateState(opening.session.slug, app.actor.guildId).commands).toEqual([]);
  });

  it.each(["duel_seats", "duel_commands", "replay_fork_requests"])("rolls back the full fork on a %s insert failure", table => {
    const app = fixture(), before = sourceRows(app);
    const counts = ["duels", "duel_seats", "duel_commands", "replay_fork_requests"].map(name => app.db.prepare(`select count(*) as n from ${name}`).get());
    app.db.exec(`create trigger force_fork_failure before insert on ${table} begin select raise(abort, 'Forced insert failure'); end`);
    expect(() => app.forks.create(app.input)).toThrow("Forced insert failure");
    expect(["duels", "duel_seats", "duel_commands", "replay_fork_requests"].map(name => app.db.prepare(`select count(*) as n from ${name}`).get())).toEqual(counts);
    app.db.exec("drop trigger force_fork_failure");
    expect(sourceRows(app)).toEqual(before);
    expect(app.forks.create(app.input).reused).toBe(false);
  });

  it("never inserts an unmarked staging or lobby row", () => {
    const app = fixture();
    app.db.exec(`create table inserted_duels(kind text,status text);
      create trigger record_fork_insert after insert on duels begin insert into inserted_duels values(new.kind,new.status); end`);
    app.forks.create(app.input);
    expect(app.db.prepare("select * from inserted_duels").all()).toEqual([{ kind: "replay-fork", status: "active" }]);
  });

  it("returns one fork for repeated requests and checks each payload binding", () => {
    const app = fixture(), first = app.forks.create(app.input);
    expect(app.forks.create(app.input)).toEqual({ session: first.session, reused: true });
    expect(app.forks.retry(app.retry)).toEqual({ session: first.session, reused: true });
    expect(app.forks.retry({ ...app.retry, requestId: "new-key" })).toBeNull();
    for (const patch of [{ sourceSlug: "other" }, { sourceVersion: "other" }, { cursorDigest: "c".repeat(64) }]) {
      expect(() => app.forks.retry({ ...app.retry, ...patch })).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT", status: 409 }));
    }
    expect(app.db.prepare("select count(*) as n from duels where kind = 'replay-fork'").get()).toEqual({ n: 1 });
  });

  it("checks current creator access before reads and saved retries", () => {
    const app = fixture(), { session } = app.forks.create(app.input);
    const dev = seedIdentity(app.db, { guildId: app.actor.guildId, userId: 102 });
    expect(() => app.forks.privateState(session.slug, { ...app.actor, ...dev })).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => app.forks.retry({ ...app.retry, actor: { ...app.actor, userId: 102 } })).toThrowError(expect.objectContaining({ status: 404 }));
    vi.stubEnv("OWNER_USER_IDS", "102");
    expect(() => app.forks.privateState(session.slug, app.actor)).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => app.forks.retry(app.retry)).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => app.forks.create(app.input)).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("recovers copied state and returns a retry after the source was deleted", () => {
    const app = fixture(), first = app.forks.create(app.input);
    const saved = app.forks.privateState(first.session.slug, app.actor);
    app.db.prepare("delete from duels where id = ?").run(app.source.session.id);
    const restarted = services.createReplayForkService(app.db);
    expect(restarted.privateState(first.session.slug, app.actor)).toEqual(saved);
    expect(restarted.retry(app.retry)).toEqual({ session: first.session, reused: true });
    expect(restarted.create(app.input)).toEqual({ session: first.session, reused: true });
    expect(app.db.pragma("foreign_key_check")).toEqual([]);
  });

  it.each(["missing-prefix", "changed-prefix"])("refuses corrupt copied input at recovery: %s", corruption => {
    const app = fixture(), { session } = app.forks.create(app.input);
    if (corruption === "missing-prefix") app.db.prepare("delete from duel_commands where duel_id = ? and seq = 8").run(session.id);
    else app.db.prepare("update duel_commands set command_json = json_set(command_json,'$.answer.choice','different') where duel_id = ? and seq = 2").run(session.id);
    expect(() => app.forks.privateState(session.slug, app.actor)).toThrowError(expect.objectContaining({ code: "REPLAY_MISMATCH", status: 409 }));
  });

  it("uses distinct retry keys for different authorized creators", () => {
    const app = fixture(), first = app.forks.create(app.input);
    const dev = seedIdentity(app.db, { guildId: app.actor.guildId, userId: 102 });
    const actor = { ...app.actor, ...dev };
    expect(app.forks.retry({ ...app.retry, actor })).toBeNull();
    const second = app.forks.create({ ...app.input, actor });
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.seats[0]!.playerId).toBe(dev.playerId);
    expect(app.forks.retry({ ...app.retry, actor })?.session.id).toBe(second.session.id);
  });

  it.each(["seed", "deck", "commands", "rules", "setup", "identity", "status"])("rejects a source changed after detached validation: %s", field => {
    const app = fixture(), before = app.db.prepare("select count(*) as n from duels").get();
    if (field === "seed") app.db.prepare("update duels set seed_json = '[\"5\",\"6\",\"7\",\"8\"]' where id = ?").run(app.source.session.id);
    if (field === "deck") app.db.prepare("update duel_seats set deck_json = ? where duel_id = ? and seat = 0").run(JSON.stringify(deck(9)), app.source.session.id);
    if (field === "commands") app.db.prepare("delete from duel_commands where duel_id = ? and seq = 8").run(app.source.session.id);
    if (field === "rules") app.db.prepare("update duels set master_rule = 4 where id = ?").run(app.source.session.id);
    if (field === "setup") app.db.prepare("update duels set setup_json = json_set(setup_json,'$.firstTurnDraw',json('false')) where id = ?").run(app.source.session.id);
    if (field === "identity") app.db.prepare("update duels set setup_json = json_set(setup_json,'$.engineIdentity.wasmHash',?) where id = ?").run("0".repeat(64), app.source.session.id);
    if (field === "status") app.db.prepare("update duels set status = 'active' where id = ?").run(app.source.session.id);
    expect(() => app.forks.create(app.input)).toThrowError(expect.objectContaining({ code: "SOURCE_CHANGED", status: 409 }));
    expect(app.db.prepare("select count(*) as n from duels").get()).toEqual(before);
  });

  it.each(["seed", "hash", "count", "seat-count", "source", "request", "cursor", "journal-seat"])("rejects invalid internal persistence input: %s", field => {
    const app = fixture();
    if (field === "seed") app.input.source.seed = ["0", "2", "3", "4"];
    if (field === "hash") app.input.origin.prefixHash = "0".repeat(64);
    if (field === "count") app.input.origin.prefixCount = 9;
    if (field === "seat-count") app.input.origin.sourceSeats.pop();
    if (field === "source") app.input.origin.sourceSlug = "different";
    if (field === "request") app.input.requestId = "bad key";
    if (field === "cursor") app.input.cursorDigest = "bad";
    if (field === "journal-seat") app.input.source.commands[0]!.seat = 9;
    expect(() => app.forks.create(app.input)).toThrow();
    expect(app.db.prepare("select count(*) as n from duels where kind = 'replay-fork'").get()).toEqual({ n: 0 });
  });

  it("copies game-2 sided decks in the resolved seat order without series links", () => {
    const app = fixture(), series = createDuelSeriesService(app.db), guild = app.actor.guildId;
    const [p0, p1] = app.players;
    const game1 = series.createChallenge({ guildId: guild, challengerPlayerId: p0!.playerId, opponentPlayerId: p1!.playerId, mode: "normal", bestOf: 3, ranked: false });
    for (const [index, player] of app.players.entries()) app.duels.setDeck(game1.duel.slug, guild, player.playerId, deck(index));
    app.duels.activate(game1.duel.slug, guild, null, ["1", "2", "3", "4"], "game-2-bundle", null);
    app.duels.complete(game1.duel.slug, guild, game1.duel.seats.find(seat => seat.playerId === p0!.playerId)!.seat, "Fixture winner");
    const sided = deck(1); [sided.main[0], sided.side[0]] = [sided.side[0]!, sided.main[0]!];
    series.setSideDeck(game1.series.id, guild, p1!.playerId, sided);
    series.setFirstChoice(game1.series.id, guild, p1!.playerId, "first");
    for (const player of app.players) series.setSideReady(game1.series.id, guild, player.playerId);
    const game2 = series.createNextGame(game1.series.id, guild);
    app.duels.activate(game2.slug, guild, null, ["9", "8", "7", "6"], "game-2-bundle", null, { engine: "legacy" });
    app.duels.interrupt(game2.slug, guild, "Fixture stopped");
    const state = app.duels.privateState(game2.slug, guild);
    const source: ReplaySource = { session: state.session, decks: state.decks, seed: state.seed as ReplaySource["seed"], bundleVersion: state.bundleVersion!,
      commands: state.commands, setup: state.setup, engineIdentity: null };
    const origin = { ...app.input.origin, sourceSlug: game2.slug, sourceVersion: "game-2", frameId: "opening", step: 0, prefixCount: 0,
      prefixHash: services.hashReplayForkPrefix([]), sourceSeats: source.session.seats.map(seat => ({ seat: seat.seat, displayName: seat.displayName })) };
    const before = sourceRows(app);
    const { session } = app.forks.create({ ...app.input, source, origin });
    expect(state.session.gameNumber).toBe(2);
    expect(state.session.seats[0]!.playerId).toBe(p1!.playerId);
    expect(app.duels.privateState(session.slug, guild).decks).toEqual([sided, deck(0)]);
    expect(session).toMatchObject({ seriesId: null, gameNumber: null, bestOf: 1 });
    expect(sourceRows(app)).toEqual(before);
  });

  it("hashes the complete ordered prefix without depending on object key order", () => {
    const app = fixture(), prefix = app.source.commands.slice(0, 2);
    const reversedKeys = prefix.map(entry => ({ command: { answer: entry.command.answer, revision: entry.command.revision, promptId: entry.command.promptId,
      ...("note" in entry.command ? { note: entry.command.note } : {}) }, seat: entry.seat, storedSeq: entry.storedSeq }));
    expect(services.hashReplayForkPrefix(reversedKeys)).toBe(services.hashReplayForkPrefix(prefix));
    expect(services.hashReplayForkPrefix([...prefix].reverse())).not.toBe(services.hashReplayForkPrefix(prefix));
    expect(services.hashReplayForkPrefix(prefix.slice(0, 1))).not.toBe(services.hashReplayForkPrefix(prefix));
  });

  it("serializes concurrent requests from independent database connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "replay-fork-")); directories.push(directory);
    const path = join(directory, "fork.sqlite"), app = fixture("ffa4", path);
    const moduleUrl = new URL("../../src/services/replay-forks.ts", import.meta.url).href;
    const script = `import Database from 'better-sqlite3';
      const {createReplayForkService} = await import(${JSON.stringify(moduleUrl)});
      const db = new Database(process.argv[1]); db.pragma('foreign_keys=on'); db.pragma('busy_timeout=5000');
      const service = createReplayForkService(db); process.stdout.write('ready\\n');
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const result = service.create(JSON.parse(input)); db.close(); process.stdout.write(JSON.stringify(result)+'\\n');`;
    const children = Array.from({ length: 2 }, () => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], { env: { ...process.env } });
      let output = "", errors = "";
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", chunk => { output += chunk; if (output.startsWith("ready\n")) resolve(); });
        child.on("error", reject); child.on("exit", code => { if (code !== 0) reject(new Error(errors)); });
      });
      child.stderr.on("data", chunk => { errors += chunk; });
      const done = new Promise<{ session: { id: number }; reused: boolean }>((resolve, reject) => {
        child.on("error", reject); child.on("exit", code => {
          if (code !== 0) reject(new Error(errors));
          else { try { resolve(JSON.parse(output.split("\n")[1]!)); } catch (error) { reject(error); } }
        });
      });
      return { child, ready, done };
    });
    try {
      await Promise.all(children.map(child => child.ready));
      for (const { child } of children) child.stdin.end(JSON.stringify(app.input));
      const results = await Promise.all(children.map(child => child.done));
      expect(results[0]!.session.id).toBe(results[1]!.session.id);
      expect(results.map(result => result.reused).sort()).toEqual([false, true]);
      expect(app.db.prepare("select count(*) as n from duels where kind='replay-fork'").get()).toEqual({ n: 1 });
      expect(app.db.prepare("select count(*) as n from replay_fork_requests").get()).toEqual({ n: 1 });
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.allSettled(children.map(child => child.done));
    }
  }, 15_000);
});
