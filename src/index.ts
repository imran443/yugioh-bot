import "dotenv/config";
import cron from "node-cron";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
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
  type DraftNotifier,
} from "./commands/handlers.js";
import { openDatabase } from "./db/connection.js";
import { createCardCatalogService } from "./services/card-catalog.js";
import { createDraftCleanupService } from "./services/draft-cleanup.js";
import { createDraftImageService } from "./services/draft-images.js";
import { createDraftService } from "./services/drafts.js";
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
const deps = {
  matches: createMatchService(db),
  players: createPlayerRepository(db),
  tournaments: createTournamentService(db),
  drafts: createDraftService(db),
  cards: createCardCatalogService(db),
  templates: createDraftTemplateService(db),
  draftImages: createDraftImageService({ cacheDir: cardImageCacheDir }),
  cleanup,
  notifier: {
    async sendPickPrompt(input: Parameters<DraftNotifier["sendPickPrompt"]>[0]) {
      const channel = await client.channels.fetch(input.channelId);

      if (channel?.type !== ChannelType.GuildText) {
        return;
      }

      await channel.send({
        content: `<@${input.userId}> ${input.draftName} is ready for your next pick.`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`draft_pick:${input.draftId}`)
              .setLabel("Pick Card")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    },
  },
};

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
