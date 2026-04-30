import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { DiscordUserLike } from "../commands/handlers.js";
import type { TournamentService } from "../services/tournaments.js";

export type SelectMenuInteractionLike = {
  customId: string;
  guildId: string | null;
  user: DiscordUserLike;
  values: string[];
  showModal(modal: ModalBuilder): Promise<void> | void;
};

type SelectMenuDependencies = {
  tournaments: TournamentService;
};

function requireFormat(value: string): "round_robin" | "single_elim" {
  if (value === "round_robin" || value === "single_elim") {
    return value;
  }

  throw new Error("Unsupported tournament format");
}

export async function handleSelectMenu(
  interaction: SelectMenuInteractionLike,
  _deps: SelectMenuDependencies,
): Promise<void> {
  if (interaction.customId !== "dashboard_create_event_format") {
    throw new Error("Unsupported select menu interaction");
  }

  const format = requireFormat(interaction.values[0] ?? "");

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`dashboard_create_event:${format}`)
      .setTitle("Create Event")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("name")
            .setLabel("Event name")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true),
        ),
      ),
  );
}
