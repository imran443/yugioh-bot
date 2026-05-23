import { History } from "lucide-react";
import { formatMatchTime } from "@/lib/format-date";
import type { Match } from "./types";

export function OverviewRecentResults({ matches }: { matches: Match[] }) {
  const completed = matches
    .filter((m) => m.status === "completed" && m.winnerId != null)
    .sort((a, b) => {
      const ta = a.resolvedAt ? Date.parse(a.resolvedAt) : 0;
      const tb = b.resolvedAt ? Date.parse(b.resolvedAt) : 0;
      return tb - ta;
    })
    .slice(0, 5);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4 text-text-secondary" />
        <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
          Recent results
        </h2>
      </div>
      {completed.length === 0 ? (
        <p className="text-sm text-text-muted">No results yet — completed matches will show up here.</p>
      ) : (
        <ul className="space-y-2">
          {completed.map((m) => {
            const winnerName = m.winnerId === m.playerOneId ? m.playerOneName : m.playerTwoName;
            const loserName = m.winnerId === m.playerOneId ? m.playerTwoName : m.playerOneName;
            const when = formatMatchTime(m.resolvedAt);
            return (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 border-t border-border pt-2 text-sm first:border-t-0 first:pt-0"
              >
                <span className="min-w-0 truncate text-text-primary">
                  <span className="font-semibold text-accent-success">{winnerName}</span>
                  <span className="text-text-muted"> def. </span>
                  <span className="text-text-secondary">{loserName ?? "—"}</span>
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                  R{m.roundNumber}
                  {when ? ` · ${when}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
