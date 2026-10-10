import { seedIdentity, seedUser } from "./helpers/identity.js";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "@yugidraft/shared/db";
import type { DuelAnswer, DuelCardInfo, DuelDeck, DuelEngineView, DuelPrompt } from "@yugidraft/shared/duels";
import {
  createDuelSeriesService,
  createDuelService,
  createTournamentService,
} from "@yugidraft/shared/services";
import { normalizeImportedDeck } from "../src/deck-import.js";
import { createDuelHost, type DuelHost, type TournamentNotice } from "../src/host.js";
import { cardScriptHash } from "../src/card-script-hash.js";
import { loadCardDatabase } from "../src/cards.js";
import { buildPracticeBotDeck } from "../src/practice-bot.js";
import type { DuelGameWorker, GameOptions } from "../src/worker-client.js";
import { createHostDataFixture } from "./helpers/host-data-fixture.js";

let DATA: string;
beforeAll(() => {
  DATA = createHostDataFixture([
    ...Array.from({ length: 40 }, (_, i) => ({ code: 1000 + i, name: `Fixture Normal Monster ${i}` })),
    { code: 18144506, name: "Harpie's Feather Duster", type: 2 },
    { code: 46986414, name: "Dark Magician" },
    { code: 46986421, name: "Dark Magician", alias: 46986414 },
  ]);
});
afterAll(() => { rmSync(DATA, { recursive: true, force: true }); });

// Passes through to the real import; the spy shows which options the host asks for.
vi.mock("../src/deck-import.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deck-import.js")>();
  return { ...actual, normalizeImportedDeck: vi.fn(actual.normalizeImportedDeck) };
});

const SECRET = "duel-host-series-secret";
const GUILD = "g1";

function fakeView(viewer: number | null, result: DuelEngineView["result"]): DuelEngineView {
  const prompt: DuelPrompt | null =
    !result && viewer === 0
      ? { id: "p1", seat: 0, kind: "choice", title: "Main", options: [{ id: "pass", label: "Pass" }] }
      : null;
  const seat = (index: number) => ({
    seat: index,
    lp: 8000,
    hand: [{ controller: index, location: 1, sequence: 0, position: 2 }],
    deckCount: 35,
    extraCount: 0,
    extra: [],
    monsters: [],
    spells: [],
    graveyard: [],
    banished: [],
  });
  return {
    revision: 1,
    turn: 1,
    turnSeat: 0,
    phase: "main1",
    seats: [seat(0), seat(1)],
    prompt,
    chain: [],
    events: [],
    log: [],
    result,
  };
}

class FakeWorker implements DuelGameWorker {
  createdOptions: GameOptions | null = null;
  result: DuelEngineView["result"] = null;
  private stopped = false;

  get running() {
    return !this.stopped;
  }

  async create(options: GameOptions) {
    this.createdOptions = options;
  }

  async view(seat: number | null) {
    return fakeView(seat, this.result);
  }

  async answer(_seat: number, _promptId: string, _answer: DuelAnswer) {}

  async search(_query: string): Promise<DuelCardInfo[]> {
    return [];
  }

  async close() {
    this.stopped = true;
  }
}

const hosts: DuelHost[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (hosts.length > 0) {
    const host = hosts.pop();
    if (host) await host.close();
  }
  vi.unstubAllEnvs();
});

function insertPlayer(db: Database.Database, discordUserId: string, displayName: string) {
  return seedIdentity(db, { guildId: GUILD, name: displayName, userId: seedUser(db, discordUserId).userId, discordUserId: seedUser(db, discordUserId).discordUserId ?? discordUserId }).playerId;
}

function setup() {
  vi.stubEnv("DUEL_DATA_DIR", DATA);
  const db = new Database(":memory:");
  migrate(db);
  return {
    db,
    duels: createDuelService(db),
    series: createDuelSeriesService(db),
    tournaments: createTournamentService(db),
    p1: insertPlayer(db, "u1", "Yugi"),
    p2: insertPlayer(db, "u2", "Kaiba"),
    p3: insertPlayer(db, "u3", "Joey"),
  };
}

type App = ReturnType<typeof setup>;

function openHost(
  app: App,
  extra: {
    onChange?: (slug: string, guildId: string) => void | Promise<void>;
    notifyTournament?: (notice: TournamentNotice) => void | Promise<void>;
    pollIntervalMs?: number;
    createWorker?: () => FakeWorker;
  } = {},
) {
  const workers: FakeWorker[] = [];
  const host = createDuelHost({
    db: app.db,
    dataDirectory: DATA,
    secret: SECRET,
    searchCards: () => [],
    archiveAfterMs: 60 * 60 * 1000,
    idleWorkerMs: 60 * 60 * 1000,
    pollIntervalMs: extra.pollIntervalMs ?? 60 * 60 * 1000,
    createWorker: () => {
      const worker = extra.createWorker?.() ?? new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onChange: extra.onChange,
    notifyTournament: extra.notifyTournament,
  });
  hosts.push(host);
  return { host, workers };
}

async function post(host: DuelHost, body: Record<string, unknown>) {
  const raw = JSON.stringify({ guildId: GUILD, ...body });
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const response = await host.handle(
    new Request("http://localhost/internal/duel", {
      method: "POST",
      headers: { "content-type": "application/json", "x-announce-signature": signature },
      body: raw,
    }),
  );
  let data: any = null;
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

/** Lets queued host work (timers, sweeps, worker starts) finish under fake timers. */
async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1);
}

/** A legal deck with two side cards, so the between-games window keeps its 60 s deadline. */
function deckWithSide(reverse = false): DuelDeck {
  const base = buildPracticeBotDeck("normal", DATA);
  const main = reverse ? [...base.main].reverse() : base.main;
  return { main, extra: [], side: [base.main[0]!, base.main[1]!] };
}

function challenge(app: App, bestOf: 1 | 3) {
  return app.series.createChallenge({
    guildId: GUILD,
    challengerPlayerId: app.p1,
    opponentPlayerId: app.p2,
    bestOf,
    ranked: false,
    mode: "normal",
  });
}

/** Both players submit a deck through the host; the second one starts game 1. */
async function startChallenge(app: App, host: DuelHost, bestOf: 1 | 3) {
  const started = challenge(app, bestOf);
  await post(host, { op: "deck", slug: started.duel.slug, playerId: app.p1, deck: deckWithSide() });
  const second = await post(host, { op: "deck", slug: started.duel.slug, playerId: app.p2, deck: deckWithSide(true) });
  expect(second.status).toBe(200);
  return started;
}

/** Ends the live game through the host, like an engine result seen on a view request. */
async function endGame(host: DuelHost, worker: FakeWorker, slug: string, playerId: number, winnerSeat: number | null) {
  worker.result = { winnerSeat, reason: "test" };
  const view = await post(host, { op: "view", slug, playerId });
  expect(view.status).toBe(200);
  expect(view.data.session.status).toBe("completed");
}

function seatPlayer(app: App, slug: string, seat: number): number {
  const found = app.duels.get(slug, GUILD).seats.find((entry) => entry.seat === seat);
  if (!found || found.playerId === null) throw new Error("missing seat");
  return found.playerId;
}

function tournamentMatch(app: App, bestOf: 1 | 3, registeredDeck = deckWithSide()) {
  const tournament = app.tournaments.create(GUILD, "Cup", "single_elim", seedUser(app.db, "u3").userId, { bestOf });
  app.tournaments.join(tournament.id, app.p1);
  app.tournaments.join(tournament.id, app.p2);
  app.tournaments.start(tournament.id);
  const slot = app.db.prepare("select * from tournament_matches where tournament_id = ?").get(tournament.id) as Record<string, any>;
  const deck = JSON.stringify(registeredDeck);
  app.db.prepare("update tournament_participants set deck_json = ? where tournament_id = ?").run(deck, tournament.id);
  const started = app.series.startTournamentMatch({ guildId: GUILD, tournamentMatchId: slot.id, actorPlayerId: app.p1 });
  return { tournament, slot, started };
}

describe("series game lobby ops", () => {
  it("starts a challenge game when the second player submits a deck, with seat 0 first in the engine order", async () => {
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel } = challenge(app, 3);

    const first = await post(host, { op: "deck", slug: duel.slug, playerId: app.p1, deck: deckWithSide() });
    expect(first.status).toBe(200);
    expect(first.data.session.status).toBe("lobby");
    expect(workers).toHaveLength(0);

    const second = await post(host, { op: "deck", slug: duel.slug, playerId: app.p2, deck: deckWithSide(true) });
    expect(second.status).toBe(200);
    expect(second.data.session.status).toBe("active");
    expect(workers).toHaveLength(1);

    // The engine gives the first turn to seat 0, so the host must hand it the seat 0 player's deck.
    const seat0 = seatPlayer(app, duel.slug, 0);
    const expected = seat0 === app.p1 ? deckWithSide() : deckWithSide(true);
    expect(workers[0]!.createdOptions?.decks[0]?.main).toEqual(expected.main);
    expect(workers[0]!.createdOptions?.decks[1]?.main).not.toEqual(expected.main);
  });

  it("lets any seated player start a series game, but only the organizer start a plain duel", async () => {
    const app = setup();
    const { host } = openHost(app);
    const { duel } = challenge(app, 1);
    app.duels.setDeck(duel.slug, GUILD, app.p1, deckWithSide());
    app.duels.setDeck(duel.slug, GUILD, app.p2, deckWithSide(true));
    const started = await post(host, { op: "start", slug: duel.slug, playerId: app.p2 });
    expect(started.status).toBe(200);
    expect(started.data.session.status).toBe("active");

    const plain = app.duels.create({ guildId: GUILD, organizerPlayerId: app.p1, name: "Plain", mode: "normal" });
    app.duels.takeSeat(plain.slug, GUILD, app.p2);
    app.duels.setDeck(plain.slug, GUILD, app.p1, deckWithSide());
    app.duels.setDeck(plain.slug, GUILD, app.p2, deckWithSide(true));
    const refused = await post(host, { op: "start", slug: plain.slug, playerId: app.p2 });
    expect(refused.status).toBe(403);
  });

  it("uses ready for a tournament game, rejects a deck change and starts when both are ready", async () => {
    const app = setup();
    const { host, workers } = openHost(app);
    const { started } = tournamentMatch(app, 3);
    const slug = started.duel.slug;
    const [a, b] = started.series.playerIds;

    const deck = await post(host, { op: "deck", slug, playerId: a, deck: deckWithSide() });
    expect(deck.status).toBe(409);
    expect(deck.data.error).toBe("Tournament games use your registered deck");

    const first = await post(host, { op: "ready", slug, playerId: a });
    expect(first.status).toBe(200);
    expect(first.data.session.status).toBe("lobby");
    expect(workers).toHaveLength(0);

    const second = await post(host, { op: "ready", slug, playerId: b });
    expect(second.status).toBe(200);
    expect(second.data.session.status).toBe("active");
    expect(workers).toHaveLength(1);
    const locked = app.db.prepare("select count(*) as c from tournament_participants where deck_locked_at is not null").get() as { c: number };
    expect(locked.c).toBe(2);
  });

  it("rejects a deck for a casual game after game 1", async () => {
    const app = setup();
    const { host, workers } = openHost(app);
    const { series } = await startChallenge(app, host, 3);
    await endGame(host, workers[0]!, app.series.get(series.id, GUILD).currentDuelSlug!, app.p1, 0);
    const next = app.series.createNextGame(series.id, GUILD);
    expect(next.gameNumber).toBe(2);
    const refused = await post(host, { op: "deck", slug: next.slug, playerId: app.p1, deck: deckWithSide() });
    expect(refused.status).toBe(409);
  });
});

describe("series advance", () => {
  it("a new auto block cannot stop tournament game 1 before either player is ready", async () => {
    const app = setup();
    const { host, workers } = openHost(app);
    try {
      const code = 18144506;
      const deck = { ...deckWithSide(), main: [code, ...deckWithSide().main.slice(1)] };
      const { started } = tournamentMatch(app, 3, deck);
      app.db.prepare(`INSERT INTO card_script_auto_blocks
        (code, reason, blocked_at, distinct_duels, error_count, threshold, window_days, bundle_version, script_hash)
        VALUES (?, 'investigating', CURRENT_TIMESTAMP, 3, 3, 3, 7, 'test', ?)`)
        .run(code, cardScriptHash(loadCardDatabase(DATA), code));
      const details = await post(host, { op: "card-details", slug: started.duel.slug, playerId: app.p1, codes: [code] });
      expect(details.data.cards[0]).not.toHaveProperty("unavailableReason");
      const query = await post(host, { op: "card-query", slug: started.duel.slug, playerId: app.p1, cardQuery: { text: String(code) } });
      expect(query.data.cards[0]).not.toHaveProperty("unavailableReason");
      const fresh = await post(host, { op: "check-deck", playerId: app.p1, mode: "normal", deck });
      expect(fresh.data.report.issues.some((issue: { message: string }) => issue.message.includes("is unavailable"))).toBe(true);
      expect((await post(host, { op: "ready", slug: started.duel.slug, playerId: app.p1 })).status).toBe(200);
      expect((await post(host, { op: "ready", slug: started.duel.slug, playerId: app.p2 })).status).toBe(200);
      expect(workers).toHaveLength(1);
      expect(app.duels.get(started.duel.slug, GUILD)).toMatchObject({ status: "active", gameNumber: 1 });
    } finally { await host.close(); app.db.close(); }
  });

  it.each(["challenge", "tournament"] as const)("%s: a new auto block cannot stop games 2 and 3 or side decking", async kind => {
    const app = setup();
    const { host, workers } = openHost(app);
    const deck = { ...deckWithSide(), main: [18144506, ...deckWithSide().main.slice(1)] };
    const started = kind === "challenge" ? challenge(app, 3) : tournamentMatch(app, 3, deck).started;
    if (kind === "challenge") {
      await post(host, { op: "deck", slug: started.duel.slug, playerId: app.p1, deck });
      expect((await post(host, { op: "deck", slug: started.duel.slug, playerId: app.p2, deck })).status).toBe(200);
    }
    if (kind === "tournament") {
      await post(host, { op: "ready", slug: started.duel.slug, playerId: app.p1 });
      await post(host, { op: "ready", slug: started.duel.slug, playerId: app.p2 });
    }
    await endGame(host, workers[0]!, started.duel.slug, app.p1, app.duels.get(started.duel.slug, GUILD).seats.find(seat => seat.playerId === app.p1)!.seat);
    const code = 18144506;
    app.db.prepare(`INSERT INTO card_script_auto_blocks
      (code, reason, blocked_at, distinct_duels, error_count, threshold, window_days, bundle_version, script_hash)
      VALUES (?, 'investigating', CURRENT_TIMESTAMP, 3, 3, 3, 7, 'test', ?)`)
      .run(code, cardScriptHash(loadCardDatabase(DATA), code));
    const check = await post(host, { op: "check-deck", playerId: app.p1, mode: "normal", deck });
    expect(check.data.report.issues.some((issue: { message: string }) => issue.message.includes("is unavailable"))).toBe(true);
    const fresh = app.series.createChallenge({ guildId: GUILD, challengerPlayerId: app.p1, opponentPlayerId: app.p3, bestOf: 3, ranked: false, mode: "normal" });
    expect((await post(host, { op: "deck", slug: fresh.duel.slug, playerId: app.p1, deck })).status).toBe(400);
    const details = await post(host, { op: "card-details", slug: started.duel.slug, playerId: app.p1, codes: [code] });
    expect(details.data.cards[0]).not.toHaveProperty("unavailableReason");
    const sided = await post(host, { op: "series-side", slug: started.duel.slug, playerId: app.p1, deck });
    expect(sided.status).toBe(200);
    for (let gameNumber = 2; gameNumber <= 3; gameNumber++) {
      const previous = app.series.get(started.series.id, GUILD).currentDuelSlug!;
      await post(host, { op: "series-ready", slug: previous, playerId: app.p1 });
      const ready = await post(host, { op: "series-ready", slug: previous, playerId: app.p2 });
      expect(ready.status).toBe(200);
      const current = app.series.get(started.series.id, GUILD).currentDuelSlug!;
      expect(app.duels.get(current, GUILD)).toMatchObject({ status: "active", gameNumber });
      if (gameNumber === 2) await endGame(host, workers[1]!, current, app.p1, app.duels.get(current, GUILD).seats.find(seat => seat.playerId === app.p2)!.seat);
    }
    await host.close(); app.db.close();
  });

  it("starts the next game when the side deck window ends, with the loser in seat 0", async () => {
    vi.useFakeTimers();
    const app = setup();
    const changes: string[] = [];
    const { host, workers } = openHost(app, { onChange: (slug) => void changes.push(slug) });
    const { duel, series } = await startChallenge(app, host, 3);
    const winner = seatPlayer(app, duel.slug, 0);
    const loser = seatPlayer(app, duel.slug, 1);
    const lastDecks = new Map(duel.seats.map((seat) => [seat.playerId, app.duels.privateState(duel.slug, GUILD).decks[seat.seat]]));

    await endGame(host, workers[0]!, duel.slug, winner, 0);
    const between = app.series.get(series.id, GUILD);
    expect(between.status).toBe("between_games");
    expect(between.nextGameAt).not.toBeNull();
    expect(workers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    const after = app.series.get(series.id, GUILD);
    expect(after.status).toBe("active");
    expect(after.gameNumber).toBe(2);
    expect(after.currentDuelSlug).not.toBe(duel.slug);
    expect(workers).toHaveLength(2);
    const game2 = app.duels.get(after.currentDuelSlug!, GUILD);
    expect(game2.status).toBe("active");
    expect(seatPlayer(app, game2.slug, 0)).toBe(loser);
    const nextDecks = app.duels.privateState(game2.slug, GUILD).decks;
    for (const seat of game2.seats) expect(nextDecks[seat.seat]).toEqual(lastDecks.get(seat.playerId));
    expect(changes).toContain(duel.slug);
    expect(changes).toContain(game2.slug);
  });

  it.each([0, 1])("waits for both Ready clicks without Side Decks (loser seat %s)", async (loserSeat) => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const started = challenge(app, 3);
    const plain = buildPracticeBotDeck("normal", DATA);
    await post(host, { op: "deck", slug: started.duel.slug, playerId: app.p1, deck: plain });
    await post(host, { op: "deck", slug: started.duel.slug, playerId: app.p2, deck: plain });
    const winnerSeat = 1 - loserSeat;
    const winner = seatPlayer(app, started.duel.slug, winnerSeat);
    const loser = winner === app.p1 ? app.p2 : app.p1;
    await endGame(host, workers[0]!, started.duel.slug, winner, winnerSeat);
    await settle();
    expect(app.series.get(started.series.id, GUILD).sideReady).toEqual([false, false]);
    expect(workers).toHaveLength(1);
    const chosen = await post(host, { op: "series-first", slug: started.duel.slug, playerId: loser, choice: "first" });
    expect(chosen.status).toBe(200);
    expect(chosen.data.nextSlug).toBeNull();
    await settle();
    expect(workers).toHaveLength(1);
    await post(host, { op: "series-ready", slug: started.duel.slug, playerId: winner });
    const changed = await post(host, { op: "series-first", slug: started.duel.slug, playerId: loser, choice: "second" });
    expect(changed.data.nextSlug).toBeNull();
    await settle();
    expect(workers).toHaveLength(1);
    const ready = await post(host, { op: "series-ready", slug: started.duel.slug, playerId: loser });
    expect(ready.data.nextSlug).toBeTruthy();
    expect(workers).toHaveLength(2);
    expect(app.series.get(started.series.id, GUILD).gameNumber).toBe(2);
  });

  it("lets the loser choose second: the winner takes seat 0 and the loser seat 1", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    const winner = seatPlayer(app, duel.slug, 0);
    const loser = winner === app.p1 ? app.p2 : app.p1;
    await endGame(host, workers[0]!, duel.slug, winner, 0);
    expect(app.series.get(series.id, GUILD).firstChooser).toBe(app.series.get(series.id, GUILD).playerIds.indexOf(loser));

    const winnerTries = await post(host, { op: "series-first", slug: duel.slug, playerId: winner, choice: "second" });
    expect(winnerTries.status).toBe(403);
    const bad = await post(host, { op: "series-first", slug: duel.slug, playerId: loser, choice: "middle" });
    expect(bad.status).toBe(400);
    const stranger = await post(host, { op: "series-first", slug: duel.slug, playerId: app.p3, choice: "second" });
    expect(stranger.status).toBe(403);

    const chosen = await post(host, { op: "series-first", slug: duel.slug, playerId: loser, choice: "second" });
    expect(chosen.status).toBe(200);
    expect(chosen.data.series.firstChoice).toBe("second");
    // The side window is still open: nobody has clicked Ready yet.
    expect(chosen.data.nextSlug).toBeNull();
    await post(host, { op: "series-ready", slug: duel.slug, playerId: winner });
    const ready = await post(host, { op: "series-ready", slug: duel.slug, playerId: loser });
    expect(ready.data.series.status).toBe("active");
    expect(seatPlayer(app, ready.data.nextSlug, 0)).toBe(winner);
    expect(seatPlayer(app, ready.data.nextSlug, 1)).toBe(loser);
  });

  it("goes first by default when the loser never chooses and the window ends", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    const winner = seatPlayer(app, duel.slug, 0);
    const loser = winner === app.p1 ? app.p2 : app.p1;
    await endGame(host, workers[0]!, duel.slug, winner, 0);
    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    const after = app.series.get(series.id, GUILD);
    expect(after.gameNumber).toBe(2);
    expect(seatPlayer(app, after.currentDuelSlug!, 0)).toBe(loser);
  });

  it.each([0, 1])("uses the latest sided deck and choice at expiry with one player unready (loser seat %s)", async (loserSeat) => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    const loser = seatPlayer(app, duel.slug, loserSeat);
    const winner = seatPlayer(app, duel.slug, 1 - loserSeat);
    await endGame(host, workers[0]!, duel.slug, winner, 1 - loserSeat);
    await post(host, { op: "series-ready", slug: duel.slug, playerId: winner });
    const base = app.series.sideState(series.id, GUILD, loser).currentDeck;
    const sided: DuelDeck = { ...base, main: [base.side[1]!, ...base.main.slice(1)], side: [base.side[0]!, base.main[0]!] };
    const stored = await post(host, { op: "series-side", slug: duel.slug, playerId: loser, deck: sided });
    expect(stored.status).toBe(200);
    const chosen = await post(host, { op: "series-first", slug: duel.slug, playerId: loser, choice: "second" });
    expect(chosen.data.nextSlug).toBeNull();
    const loserIndex = series.playerIds.indexOf(loser);
    expect(chosen.data.series.sideReady[loserIndex]).toBe(false);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(workers).toHaveLength(2);
    const nextSlug = app.series.get(series.id, GUILD).currentDuelSlug!;
    expect(seatPlayer(app, nextSlug, 1)).toBe(loser);
    expect(app.duels.privateState(nextSlug, GUILD).decks[1]).toEqual(sided);
  });

  it.each([
    ["legacy", "pinned"],
    ["pinned", "legacy"],
  ] as const)("game 2 reads the Standard switch again after game 1 used %s and the switch changes to %s", async (firstEngine, nextEngine) => {
    vi.useFakeTimers();
    vi.stubEnv("DUEL_1V1_ENGINE", "legacy");
    vi.stubEnv("DUEL_STANDARD_1V1_ENGINE", firstEngine);
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    expect(workers[0]!.createdOptions?.engine).toBe(firstEngine);
    expect(app.duels.privateState(duel.slug, GUILD).setup?.engine).toBe(firstEngine);
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);

    vi.stubEnv("DUEL_STANDARD_1V1_ENGINE", nextEngine);
    expect((await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 })).status).toBe(200);
    const ready = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p2 });
    expect(ready.status).toBe(200);
    expect(workers).toHaveLength(2);
    expect(app.series.get(series.id, GUILD).gameNumber).toBe(2);
    expect(workers[1]!.createdOptions?.engine).toBe(nextEngine);
    expect(app.duels.privateState(ready.data.nextSlug, GUILD).setup?.engine).toBe(nextEngine);
    expect(app.duels.privateState(duel.slug, GUILD).setup?.engine).toBe(firstEngine);
  });

  it("series-ready advances when both players are ready and points a late caller at the new game", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);

    const stranger = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p3 });
    expect(stranger.status).toBe(403);

    const first = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    expect(first.status).toBe(200);
    expect(first.data.nextSlug).toBeNull();
    expect(first.data.series.status).toBe("between_games");
    expect(workers).toHaveLength(1);

    const second = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p2 });
    expect(second.status).toBe(200);
    expect(typeof second.data.nextSlug).toBe("string");
    expect(second.data.series.status).toBe("active");
    expect(workers).toHaveLength(2);
    expect(app.duels.get(second.data.nextSlug, GUILD).status).toBe("active");

    const late = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    expect(late.status).toBe(200);
    expect(late.data.nextSlug).toBe(second.data.nextSlug);
    await settle();
    expect(workers).toHaveLength(2);
    expect(app.series.get(series.id, GUILD).gameNumber).toBe(2);
  });

  it("never makes two games when two advances race", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);
    await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    const [one, two] = await Promise.all([
      post(host, { op: "series-ready", slug: duel.slug, playerId: app.p2 }),
      post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 }),
    ]);
    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(workers).toHaveLength(2);
    expect(app.series.get(series.id, GUILD).gameNumber).toBe(2);
  });

  it("series-unready: a swap after Ready (no save) keeps the next game from starting when the opponent readies", async () => {
    vi.useFakeTimers();
    const app = setup();
    const changes: string[] = [];
    const { host, workers } = openHost(app, { onChange: (slug) => void changes.push(slug) });
    const { duel, series } = await startChallenge(app, host, 3);
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);
    const p1Index = app.series.get(series.id, GUILD).playerIds.indexOf(app.p1);

    const ready = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    expect(ready.data.series.sideReady[p1Index]).toBe(true);

    // The side deck panel sends this on the player's first swap, before anything is saved.
    const stranger = await post(host, { op: "series-unready", slug: duel.slug, playerId: app.p3 });
    expect(stranger.status).toBe(403);
    changes.length = 0;
    const unready = await post(host, { op: "series-unready", slug: duel.slug, playerId: app.p1 });
    expect(unready.status).toBe(200);
    expect(unready.data.series.sideReady[p1Index]).toBe(false);
    expect(unready.data.nextSlug).toBeNull();
    expect(changes).toContain(duel.slug);

    const other = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p2 });
    expect(other.status).toBe(200);
    expect(other.data.nextSlug).toBeNull();
    await settle();
    expect(workers).toHaveLength(1);
    expect(app.series.get(series.id, GUILD)).toMatchObject({ status: "between_games", gameNumber: 1 });

    // Not ready already: nothing changes and no refresh goes out.
    changes.length = 0;
    const again = await post(host, { op: "series-unready", slug: duel.slug, playerId: app.p1 });
    expect(again.status).toBe(200);
    expect(changes).toEqual([]);

    const back = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    expect(typeof back.data.nextSlug).toBe("string");
    expect(workers).toHaveLength(2);

    // Too late: the next game exists, so the caller is pointed at it instead.
    const late = await post(host, { op: "series-unready", slug: duel.slug, playerId: app.p1 });
    expect(late.status).toBe(200);
    expect(late.data.nextSlug).toBe(back.data.nextSlug);
  });

  it("un-readies a player who sides after Ready, so the next game waits for their new deck", async () => {
    vi.useFakeTimers();
    const app = setup();
    const changes: string[] = [];
    const { host, workers } = openHost(app, { onChange: (slug) => void changes.push(slug) });
    const { duel, series } = await startChallenge(app, host, 3);
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);
    const p1Index = app.series.get(series.id, GUILD).playerIds.indexOf(app.p1);
    const before = app.series.sideState(series.id, GUILD, app.p1).currentDeck;
    // Swap the first main card for the second side card.
    const sided: DuelDeck = { ...before, main: [before.side[1]!, ...before.main.slice(1)], side: [before.side[0]!, before.main[0]!] };
    expect(sided).not.toEqual(before);

    const ready = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    expect(ready.status).toBe(200);
    expect(ready.data.series.sideReady[p1Index]).toBe(true);

    changes.length = 0;
    const side = await post(host, { op: "series-side", slug: duel.slug, playerId: app.p1, deck: sided });
    expect(side.status).toBe(200);
    expect(side.data.series.sideReady[p1Index]).toBe(false);
    // The opponent's view refreshes so it no longer shows this player as ready.
    expect(changes).toContain(duel.slug);

    const other = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p2 });
    expect(other.status).toBe(200);
    expect(other.data.nextSlug).toBeNull();
    expect(other.data.series.status).toBe("between_games");
    expect(other.data.series.sideReady[p1Index]).toBe(false);
    await settle();
    expect(workers).toHaveLength(1);
    expect(app.series.get(series.id, GUILD)).toMatchObject({ status: "between_games", gameNumber: 1 });

    // Ready again on the new deck: the next game starts with it.
    const again = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    expect(again.status).toBe(200);
    expect(typeof again.data.nextSlug).toBe("string");
    expect(workers).toHaveLength(2);
    const next = app.duels.get(again.data.nextSlug, GUILD);
    const seat = next.seats.find((entry) => entry.playerId === app.p1)!.seat;
    expect(app.duels.privateState(next.slug, GUILD).decks[seat]).toEqual(sided);
  });

  it("refreshes the room when a side save clears a Ready sent through another game slug meanwhile", async () => {
    vi.useFakeTimers();
    const app = setup();
    const changes: string[] = [];
    const { host, workers } = openHost(app, { onChange: (slug) => void changes.push(slug) });
    const { duel, series } = await startChallenge(app, host, 3);
    const seatOf = (slug: string, playerId: number) => app.duels.get(slug, GUILD).seats.find((entry) => entry.playerId === playerId)!.seat;
    await endGame(host, workers[0]!, duel.slug, app.p1, seatOf(duel.slug, app.p1));
    await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    const advanced = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p2 });
    const game2 = advanced.data.nextSlug as string;
    expect(typeof game2).toBe("string");
    // Player 2 takes game 2, so the series goes to a game 3 with two game slugs to send requests through.
    await endGame(host, workers[1]!, game2, app.p1, seatOf(game2, app.p2));
    expect(app.series.get(series.id, GUILD)).toMatchObject({ status: "between_games", currentDuelSlug: game2 });
    const p1Index = app.series.get(series.id, GUILD).playerIds.indexOf(app.p1);
    const before = app.series.sideState(series.id, GUILD, app.p1).currentDeck;
    const sided: DuelDeck = { ...before, main: [before.side[1]!, ...before.main.slice(1)], side: [before.side[0]!, before.main[0]!] };

    // Hold the side save inside deck normalization, after the host read the series (p1 not ready yet).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = vi.mocked(normalizeImportedDeck).getMockImplementation()!;
    vi.mocked(normalizeImportedDeck).mockImplementationOnce(async (...args) => {
      await gate;
      return real(...args);
    });
    const side = post(host, { op: "series-side", slug: game2, playerId: app.p1, deck: sided });
    await vi.advanceTimersByTimeAsync(1);

    // Requests queue per slug, so a Ready through game 1's slug runs while the save waits.
    const ready = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    expect(ready.status).toBe(200);
    expect(ready.data.series.sideReady[p1Index]).toBe(true);

    changes.length = 0;
    release();
    const saved = await side;
    expect(saved.status).toBe(200);
    expect(saved.data.series.sideReady[p1Index]).toBe(false);
    expect(changes).toContain(game2);
  });

  it("stores a sided deck between games and rejects it at other times", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    const base = deckWithSide();
    const sided: DuelDeck = { main: [base.side[1]!, ...base.main.slice(1)], extra: [], side: [base.side[0]!, base.side[0]!] };

    const early = await post(host, { op: "series-side", slug: duel.slug, playerId: app.p1, deck: sided });
    expect(early.status).toBe(409);

    await endGame(host, workers[0]!, duel.slug, app.p1, 0);
    const stranger = await post(host, { op: "series-side", slug: duel.slug, playerId: app.p3, deck: sided });
    expect(stranger.status).toBe(403);
    const stored = await post(host, { op: "series-side", slug: duel.slug, playerId: app.p1, deck: sided });
    expect(stored.status).toBe(200);
    expect(stored.data.series.id).toBe(series.id);
    expect(app.series.sideState(series.id, GUILD, app.p1).currentDeck).toEqual(sided);

    const illegal = await post(host, { op: "series-side", slug: duel.slug, playerId: app.p1, deck: { main: sided.main.slice(0, 5), extra: [], side: [] } });
    expect(illegal.status).toBe(400);
  });

  it("sides a locked tournament deck stored with an old artwork id", async () => {
    vi.useFakeTimers();
    const app = setup();
    const oldDeck = { ...deckWithSide(), side: [46986421, 46986414] };
    const { tournament, started } = tournamentMatch(app, 3, oldDeck);
    const { host, workers } = openHost(app);
    const { duel, series } = started;
    await post(host, { op: "ready", slug: duel.slug, playerId: app.p1 });
    await post(host, { op: "ready", slug: duel.slug, playerId: app.p2 });
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);
    expect(app.series.sideState(series.id, GUILD, app.p1).currentDeck).toEqual(oldDeck);

    const sided = { ...oldDeck, main: [46986414, ...oldDeck.main.slice(1)], side: [oldDeck.main[0]!, 46986414] };
    const saved = await post(host, { op: "series-side", slug: duel.slug, playerId: app.p1, deck: sided });
    expect(saved.status).toBe(200);
    expect(app.series.sideState(series.id, GUILD, app.p1)).toMatchObject({ currentDeck: sided, baseDeck: oldDeck });
    const registration = app.db.prepare("select deck_json, deck_locked_at from tournament_participants where tournament_id = ? and player_id = ?")
      .get(tournament.id, app.p1) as { deck_json: string; deck_locked_at: string | null };
    expect(JSON.parse(registration.deck_json)).toEqual(oldDeck);
    expect(registration.deck_locked_at).not.toBeNull();

    const extraCopy = { ...sided, side: [46986414, 46986421] };
    const rejected = await post(host, { op: "series-side", slug: duel.slug, playerId: app.p1, deck: extraCopy });
    expect(rejected.status).toBe(400);
    expect(rejected.data.error).toBe("A sided deck must use the same cards as your current deck");
    expect(app.series.sideState(series.id, GUILD, app.p1).currentDeck).toEqual(sided);
    expect(app.db.prepare("select deck_json, deck_locked_at from tournament_participants where tournament_id = ? and player_id = ?")
      .get(tournament.id, app.p1)).toEqual(registration);

    await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p1 });
    const next = await post(host, { op: "series-ready", slug: duel.slug, playerId: app.p2 });
    expect(next.status).toBe(200);
    const seat = app.duels.room(next.data.nextSlug, GUILD, app.p1).mySeat!;
    expect(workers[1]!.createdOptions?.decks[seat]).toEqual(sided);
  });

  it("keeps unresolved card codes while siding, like check-deck", async () => {
    // Both requests use the shared card-fetch rate timer. Let it run between lookups.
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);
    const before = app.series.sideState(series.id, GUILD, app.p1).currentDeck;
    const unknown = 999999999;
    const fetchStub = vi.fn(async () => new Response(
      JSON.stringify({ error: "No card matching your query was found in the database." }),
      { status: 400 },
    ));
    vi.stubGlobal("fetch", fetchStub);
    try {
      vi.mocked(normalizeImportedDeck).mockClear();
      const sided: DuelDeck = { ...before, main: [unknown, ...before.main.slice(1)] };
      const result = await post(host, { op: "series-side", slug: duel.slug, playerId: app.p1, deck: sided });
      // The code stays as sent, so the deck check names it; the stored deck does not change.
      expect(result.status).toBe(400);
      expect(result.data.error).toMatch(/Unknown card 999999999/);
      expect(app.series.sideState(series.id, GUILD, app.p1).currentDeck).toEqual(before);
      expect(vi.mocked(normalizeImportedDeck)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(normalizeImportedDeck).mock.calls[0]![3]).toEqual({ keepUnresolved: true });

      const check = await post(host, { op: "check-deck", playerId: app.p1, mode: "normal", deck: sided });
      expect(check.status).toBe(200);
      expect(check.data.deck.main[0]).toBe(unknown);
      expect(vi.mocked(normalizeImportedDeck).mock.calls[1]![3]).toEqual({ keepUnresolved: true });
      expect(fetchStub).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("backs off a series game that cannot start instead of retrying every tick", async () => {
    vi.useFakeTimers();
    const app = setup();
    // A preloaded deck with a card the engine does not know: both seats ready, the start always fails.
    const started = challenge(app, 3);
    const badDeck = deckWithSide();
    badDeck.main[0] = 999999999;
    app.duels.setDeck(started.duel.slug, GUILD, app.p1, badDeck);
    app.duels.setDeck(started.duel.slug, GUILD, app.p2, deckWithSide(true));
    const slug = started.duel.slug;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const changes: string[] = [];
    try {
      const { workers } = openHost(app, { pollIntervalMs: 30_000, onChange: (changed) => void changes.push(changed) });
      const attempts = () => warn.mock.calls.filter((call) => String(call[0]).includes("did not start")).length;
      await settle();
      expect(attempts()).toBe(1);
      expect(String(warn.mock.calls[0]![0])).toContain(slug);
      expect(String(warn.mock.calls[0]![0])).toContain("Unknown card 999999999");
      expect(changes.filter((changed) => changed === slug)).toHaveLength(1);

      // Ticks at 30 s are skipped; the 2nd attempt comes after 1 minute, the 3rd 5 minutes later.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts()).toBe(2);
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
      expect(attempts()).toBe(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts()).toBe(3);
      expect(changes.filter((changed) => changed === slug)).toHaveLength(3);
      // The 4th attempt waits the 15 minute cap.
      await vi.advanceTimersByTimeAsync(14 * 60_000 + 30_000);
      expect(attempts()).toBe(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts()).toBe(4);
      await vi.advanceTimersByTimeAsync(14 * 60_000 + 30_000);
      expect(attempts()).toBe(4);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts()).toBe(5);

      // A fixed deck starts at the next retry, and the entry is gone for good.
      app.duels.setDeck(slug, GUILD, app.p1, deckWithSide());
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await settle();
      expect(app.duels.get(slug, GUILD).status).toBe("active");
      expect(workers).toHaveLength(1);
      expect(attempts()).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });

  it("starts a due series and a waiting game after a host restart (tick recovery)", async () => {
    vi.useFakeTimers();
    const app = setup();
    // Game 1 ends with no host running, so no advance timer exists.
    const first = challenge(app, 3);
    app.duels.setDeck(first.duel.slug, GUILD, app.p1, deckWithSide());
    app.duels.setDeck(first.duel.slug, GUILD, app.p2, deckWithSide(true));
    app.duels.activate(first.duel.slug, GUILD, null, ["s"], "v", null);
    app.duels.complete(first.duel.slug, GUILD, 0, "done");
    expect(app.series.get(first.series.id, GUILD).status).toBe("between_games");

    // A second series has its next game waiting in lobby with both seats ready.
    const second = app.series.createChallenge({
      guildId: GUILD, challengerPlayerId: app.p1, opponentPlayerId: app.p3, bestOf: 3, ranked: false, mode: "normal",
    });
    app.duels.setDeck(second.duel.slug, GUILD, app.p1, deckWithSide());
    app.duels.setDeck(second.duel.slug, GUILD, app.p3, deckWithSide(true));
    app.duels.activate(second.duel.slug, GUILD, null, ["s"], "v", null);
    app.duels.complete(second.duel.slug, GUILD, 0, "done");
    const waiting = app.series.createNextGame(second.series.id, GUILD);
    expect(app.duels.get(waiting.slug, GUILD).status).toBe("lobby");

    const { workers } = openHost(app, { pollIntervalMs: 30_000 });
    await settle();
    expect(workers).toHaveLength(1);
    expect(app.duels.get(waiting.slug, GUILD).status).toBe("active");
    expect(app.series.get(first.series.id, GUILD).gameNumber).toBe(1);

    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    expect(app.series.get(first.series.id, GUILD).gameNumber).toBe(2);
    expect(workers).toHaveLength(2);
  });

  it("times a between-games series that is not due yet when the host boots, instead of waiting for the next sweep", async () => {
    vi.useFakeTimers();
    const app = setup();
    // Game 1 ends with no host running; the host then restarts a few seconds before the 60 s window ends.
    const first = challenge(app, 3);
    app.duels.setDeck(first.duel.slug, GUILD, app.p1, deckWithSide());
    app.duels.setDeck(first.duel.slug, GUILD, app.p2, deckWithSide(true));
    app.duels.activate(first.duel.slug, GUILD, null, ["s"], "v", null);
    app.duels.complete(first.duel.slug, GUILD, 0, "done");
    await vi.advanceTimersByTimeAsync(52_000);

    const { workers } = openHost(app, { pollIntervalMs: 30_000 });
    await settle();
    expect(app.series.get(first.series.id, GUILD).gameNumber).toBe(1);

    // The deadline passes 8 s after boot; the next sweep is 30 s after boot, so only a timer starts it on time.
    await vi.advanceTimersByTimeAsync(9_000);
    await settle();
    expect(app.series.get(first.series.id, GUILD).gameNumber).toBe(2);
    expect(workers).toHaveLength(1);
  });

  it("does not advance after the host closes", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const { duel, series } = await startChallenge(app, host, 3);
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);
    await host.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(app.series.get(series.id, GUILD).status).toBe("between_games");
    expect(workers).toHaveLength(1);
  });
});

describe("Best of 3 against the practice bot", () => {
  /** A Best of 3 table: the human's deck is in, the bot sits in the other seat, and game 1 runs. */
  async function startBotMatch(app: App, host: DuelHost, withSide = true) {
    const table = app.duels.create({ guildId: GUILD, organizerPlayerId: app.p1, name: "Bot", mode: "normal", bestOf: 3 });
    app.duels.setDeck(table.slug, GUILD, app.p1, withSide ? deckWithSide() : buildPracticeBotDeck("normal", DATA));
    app.duels.markReady(table.slug, GUILD, app.p1);
    expect((await post(host, { op: "add-bot", slug: table.slug, playerId: app.p1 })).status).toBe(200);
    const started = await post(host, { op: "start", slug: table.slug, playerId: app.p1 });
    expect(started.status).toBe(200);
    expect(started.data.session.status).toBe("active");
    return table;
  }
  const humanSeat = (app: App, slug: string) => app.duels.get(slug, GUILD).seats.find((seat) => !seat.isBot)!.seat;

  it.each(["first", "second"] as const)("a bot-ready opponent waits for the human after choosing %s with no Side Deck", async (choice) => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const table = await startBotMatch(app, host, false);
    await endGame(host, workers[0]!, table.slug, app.p1, 1 - humanSeat(app, table.slug));
    const chosen = await post(host, { op: "series-first", slug: table.slug, playerId: app.p1, choice });
    expect(chosen.data).toMatchObject({ nextSlug: null, series: { status: "between_games", sideReady: [false, true], firstChoice: choice } });
    await vi.advanceTimersByTimeAsync(59_000);
    await post(host, { op: "view", slug: table.slug, playerId: app.p1 });
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(workers).toHaveLength(2);
    const series = app.series.forDuel(table.id)!;
    expect(humanSeat(app, series.currentDuelSlug!)).toBe(choice === "first" ? 0 : 1);
  });

  it("gives game 2 a fresh decision bank and opening grace after side decking against the bot", async () => {
    vi.useFakeTimers();
    const app = setup();
    class OpeningWorker extends FakeWorker {
      async view(seat: number | null) {
        return { ...await super.view(seat), revision: 0 };
      }
    }
    const { host, workers } = openHost(app, { createWorker: () => new OpeningWorker() });
    const table = await startBotMatch(app, host);
    const firstClock = app.duels.privateState(table.slug, GUILD).clock!;
    expect(firstClock.startedAt).toBe(Date.now() + 8_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await endGame(host, workers[0]!, table.slug, app.p1, 1 - humanSeat(app, table.slug));
    await post(host, { op: "series-first", slug: table.slug, playerId: app.p1, choice: "first" });
    const ready = await post(host, { op: "series-ready", slug: table.slug, playerId: app.p1 });
    expect(ready.status).toBe(200);
    const nextSlug = ready.data.nextSlug as string;
    const next = app.duels.get(nextSlug, GUILD);
    expect(next.gameNumber).toBe(2);
    expect(next.status).toBe("active");
    const nextClock = app.duels.privateState(nextSlug, GUILD).clock!;
    expect(nextClock.remainingMs).toEqual(firstClock.remainingMs);
    expect(nextClock.activeSeat).toBe(humanSeat(app, nextSlug));
    expect(nextClock.startedAt).toBe(Date.now() + 8_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await post(host, { op: "view", slug: nextSlug, playerId: app.p1 });
    expect(app.duels.privateState(nextSlug, GUILD).clock).toEqual(nextClock);
  });

  it("keeps the match going after the bot wins: the human chooses, then game 2 starts with the bot", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const table = await startBotMatch(app, host);
    expect(app.duels.get(table.slug, GUILD).seriesId).not.toBeNull();

    const botSeat = 1 - humanSeat(app, table.slug);
    await endGame(host, workers[0]!, table.slug, app.p1, botSeat);
    const view = await post(host, { op: "view", slug: table.slug, playerId: app.p1 });
    expect(view.data.series).toMatchObject({ status: "between_games", wins: [0, 1], vsBot: true, sideReady: [false, true], firstChooser: 0, firstChoice: null });

    const chosen = await post(host, { op: "series-first", slug: table.slug, playerId: app.p1, choice: "second" });
    expect(chosen.status).toBe(200);
    expect(chosen.data.nextSlug).toBeNull();
    const ready = await post(host, { op: "series-ready", slug: table.slug, playerId: app.p1 });
    expect(ready.status).toBe(200);
    expect(typeof ready.data.nextSlug).toBe("string");
    const game2 = app.duels.get(ready.data.nextSlug, GUILD);
    expect(game2.status).toBe("active");
    expect(game2.gameNumber).toBe(2);
    expect(game2.seats.find((seat) => seat.seat === 0)!.isBot).toBe(true);
    expect(game2.seats.find((seat) => seat.seat === 1)!.playerId).toBe(app.p1);
    expect(workers).toHaveLength(2);
  });

  it("starts game 2 by itself when the window ends, with the beaten bot going first", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const table = await startBotMatch(app, host);
    await endGame(host, workers[0]!, table.slug, app.p1, humanSeat(app, table.slug));
    const between = await post(host, { op: "view", slug: table.slug, playerId: app.p1 });
    expect(between.data.series).toMatchObject({ status: "between_games", wins: [1, 0], firstChooser: 1, firstChoice: "first" });

    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    const after = app.series.get(between.data.series.id, GUILD);
    expect(after).toMatchObject({ status: "active", gameNumber: 2 });
    const game2 = app.duels.get(after.currentDuelSlug!, GUILD);
    expect(game2.status).toBe("active");
    expect(game2.seats.find((seat) => seat.seat === 0)!.isBot).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it("refuses a choice when the bot was the one choosing", async () => {
    vi.useFakeTimers();
    const app = setup();
    const { host, workers } = openHost(app);
    const table = await startBotMatch(app, host);
    await endGame(host, workers[0]!, table.slug, app.p1, humanSeat(app, table.slug));
    const refused = await post(host, { op: "series-first", slug: table.slug, playerId: app.p1, choice: "second" });
    expect(refused.status).toBe(403);
  });
});

describe("tournament notices", () => {
  it("tells the ws server about the slot and the finished tournament for a Best of 1", async () => {
    const app = setup();
    const notices: TournamentNotice[] = [];
    const { host, workers } = openHost(app, { notifyTournament: (notice) => void notices.push(notice) });
    const { tournament, started } = tournamentMatch(app, 1);
    const [a, b] = started.series.playerIds;
    await post(host, { op: "ready", slug: started.duel.slug, playerId: a });
    await post(host, { op: "ready", slug: started.duel.slug, playerId: b });
    await endGame(host, workers[0]!, started.duel.slug, a, 0);

    const slug = started.series.tournamentSlug!;
    expect(app.series.get(started.series.id, GUILD).status).toBe("completed");
    const row = app.db.prepare("select status from tournaments where id = ?").get(tournament.id) as { status: string };
    expect(row.status).toBe("completed");
    expect(notices).toEqual([
      { kind: "match-updated", slug },
      { kind: "completed", slug },
    ]);
  });

  it("sends only match-updated while a Best of 3 is open, and survives a failing notice", async () => {
    const app = setup();
    const notify = vi.fn(async () => {
      throw new Error("ws down");
    });
    const { host, workers } = openHost(app, { notifyTournament: notify });
    const { started } = tournamentMatch(app, 3);
    const [a, b] = started.series.playerIds;
    await post(host, { op: "ready", slug: started.duel.slug, playerId: a });
    await post(host, { op: "ready", slug: started.duel.slug, playerId: b });
    await endGame(host, workers[0]!, started.duel.slug, a, 0);

    expect(app.series.get(started.series.id, GUILD).status).toBe("between_games");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ kind: "match-updated", slug: started.series.tournamentSlug });
  });

  it("sends nothing for a casual series", async () => {
    const app = setup();
    const notify = vi.fn();
    const { host, workers } = openHost(app, { notifyTournament: notify });
    const { duel } = await startChallenge(app, host, 1);
    await endGame(host, workers[0]!, duel.slug, app.p1, 0);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("catalog ops", () => {
  it("check-deck returns the normalized deck and a report without a slug", async () => {
    const app = setup();
    const { host } = openHost(app);
    const legal = await post(host, { op: "check-deck", playerId: app.p1, deck: deckWithSide(), mode: "normal" });
    expect(legal.status).toBe(200);
    expect(legal.data.deck.main).toEqual(deckWithSide().main);
    expect(legal.data.report.issues).toEqual([]);

    const short = { main: deckWithSide().main.slice(0, 5), extra: [], side: [] };
    const illegal = await post(host, { op: "check-deck", playerId: app.p1, deck: short, mode: "normal" });
    expect(illegal.status).toBe(200);
    expect(illegal.data.report.issues.length).toBeGreaterThan(0);
  });

  it("check-deck rejects a bad mode and a bad master rule", async () => {
    const app = setup();
    const { host } = openHost(app);
    const mode = await post(host, { op: "check-deck", playerId: app.p1, deck: deckWithSide(), mode: "weird" });
    expect(mode.status).toBe(400);
    const rule = await post(host, { op: "check-deck", playerId: app.p1, deck: deckWithSide(), mode: "normal", masterRule: 9 });
    expect(rule.status).toBe(400);
  });

  it("normalize-codes keeps engine ids, maps unknown ids to null and checks its input", async () => {
    const app = setup();
    const { host } = openHost(app);
    const fetchStub = vi.fn(async () => new Response(
      JSON.stringify({ error: "No card matching your query was found in the database." }),
      { status: 400 },
    ));
    vi.stubGlobal("fetch", fetchStub);
    try {
      const known = deckWithSide().main[0]!;
      const unknown = 999999999;
      const result = await post(host, { op: "normalize-codes", playerId: app.p1, codes: [known, unknown] });
      expect(result.status).toBe(200);
      expect(result.data.codes).toEqual({ [known]: known, [unknown]: null });

      const tooMany = await post(host, { op: "normalize-codes", playerId: app.p1, codes: Array.from({ length: 1001 }, (_, i) => i + 1) });
      expect(tooMany.status).toBe(400);
      const bad = await post(host, { op: "normalize-codes", playerId: app.p1, codes: [1, -2] });
      expect(bad.status).toBe(400);
      const notList = await post(host, { op: "normalize-codes", playerId: app.p1, codes: "1" });
      expect(notList.status).toBe(400);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
