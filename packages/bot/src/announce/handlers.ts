import { ChannelType, type Client } from "discord.js";
import type { DraftMessenger } from "../commands/handlers.js";
import type { DraftService } from "../services/drafts.js";
import type { AnnounceHandlers } from "./server.js";
import {
  draftCreatedAnnouncement,
  tournamentCreatedAnnouncement,
  tournamentStartedAnnouncement,
} from "./messages.js";

export function createAnnounceHandlers({
  client,
}: {
  client: Pick<Client, "channels">;
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
