import Link from "next/link";
import { Users, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface TournamentCardProps {
  id: number;
  name: string;
  format: string;
  status: string;
  participantCount: number;
  webSlug?: string;
}

export function TournamentCard({ tournament }: { tournament: TournamentCardProps }) {
  const statusVariant =
    tournament.status === "active"
      ? "success"
      : tournament.status === "pending"
        ? "warning"
        : "default";

  const formatLabel =
    tournament.format === "round_robin"
      ? "Round Robin"
      : tournament.format === "single_elim"
        ? "Single Elimination"
        : tournament.format;

  return (
    <Link
      href={`/tournament/${tournament.webSlug ?? tournament.id}`}
      className="group block rounded-xl border border-border bg-surface p-5 motion-safe:transition-colors hover:border-accent-primary/30 hover:bg-bg-elevated"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-body text-lg font-semibold text-text-primary">
            {tournament.name}
          </h3>
          <div className="mt-2 flex items-center gap-3">
            <Badge variant={statusVariant}>{tournament.status}</Badge>
            <span className="text-sm text-text-muted">{formatLabel}</span>
          </div>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-text-muted motion-safe:transition-transform group-hover:translate-x-1" />
      </div>
      <div className="mt-4 flex items-center gap-2 text-sm text-text-secondary">
        <Users className="h-4 w-4" />
        <span>{tournament.participantCount} participants</span>
      </div>
    </Link>
  );
}