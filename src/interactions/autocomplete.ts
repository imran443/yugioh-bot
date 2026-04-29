import type { DiscordUserLike } from "../commands/handlers.js";
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
    getFocused(): string;
  };
  respond(choices: AutocompleteChoice[]): Promise<void> | void;
};

type AutocompleteDependencies = {
  tournaments: TournamentService;
};

export async function handleAutocomplete(
  interaction: AutocompleteInteractionLike,
  deps: AutocompleteDependencies,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  if (interaction.commandName !== "event" || interaction.options.getSubcommand() !== "signup") {
    await interaction.respond([]);
    return;
  }

  const tournaments = deps.tournaments.autocomplete({
    guildId: interaction.guildId,
    query: interaction.options.getFocused(),
    statuses: ["pending"],
    createdByUserId: interaction.user.id,
  });

  await interaction.respond(
    tournaments.map((tournament) => ({ name: tournament.name, value: tournament.name })),
  );
}
