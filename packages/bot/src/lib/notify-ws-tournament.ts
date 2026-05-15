import { createHmac } from "node:crypto";
import type { TournamentBroadcastPayload } from "@yugidraft/shared/ws";

export async function notifyWsTournament(
  cfg: { url: string; secret: string },
  payload: TournamentBroadcastPayload,
): Promise<void> {
  if (!cfg.url || !cfg.secret) return;
  const { kind, ...data } = payload;
  const body = JSON.stringify(data);
  const sig = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  try {
    const res = await fetch(`${cfg.url}/internal/tournament/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-announce-signature": sig },
      body,
    });
    if (!res.ok) console.warn(`[bot/notify-ws-tournament] non-2xx for ${kind}: ${res.status}`);
  } catch (err) {
    console.warn(`[bot/notify-ws-tournament] failed for ${kind}:`, err);
  }
}
