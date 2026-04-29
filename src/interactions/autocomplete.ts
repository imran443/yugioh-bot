import type { DiscordUserLike } from "../commands/handlers.js";
import type { PlayerRepository } from "../repositories/players.js";
import type { TournamentService } from "../services/tournaments.js";

type AutocompleteChoice = {
  name: string;
  value: string;
};

export type AutocompleteInteractionLike = {
  commandName: string;
  guildId: string | null;
  user: DiscordUserLike;
  options: {
    getSubcommand(): string;
    getFocused(): { name: string; value: string };
  };
  respond(choices: AutocompleteChoice[]): Promise<void> | void;
};

type AutocompleteDependencies = {
  players: PlayerRepository;
  tournaments: TournamentService;
};

function tournamentChoices(
  tournaments: ReturnType<TournamentService["autocomplete"]>,
): AutocompleteChoice[] {
  return tournaments.map((tournament) => ({ name: tournament.name, value: tournament.name }));
}

export async function handleAutocomplete(
  interaction: AutocompleteInteractionLike,
  deps: AutocompleteDependencies,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused();
  const query = focused.value;

  if (interaction.commandName === "stats") {
    if (focused.name !== "tournament") {
      await interaction.respond([]);
      return;
    }

    await interaction.respond(
      tournamentChoices(
        deps.tournaments.autocomplete({
          guildId: interaction.guildId,
          query,
          statuses: ["active", "completed"],
        }),
      ),
    );
    return;
  }

  if (interaction.commandName !== "event") {
    await interaction.respond([]);
    return;
  }

  if (focused.name !== "name") {
    await interaction.respond([]);
    return;
  }

  switch (interaction.options.getSubcommand()) {
    case "start":
    case "signup":
      await interaction.respond(
        tournamentChoices(
          deps.tournaments.autocomplete({
            guildId: interaction.guildId,
            query,
            statuses: ["pending"],
            createdByUserId: interaction.user.id,
          }),
        ),
      );
      return;
    case "show":
      await interaction.respond(
        tournamentChoices(
          deps.tournaments.autocomplete({
            guildId: interaction.guildId,
            query,
          }),
        ),
      );
      return;
    case "report": {
      const player = deps.players.findByDiscordId(interaction.guildId, interaction.user.id);

      await interaction.respond(
        player
          ? tournamentChoices(
              deps.tournaments.autocomplete({
                guildId: interaction.guildId,
                query,
                statuses: ["active"],
                participantPlayerId: player.id,
              }),
            )
          : [],
      );
      return;
    }
    case "cancel":
      await interaction.respond(
        tournamentChoices(
          deps.tournaments.autocomplete({
            guildId: interaction.guildId,
            query,
            statuses: ["pending", "active"],
            createdByUserId: interaction.user.id,
          }),
        ),
      );
      return;
    default:
      await interaction.respond([]);
  }
}
