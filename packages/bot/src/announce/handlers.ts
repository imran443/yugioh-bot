import { ChannelType, type Client } from "discord.js";
import type Database from "better-sqlite3";
import type { DraftMessenger } from "../commands/handlers.js";
import type { DraftService } from "../services/drafts.js";
import type { AnnounceHandlers } from "./server.js";
import type { GuildSettingsService } from "@yugidraft/shared/services";
import {
  draftCreatedAnnouncement,
  draftCompletedAnnouncement,
  tournamentCreatedAnnouncement,
  tournamentStartedAnnouncement,
  reportPendingAnnouncement,
} from "./messages.js";
import { deleteNotifyMessage } from "../lib/notify-message.js";

export function createAnnounceHandlers({
  client,
  db,
  guildSettings,
}: {
  client: Pick<Client, "channels">;
  db: Database.Database;
  drafts: DraftService;
  messenger: DraftMessenger;
  guildSettings: GuildSettingsService;
}): AnnounceHandlers {
  return {
    async onDraftCreated({ channelId, name, webSlug }) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;
      await channel.send(draftCreatedAnnouncement({ name, webSlug }));
    },
    async onDraftStarted() {
      return;
    },
    async onDraftCompleted({ draftId, channelId, name, webSlug }) {
      const existing = db
        .prepare("select complete_message_id from drafts where id = ?")
        .get(draftId) as { complete_message_id: string | null } | undefined;
      if (existing?.complete_message_id) return; // already posted

      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;

      const msg = await channel.send(draftCompletedAnnouncement({ name, webSlug }));
      db.prepare("update drafts set complete_message_id = ? where id = ?").run(msg.id, draftId);
    },
    async onTournamentCreated({ channelId, name, format, webSlug, organizerUserId, participantCount }) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;
      await channel.send(
        tournamentCreatedAnnouncement({ name, format, webSlug, organizerUserId, participantCount }),
      );
    },
    async onTournamentStarted({ channelId, name, webSlug }) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;
      await channel.send(tournamentStartedAnnouncement({ name, webSlug }));
    },

    async onMatchReportPending(p) {
      const channelId = guildSettings.get(p.guildId).announceChannelId;
      if (!channelId) return;
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || !channel.isTextBased()) return;
      const msg = await channel.send(
        reportPendingAnnouncement({
          matchId: p.matchId,
          tournamentName: p.tournamentName,
          roundNumber: p.roundNumber,
          reporterName: p.reporterName,
          opponentDiscordId: p.opponentDiscordId,
          opponentLost: p.opponentLost,
        }),
      );
      db.prepare(
        "update matches set notify_channel_id = ?, notify_message_id = ? where id = ?",
      ).run(channelId, msg.id, p.matchId);
    },

    async onMatchResolved(p) {
      await deleteNotifyMessage(client, db, p.matchId);
    },
  };
}
