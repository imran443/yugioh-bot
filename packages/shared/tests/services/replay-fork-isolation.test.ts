import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { type DuelFormat, type ReplaySource, seatCountFor } from "../../src/duels/index.js";
import { createDuelService } from "../../src/services/duels.js";
import { createDuelSeriesService, createSeriesStore } from "../../src/services/duel-series.js";
import { createReplayForkService, hashReplayForkPrefix } from "../../src/services/replay-forks.js";
import { createMatchService } from "../../src/services/matches.js";
import { createLiveNowService } from "../../src/services/live-now.js";
import { createOpenNowService } from "../../src/services/open-now.js";
import { createTournamentService } from "../../src/services/tournaments.js";
import { createTournamentDuelService } from "../../src/services/tournament-duels.js";
import { seedIdentity } from "../helpers/identity.js";

const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); });
const deck = { main: [1, 2, 3], extra: [], side: [] };
function fixture(format: DuelFormat = "1v1") {
  const db = new Database(":memory:"); dbs.push(db); migrate(db);
  const guildId = "isolation-test";
  const owner = seedIdentity(db, { guildId, userId: 101, name: "Creator" });
  const dev = seedIdentity(db, { guildId, userId: 102, name: "Developer" });
  const actors = Array.from({ length: seatCountFor(format) }, (_, i) => seedIdentity(db, { guildId, userId: 201 + i, name: `Player ${i}` }));
  vi.stubEnv("OWNER_USER_IDS", "101,102");
  const duels = createDuelService(db), series = createDuelSeriesService(db);
  const session = duels.create({ guildId, organizerPlayerId: actors[0]!.playerId, name: "Source", mode: "normal", format, settings: { validateDeck: false, turnSeconds: 60 } });
  for (const [seat, actor] of actors.entries()) {
    if (seat) duels.takeSeat(session.slug, guildId, actor.playerId);
    duels.setDeck(session.slug, guildId, actor.playerId, deck);
  }
  duels.activate(session.slug, guildId, actors[0]!.playerId, ["1", "2", "3", "4"], "fixture", null, { firstTurnDraw: false });
  duels.interrupt(session.slug, guildId, "Source stopped");
  const state = duels.privateState(session.slug, guildId);
  const source: ReplaySource = { session: state.session, decks: state.decks, seed: ["1", "2", "3", "4"], bundleVersion: "fixture", commands: [], setup: state.setup, engineIdentity: null };
  const actor = { guildId, ...owner }, forks = createReplayForkService(db);
  const input = { actor, requestId: "isolation-1", cursorDigest: "b".repeat(64), source,
    origin: { sourceSlug: source.session.slug, sourceVersion: "v1", frameId: "opening", step: 0, prefixCount: 0, prefixHash: hashReplayForkPrefix([]),
      sourceSeats: source.session.seats.map(seat => ({ seat: seat.seat, displayName: seat.displayName })) } };
  const fork = forks.create(input).session;
  return { db, guildId, owner, dev, actors, actor, duels, series, source, fork, forks, input };
}
const protectedTables = ["duel_series", "matches", "point_awards", "player_ratings", "season_standings", "tournaments", "tournament_matches"];
function protectedRows(db: Database.Database) {
  return Object.fromEntries(protectedTables.map(table => [table, db.prepare(`select * from ${table} order by rowid`).all()]));
}
function sourceRows(app: ReturnType<typeof fixture>) {
  return ["duels", "duel_seats", "duel_commands"].map((table, index) => app.db.prepare(`select * from ${table} where ${index ? "duel_id" : "id"} = ?`).all(app.source.session.id));
}
function attachBadSeries(app: ReturnType<typeof fixture>) {
  const link = app.series.createChallenge({ guildId: app.guildId, challengerPlayerId: app.actors[0]!.playerId, opponentPlayerId: app.actors[1]!.playerId, mode: "normal", bestOf: 3, ranked: true });
  app.db.prepare("update duels set series_id = ?, game_number = 2 where id = ?").run(link.series.id, app.fork.id);
  return link.series.id;
}

describe("replay fork real-play isolation", () => {
  it.each(["1v1", "tag", "ffa3", "ffa4"] as const)("keeps %s results local and preserves real-play data", format => {
    const app = fixture(format), before = protectedRows(app.db), source = sourceRows(app);
    const result = app.duels.complete(app.fork.slug, app.guildId, 0, "Engine result");
    expect(result).toMatchObject({ status: "completed", winnerSeat: 0, winnerPlayerId: null, seriesId: null });
    expect(app.duels.complete(app.fork.slug, app.guildId, 1, "Retry")).toEqual(result);
    expect(app.duels.interrupt(app.fork.slug, app.guildId, "Retry")).toEqual(result);
    expect(protectedRows(app.db)).toEqual(before);
    expect(sourceRows(app)).toEqual(source);
    expect(app.forks.create(app.input)).toEqual({ session: result, reused: true });
    expect(createMatchService(app.db).stats(app.owner.playerId)).toEqual({ wins: 0, losses: 0 });
  });

  it.each(["complete", "interrupt", "cancel"] as const)("skips invalid series links on local %s and retry", operation => {
    const app = fixture(), seriesId = attachBadSeries(app), before = protectedRows(app.db), source = sourceRows(app);
    const run = () => operation === "complete" ? app.duels.complete(app.fork.slug, app.guildId, 1, "Surrender")
      : operation === "interrupt" ? app.duels.interrupt(app.fork.slug, app.guildId, "Engine failure")
      : app.duels.cancel(app.fork.slug, app.guildId, app.owner.playerId);
    const result = run(); expect(run()).toEqual(result);
    expect(result.winnerPlayerId).toBeNull();
    expect(protectedRows(app.db)).toEqual(before); expect(sourceRows(app)).toEqual(source);
    expect(app.series.dueNextGames(Date.now() + 120_000, 10).some(item => item.seriesId === seriesId)).toBe(false);
  });

  it("checks persisted kind in series hooks even if callers supply play metadata", () => {
    const app = fixture(), store = createSeriesStore(app.db), before = protectedRows(app.db);
    const row = app.db.prepare("select * from duels where id = ?").get(app.fork.id) as Parameters<typeof store.onActivate>[0];
    expect(() => store.onActivate({ ...row, kind: "play" } as typeof row, app.fork.settings)).toThrow(/fork/i);
    expect(protectedRows(app.db)).toEqual(before);
    const seriesId = attachBadSeries(app), linkedBefore = protectedRows(app.db);
    expect(() => store.onGameFinished({ id: app.fork.id, series_id: seriesId, game_number: 2 }, "completed", app.actors[0]!.playerId)).toThrow(/fork/i);
    expect(protectedRows(app.db)).toEqual(linkedBefore);
  });

  it("blocks series admission, side changes, cancel, next game, retries and sweeps with a linked fork", () => {
    const app = fixture(), seriesId = attachBadSeries(app);
    app.db.prepare("update duel_series set status = 'between_games', side_ready0 = 1, side_ready1 = 1, next_game_at = '2000-01-01' where id = ?").run(seriesId);
    const before = protectedRows(app.db);
    for (const work of [() => app.series.createNextGame(seriesId, app.guildId), () => app.series.cancel(seriesId, app.guildId),
      () => app.series.setSideDeck(seriesId, app.guildId, app.actors[0]!.playerId, deck),
      () => app.series.setSideReady(seriesId, app.guildId, app.actors[0]!.playerId),
      () => app.series.clearSideReady(seriesId, app.guildId, app.actors[0]!.playerId),
      () => app.series.setFirstChoice(seriesId, app.guildId, app.actors[0]!.playerId, "first")]) expect(work).toThrow(/fork/i);
    expect(app.series.dueNextGames(Date.now(), 10).some(item => item.seriesId === seriesId)).toBe(false);
    app.db.prepare("update duels set status = 'lobby' where id = ?").run(app.fork.id);
    app.db.prepare("update duel_series set status = 'active' where id = ?").run(seriesId);
    expect(app.series.dueStarts(10).some(item => item.slug === app.fork.slug)).toBe(false);
    app.db.prepare("update duel_series set status = 'completed', winner_player_id = ? where id = ?").run(app.actors[0]!.playerId, seriesId);
    const retryBefore = protectedRows(app.db);
    expect(createSeriesStore(app.db).retryResult(seriesId, app.guildId)).toMatchObject({ ok: false });
    expect(protectedRows(app.db)).toEqual(retryBefore);
    // Only the fixture's explicit changes are permitted.
    expect(app.db.prepare("select * from matches").all()).toEqual(before.matches);
  });

  it("refuses a confirmed result whose stored source is a fork", () => {
    const app = fixture(), matches = createMatchService(app.db), before = protectedRows(app.db);
    const input = { guildId: app.guildId, playerOneId: app.actors[0]!.playerId, playerTwoId: app.actors[1]!.playerId,
      winnerId: app.actors[0]!.playerId, source: "casual" as const, sourceDuelId: app.fork.id };
    expect(() => matches.recordConfirmedResult(input)).toThrow(/fork/i);
    expect(() => matches.recordConfirmedResult({ ...input, sourceDuelId: 99999 })).toThrow(/source/i);
    expect(() => matches.recordConfirmedResult({ ...input, guildId: "other" })).toThrow(/source/i);
    expect(protectedRows(app.db)).toEqual(before);
    expect(matches.recordConfirmedResult({ ...input, sourceDuelId: app.source.session.id })).toMatchObject({ status: "approved" });
  });

  it("refuses tournament links before an organizer result can alter the bracket", () => {
    const app = fixture(), tournaments = createTournamentService(app.db);
    const tournament = tournaments.create(app.guildId, "Cup", "single_elim", app.owner.userId);
    for (const player of app.actors) tournaments.join(tournament.id, player.playerId);
    tournaments.start(tournament.id);
    const slot = app.db.prepare("select id from tournament_matches where tournament_id = ?").get(tournament.id) as { id: number };
    const seriesId = attachBadSeries(app);
    app.db.prepare("update duel_series set tournament_match_id = ? where id = ?").run(slot.id, seriesId);
    const before = protectedRows(app.db);
    expect(() => createTournamentDuelService(app.db).setResultByOrganizer({ tournamentMatchId: slot.id, organizerUserId: app.owner.userId, winnerPlayerId: app.actors[0]!.playerId })).toThrow(/fork/i);
    expect(() => createMatchService(app.db).recordConfirmedResult({ guildId: app.guildId, playerOneId: app.actors[0]!.playerId,
      playerTwoId: app.actors[1]!.playerId, winnerId: app.actors[0]!.playerId, source: "tournament", tournamentMatchId: slot.id })).toThrow(/fork/i);
    expect(protectedRows(app.db)).toEqual(before);
  });

  it.each(["active", "completed", "interrupted"])("excludes %s forks from lists and discovery even for their creator", status => {
    const app = fixture();
    app.db.prepare("update duels set status = ?, archived_at = null where id = ?").run(status, app.fork.id);
    for (const player of [app.owner, app.dev, ...app.actors]) {
      for (const options of [undefined, { archived: true, scope: "all" as const }, { archived: true, scope: "mine" as const }]) {
        expect(app.duels.list(app.guildId, player.playerId, options).some(item => item.id === app.fork.id)).toBe(false);
      }
      const live = createLiveNowService(app.db);
      expect(live.forPlayer(app.guildId, player.playerId).yourDuel?.href).not.toBe(`/duels/${app.fork.slug}`);
      expect(live.countInProgress(app.guildId, player.playerId)).toBe(0);
      expect(createOpenNowService(app.db).forPlayer(app.guildId, player.playerId).duelsInProgress).toBe(0);
    }
  });

  it("requires current creator access for room reads and hides share/series/clock metadata", () => {
    const app = fixture();
    const room = app.duels.room(app.fork.slug, app.guildId, app.owner.playerId);
    expect(room).not.toHaveProperty("inviteCode"); expect(room.series).toBeNull(); expect(room.clock).toBeNull();
    for (const player of [app.dev, ...app.actors]) expect(() => app.duels.room(app.fork.slug, app.guildId, player.playerId)).toThrow();
    vi.stubEnv("OWNER_USER_IDS", "102");
    expect(() => app.duels.room(app.fork.slug, app.guildId, app.owner.playerId)).toThrow();
    expect(() => app.duels.cancel(app.fork.slug, app.guildId, app.owner.playerId)).toThrow();
    vi.stubEnv("OWNER_USER_IDS", "101");
    app.duels.complete(app.fork.slug, app.guildId, 0, "Done");
    vi.stubEnv("OWNER_USER_IDS", "");
    expect(() => app.duels.room(app.fork.slug, app.guildId, app.owner.playerId)).toThrow();
  });

  it("rejects all normal lobby writes and excludes corrupt clocks/openings from sweeps", () => {
    const app = fixture(), slug = app.fork.slug, guild = app.guildId, player = app.owner.playerId;
    app.db.prepare("update duels set status = 'lobby', invite_code = 'copied-code' where id = ?").run(app.fork.id);
    const before = sourceRows(app);
    for (const work of [() => app.duels.takeSeat(slug, guild, app.dev.playerId), () => app.duels.leave(slug, guild, player),
      () => app.duels.setDeck(slug, guild, player, deck), () => app.duels.markReady(slug, guild, player), () => app.duels.markUnready(slug, guild, player),
      () => app.duels.addPracticeBot(slug, guild, player, deck), () => app.duels.removePracticeBot(slug, guild, player),
      () => app.duels.admit(slug, guild, app.dev.playerId, "copied-code"),
      () => app.duels.startOpening(slug, guild, player, 0), () => app.duels.submitOpeningPick(slug, guild, 0, "rock", 0),
      () => app.duels.submitOpeningChoice(slug, guild, 0, "first", 0), () => app.duels.abortOpening(slug, guild),
      () => app.duels.activate(slug, guild, player, ["1", "2", "3", "4"], "fixture", null)]) expect(work).toThrow(/fork/i);
    app.db.prepare("update duels set opening_json = '{\"deadline\":0}' where id = ?").run(app.fork.id);
    expect(app.duels.dueOpenings(Date.now(), 10)).toEqual([]);
    expect(app.duels.settleOpening(slug, guild, Date.now())).toBeNull();
    app.db.prepare("update duels set status = 'active', clock_json = '{\"remainingMs\":[0,0],\"activeSeat\":0,\"startedAt\":0}' where id = ?").run(app.fork.id);
    expect(app.duels.dueClocks(Date.now(), 10)).toEqual([]);
    expect(() => app.duels.setClock(slug, guild, { remainingMs: [1000, 1000], activeSeat: 0, startedAt: 0, turn: 1 })).toThrow(/fork/i);
    expect(() => app.duels.recordCommand(slug, guild, 0, { promptId: "p1", revision: 1, answer: {} }, { remainingMs: [1000, 1000], activeSeat: 0, startedAt: 0, turn: 1 })).toThrow(/fork/i);
    expect(sourceRows(app)).toEqual(before);
  });

  it("still records ordinary ranked play results", () => {
    const app = fixture(), game = app.series.createChallenge({ guildId: app.guildId, challengerPlayerId: app.actors[0]!.playerId,
      opponentPlayerId: app.actors[1]!.playerId, mode: "normal", bestOf: 1, ranked: true, settings: { validateDeck: false } });
    for (const player of app.actors) app.duels.setDeck(game.duel.slug, app.guildId, player.playerId, deck);
    app.duels.activate(game.duel.slug, app.guildId, null, ["1", "2", "3", "4"], "fixture", null);
    const winnerSeat = app.duels.get(game.duel.slug, app.guildId).seats.find(seat => seat.playerId === app.actors[0]!.playerId)!.seat;
    app.duels.complete(game.duel.slug, app.guildId, winnerSeat, "Engine result");
    expect(app.series.get(game.series.id, app.guildId)).toMatchObject({ status: "completed", winnerPlayerId: app.actors[0]!.playerId });
    expect(createMatchService(app.db).stats(app.actors[0]!.playerId).wins).toBe(1);
    expect(app.db.prepare("select count(*) as n from point_awards").get()).toEqual({ n: 1 });
  });
});
