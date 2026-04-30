import type { CommandReplyLike, DiscordUserLike } from "../commands/handlers.js";
import { draftSignupPostReply, tournamentSignupPostReply } from "../commands/handlers.js";
import type { PlayerRepository } from "../repositories/players.js";
import type { CardCatalogService } from "../services/card-catalog.js";
import type { DraftImageService } from "../services/draft-images.js";
import type { DraftService } from "../services/drafts.js";
import type { TournamentFormat, TournamentService } from "../services/tournaments.js";

export type ModalInteractionLike = {
  customId: string;
  channelId: string | null;
  guildId: string | null;
  user: DiscordUserLike;
  fields: { getTextInputValue(name: string): string };
  reply(message: CommandReplyLike): Promise<void> | void;
};

type ModalDependencies = {
  tournaments: TournamentService;
  drafts: DraftService;
  cards: CardCatalogService;
  draftImages: DraftImageService;
  players: PlayerRepository;
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

function requireChannelId(interaction: ModalInteractionLike): string {
  if (!interaction.channelId) {
    throw new Error("This interaction must come from a channel");
  }

  return interaction.channelId;
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function handleModal(
  interaction: ModalInteractionLike,
  deps: ModalDependencies,
): Promise<void> {
  if (interaction.customId === "draft_create_modal") {
    const guildId = requireGuildId(interaction);
    const channelId = requireChannelId(interaction);
    const name = interaction.fields.getTextInputValue("name").trim();

    if (!name) {
      await interaction.reply({ content: "Draft name is required.", ephemeral: true });
      return;
    }

    const creator = deps.players.upsert(guildId, interaction.user.id, interaction.user.displayName ?? interaction.user.username);
    const draft = deps.drafts.create(
      guildId,
      channelId,
      name,
      {
        setNames: parseList(interaction.fields.getTextInputValue("sets")),
        includeNames: parseList(interaction.fields.getTextInputValue("includes")),
        excludeNames: parseList(interaction.fields.getTextInputValue("excludes")),
      },
      interaction.user.id,
      creator.id,
    );

    await interaction.reply(draftSignupPostReply(draft));
    return;
  }

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
