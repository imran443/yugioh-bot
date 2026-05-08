import { createHmac } from "node:crypto";
import type { DraftBroadcastPayload } from "@yugidraft/shared/ws";

export type { DraftBroadcastPayload };

export async function notifyWs(
  cfg: { url: string; secret: string },
  payload: DraftBroadcastPayload,
): Promise<void> {
  if (!cfg.url || !cfg.secret) return;
  const { kind, ...data } = payload;
  const body = JSON.stringify(data);
  const sig = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  void Promise.resolve()
    .then(() =>
      fetch(`${cfg.url}/internal/draft/${kind}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-announce-signature": sig,
        },
        body,
      }),
    )
    .then((res) => {
      if (!res.ok) console.warn(`[notify-ws] non-2xx for ${kind}: ${res.status}`);
    })
    .catch((err) => {
      console.warn(`[notify-ws] failed for ${kind}:`, err);
    });
}
