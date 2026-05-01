import type { DiscordUserLike } from "../commands/handlers.js";
import type { PlayerRepository } from "../repositories/players.js";
import type { CardCatalogService } from "../services/card-catalog.js";
import type { DraftTemplateService } from "../services/draft-templates.js";
import type { DraftService } from "../services/drafts.js";
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
    getSubcommandGroup(): string | null;
    getFocused(): { name: string; value: string };
  };
  respond(choices: AutocompleteChoice[]): Promise<void> | void;
};

type AutocompleteDependencies = {
  players: PlayerRepository;
  tournaments: TournamentService;
  drafts: DraftService;
  cards: CardCatalogService;
  templates: DraftTemplateService;
};

const maxAutocompleteChoiceLength = 100;

function tournamentChoices(
  tournaments: ReturnType<TournamentService["autocomplete"]>,
): AutocompleteChoice[] {
  return tournaments.map((tournament) => {
    const name = tournament.name.slice(0, maxAutocompleteChoiceLength);

    return { name, value: name };
  });
}

function draftChoices(
  drafts: ReturnType<DraftService["autocomplete"]>,
): AutocompleteChoice[] {
  return drafts.map((draft) => {
    const name = draft.name.slice(0, maxAutocompleteChoiceLength);

    return { name, value: name };
  });
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

  if (interaction.commandName === "draft") {
    const subcommand = interaction.options.getSubcommand();
    const subcommandGroup = interaction.options.getSubcommandGroup();

    if (subcommandGroup === "template") {
      switch (subcommand) {
        case "save": {
          if (focused.name !== "draft") {
            await interaction.respond([]);
            return;
          }

          await interaction.respond(
            draftChoices(
              deps.drafts.autocomplete({
                guildId: interaction.guildId,
                query,
                statuses: ["pending", "active", "completed"],
                createdByUserId: interaction.user.id,
              }),
            ),
          );
          return;
        }
        case "delete": {
          if (focused.name !== "name") {
            await interaction.respond([]);
            return;
          }

          const templates = deps.templates
            .list(interaction.guildId)
            .filter((template) => template.name.toLowerCase().includes(query.toLowerCase()));

          await interaction.respond(
            templates.map((template) => ({
              name: template.name.slice(0, maxAutocompleteChoiceLength),
              value: template.name,
            })),
          );
          return;
        }
        default:
          await interaction.respond([]);
          return;
      }
    }

    if (subcommand === "sets") {
      if (focused.name !== "query") {
        await interaction.respond([]);
        return;
      }

      const sets = deps.cards.listSets(query);

      await interaction.respond(
        sets.map((set) => ({
          name: set.slice(0, maxAutocompleteChoiceLength),
          value: set,
        })),
      );
      return;
    }

    if (subcommand === "create" && focused.name === "sets") {
      const lastSegment = query
        .split(",")
        .map((s) => s.trim())
        .pop() ?? "";
      const sets = deps.cards.listSets(lastSegment);

      await interaction.respond(
        sets.map((set) => ({
          name: set.slice(0, maxAutocompleteChoiceLength),
          value: set,
        })),
      );
      return;
    }

    if (focused.name !== "name") {
      await interaction.respond([]);
      return;
    }

    switch (subcommand) {
      case "join":
        await interaction.respond(
          draftChoices(
            deps.drafts.autocomplete({
              guildId: interaction.guildId,
              query,
              statuses: ["pending"],
            }),
          ),
        );
        return;
      case "start":
        await interaction.respond(
          draftChoices(
            deps.drafts.autocomplete({
              guildId: interaction.guildId,
              query,
              statuses: ["pending"],
              createdByUserId: interaction.user.id,
            }),
          ),
        );
        return;
      case "cancel":
        await interaction.respond(
          draftChoices(
            deps.drafts.autocomplete({
              guildId: interaction.guildId,
              query,
              statuses: ["pending", "active"],
              createdByUserId: interaction.user.id,
            }),
          ),
        );
        return;
      case "export":
        await interaction.respond(
          draftChoices(
            deps.drafts.autocomplete({
              guildId: interaction.guildId,
              query,
              statuses: ["completed"],
            }),
          ),
        );
        return;
      default:
        await interaction.respond([]);
        return;
    }
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
    case "participants":
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
