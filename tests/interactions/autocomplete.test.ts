import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  handleAutocomplete,
  type AutocompleteInteractionLike,
} from "../../src/interactions/autocomplete.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
  };
}

function fakeAutocomplete(input: Partial<AutocompleteInteractionLike> = {}) {
  const responses: Array<Array<{ name: string; value: string }>> = [];
  const interaction: AutocompleteInteractionLike = {
    commandName: "event",
    guildId: "guild-1",
    user: { id: "creator-1", username: "Yugi" },
    options: {
      getSubcommand: () => "signup",
      getFocused: () => "cup",
    },
    respond: (choices) => {
      responses.push(choices);
    },
    ...input,
  };

  return { interaction, responses };
}

describe("autocomplete interactions", () => {
  it("suggests pending signup tournaments created by the user", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Creator Cup", "round_robin", "creator-1");
    app.tournaments.create("guild-1", "Other Cup", "round_robin", "other-user");
    app.tournaments.create("guild-2", "Other Guild Cup", "round_robin", "creator-1");
    const activeTournament = app.tournaments.create("guild-1", "Active Cup", "round_robin", "creator-1");
    const yugi = app.players.upsert("guild-1", "creator-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    app.tournaments.join(activeTournament.id, yugi.id);
    app.tournaments.join(activeTournament.id, kaiba.id);
    app.tournaments.start(activeTournament.id);
    const { interaction, responses } = fakeAutocomplete();

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([{ name: "Creator Cup", value: "Creator Cup" }]);
  });

  it("returns no choices for unsupported autocomplete contexts", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Creator Cup", "round_robin", "creator-1");
    const { interaction, responses } = fakeAutocomplete({ commandName: "stats" });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([]);
  });
});
