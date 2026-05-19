import type { Client } from "discord.js";
import type Database from "better-sqlite3";
import type { GuildSettingsService } from "@yugidraft/shared/services";
import { tournamentCompletedAnnouncement } from "../announce/messages.js";

export async function announceTournamentCompleted(
  client: Pick<Client, "channels">,
  db: Database.Database,
  guildSettings: GuildSettingsService,
  tournamentId: number,
): Promise<void> {
  const t = db
    .prepare("select name, web_slug, guild_id from tournaments where id = ?")
    .get(tournamentId) as { name: string; web_slug: string | null; guild_id: string } | undefined;
  if (!t?.web_slug) return;
  const channelId = guildSettings.get(t.guild_id).announceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !("send" in channel) || !channel.isTextBased()) return;
  await channel.send(tournamentCompletedAnnouncement({ name: t.name, webSlug: t.web_slug }));
}
