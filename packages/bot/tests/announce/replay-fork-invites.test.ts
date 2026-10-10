import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { forkEventFixture } from "../helpers/replay-fork-events.js";
import { createAnnounceHandlers } from "../../src/announce/handlers.js";
import { createAnnounceServer } from "../../src/announce/server.js";
import { findDuelEventTarget } from "@yugidraft/shared/services";
import { createNotifyDuelChange } from "../../src/lib/notify-duel.js";

let app: ReturnType<typeof forkEventFixture>;
const fetch = vi.fn(), send = vi.fn(), post = vi.fn();
beforeEach(() => { vi.clearAllMocks(); app = forkEventFixture(); fetch.mockResolvedValue({ send }); send.mockResolvedValue(undefined); post.mockResolvedValue({ ok: true }); });
afterEach(() => app.db.close());
function handlers() { return createAnnounceHandlers({ client: { users: { fetch }, channels: { fetch } } as never,
  db: app.db, guildSettings: {} as never, drafts: {} as never, messenger: {} as never }); }
const invite = (fork = true) => ({ guildId: app.guildId, duelId: fork ? app.forkId : app.source.id, slug: fork ? app.forkSlug : app.source.slug,
  opponentDiscordUserId: "fixture-recipient", challengerName: "Test", duelName: "Test", bestOf: 1 as const, ranked: false,
  tournamentName: null, url: `https://duel.example/duels/${fork ? app.forkSlug : app.source.slug}` });

it.each(["active", "completed", "interrupted", "cancelled"])("rejects a direct marked-fork invite at the sink in status %s", async status => {
  app.db.prepare("update duels set status=? where id=?").run(status, app.forkId);
  await expect(handlers().onDuelInvite(invite())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});
it("rejects a source reference with a fork URL and a wrong guild", async () => {
  await expect(handlers().onDuelInvite({ ...invite(false), url: invite().url })).rejects.toThrow();
  await expect(handlers().onDuelInvite({ ...invite(false), guildId: "other" })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("sends an ordinary invite", async () => {
  await handlers().onDuelInvite(invite(false));
  expect(fetch).toHaveBeenCalledWith("fixture-recipient"); expect(send).toHaveBeenCalledTimes(1);
});
it("refuses a signed invite without a stored target reference before dispatch", async () => {
  const onDuelInvite = vi.fn();
  const server = createAnnounceServer({ secret: "test", handlers: { ...handlers(), onDuelInvite } });
  const { duelId: _id, slug: _slug, ...unbound } = invite(false);
  const body = JSON.stringify(unbound);
  const signature = "sha256=" + createHmac("sha256", "test").update(body).digest("hex");
  const response = await server.handle(new Request("http://test/internal/announce/duel-invite", { method: "POST", body,
    headers: { "x-announce-signature": signature } }));
  expect(response.status).toBe(400); expect(onDuelInvite).not.toHaveBeenCalled();
});
it("refuses bot-origin fork changes and keeps ordinary changes", async () => {
  const resolve = (slug: string, guildId: string) => findDuelEventTarget(app.db, slug, guildId);
  const notify = createNotifyDuelChange({ post }, resolve);
  await notify(app.forkSlug, app.guildId); expect(post).not.toHaveBeenCalled();
  await notify(app.source.slug, app.guildId); expect(post).toHaveBeenCalledTimes(1);
});
