import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createDraftService } from "../../src/services/drafts.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    db,
    drafts: createDraftService(db),
    players: createPlayerRepository(db),
  };
}

describe("draft service", () => {
  it("creates a pending draft, stores config, and auto-joins the creator", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");

    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "cube night",
      {
        setNames: ["Battle Pack 3"],
        includeNames: ["Dark Magician"],
        excludeNames: ["Pot of Greed"],
      },
      "user-1",
      yugi.id,
    );

    expect(draft).toEqual({
      id: expect.any(Number),
      guildId: "guild-1",
      channelId: "channel-1",
      name: "cube night",
      status: "pending",
      createdByUserId: "user-1",
      config: {
        setNames: ["Battle Pack 3"],
        includeNames: ["Dark Magician"],
        excludeNames: ["Pot of Greed"],
      },
      currentWaveNumber: 0,
      currentPickStep: 0,
    });
    expect(app.drafts.findById(draft.id)).toEqual(draft);
    expect(app.drafts.findByName("guild-1", "cube night")).toEqual(draft);
    expect(app.drafts.players(draft.id)).toEqual([{ playerId: yugi.id, displayName: "Yugi" }]);
  });

  it("lists drafts by status within a guild", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const pending = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);
    const active = app.drafts.create("guild-1", "channel-2", "side draft", {}, "user-1", yugi.id);
    app.drafts.create("guild-2", "channel-3", "remote draft", {}, "user-1", yugi.id);

    app.db.prepare("update drafts set status = 'active' where id = ?").run(active.id);

    expect(app.drafts.listByStatus("guild-1", ["pending", "active"])).toEqual([
      expect.objectContaining({ id: pending.id, guildId: "guild-1", status: "pending" }),
      expect.objectContaining({ id: active.id, guildId: "guild-1", status: "active" }),
    ]);
  });

  it("joins pending drafts without duplicating players and rejects non-pending drafts", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    app.drafts.join(draft.id, kaiba.id);

    expect(app.drafts.players(draft.id)).toEqual([
      { playerId: yugi.id, displayName: "Yugi" },
      { playerId: kaiba.id, displayName: "Kaiba" },
    ]);

    app.db.prepare("update drafts set status = 'active' where id = ?").run(draft.id);

    expect(() => app.drafts.join(draft.id, joey.id)).toThrow("Draft is no longer accepting players");
  });

  it("rejects duplicate active or pending draft names in the same guild", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const active = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.db.prepare("update drafts set status = 'active' where id = ?").run(active.id);

    expect(() =>
      app.drafts.create("guild-1", "channel-2", "cube night", {}, "user-1", yugi.id),
    ).toThrow("An active or pending draft already uses that name");
  });
});
