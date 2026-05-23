import type { TournamentDetail } from "./types";

export function OverviewProgress({ tournament }: { tournament: TournamentDetail }) {
  const allRounds = tournament.matches.map((m) => m.roundNumber);
  const maxRound = allRounds.length > 0 ? Math.max(...allRounds) : 0;
  const completedMatches = tournament.matches.filter((m) => m.status === "completed").length;
  const totalMatches = tournament.matches.length;

  // Round numbers are a real, sequential bracket concept only for single elimination.
  // For round-robin all rounds are generated up front and played in any order, so the
  // "current round" is a meaningless scheduling artifact — show progress only.
  const roundsAreMeaningful = tournament.format === "single_elim";
  const incompleteRounds = tournament.matches
    .filter((m) => m.status !== "completed")
    .map((m) => m.roundNumber);
  const currentRound = incompleteRounds.length > 0 ? Math.min(...incompleteRounds) : maxRound;

  if (totalMatches === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
        Progress
      </h2>
      <p className="text-sm text-text-secondary">
        {roundsAreMeaningful && maxRound > 0 ? (
          <>
            <span className="font-semibold text-text-primary">
              Round {currentRound} of {maxRound}
            </span>
            {" · "}
            {completedMatches}/{totalMatches} matches done
          </>
        ) : (
          <span className="font-semibold text-text-primary">
            {completedMatches}/{totalMatches} matches done
          </span>
        )}
      </p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-deep">
        <div
          className="h-full bg-accent-primary motion-safe:transition-all motion-safe:duration-300"
          style={{ width: `${(completedMatches / totalMatches) * 100}%` }}
        />
      </div>
    </section>
  );
}
