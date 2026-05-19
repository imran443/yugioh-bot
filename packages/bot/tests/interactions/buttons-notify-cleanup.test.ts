import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleButton, type ButtonInteractionLike } from "../../src/interactions/buttons.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createMatchService, createTournamentService } from "@yugidraft/shared/services";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return {
    db,
    matches: createMatchService(db),
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
    drafts: createDraftService(db),
    cards: createCardCatalogService(db),
  };
}

describe("dashboard approve clears notify message", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("calls deleteNotifyMessage with the resolved match id", async () => {
    const app = setup();
    const a = app.players.upsert("guild-1", "u-a", "A");
    const b = app.players.upsert("guild-1", "u-b", "B");
    const tour = app.tournaments.create("guild-1", "RR", "round_robin", "u-creator");
    app.tournaments.join(tour.id, a.id);
    app.tournaments.join(tour.id, b.id);
    app.tournaments.start(tour.id);
    const tm = app.db.prepare("select * from tournament_matches where tournament_id = ?").get(tour.id) as any;
    const rep = app.tournaments.reportTournamentMatch(tm.id, a.id, a.id);

    const deleteNotifyMessage = vi.fn(async () => {});
    const replies: any[] = [];
    const interaction: ButtonInteractionLike = {
      customId: `dashboard_approve:${rep.id}`,
      channelId: "c", guildId: "guild-1",
      user: { id: "u-b", username: "B" },
      reply: (m) => { replies.push(m); },
      showModal: () => {},
    };

    await handleButton(interaction, { ...app, deleteNotifyMessage });
    expect(deleteNotifyMessage).toHaveBeenCalledWith(rep.id);
  });
});
