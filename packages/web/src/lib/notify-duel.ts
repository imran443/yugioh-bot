import { httpTransport } from "@yugidraft/shared/notify";
import { findDuelEventTarget } from "@yugidraft/shared/services";
import { getDb } from "./db";
import { env } from "./env";

export async function notifyDuelChange(slug: string, guildId: string): Promise<void> {
  try {
    const target = findDuelEventTarget(getDb(), slug, guildId);
    if (!target) return;
    const result = await httpTransport({
      url: env.wsInternalUrl,
      secret: env.wsInternalSecret,
    }).post("/internal/duel/changed", JSON.stringify({ slug: target.slug, guildId: target.guildId }));
    if (!result.ok) {
      console.warn(
        `[notify-duel] /internal/duel/changed -> ${result.status}${result.text ? ` ${result.text}` : ""}`,
      );
    }
  } catch (error) {
    console.warn("[notify-duel] /internal/duel/changed failed", error);
  }
}
