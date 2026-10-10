import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as access from "../../src/services/index.js";
import { forkEventFixture } from "../helpers/replay-fork-events.js";

let app: ReturnType<typeof forkEventFixture>;
beforeEach(() => { app = forkEventFixture(); vi.stubEnv("OWNER_USER_IDS", "101,102"); });
afterEach(() => { app.db.close(); vi.unstubAllEnvs(); });
const claims = (slug: string, actor = app.owner, seat: number | null = 0) => ({ slug, guildId: actor.guildId, playerId: actor.playerId, seat });

it("allows only the current fork creator at identity seat 0", () => {
  expect(access.canReadDuel(app.db, claims(app.forkSlug))).toBe(true);
  for (const actor of [app.dev, app.alpha, app.sourcePlayer]) expect(access.canReadDuel(app.db, claims(app.forkSlug, actor))).toBe(false);
  for (const seat of [null, 1, 2, 3]) expect(access.canReadDuel(app.db, claims(app.forkSlug, app.owner, seat))).toBe(false);
  vi.stubEnv("OWNER_USER_IDS", "102");
  expect(access.canReadDuel(app.db, claims(app.forkSlug))).toBe(false);
});
it("checks the guild, player mapping and immutable kind/setup pair", () => {
  expect(access.canReadDuel(app.db, { ...claims(app.forkSlug), guildId: "other" })).toBe(false);
  expect(access.canReadDuel(app.db, { ...claims(app.forkSlug), playerId: 999 })).toBe(false);
  app.db.prepare("update duels set setup_json = '{}' where id = ?").run(app.forkId);
  expect(access.canReadDuel(app.db, claims(app.forkSlug))).toBe(false);
  expect(access.findDuelEventTarget(app.db, app.forkSlug, app.guildId)).toBeNull();
});
it("keeps ordinary public and private duel access and validates current seats", () => {
  expect(access.canReadDuel(app.db, claims(app.source.slug, app.alpha, null))).toBe(true);
  expect(access.canReadDuel(app.db, claims(app.source.slug, app.sourcePlayer))).toBe(true);
  expect(access.canReadDuel(app.db, claims(app.source.slug, app.alpha))).toBe(false);
  const privateDuel = app.duels.create({ guildId: app.guildId, organizerPlayerId: app.sourcePlayer.playerId,
    name: "Private", mode: "normal", settings: { visibility: "private" } });
  expect(access.canReadDuel(app.db, claims(privateDuel.slug, app.alpha, null))).toBe(false);
  const code = app.duels.room(privateDuel.slug, app.guildId, app.sourcePlayer.playerId).inviteCode!;
  app.duels.admit(privateDuel.slug, app.guildId, app.alpha.playerId, code);
  expect(access.canReadDuel(app.db, claims(privateDuel.slug, app.alpha, null))).toBe(true);
});
it("binds an invite to its stored id, guild, slug and URL", () => {
  const invite = { duelId: app.source.id, slug: app.source.slug, guildId: app.guildId, url: `https://duel.example/duels/${app.source.slug}` };
  expect(access.assertDuelInviteTarget(app.db, invite).kind).toBe("play");
  for (const change of [{ duelId: app.forkId, slug: app.forkSlug, url: `https://duel.example/duels/${app.forkSlug}` },
    { url: `https://duel.example/duels/${app.forkSlug}` }, { duelId: app.forkId }, { guildId: "other" }, { duelId: undefined }]) {
    expect(() => access.assertDuelInviteTarget(app.db, { ...invite, ...change })).toThrow();
  }
});

it("uses a readonly reader and rechecks owner access without changing rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "duel-access-test-"));
  const stored = forkEventFixture(join(directory, "test.sqlite"));
  const reader = access.createDuelAccessReader(join(directory, "test.sqlite"));
  try {
    const before = stored.db.serialize();
    const identity = { ...claims(stored.forkSlug), expiresAt: Date.now() + 60_000 };
    expect(reader.canReadDuel(identity)).toBe(true);
    expect(reader.findDuelEventTarget(stored.forkSlug, stored.guildId)).toMatchObject({ kind: "replay-fork", ownerUserId: 101 });
    vi.stubEnv("OWNER_USER_IDS", "102");
    expect(reader.canReadDuel(identity)).toBe(false);
    expect(stored.db.serialize()).toEqual(before);
    reader.close();
    expect(reader.canReadDuel(identity)).toBe(false);
  } finally { reader.close(); stored.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
it("fails closed when the database is missing", () => {
  const reader = access.createDuelAccessReader("/missing-fork-test/test.sqlite");
  try {
    expect(reader.canReadDuel({ ...claims(app.forkSlug), expiresAt: Date.now() + 60_000 })).toBe(false);
    expect(reader.findDuelEventTarget(app.forkSlug, app.guildId)).toBeNull();
  } finally { reader.close(); }
});
