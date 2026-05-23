export type AnnouncePayload =
  | { kind: "draft-created"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "draft-started"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "draft-completed"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "tournament-created"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string; organizerUserId: string; participantCount: number }
  | { kind: "tournament-started"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string }
  | {
      kind: "match-report-pending";
      guildId: string;
      slug: string;
      matchId: number;
      tournamentMatchId: number;
      tournamentName: string;
      roundNumber: number;
      reporterDiscordId: string;
      opponentDiscordId: string;
      reporterName: string;
      opponentName: string;
      opponentLost: boolean;
    }
  | { kind: "match-resolved"; matchId: number }
  | { kind: "tournament-completed"; tournamentId: number };

export type AnnounceResult = { ok: true } | { ok: false; error: string };
