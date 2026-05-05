import type { DraftMessenger } from "../commands/handlers.js";
import type { DraftService } from "./drafts.js";

export function createDraftTimerService({
  drafts,
  messenger,
}: {
  drafts: DraftService;
  messenger: DraftMessenger;
}) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(now = new Date()) {
    const activeDrafts = drafts.listActive();

    for (const draft of activeDrafts) {
      if (!draft.pickDeadlineAt) {
        continue;
      }

      const deadline = new Date(draft.pickDeadlineAt);

      if (deadline > now) {
        continue;
      }

      try {
        drafts.expireCurrentPickStep(draft.id, now);
        const updatedDraft = drafts.findById(draft.id);
        await messenger.updateStatus(updatedDraft);
      } catch (error) {
        console.warn(`Draft timer failed to expire pick step for draft ${draft.id}`, error);
      }
    }
  }

  return {
    start() {
      if (intervalId) {
        return;
      }

      intervalId = setInterval(() => tick(), 10000);
    },

    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    tick,
  };
}

export type DraftTimerService = ReturnType<typeof createDraftTimerService>;
