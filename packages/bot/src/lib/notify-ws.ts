import { createHmac } from "node:crypto";

export async function notifyWs(
  cfg: { url: string; secret: string },
  kind: string,
  slug: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!cfg.url || !cfg.secret) return;
  const body = JSON.stringify({ slug, ...extra });
  const sig = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  try {
    const res = await fetch(`${cfg.url}/internal/draft/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-announce-signature": sig,
      },
      body,
    });
    if (!res.ok) console.warn(`[bot/notify-ws] non-2xx for ${kind}: ${res.status}`);
  } catch (err) {
    console.warn(`[bot/notify-ws] failed for ${kind}:`, err);
  }
}
