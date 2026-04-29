import "dotenv/config";
import cron from "node-cron";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { handleCommand, type CommandInteractionLike } from "./commands/handlers.js";
import { openDatabase } from "./db/connection.js";
import {
  handleAutocomplete,
  type AutocompleteInteractionLike,
} from "./interactions/autocomplete.js";
import { handleButton, type ButtonInteractionLike } from "./interactions/buttons.js";
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
const deps = {
  matches: createMatchService(db),
  players: createPlayerRepository(db),
  tournaments: createTournamentService(db),
};

function toCommandInteraction(
  interaction: ChatInputCommandInteraction,
): CommandInteractionLike {
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
    guildId: interaction.guildId,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
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
      getFocused: () => ({ name: focused.name, value: String(focused.value) }),
    },
    respond: async (choices) => {
      await interaction.respond(choices);
    },
  };
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown bot"}`);

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
