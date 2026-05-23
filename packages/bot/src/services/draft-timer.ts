import type { DraftMessenger } from "../commands/handlers.js";
import type { DraftService } from "./drafts.js";
import type { Broadcaster } from "@yugidraft/shared/notify";

export function createDraftTimerService({
  drafts,
  messenger,
  broadcaster,
  onDraftCompleted,
}: {
  drafts: DraftService;
  messenger: DraftMessenger;
  broadcaster: Broadcaster;
  onDraftCompleted?: (draftId: number) => Promise<void>;
}) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(now = new Date()) {
    const activeDrafts = drafts.listActive();

    for (const draft of activeDrafts) {
      if (!draft.pickDeadlineAt) continue;
      const deadline = new Date(draft.pickDeadlineAt);
      if (deadline > now) continue;

      try {
        drafts.expireCurrentPickStep(draft.id, now);
        const updatedDraft = drafts.findById(draft.id);
        await messenger.updateStatus(updatedDraft);

        if (!updatedDraft.webSlug) continue;

        if (updatedDraft.status === "completed") {
          await broadcaster.draft({ kind: "complete", slug: updatedDraft.webSlug });
          if (onDraftCompleted) {
            await onDraftCompleted(updatedDraft.id).catch((err) =>
              console.warn(`[draft-timer] onDraftCompleted failed for ${updatedDraft.id}:`, err),
            );
          }
        } else {
          await broadcaster.draft({
            kind: "resync",
            slug: updatedDraft.webSlug,
            packRound: updatedDraft.currentPackRound,
            pickStep: updatedDraft.currentPickStep,
          });
        }
      } catch (error) {
        console.warn(`Draft timer failed to expire pick step for draft ${draft.id}`, error);
      }
    }
  }

  return {
    start() {
      if (intervalId) return;
      intervalId = setInterval(() => tick(), 1000);
    },
    stop() {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    },
    tick,
  };
}

export type DraftTimerService = ReturnType<typeof createDraftTimerService>;
