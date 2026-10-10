import { httpTransport, type SignedPostTransport } from "@yugidraft/shared/notify";
import { createDuelAccessReader, type DuelEventTarget } from "@yugidraft/shared/services";
import { isReplayFork } from "@yugidraft/shared/duels";

export type NotifyDuelChange = (slug: string, guildId: string) => Promise<void>;

/**
 * Tells the ws server that a duel game changed (for example, its series was
 * closed by a tournament ending) so open duel pages refetch. Never throws.
 */
export function createNotifyDuelChange(transport: SignedPostTransport,
  resolveTarget: (slug: string, guildId: string) => DuelEventTarget | null = createDuelAccessReader().findDuelEventTarget,
): NotifyDuelChange {
  return async (slug, guildId) => {
    try {
      const target = resolveTarget(slug, guildId);
      if (!target || isReplayFork(target)) return;
      const result = await transport.post("/internal/duel/changed", JSON.stringify({ slug: target.slug, guildId: target.guildId }));
      if (!result.ok) {
        console.warn(
          `[notify-duel] /internal/duel/changed -> ${result.status}${result.text ? ` ${result.text}` : ""}`,
        );
      }
    } catch (error) {
      console.warn("[notify-duel] /internal/duel/changed failed", error);
    }
  };
}

export function createHttpNotifyDuelChange(cfg: { url: string; secret: string }): NotifyDuelChange {
  return createNotifyDuelChange(httpTransport(cfg));
}
