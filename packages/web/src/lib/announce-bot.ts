import { createHmac } from "node:crypto";

export type AnnouncePayload =
  | { kind: "draft-created"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "draft-started"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "draft-completed"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "tournament-created"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string }
  | { kind: "tournament-started"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string };

export async function announceToBot(
  cfg: { url: string; secret: string },
  payload: AnnouncePayload,
): Promise<void> {
  if (!cfg.url || !cfg.secret) return;
  const { kind, ...data } = payload;
  const body = JSON.stringify(data);
  const sig = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  void Promise.resolve()
    .then(() =>
      fetch(`${cfg.url}/internal/announce/${kind}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-announce-signature": sig,
        },
        body,
      }),
    )
    .then((res) => {
      if (!res.ok) console.warn(`[announce-bot] non-2xx for ${kind}: ${res.status}`);
    })
    .catch((err) => {
      console.warn(`[announce-bot] failed for ${kind}:`, err);
    });
}
