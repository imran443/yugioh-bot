import type { DiscordUserLike } from "../commands/handlers.js";
import type { PlayerRepository } from "../repositories/players.js";
import type { TournamentService } from "../services/tournaments.js";

export type ButtonInteractionLike = {
  customId: string;
  guildId: string | null;
  user: DiscordUserLike;
  reply(message: { content: string; ephemeral: boolean }): Promise<void> | void;
};

type ButtonDependencies = {
  players: PlayerRepository;
  tournaments: TournamentService;
};

function requireGuildId(interaction: ButtonInteractionLike): string {
  if (!interaction.guildId) {
    throw new Error("This interaction can only be used in a server");
  }

  return interaction.guildId;
}

function displayName(user: DiscordUserLike): string {
  return user.displayName ?? user.username;
}

export async function handleButton(
  interaction: ButtonInteractionLike,
  deps: ButtonDependencies,
): Promise<void> {
  const match = /^join_tournament:(\d+)$/.exec(interaction.customId);

  if (!match) {
    throw new Error("Unsupported button interaction");
  }

  const guildId = requireGuildId(interaction);
  const tournament = deps.tournaments.findById(Number(match[1]));

  if (tournament.guildId !== guildId) {
    throw new Error("Tournament not found in this server");
  }

  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));

  deps.tournaments.join(tournament.id, player.id);
  await interaction.reply({ content: `Joined event: ${tournament.name}.`, ephemeral: true });
}
