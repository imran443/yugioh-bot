import { ChannelType, type Client } from "discord.js";
import type Database from "better-sqlite3";
import type { DraftMessenger } from "../commands/handlers.js";
import { assertDuelInviteTarget, createDraftLobbyService, isTestBotDiscordId, type DraftLobbyService } from "@yugidraft/shared/services";
import type { DraftService } from "../services/drafts.js";
import type { AnnounceHandlers } from "./server.js";
import type { GuildSettingsService } from "@yugidraft/shared/services";
import {
  draftCreatedAnnouncement,
  draftStartedAnnouncement,
  draftNudgeAnnouncement,
  draftCompletedAnnouncement,
  tournamentCreatedAnnouncement,
  tournamentStartedAnnouncement,
  reportPendingAnnouncement,
  duelInviteMessage,
} from "./messages.js";
import { announceTournamentCompleted } from "../lib/announce-tournament-completed.js";
import { deleteNotifyMessage } from "../lib/notify-message.js";

export function createAnnounceHandlers({
  client,
  db,
  guildSettings,
  drafts,
  messenger,
  lobby,
}: {
  client: Pick<Client, "channels" | "users">;
  db: Database.Database;
  drafts: DraftService;
  messenger: DraftMessenger;
  guildSettings: GuildSettingsService;
  lobby?: Pick<DraftLobbyService, "read">;
}): AnnounceHandlers {
  async function onDraftStatus({ draftId }: { draftId: number }): Promise<void> {
    if (!Number.isSafeInteger(draftId) || draftId <= 0) throw new Error("Invalid draft ID");
    const draft = drafts.findById(draftId);
    if (draft.channelId) await messenger.updateStatus(draft);
  }

  return {
    onDraftStatus,
    async onDraftCreated({ channelId, name, webSlug }) {
      if (process.env.DISCORD_BOT_ENABLED !== "1" || !channelId) return;
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;
      await channel.send(draftCreatedAnnouncement({ name, webSlug }));
    },
    async onDraftStarted({ draftId }) {
      if (process.env.DISCORD_BOT_ENABLED !== "1") return;
      const draft = drafts.findById(draftId);
      if (!draft.channelId) return;
      if (draft.status !== "active" || !draft.webSlug) throw new Error("Draft has not started");
      const channel = await client.channels.fetch(draft.channelId);
      if (channel?.type !== ChannelType.GuildText || channel.guildId !== draft.guildId) {
        throw new Error("Draft channel is unavailable in its guild");
      }
      // Status delivery and the started announcement can fail independently.
      try {
        if (draft.statusMessageId) await messenger.updateStatus(draft);
        else await messenger.postStatus(draft);
      } catch (error) {
        console.warn(`[announce] draft status failed for ${draft.id}:`, error);
      }
      await channel.send(draftStartedAnnouncement({ name: draft.name, webSlug: draft.webSlug }));
    },
    async onDraftNudge(payload) {
      if (!payload || !Number.isSafeInteger(payload.draftId) || payload.draftId <= 0 ||
        !Array.isArray(payload.mentionUserIds) || payload.mentionUserIds.some(id => typeof id !== "string")) {
        throw new Error("Invalid draft Nudge payload");
      }
      const loadDraft = () => {
        const row = db.prepare("select id, guild_id, channel_id, name, web_slug, status, created_by_user_id from drafts where id = ?")
          .get(payload.draftId) as { id: number; guild_id: string; channel_id: string; name: string; web_slug: string | null; status: string; created_by_user_id: number } | undefined;
        if (!row || row.status !== "pending" || !row.web_slug) throw new Error("Draft is no longer pending");
        return row;
      };
      const initial = loadDraft();
      const channel = await client.channels.fetch(initial.channel_id);
      const draft = loadDraft();
      if (channel?.type !== ChannelType.GuildText || channel.guildId !== draft.guild_id || draft.channel_id !== initial.channel_id) {
        throw new Error("Draft channel is unavailable in its guild");
      }
      // Fetching Discord can yield to Ready/Leave/Start, so re-read the current roster afterwards.
      const state = (lobby ?? createDraftLobbyService(db)).read(draft.id, draft.created_by_user_id);
      const unready = new Set(state.players.filter(player => !player.ready && !player.isBot).map(player => player.playerId));
      const requested = new Set(payload.mentionUserIds);
      const members = db.prepare(`select p.id, u.discord_user_id from draft_players dp join players p on p.id = dp.player_id join users u on u.id = p.user_id
        where dp.draft_id = ? and p.guild_id = ?`).all(draft.id, draft.guild_id) as Array<{ id: number; discord_user_id: string | null }>;
      const validatedIds = [...new Set(members.filter(member => unready.has(member.id) && member.discord_user_id !== null && requested.has(member.discord_user_id) &&
        !isTestBotDiscordId(member.discord_user_id) && /^[1-9]\d{16,19}$/.test(member.discord_user_id) &&
        BigInt(member.discord_user_id) <= 18_446_744_073_709_551_615n).map(member => member.discord_user_id!))].slice(0, 100);
      // Send errors propagate to the signed endpoint and release the web cooldown reservation.
      await channel.send(draftNudgeAnnouncement({ name: draft.name, webSlug: draft.web_slug!, mentionUserIds: validatedIds }));
    },
    async onDraftCompleted({ draftId }) {
      const draft = drafts.findById(draftId);
      if (draft.status !== "completed" || !draft.channelId || !draft.webSlug) return;
      // Delivery is at-most-once: claim before Discord I/O, and never retry a failed send.
      const claimed = db.prepare(`update drafts set complete_message_id='worker-claimed'
        where id=? and status='completed' and complete_message_id is null`).run(draftId).changes === 1;
      if (!claimed) return;
      const skip = (reason: string) => {
        db.prepare("update drafts set complete_message_id='skipped' where id=? and complete_message_id='worker-claimed'")
          .run(draftId);
        console.error(`[announce] draft completion skipped for ${draftId}: ${reason}`);
      };
      let channel;
      try {
        channel = await client.channels.fetch(draft.channelId);
      } catch (error) {
        skip(`channel fetch failed (${String(error)})`);
        return;
      }
      if (channel?.type !== ChannelType.GuildText) {
        skip("channel is missing or is not a guild text channel");
        return;
      }
      try {
        const msg = await channel.send(draftCompletedAnnouncement({ name: draft.name, webSlug: draft.webSlug }));
        db.prepare("update drafts set complete_message_id=? where id=? and complete_message_id='worker-claimed'")
          .run(msg.id, draftId);
      } catch (error) {
        console.error(`[announce] draft completion delivery failed for ${draftId}:`, error);
      }
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

    async onTournamentCompleted({ tournamentId }) {
      await announceTournamentCompleted(client, db, guildSettings, tournamentId);
    },

    async onDuelInvite(payload) {
      assertDuelInviteTarget(db, payload);
      const { opponentDiscordUserId, challengerName, duelName, bestOf, ranked, tournamentName, url } = payload;
      // A closed DM or an unknown user must not fail the announce call.
      try {
        const user = await client.users.fetch(opponentDiscordUserId);
        await user.send(duelInviteMessage({ challengerName, duelName, bestOf, ranked, tournamentName, url }));
      } catch (err) {
        console.warn(`[announce] could not DM duel invite to ${opponentDiscordUserId}:`, err);
      }
    },
  };
}
