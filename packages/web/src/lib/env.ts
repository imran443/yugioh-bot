export const env = {
  discordGuildId: process.env.DISCORD_GUILD_ID ?? "",
  discordDefaultChannelId: process.env.DISCORD_DEFAULT_CHANNEL_ID ?? process.env.DISCORD_REMINDER_CHANNEL_ID ?? "",
  botAnnounceUrl: process.env.BOT_ANNOUNCE_URL ?? "",
  botAnnounceSecret: process.env.BOT_ANNOUNCE_SECRET ?? "",
  wsInternalUrl: process.env.WS_INTERNAL_URL ?? "",
  wsInternalSecret: process.env.WS_INTERNAL_SECRET ?? "",
};