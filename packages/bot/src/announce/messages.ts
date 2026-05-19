import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const DEFAULT_WEB_URL = "http://localhost:3000";

function webBaseUrl(webUrl?: string): string {
  return (webUrl?.trim() || process.env.WEB_URL?.trim() || DEFAULT_WEB_URL).replace(/\/+$/, "");
}

export function draftCreatedAnnouncement(input: { name: string; webSlug: string; webUrl?: string }): string {
  return `Signups are open for **${input.name}**. Pick cards: ${webBaseUrl(input.webUrl)}/draft/${input.webSlug}`;
}

export function tournamentCreatedAnnouncement(input: {
  name: string;
  format: string;
  webSlug: string;
  organizerUserId: string;
  participantCount: number;
  webUrl?: string;
}): string {
  const formatLabel = input.format === "round_robin" ? "Round Robin" : input.format === "single_elim" ? "Single Elimination" : input.format;
  return [
    `🏆 **${input.name}** — Signups open`,
    `Format: ${formatLabel} · Pending — ${input.participantCount} participant${input.participantCount === 1 ? "" : "s"}`,
    `Organizer: <@${input.organizerUserId}>`,
    `Join: ${webBaseUrl(input.webUrl)}/tournament/${input.webSlug}`,
  ].join("\n");
}

export function tournamentStartedAnnouncement(input: { name: string; webSlug: string; webUrl?: string }): string {
  return `**${input.name}** has started. Bracket: ${webBaseUrl(input.webUrl)}/tournament/${input.webSlug}`;
}

export function draftCompletedAnnouncement(input: { name: string; webSlug: string; webUrl?: string }): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    content: `**${input.name}** has completed! View results: ${webBaseUrl(input.webUrl)}/draft/${input.webSlug}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`draft:create-tournament:${input.webSlug}`)
          .setLabel("Create Tournament")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

export function reportPendingAnnouncement(input: {
  matchId: number;
  tournamentName: string;
  roundNumber: number;
  reporterName: string;
  opponentDiscordId: string;
  opponentLost: boolean;
}): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const verb = input.opponentLost ? "lost" : "won";
  return {
    content:
      `<@${input.opponentDiscordId}> — **${input.reporterName}** reported that you **${verb}** ` +
      `Round ${input.roundNumber} of **${input.tournamentName}**. Approve or deny:`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`dashboard_approve:${input.matchId}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`dashboard_deny:${input.matchId}`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}
