import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type InteractionReplyOptions,
} from "discord.js";
import type { DiscordUserLike, DraftNotifier } from "../commands/handlers.js";
import type { PlayerRepository } from "../repositories/players.js";
import type { CardCatalogService } from "../services/card-catalog.js";
import type { DraftImageService } from "../services/draft-images.js";
import type { DraftService } from "../services/drafts.js";
import type { TournamentService } from "../services/tournaments.js";

type SelectMenuDependencies = {
  players: PlayerRepository;
  tournaments: TournamentService;
  drafts: DraftService;
  cards: CardCatalogService;
  draftImages: DraftImageService;
  notifier: DraftNotifier;
};

export type SelectMenuInteractionLike = {
  customId: string;
  channelId: string | null;
  guildId: string | null;
  user: DiscordUserLike;
  values: string[];
  showModal(modal: ModalBuilder): Promise<void> | void;
  reply(
    message: { content: string; ephemeral: boolean; components?: InteractionReplyOptions["components"]; files?: InteractionReplyOptions["files"] },
  ): Promise<void> | void;
};

function requireGuildId(interaction: SelectMenuInteractionLike): string {
  if (!interaction.guildId) {
    throw new Error("This interaction can only be used in a server");
  }

  return interaction.guildId;
}

function displayName(user: DiscordUserLike): string {
  return user.displayName ?? user.username;
}

function requireFormat(value: string): "round_robin" | "single_elim" {
  if (value === "round_robin" || value === "single_elim") {
    return value;
  }

  throw new Error("Unsupported tournament format");
}

export async function handleSelectMenu(
  interaction: SelectMenuInteractionLike,
  deps: SelectMenuDependencies,
): Promise<void> {
  const draftPickCard = /^draft_pick_card:(\d+)$/.exec(interaction.customId);

  if (draftPickCard) {
    const guildId = requireGuildId(interaction);
    const draftId = Number(draftPickCard[1]);
    const draft = deps.drafts.findById(draftId);

    if (draft.guildId !== guildId) {
      throw new Error("Draft not found in this server");
    }

    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const options = deps.drafts.pickOptions(draftId, player.id);

    if (options.length === 0) {
      await interaction.reply({ content: "You already picked this step. Waiting for other players.", ephemeral: true });
      return;
    }

    const draftCardId = Number(interaction.values[0]);
    deps.drafts.pickCard(draftId, player.id, draftCardId);

    const pickedCard = options.find((card) => card.id === draftCardId);
    const catalogCards = deps.cards.findByIds(pickedCard ? [pickedCard.catalogCardId] : []);
    const cardName = catalogCards[0]?.name ?? "Unknown";

    await interaction.reply({ content: `You picked ${cardName}.`, ephemeral: true });

    const updatedDraft = deps.drafts.findById(draftId);

    if (updatedDraft.status === "active") {
      for (const draftPlayer of deps.drafts.players(draftId)) {
        const playerOptions = deps.drafts.pickOptions(draftId, draftPlayer.playerId);

        if (playerOptions.length > 0) {
          const playerRecord = deps.players.findById(draftPlayer.playerId);

          if (playerRecord) {
            await deps.notifier.sendPickPrompt({
              channelId: draft.channelId,
              userId: playerRecord.discordUserId,
              draftId: draft.id,
              draftName: draft.name,
            });
          }
        }
      }
    }

    return;
  }

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
