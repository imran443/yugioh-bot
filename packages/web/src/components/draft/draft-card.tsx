import Link from "next/link";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface DraftCardProps {
  id: number;
  name: string;
  status: string;
  currentPackRound: number;
  currentPickStep: number;
  playerCount: number;
  webSlug?: string;
  createdAt?: string;
  endedAt?: string;
}

export function DraftCard({ draft }: { draft: DraftCardProps }) {
  const statusVariant =
    draft.status === "active"
      ? "success"
      : draft.status === "pending"
        ? "warning"
        : draft.status === "cancelled"
          ? "danger"
          : "default";

  const statusLabel =
    draft.status === "completed"
      ? "Completed"
      : draft.status === "cancelled"
        ? "Cancelled"
        : draft.status.charAt(0).toUpperCase() + draft.status.slice(1);

  const isLinkable = draft.webSlug && (draft.status === "active" || draft.status === "pending" || draft.status === "completed" || draft.status === "cancelled");

  const card = (
    <div className="rounded-xl border border-border bg-surface p-5 motion-safe:transition-colors hover:border-accent-primary/30 hover:bg-bg-elevated">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-body text-lg font-semibold text-text-primary">
            {draft.name}
          </h3>
          <div className="mt-2 flex items-center gap-3">
            <Badge variant={statusVariant}>{statusLabel}</Badge>
            {draft.status === "active" && (
              <span className="text-sm text-text-muted">
                Pack {draft.currentPackRound}, Pick {draft.currentPickStep}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Users className="h-4 w-4" />
          <span>{draft.playerCount} players</span>
        </div>
        {isLinkable && (
          <span className="text-sm font-semibold text-accent-primary hover:text-accent-secondary">
            {draft.status === "active" ? "Open Draft Room →" : draft.status === "pending" ? "Manage Draft →" : draft.status === "cancelled" ? "View Summary →" : "View Deck →"}
          </span>
        )}
      </div>
    </div>
  );

  if (isLinkable) {
    return (
      <Link href={`/draft/${draft.webSlug}`} className="block">
        {card}
      </Link>
    );
  }

  return card;
}