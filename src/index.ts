import "dotenv/config";
import cron from "node-cron";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  handleCommand,
  type CommandInteractionLike,
  type DraftMessenger,
} from "./commands/handlers.js";
import { openDatabase } from "./db/connection.js";
import { createCardCatalogService } from "./services/card-catalog.js";
import { createDraftCleanupService } from "./services/draft-cleanup.js";
import { createDraftImageService } from "./services/draft-images.js";
import { createDraftService, type Draft } from "./services/drafts.js";
import { createDraftTemplateService } from "./services/draft-templates.js";
import {
  handleAutocomplete,
  type AutocompleteInteractionLike,
} from "./interactions/autocomplete.js";
import { handleButton, type ButtonInteractionLike } from "./interactions/buttons.js";
import { handleModal, type ModalInteractionLike } from "./interactions/modals.js";
import {
  handleSelectMenu,
  type SelectMenuInteractionLike,
} from "./interactions/select-menus.js";
import { createPlayerRepository } from "./repositories/players.js";
import {
  formatTournamentReminder,
  selectTournamentReminderTargets,
} from "./reminders/tournament-reminders.js";
import { createDraftTimerService } from "./services/draft-timer.js";
import { createMatchService } from "./services/matches.js";
import { createTournamentService } from "./services/tournaments.js";

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error("DISCORD_TOKEN is required");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const db = openDatabase();
const cardImageCacheDir = process.env.CARD_IMAGE_CACHE_DIR ?? "./data/card-images";
const cardImageCacheMaxBytes = Number(process.env.CARD_IMAGE_CACHE_MAX_BYTES ?? "16106127360"); // 15 GB default
const cleanup = createDraftCleanupService(db, { imageCacheDir: cardImageCacheDir });

function buildDraftStatus(draft: Draft) {
  const draftService = deps.drafts;
  const playerService = deps.players;
  const players = draftService.players(draft.id);
  const picks = draftService.picks(draft.id);
  const currentPicks = picks.filter(
    (p) => p.waveNumber === draft.currentPackRound && p.pickStep === draft.currentPickStep,
  );
  const pickedPlayerIds = new Set(currentPicks.map((p) => p.playerId));
  const pickedCount = pickedPlayerIds.size;
  const waitingPlayers = players.filter((p) => !pickedPlayerIds.has(p.playerId));

  const remainingSeconds = draft.pickDeadlineAt
    ? Math.max(0, Math.ceil((new Date(draft.pickDeadlineAt).getTime() - Date.now()) / 1000))
    : 0;

  const embed = new EmbedBuilder()
    .setTitle(draft.name)
    .setColor(
      draft.status === "active" ? 0x3498db : draft.status === "completed" ? 0x2ecc71 : 0xe74c3c,
    );

  if (draft.status === "active") {
    embed.setDescription(`Pack ${draft.currentPackRound}, Pick ${draft.currentPickStep}`);
    embed.addFields(
      { name: "⏱️ Timer", value: `${remainingSeconds}s`, inline: true },
      { name: "✅ Picked", value: `${pickedCount}/${players.length}`, inline: true },
      {
        name: "⏳ Waiting for",
        value:
          waitingPlayers
            .map((p) => playerService.findById(p.playerId)?.displayName ?? "Unknown")
            .join(", ") || "None",
        inline: false,
      },
    );
  } else if (draft.status === "completed") {
    embed.setDescription("Draft completed!");
  } else if (draft.status === "cancelled") {
    embed.setDescription("Draft cancelled.");
  }

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (draft.status === "active") {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`draft_pick:${draft.id}`)
          .setLabel("Pick Card")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`draft_pool:${draft.id}`)
          .setLabel("View My Pool")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return { embed, components };
}

const deps = {
  matches: createMatchService(db),
  players: createPlayerRepository(db),
  tournaments: createTournamentService(db),
  drafts: createDraftService(db),
  cards: createCardCatalogService(db),
  templates: createDraftTemplateService(db),
  draftImages: createDraftImageService({ cacheDir: cardImageCacheDir }),
  cleanup,
  messenger: {
    async postStatus(draft: Draft) {
      const channel = await client.channels.fetch(draft.channelId);

      if (channel?.type !== ChannelType.GuildText) {
        return;
      }

      const { embed, components } = buildDraftStatus(draft);
      const message = await channel.send({ embeds: [embed], components });

      try {
        await message.pin();
      } catch {
        // ignore pin failures
      }

      deps.drafts.setStatusMessageId(draft.id, message.id);
    },

    async updateStatus(draft: Draft) {
      if (!draft.statusMessageId) {
        return;
      }

      const channel = await client.channels.fetch(draft.channelId);

      if (channel?.type !== ChannelType.GuildText) {
        return;
      }

      try {
        const message = await channel.messages.fetch(draft.statusMessageId);
        const { embed, components } = buildDraftStatus(draft);
        await message.edit({ embeds: [embed], components });
      } catch (error) {
        console.warn(`Failed to update draft status message for ${draft.id}`, error);
      }
    },
  } as DraftMessenger,
};

const draftTimer = createDraftTimerService({ drafts: deps.drafts, messenger: deps.messenger });

function toCommandInteraction(
  interaction: ChatInputCommandInteraction,
): CommandInteractionLike {
  return {
    commandName: interaction.commandName,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
    },
    options: {
      getSubcommand: () => interaction.options.getSubcommand(false) ?? "",
      getSubcommandGroup: () => interaction.options.getSubcommandGroup(false) ?? null,
      getString: (name, required = false) => interaction.options.getString(name, required),
      getRole: (name, required = false) => {
        const role = interaction.options.getRole(name, required);

        return role ? { id: role.id, name: role.name } : null;
      },
      getUser: (name, required = false) => {
        const user = interaction.options.getUser(name, required);

        return user ? { id: user.id, username: user.username, displayName: user.displayName } : null;
      },
    },
    reply: async (message) => {
      await interaction.reply(message);
    },
  };
}

function toButtonInteraction(interaction: ButtonInteraction): ButtonInteractionLike {
  return {
    customId: interaction.customId,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
    },
    showModal: async (modal) => {
      await interaction.showModal(modal);
    },
    reply: async (message) => {
      await interaction.reply(message);
    },
  };
}

function toSelectMenuInteraction(interaction: StringSelectMenuInteraction): SelectMenuInteractionLike {
  return {
    customId: interaction.customId,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
    },
    values: interaction.values,
    showModal: async (modal) => {
      await interaction.showModal(modal);
    },
    reply: async (message) => {
      await interaction.reply(message);
    },
  };
}

function toModalInteraction(interaction: ModalSubmitInteraction): ModalInteractionLike {
  return {
    customId: interaction.customId,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
    },
    fields: {
      getTextInputValue: (name) => interaction.fields.getTextInputValue(name),
    },
    reply: async (message) => {
      await interaction.reply(message);
    },
  };
}

function toAutocompleteInteraction(
  interaction: AutocompleteInteraction,
): AutocompleteInteractionLike {
  const focused = interaction.options.getFocused(true);

  return {
    commandName: interaction.commandName,
    guildId: interaction.guildId,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
    },
    options: {
      getSubcommand: () => interaction.options.getSubcommand(false) ?? "",
      getSubcommandGroup: () => interaction.options.getSubcommandGroup(false) ?? null,
      getFocused: () => ({ name: focused.name, value: String(focused.value) }),
    },
    respond: async (choices) => {
      await interaction.respond(choices);
    },
  };
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown bot"}`);

  const setCount = db.prepare("select count(*) as count from card_sets").get() as { count: number };

  if (setCount.count === 0) {
    console.log("Card sets cache is empty. Syncing on startup...");
    deps.cards.syncSets()
      .then((count) => console.log(`Synced ${count} card sets on startup`))
      .catch((error) => console.error("Failed to sync card sets on startup:", error));
  }

  const setsCron = process.env.SETS_SYNC_CRON ?? "0 6 * * *";
  const setsTimezone = process.env.SETS_SYNC_TIMEZONE ?? "UTC";

  cron.schedule(
    setsCron,
    async () => {
      try {
        const count = await deps.cards.syncSets();
        console.log(`Synced ${count} card sets`);
      } catch (error) {
        console.error("Failed to sync card sets:", error);
      }
    },
    { timezone: setsTimezone },
  );

  const imageCleanupCron = process.env.IMAGE_CLEANUP_CRON ?? "0 4 * * *";
  const imageCleanupTimezone = process.env.IMAGE_CLEANUP_TIMEZONE ?? "UTC";

  cron.schedule(
    imageCleanupCron,
    async () => {
      try {
        const currentBytes = await cleanup.imageCacheBytes();
        const maxMb = Math.round(cardImageCacheMaxBytes / 1024 / 1024);
        const currentMb = Math.round(currentBytes / 1024 / 1024);

        if (currentBytes <= cardImageCacheMaxBytes) {
          console.log(`Image cache is ${currentMb}MB / ${maxMb}MB. No cleanup needed.`);
          return;
        }

        const deleted = await cleanup.removeOldestImages(cardImageCacheMaxBytes);
        console.log(`Image cache was ${currentMb}MB / ${maxMb}MB. Deleted ${deleted} oldest images.`);
      } catch (error) {
        console.error("Failed to clean up image cache:", error);
      }
    },
    { timezone: imageCleanupTimezone },
  );

  draftTimer
    .tick()
    .then(() => {
      draftTimer.start();
    })
    .catch((error) => {
      console.error("Failed to run initial draft timer tick:", error);
      draftTimer.start();
    });

  const reminderChannelId = process.env.DISCORD_REMINDER_CHANNEL_ID;
  const reminderCron = process.env.REMINDER_CRON ?? "0 10 * * *";
  const reminderTimezone = process.env.REMINDER_TIMEZONE ?? "UTC";

  if (!reminderChannelId) {
    console.log("DISCORD_REMINDER_CHANNEL_ID is not set; tournament reminders are disabled");
    return;
  }

  cron.schedule(
    reminderCron,
    async () => {
      const channel = await client.channels.fetch(reminderChannelId);

      if (channel?.type !== ChannelType.GuildText) {
        return;
      }

      const reminder = formatTournamentReminder(
        selectTournamentReminderTargets(db, channel.guildId),
      );

      if (!reminder) {
        return;
      }

      await channel.send(reminder);
    },
    { timezone: reminderTimezone },
  );
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButton(toButtonInteraction(interaction), deps);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(toSelectMenuInteraction(interaction), deps);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModal(toModalInteraction(interaction), deps);
      return;
    }

    if (interaction.isAutocomplete()) {
      await handleAutocomplete(toAutocompleteInteraction(interaction), deps);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    await handleCommand(toCommandInteraction(interaction), deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong";

    if (interaction.isAutocomplete()) {
      await interaction.respond([]);
      return;
    }

    if (!interaction.isRepliable()) {
      return;
    }

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, ephemeral: true });
      return;
    }

    await interaction.reply({ content: message, ephemeral: true });
  }
});

await client.login(token);
