import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDraftService, createDraftLobbyService, createPlayerService, createUserService } from "@yugidraft/shared/services";
import { createDraftTimer } from "../src/draft-timer.js";
import type { WorkerEffects } from "../src/effects.js";

const now = new Date("2026-10-07T12:00:00Z");
const databases: Database.Database[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(bot = false) {
  const db = new Database(":memory:"); databases.push(db); migrate(db);
  const users = createUserService(db), players = createPlayerService(db);
  const host = players.findOrCreate("g", users.createNonLogin("Email host").id, "Email host");
  const guest = bot ? players.findOrCreateTestPlayer("g", "bot_player_dev_1", "Test bot")
    : players.findOrCreate("g", users.createNonLogin("Email guest").id, "Email guest");
  for (let id = 1; id <= 24; id++) db.prepare(`insert into card_catalog
    (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
    values (?,?,'Normal Monster','normal','','','[]','now')`).run(id, `Card ${id}`);
  const drafts = createDraftService(db), lobby = createDraftLobbyService(db);
  const draft = drafts.create("g", null, "Worker lobby", { lobbySeats: 2, packSize: 3,
    packsPerPlayer: 2, cardsPerPlayer: 6, pickSeconds: 45, cubeCardIds: Array.from({ length: 24 }, (_, i) => i + 1) }, host.userId, host.id);
  drafts.join(draft.id, guest.id);
  lobby.setReady(draft.id, host.userId, true, now);
  if (!bot) lobby.setReady(draft.id, guest.userId, true, now);
  const effects: WorkerEffects = { discordEnabled: false, draft: vi.fn(async () => {}),
    tournament: vi.fn(async () => {}), discord: vi.fn(async () => {}), duel: vi.fn(async () => {}) };
  return { db, drafts, lobby, draft, host, guest, effects, startedAt: now };
}
it("ignores cancelled drafts in a stale active-list snapshot", async () => {
  const app = setup(true);
  app.drafts.start(app.draft.id, now);
  const snapshot = app.drafts.findById(app.draft.id);
  const expire = vi.spyOn(app.drafts, "expireCurrentPickStep");
  vi.spyOn(app.drafts, "listActive").mockImplementationOnce(() => {
    app.drafts.cancel(app.draft.id);
    return [snapshot];
  });
  const timer = createDraftTimer(app);
  await timer.tick(new Date(now.getTime() + 60_000));
  await timer.tick(new Date(now.getTime() + 120_000));
  expect(expire).not.toHaveBeenCalled();
  expect(app.drafts.picks(app.draft.id)).toEqual([]);
  expect(app.effects.draft).not.toHaveBeenCalled();
  expect(app.effects.discord).not.toHaveBeenCalled();
});
it("does not resync a draft cancelled between the timer read and expiry", async () => {
  const app = setup(true);
  app.drafts.start(app.draft.id, now);
  const expiry = app.drafts.expireCurrentPickStep.bind(app.drafts);
  vi.spyOn(app.drafts, "expireCurrentPickStep").mockImplementation((id, time) => {
    app.drafts.cancel(id);
    return expiry(id, time);
  });
  await createDraftTimer(app).tick(new Date(now.getTime() + 60_000));
  expect(app.drafts.findById(app.draft.id).status).toBe("cancelled");
  expect(app.effects.draft).not.toHaveBeenCalled();
  expect(app.effects.discord).not.toHaveBeenCalled();
});
it("does not start an armed lobby after cancellation", async () => {
  const app = setup(true);
  app.lobby.setAutoStart(app.draft.id, app.host.userId, { revision: app.lobby.read(app.draft.id).lobby.revision, enabled: true }, now);
  app.drafts.cancel(app.draft.id);
  await createDraftTimer(app).tick(new Date(now.getTime() + 60_000));
  expect(app.drafts.findById(app.draft.id).status).toBe("cancelled");
  expect(app.drafts.picks(app.draft.id)).toEqual([]);
  expect(app.effects.draft).not.toHaveBeenCalled();
});
it("preserves an armed lobby and starts it at its deadline", async () => {
  const app = setup(true);
  const scheduled = app.lobby.setAutoStart(app.draft.id, app.host.userId, {
    revision: app.lobby.read(app.draft.id).lobby.revision, enabled: true,
  }, now);
  expect(app.drafts.findById(app.draft.id).status).toBe("pending");
  expect(app.lobby.read(app.draft.id, app.host.userId)).toEqual(scheduled);
  await createDraftTimer(app).tick(new Date(scheduled.lobby.start!.startsAt));
  expect(app.drafts.findById(app.draft.id).status).toBe("active");
  expect(app.effects.draft).toHaveBeenCalledWith({ kind: "status", slug: app.draft.webSlug, status: "active" });
});
it.each(["manual", "auto"] as const)("starts an unattended %s lobby with Discord off and publishes the dealt state", async kind => {
  const app = setup(kind === "auto");
  const revision = app.lobby.read(app.draft.id).lobby.revision;
  const scheduled = kind === "manual" ? app.lobby.scheduleStart(app.draft.id, app.host.userId, { revision }, now)
    : app.lobby.setAutoStart(app.draft.id, app.host.userId, { revision, enabled: true }, now);
  const deadline = new Date(scheduled.lobby.start!.startsAt);
  const timer = createDraftTimer(app);
  await timer.tick(new Date(deadline.getTime() - 1));
  expect(app.drafts.findById(app.draft.id).status).toBe("pending");
  await timer.tick(deadline);
  expect(app.drafts.findById(app.draft.id).status).toBe("active");
  expect(app.effects.draft).toHaveBeenCalledWith({ kind: "resync", slug: app.draft.webSlug, packRound: 1, pickStep: 1 });
  expect(app.effects.draft).toHaveBeenCalledWith({ kind: "status", slug: app.draft.webSlug, status: "active" });
  expect(app.effects.discord).not.toHaveBeenCalled();
  await createDraftTimer(app).tick(deadline);
  expect(app.db.prepare("select count(*) as n from draft_deal where draft_id = ?").get(app.draft.id)).toEqual({ n: 12 });
  expect(app.effects.draft).toHaveBeenCalledTimes(2);
});
it("respects Stop across timer restart and keeps auto-start held", async () => {
  const app = setup(true);
  const scheduled = app.lobby.setAutoStart(app.draft.id, app.host.userId, { revision: app.lobby.read(app.draft.id).lobby.revision, enabled: true }, now);
  app.lobby.stopStart(app.draft.id, app.host.userId, scheduled.lobby.start!.token, now);
  await createDraftTimer(app).tick(new Date(now.getTime() + 60_000));
  expect(app.lobby.read(app.draft.id).lobby.autoStart.held).toBe(true);
  expect(app.drafts.findById(app.draft.id).status).toBe("pending");
  expect(app.effects.draft).not.toHaveBeenCalled();
});
it("publishes a failed countdown after the cached pool disappears", async () => {
  const app = setup();
  app.lobby.scheduleStart(app.draft.id, app.host.userId, { revision: app.lobby.read(app.draft.id).lobby.revision }, now);
  app.db.prepare("delete from card_catalog").run();
  await createDraftTimer(app).tick(new Date(now.getTime() + 5000));
  expect(app.lobby.read(app.draft.id).lobby.lastStartError).toBeTruthy();
  expect(app.effects.draft).toHaveBeenCalledWith({ kind: "seats", slug: app.draft.webSlug });
});
it("publishes status even if resync fails, then announces only when Discord has a channel", async () => {
  const app = setup(); app.effects.discordEnabled = true;
  app.db.prepare("update drafts set channel_id = 'discord-channel' where id = ?").run(app.draft.id);
  app.lobby.scheduleStart(app.draft.id, app.host.userId, { revision: app.lobby.read(app.draft.id).lobby.revision }, now);
  vi.mocked(app.effects.draft).mockRejectedValueOnce(new Error("WS offline"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await createDraftTimer(app).tick(new Date(now.getTime() + 5000));
  expect(app.effects.draft).toHaveBeenCalledWith({ kind: "status", slug: app.draft.webSlug, status: "active" });
  expect(app.effects.discord).toHaveBeenCalledExactlyOnceWith({ kind: "draft-started", draftId: app.draft.id,
    channelId: "discord-channel", name: app.draft.name, webSlug: app.draft.webSlug });
  expect(warning).toHaveBeenCalled();
});
it("does not deal again after the web fallback won the deadline", async () => {
  const app = setup();
  app.lobby.scheduleStart(app.draft.id, app.host.userId, { revision: app.lobby.read(app.draft.id).lobby.revision }, now);
  const deadline = new Date(now.getTime() + 5000);
  expect(app.lobby.tick(deadline).started).toHaveLength(1);
  await createDraftTimer(app).tick(deadline);
  expect(app.effects.draft).not.toHaveBeenCalled();
  expect(app.db.prepare("select count(*) as n from draft_deal where draft_id = ?").get(app.draft.id)).toEqual({ n: 12 });
});

it("expires active picks before waiting for lobby broadcasts", async () => {
  const app = setup();
  const active = app.drafts.create("g", null, "Due picks", app.draft.config, app.host.userId, app.host.id);
  app.drafts.join(active.id, app.guest.id);
  app.drafts.start(active.id, now);
  app.db.prepare("update drafts set pick_deadline_at = ? where id = ?").run(now.toISOString(), active.id);
  app.lobby.scheduleStart(app.draft.id, app.host.userId, { revision: app.lobby.read(app.draft.id).lobby.revision }, now);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(app.effects.draft).mockImplementationOnce(() => blocked);
  const tick = createDraftTimer(app).tick(new Date(now.getTime() + 5000));
  try {
    expect(app.drafts.findById(active.id).currentPickStep).toBe(2);
    expect(app.drafts.findById(app.draft.id).status).toBe("active");
  } finally {
    release();
    await tick;
  }
});
