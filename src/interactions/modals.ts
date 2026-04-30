import type { CommandReplyLike, DiscordUserLike } from "../commands/handlers.js";
import { tournamentSignupPostReply } from "../commands/handlers.js";
import type { TournamentFormat, TournamentService } from "../services/tournaments.js";

export type ModalInteractionLike = {
  customId: string;
  guildId: string | null;
  user: DiscordUserLike;
  fields: { getTextInputValue(name: string): string };
  reply(message: CommandReplyLike): Promise<void> | void;
};

type ModalDependencies = {
  tournaments: TournamentService;
};

function requireGuildId(interaction: ModalInteractionLike): string {
  if (!interaction.guildId) {
    throw new Error("This interaction can only be used in a server");
  }

  return interaction.guildId;
}

function parseFormat(customId: string): TournamentFormat | undefined {
  const match = /^dashboard_create_event:(round_robin|single_elim)$/.exec(customId);

  if (match) {
    return match[1] as TournamentFormat;
  }

  return undefined;
}

export async function handleModal(
  interaction: ModalInteractionLike,
  deps: ModalDependencies,
): Promise<void> {
  if (!interaction.customId.startsWith("dashboard_create_event:")) {
    throw new Error("Unsupported modal interaction");
  }

  const guildId = requireGuildId(interaction);
  const name = interaction.fields.getTextInputValue("name").trim();
  const format = parseFormat(interaction.customId);

  if (!name) {
    await interaction.reply({ content: "Event name is required.", ephemeral: true });
    return;
  }

  if (!format) {
    await interaction.reply({ content: "Format must be round_robin or single_elim.", ephemeral: true });
    return;
  }

  const tournament = deps.tournaments.create(guildId, name, format, interaction.user.id);

  await interaction.reply(tournamentSignupPostReply(tournament));
}
