import type { Match, MatchService, TournamentService } from "@yugidraft/shared/services";
import type { Tournament } from "@yugidraft/shared/types";

export function createTournamentTimerService({
  tournaments,
  matches,
  onMatchAutoResolved,
  onTournamentClosed,
}: {
  tournaments: TournamentService;
  matches: MatchService;
  onMatchAutoResolved: (match: Match) => Promise<void>;
  onTournamentClosed: (tournament: Tournament) => Promise<void>;
}) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(now = new Date()) {
    const nowIso = now.toISOString();

    // 1. Auto-confirm overdue pending reports (before deadline sweep so a match
    //    whose window elapsed can complete its tournament naturally first).
    for (const overdue of matches.findOverduePendingConfirmations(nowIso)) {
      try {
        const resolved = matches.autoApprove(overdue.id);
        await onMatchAutoResolved(resolved);
      } catch (error) {
        console.warn(`[tournament-timer] auto-approve failed for match ${overdue.id}`, error);
      }
    }

    // 2. Auto-close tournaments past their deadline ("close as-is").
    for (const tournament of tournaments.findOverdueActive(nowIso)) {
      try {
        const closed = tournaments.closeForDeadline(tournament.id);
        await onTournamentClosed(closed);
      } catch (error) {
        console.warn(`[tournament-timer] close failed for tournament ${tournament.id}`, error);
      }
    }
  }

  return {
    start() {
      if (intervalId) return;
      intervalId = setInterval(() => tick(), 60_000);
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

export type TournamentTimerService = ReturnType<typeof createTournamentTimerService>;
