import { ChannelType, type Client } from "discord.js";
import type Database from "better-sqlite3";
import type { DraftMessenger } from "../commands/handlers.js";
import type { DraftService } from "../services/drafts.js";
import type { AnnounceHandlers } from "./server.js";
import {
  draftCreatedAnnouncement,
  draftCompletedAnnouncement,
  tournamentCreatedAnnouncement,
  tournamentStartedAnnouncement,
} from "./messages.js";

export function createAnnounceHandlers({
  client,
  db,
}: {
  client: Pick<Client, "channels">;
  db: Database.Database;
  drafts: DraftService;
  messenger: DraftMessenger;
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
    async onTournamentCreated({ channelId, name, format, webSlug }) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;
      await channel.send(tournamentCreatedAnnouncement({ name, format, webSlug }));
    },
    async onTournamentStarted({ channelId, name, webSlug }) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;
      await channel.send(tournamentStartedAnnouncement({ name, webSlug }));
    },
  };
}
