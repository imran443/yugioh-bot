import { formatMatchTime } from "@/lib/format-date";
import type { TournamentDetail } from "./types";

function formatLabel(format: string): string {
  if (format === "round_robin") return "Round Robin";
  if (format === "single_elim") return "Single Elimination";
  return format;
}

export function OverviewInfo({ tournament }: { tournament: TournamentDetail }) {
  const started = formatMatchTime(tournament.startedAt);
  const rows: Array<{ label: string; value: string }> = [
    { label: "Format", value: formatLabel(tournament.format) },
    { label: "Started", value: started || "—" },
    { label: "Players", value: String(tournament.participants.length) },
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
        Details
      </h2>
      <dl className="space-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3">
            <dt className="text-text-muted">{row.label}</dt>
            <dd className="text-text-primary">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
