import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error("DISCORD_TOKEN is required");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown bot"}`);
});

await client.login(token);
