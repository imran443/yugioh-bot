import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commandDefinitions } from "./commands/definitions.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  throw new Error("DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID are required");
}

const rest = new REST({ version: "10" }).setToken(token);

await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
  body: commandDefinitions,
});

console.log(`Deployed ${commandDefinitions.length} guild commands`);
