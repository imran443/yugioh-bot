import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import type { DuelReplayV2 } from "@yugidraft/shared/duels";
import { createDuelHost, type DuelHost } from "../src/host.js";
import { EngineResourceUnavailableError } from "../src/engine-resource-resolver.js";
import { createReplayCursorCodec } from "../src/replay-cursor.js";
import { seedIdentity } from "./helpers/identity.js";
import { ReplayWorker, replaySource } from "./support/replay-fixtures.js";

const resourceRead = vi.hoisted(() => vi.fn());
vi.mock("../src/engine-resource-resolver.js", async original => ({
  ...await original<typeof import("../src/engine-resource-resolver.js")>(), resolveEngineResourcesForSource: resourceRead,
}));
const secret = "host-replay-test-secret";
let db: Database.Database; let dir: string; let host: DuelHost; let slug: string;
let workers: ReplayWorker[]; let onChange: ReturnType<typeof vi.fn<(slug: string, guildId: string) => void>>;
const owner = { guildId: "test-guild", playerId: 61, userId: 101 };
beforeEach(() => {
  vi.stubEnv("OWNER_USER_IDS", "101,102");
  db = new Database(":memory:"); migrate(db);
  dir = mkdtempSync(join(tmpdir(), "host-replay-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ bundleVersion: "test-bundle" }));
  resourceRead.mockReset().mockReturnValue({ dataDirectory: dir, bundleVersion: "test-bundle" });
  for (const [playerId, userId] of [[61, 101], [62, 102], [63, 103], [64, 201], [65, 202]]) {
    seedIdentity(db, { guildId: owner.guildId, playerId, userId });
  }
  const duels = createDuelService(db);
  const session = duels.create({ guildId: owner.guildId, organizerPlayerId: 64, name: "Replay source", mode: "normal" });
  slug = session.slug; duels.takeSeat(slug, owner.guildId, 65, 1);
  const source = replaySource();
  db.prepare("update duel_seats set deck_json = ?, ready = 1 where duel_id = ?").run(JSON.stringify(source.decks[0]), session.id);
  db.prepare("update duels set status = 'interrupted', seed_json = ?, bundle_version = ?, setup_json = ?, ended_at = datetime('now'), result_reason = 'Interrupted' where id = ?")
    .run(JSON.stringify(source.seed), source.bundleVersion, JSON.stringify(source.setup), session.id);
  for (const entry of source.commands) db.prepare("insert into duel_commands(duel_id, seq, seat, command_json) values(?,?,?,?)")
    .run(session.id, entry.storedSeq, entry.seat, JSON.stringify(entry.command));
  workers = []; onChange = vi.fn();
  host = createDuelHost({ db, dataDirectory: dir, secret, searchCards: () => [], pollIntervalMs: 60_000, onChange,
    createWorker: () => { const worker = new ReplayWorker(); workers.push(worker); return worker; } });
});
afterEach(async () => { await host.close(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function post(input: Record<string, unknown>, signed = true) {
  const raw = JSON.stringify({ op: "replay", slug, guildId: owner.guildId, playerId: 64, ...input });
  const response = await host.handle(new Request("http://localhost/internal/duel", { method: "POST", body: raw,
    headers: { "x-announce-signature": signed ? "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") : "bad" } }));
  return { response, body: await response.json() as DuelReplayV2 & { code?: string; finalBoard?: string } };
}
const rows = () => [db.prepare("select * from duels").all(), db.prepare("select * from duel_commands").all(),
  db.prepare("select * from duel_seats").all(), db.prepare("select * from duel_series").all(), db.prepare("select * from duel_invite_grants").all()];

it("keeps v1 and provides public/mine v2 without private counts or owner flags", async () => {
  const before = rows();
  const v1 = await post({}); expect(v1.response.status).toBe(200); expect(v1.body).not.toHaveProperty("version");
  const mine = await post({ version: 2 }); expect(mine.response.status).toBe(200);
  expect(mine.body).toMatchObject({ version: 2, visibility: "mine", mySeat: 0, dataSeat: 0 });
  expect(mine.body).not.toHaveProperty("capabilities");
  const publicView = await post({ version: 2, visibility: "public" });
  expect(publicView.body).toMatchObject({ visibility: "public", mySeat: 0, dataSeat: null });
  expect(publicView.body.frames[0]!.view.seats[0]!.hand[0]!.code).toBeUndefined();
  expect(publicView.body.frames.map(f => f.frameId)).toEqual(mine.body.frames.map(f => f.frameId));
  const ordinary = JSON.stringify(publicView.body);
  for (const field of ["prefixCount", "storedSeq", "promptId", "chainMode", "seed", "deck_json"]) expect(ordinary).not.toContain(field);
  expect(rows()).toEqual(before); expect(onChange).not.toHaveBeenCalled();
  expect(db.prepare("select * from card_script_error_occurrences").all()).toEqual([]);
});
it.each(["seat", "reveal", "as"])("rejects normal %s overrides even for an owner", async field => {
  const result = await post({ playerId: owner.playerId, version: 2, [field]: 0 });
  expect(result.response.status).toBe(400); expect(workers).toHaveLength(0);
});
it("lets an owner read a private bug-report source without a seat or invite; defaults to public", async () => {
  db.prepare("update duels set settings_json = json_set(settings_json, '$.visibility', 'private') where web_slug = ?").run(slug);
  const before = rows();
  const denied = await post({ playerId: owner.playerId, version: 2 }); expect(denied.response.status).toBe(403);
  const result = await post({ op: "owner-replay", ...owner });
  expect(result.response.status).toBe(200);
  expect(result.body).toMatchObject({ version: 2, visibility: "mine", mySeat: null, dataSeat: null, role: "spectator",
    capabilities: { canFork: true, privateSeats: [0, 1] } });
  const privateView = await post({ op: "owner-replay", ...owner, seat: 1, reveal: true });
  expect(privateView.body).toMatchObject({ mySeat: null, dataSeat: 1, reveal: true });
  expect(privateView.body.frames[0]!.view.seats.map(s => s.hand[0]!.code)).toEqual([900, 901]);
  expect(rows()).toEqual(before); expect(onChange).not.toHaveBeenCalled();
});
it("sets capabilities from the host mapping and defaults an owner source player to their own seat", async () => {
  vi.stubEnv("OWNER_USER_IDS", "201");
  const result = await post({ op: "owner-replay", playerId: 64, userId: 201 });
  expect(result.response.status).toBe(200); expect(result.body).toMatchObject({ mySeat: 0, dataSeat: 0, capabilities: { canFork: true } });
  const normal = await post({ version: 2, playerId: 64 }); expect(normal.body).toHaveProperty("capabilities");
});
it("checks the allowlist before source reads and checks revoked access before cached results", async () => {
  await post({ op: "owner-replay", ...owner, seat: 1 });
  const beforeReads = resourceRead.mock.calls.length;
  vi.stubEnv("OWNER_USER_IDS", "");
  const denied = await post({ op: "owner-replay", ...owner, seat: 1 });
  expect(denied.response.status).toBe(404); expect(denied.body.code).toBe("ACCESS_DENIED");
  expect(resourceRead).toHaveBeenCalledTimes(beforeReads);
});
it("rejects alpha, forged mapping, wrong guild and unsigned internal calls", async () => {
  for (const input of [{ playerId: 63, userId: 103 }, { playerId: 63, userId: 101 }, { ...owner, guildId: "other-guild" }]) {
    const denied = await post({ op: "owner-replay", ...input }); expect(denied.response.status).toBe(404);
  }
  expect((await post({ op: "owner-replay", ...owner }, false)).response.status).toBe(401);
  expect(workers).toHaveLength(0); expect(resourceRead).not.toHaveBeenCalled();
});
it("binds no-op cursor prefixes and invalidates cached source versions after a source edit", async () => {
  const a = await post({ version: 2 }); const b = await post({ version: 2 });
  expect(a.body).toEqual(b.body); expect(workers).toHaveLength(1);
  const codec = createReplayCursorCodec(secret);
  expect(a.body.frames.map(f => f.cursor && codec.open(f.cursor).prefixCount)).toEqual([0, 1, 3, null]);
  db.prepare("update duels set name = 'Changed source' where web_slug = ?").run(slug);
  const changed = await post({ version: 2 }); expect(changed.body.sourceVersion).not.toBe(a.body.sourceVersion);
  expect(workers).toHaveLength(2);
});
it("deduplicates concurrent detached replay requests", async () => {
  const results = await Promise.all([post({ version: 2 }), post({ version: 2 }), post({ version: 2 })]);
  expect(results.every(r => r.response.status === 200)).toBe(true); expect(workers).toHaveLength(1);
});
it("keeps public, own-seat, private-seat and reveal cache entries separate", async () => {
  const mine = await post({ version: 2 }); const publicView = await post({ version: 2, visibility: "public" });
  const privateView = await post({ op: "owner-replay", ...owner, seat: 1 });
  const revealed = await post({ op: "owner-replay", ...owner, seat: 1, reveal: true });
  expect(workers).toHaveLength(4);
  expect(mine.body.frames[0]!.view.seats[0]!.hand[0]!.code).toBe(900);
  expect(publicView.body.frames[0]!.view.seats[0]!.hand[0]!.code).toBeUndefined();
  expect(privateView.body.frames[0]!.view.seats[0]!.hand[0]!.code).toBeUndefined();
  expect(revealed.body.frames[0]!.view.seats[0]!.hand[0]!.code).toBe(900);
  const alphaAgain = await post({ version: 2, playerId: 63 }); expect(alphaAgain.body).not.toHaveProperty("capabilities");
  expect(alphaAgain.body.frames[0]!.view.seats[1]!.hand[0]!.code).toBeUndefined();
});
it("fails closed when owner access is revoked during a detached build", async () => {
  resourceRead.mockImplementationOnce(() => {
    vi.stubEnv("OWNER_USER_IDS", ""); return { dataDirectory: dir, bundleVersion: "test-bundle" };
  });
  const result = await post({ op: "owner-replay", ...owner, seat: 1 });
  expect(result.response.status).toBe(404); expect(result.body.code).toBe("ACCESS_DENIED");
  expect(result.body).not.toHaveProperty("frames"); expect(workers.every(w => !w.running)).toBe(true);
});
it("guards a known fork slug for both normal and privileged replay reads", async () => {
  const setup = { ...replaySource().setup, replayFork: { ownerUserId: 101, control: "all-manual",
    origin: { sourceSlug: "source-fixture", sourceVersion: "source-v1", frameId: "frame-0", step: 0, prefixCount: 0,
      prefixHash: "a".repeat(64), sourceSeats: [{ seat: 0, displayName: null }, { seat: 1, displayName: null }] } } };
  slug = "fork-fixture";
  db.prepare(`insert into duels(guild_id,web_slug,name,organizer_player_id,mode,status,kind,setup_json)
    values(?,?,'Fork fixture',?,'normal','active','replay-fork',?)`)
    .run(owner.guildId, slug, owner.playerId, JSON.stringify(setup));
  for (const playerId of [62, 63, 64]) for (const op of ["replay", "owner-replay"]) {
    const denied = await post({ op, playerId, version: 2 }); expect(denied.response.status).toBe(404);
  }
  expect(resourceRead).not.toHaveBeenCalled(); expect(workers).toHaveLength(0);
});
it("reports a saved final board on resource failure and on an unplayable source", async () => {
  const viewWorker = new ReplayWorker(); await viewWorker.create({ mode: "normal", decks: replaySource().decks, seed: replaySource().seed, dataDirectory: dir });
  db.prepare("update duels set snapshot_public_json = ? where web_slug = ?").run(JSON.stringify(await viewWorker.view(null)), slug);
  resourceRead.mockImplementationOnce(() => { throw new EngineResourceUnavailableError("test resource mismatch"); });
  const unavailable = await post({ version: 2, visibility: "public" });
  expect(unavailable.body).toMatchObject({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE", finalBoard: "available" });
  db.prepare("update duels set status = 'active' where web_slug = ?").run(slug);
  const active = await post({ version: 2, visibility: "public" });
  expect(active.response.status).toBe(409); expect(active.body).toMatchObject({ code: "NOT_PLAYABLE", finalBoard: "available" });
});
it("returns typed resource/mismatch errors and final board availability without source writes", async () => {
  const before = rows();
  resourceRead.mockImplementationOnce(() => { throw new EngineResourceUnavailableError("test identity mismatch"); });
  const unavailable = await post({ version: 2 }); expect(unavailable.response.status).toBe(409);
  expect(unavailable.body).toMatchObject({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE", finalBoard: "none" });
  db.prepare("update duel_commands set command_json = json_set(command_json, '$.revision', 99) where seq = 2").run();
  const mismatch = await post({ version: 2 }); expect(mismatch.response.status).toBe(409);
  expect(mismatch.body).toMatchObject({ code: "REPLAY_MISMATCH", finalBoard: "none" });
  expect(workers.every(w => !w.running)).toBe(true);
  expect(rows()[0]).toEqual(before[0]);
});
