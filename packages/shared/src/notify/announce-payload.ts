/** Signed POST /internal/announce/draft-nudge; the bot revalidates channel and mentions. */
export interface DraftNudgeAnnouncePayload {
  kind: "draft-nudge";
  draftId: number;
  channelId: string;
  name: string;
  webSlug: string;
  mentionUserIds: string[];
}

export type AnnouncePayload =
  | { kind: "draft-status"; draftId: number }
  | { kind: "draft-created"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "draft-started"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "draft-completed"; draftId: number; channelId: string; name: string; webSlug: string }
  | DraftNudgeAnnouncePayload
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
  | {
      kind: "duel-invite";
      /** Stored target, resolved by the sender and checked again by the bot. */
      duelId: number;
      slug: string;
      guildId: string;
      /** The player the bot DMs. */
      opponentDiscordUserId: string;
      challengerName: string;
      duelName: string;
      bestOf: 1 | 3;
      ranked: boolean;
      /** Set for a tournament game; the DM shows it instead of Ranked/Unranked. */
      tournamentName: string | null;
      /** Public web link to the duel room. */
      url: string;
    }
  | { kind: "match-resolved"; matchId: number }
  | { kind: "tournament-completed"; tournamentId: number };

export type AnnounceResult = { ok: true } | { ok: false; error: string };

export interface DuelInviteReference {
  duelId: number;
  slug: string;
  guildId: string;
  url: string;
}

/** Reject an unbound URL, including a source reference that points to a fork link. */
export function isDuelInviteReference(value: unknown): value is DuelInviteReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.duelId !== "number" || !Number.isSafeInteger(ref.duelId) || ref.duelId <= 0
    || typeof ref.slug !== "string" || !/^[a-zA-Z0-9_-]+$/.test(ref.slug)
    || typeof ref.guildId !== "string" || !ref.guildId || typeof ref.url !== "string") return false;
  try {
    const url = new URL(ref.url);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === `/duels/${ref.slug}`
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}
