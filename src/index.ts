import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { handleCommand, type CommandInteractionLike } from "./commands/handlers.js";
import { openDatabase } from "./db/connection.js";
import { createPlayerRepository } from "./repositories/players.js";
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

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown bot"}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    const commandInteraction: CommandInteractionLike = {
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
        getUser: (name, required = false) => {
          const user = interaction.options.getUser(name, required);

          return user
            ? { id: user.id, username: user.username, displayName: user.displayName }
            : null;
        },
      },
      reply: async (message) => {
        await interaction.reply(message);
      },
    };

    await handleCommand(commandInteraction, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong";

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, ephemeral: true });
      return;
    }

    await interaction.reply({ content: message, ephemeral: true });
  }
});

await client.login(token);
