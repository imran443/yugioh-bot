import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forkEventFixture } from "./helpers/replay-fork-events.js";
import { engineDataDirectory } from "./engine-data-dir.js";

const target = vi.hoisted(() => vi.fn());
vi.mock("@yugidraft/shared/services", async importOriginal => {
  const actual = await importOriginal<typeof import("@yugidraft/shared/services")>();
  target.mockImplementation(actual.findDuelEventTarget);
  return { ...actual, findDuelEventTarget: target };
});
import { createDuelHost, type DuelHost } from "../src/host.js";

let app: ReturnType<typeof forkEventFixture>, host: DuelHost;
const onChange = vi.fn(), notifyTournament = vi.fn();
beforeEach(() => { vi.clearAllMocks(); app = forkEventFixture(); vi.stubEnv("OWNER_USER_IDS", "101,102");
  host = createDuelHost({ db: app.db, dataDirectory: engineDataDirectory, secret: "fork-events", searchCards: () => [],
    onChange, notifyTournament, pollIntervalMs: 60_000 }); });
afterEach(async () => { await host.close(); app.db.close(); vi.unstubAllEnvs(); });
async function post(op: string, slug = app.forkSlug, playerId = app.owner.playerId) {
  const body = JSON.stringify({ op, slug, playerId, guildId: app.guildId });
  return host.handle(new Request("http://test/internal/duel", { method: "POST", body,
    headers: { "x-announce-signature": "sha256=" + createHmac("sha256", "fork-events").update(body).digest("hex") } }));
}
it("emits fork cancel, retry and archive changes only for the fork slug", async () => {
  const before = app.db.prepare("select * from duels where id=?").get(app.source.id);
  for (const op of ["cancel", "cancel", "archive"]) expect((await post(op)).status).toBe(200);
  expect(onChange.mock.calls).toEqual(Array.from({ length: 3 }, () => [app.forkSlug, app.guildId]));
  expect(notifyTournament).not.toHaveBeenCalled();
  expect(app.db.prepare("select * from duels where id=?").get(app.source.id)).toEqual(before);
});
it.each(["completed", "interrupted", "cancelled"])("emits only fork events when archiving %s", async status => {
  app.db.prepare("update duels set status=? where id=?").run(status, app.forkId);
  expect((await post("archive")).status).toBe(200);
  expect(onChange.mock.calls).toEqual([[app.forkSlug, app.guildId]]);
});
it("sends no change if the event target cannot be read", async () => {
  target.mockReturnValueOnce(null);
  expect((await post("cancel")).status).toBe(200);
  expect(onChange).not.toHaveBeenCalled();
});
it("keeps ordinary duel change events", async () => {
  expect((await post("cancel", app.source.slug, app.sourcePlayer.playerId)).status).toBe(200);
  expect(onChange.mock.calls).toEqual([[app.source.slug, app.guildId]]);
});
