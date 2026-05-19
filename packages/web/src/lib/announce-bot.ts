import { createHmac } from "node:crypto";

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
  | { kind: "match-resolved"; matchId: number };

export type AnnounceResult = { ok: true } | { ok: false; error: string };

export async function announceToBot(
  cfg: { url: string; secret: string },
  payload: AnnouncePayload,
): Promise<AnnounceResult> {
  if (!cfg.url || !cfg.secret) {
    return { ok: false, error: "Announce not configured" };
  }
  const { kind, ...data } = payload;
  const body = JSON.stringify(data);
  const sig = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  try {
    const res = await fetch(`${cfg.url}/internal/announce/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-announce-signature": sig,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const error = `Bot responded ${res.status}${text ? `: ${text}` : ""}`;
      console.warn(`[announce-bot] ${kind}: ${error}`);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Network error";
    console.warn(`[announce-bot] failed for ${kind}:`, err);
    return { ok: false, error };
  }
}
