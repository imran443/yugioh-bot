import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import {
  handleSelectMenu,
  type SelectMenuInteractionLike,
} from "../../src/interactions/select-menus.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
import { createDraftImageService } from "../../src/services/draft-images.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createTournamentService } from "../../src/services/tournaments.js";

type SelectMenuDependencies = Parameters<typeof handleSelectMenu>[1];
type _DraftSelectMenuDependencyChecks = [
  SelectMenuDependencies["drafts"],
  SelectMenuDependencies["cards"],
  SelectMenuDependencies["draftImages"],
  SelectMenuDependencies["notifier"],
];

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    tournaments: createTournamentService(db),
    drafts: createDraftService(db),
    cards: createCardCatalogService(db),
    draftImages: createDraftImageService({ cacheDir: "./data/test-card-images" }),
    notifier: {
      sendPickPrompt: async () => {},
    },
  };
}

function fakeSelectMenu(input: Partial<SelectMenuInteractionLike> = {}) {
  const modals: unknown[] = [];
  const interaction: SelectMenuInteractionLike = {
    customId: "dashboard_create_event_format",
    channelId: "channel-1",
    guildId: "guild-1",
    user: { id: "user-1", username: "Yugi" },
    values: ["round_robin"],
    showModal: (modal) => {
      modals.push(modal);
    },
    ...input,
  };

  return { interaction, modals };
}

describe("select menu interactions", () => {
  it("opens a name-only create event modal after choosing a format", async () => {
    const app = setup();
    const { interaction, modals } = fakeSelectMenu({ values: ["single_elim"] });

    await handleSelectMenu(interaction, app);

    expect(JSON.stringify(modals[0])).toContain("dashboard_create_event:single_elim");
    expect(JSON.stringify(modals[0])).toContain("name");
    expect(JSON.stringify(modals[0])).not.toContain("format");
  });

  it("rejects unsupported format selections", async () => {
    const app = setup();
    const { interaction } = fakeSelectMenu({ values: ["swiss"] });

    await expect(handleSelectMenu(interaction, app)).rejects.toThrow("Unsupported tournament format");
  });
});
