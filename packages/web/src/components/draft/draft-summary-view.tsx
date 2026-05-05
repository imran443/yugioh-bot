"use client";

import * as React from "react";
import { Clock, Download, Layers, Package, User, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface DraftSummaryViewProps {
  draft: {
    id: number;
    name: string;
    status: string;
    createdByUserId: string;
    createdAt: string;
    startedAt?: string;
    endedAt?: string;
    config: {
      packSize?: number;
      packsPerPlayer?: number;
      pickSeconds?: number;
      setNames?: string[];
    };
    players: Array<{
      playerId: number;
      displayName: string;
      seatIndex?: number;
      pickCount: number;
      finishedAt?: string;
      joinedAt: string;
    }>;
    playerCount: number;
  };
  isParticipant: boolean;
  onExportYdk: () => Promise<string>;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DraftSummaryView({
  draft,
  isParticipant,
  onExportYdk,
}: DraftSummaryViewProps) {
  const [exporting, setExporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isCompleted = draft.status === "completed";
  const statusLabel = isCompleted ? "Completed" : "Cancelled";
  const statusVariant = isCompleted ? ("success" as const) : ("danger" as const);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const ydkContent = await onExportYdk();
      const blob = new Blob([ydkContent], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${draft.name.replace(/\s+/g, "_")}.ydk`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export YDK");
    } finally {
      setExporting(false);
    }
  };

  const sortedPlayers = [...draft.players].sort((a, b) => {
    if (a.seatIndex !== undefined && b.seatIndex !== undefined) {
      return a.seatIndex - b.seatIndex;
    }
    return 0;
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {error && (
        <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-xl text-text-primary sm:text-2xl">
              {draft.name}
            </h1>
            <div className="mt-2 flex items-center gap-3">
              <Badge variant={statusVariant}>{statusLabel}</Badge>
              {draft.endedAt && (
                <span className="flex items-center gap-1 text-sm text-text-secondary">
                  <Clock className="h-3.5 w-3.5" />
                  {formatDate(draft.endedAt)}
                </span>
              )}
            </div>
          </div>
          {isCompleted && isParticipant && (
            <Button
              variant="primary"
              size="sm"
              loading={exporting}
              onClick={handleExport}
            >
              <Download className="h-4 w-4" />
              Export YDK
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-6">
        <h2 className="mb-4 font-display text-lg text-text-primary">
          <Users className="mr-2 inline h-5 w-5 text-accent-primary" />
          Players ({draft.playerCount})
        </h2>
        {draft.players.length === 0 ? (
          <p className="text-sm text-text-secondary">No players were in this draft.</p>
        ) : (
          <ul className="flex flex-col gap-2" role="list">
            {sortedPlayers.map((player) => (
              <li
                key={player.playerId}
                className="flex items-center gap-3 rounded-lg border border-border bg-bg-elevated/50 p-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-text-secondary">
                  <User className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-text-primary">
                    {player.displayName}
                  </span>
                  {player.seatIndex !== undefined && player.seatIndex !== null && (
                    <span className="ml-2 text-xs text-text-muted">
                      Seat {player.seatIndex + 1}
                    </span>
                  )}
                </div>
                <span className="shrink-0 rounded-full bg-accent-primary/10 px-2.5 py-0.5 text-xs font-semibold text-accent-primary">
                  {player.pickCount} {player.pickCount === 1 ? "pick" : "picks"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-border bg-surface p-6">
        <h2 className="mb-4 font-display text-lg text-text-primary">
          <Layers className="mr-2 inline h-5 w-5 text-accent-primary" />
          Configuration
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
            <span className="block text-xs text-text-muted">
              <Package className="mr-1 inline h-3.5 w-3.5" />
              Pack Size
            </span>
            <span className="mt-1 block text-lg font-semibold text-text-primary">
              {draft.config.packSize ?? "—"}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
            <span className="block text-xs text-text-muted">
              <Package className="mr-1 inline h-3.5 w-3.5" />
              Packs/Player
            </span>
            <span className="mt-1 block text-lg font-semibold text-text-primary">
              {draft.config.packsPerPlayer ?? "—"}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
            <span className="block text-xs text-text-muted">
              <Clock className="mr-1 inline h-3.5 w-3.5" />
              Pick Timer
            </span>
            <span className="mt-1 block text-lg font-semibold text-text-primary">
              {draft.config.pickSeconds ? `${draft.config.pickSeconds}s` : "—"}
            </span>
          </div>
        </div>
        {draft.config.setNames && draft.config.setNames.length > 0 && (
          <div className="mt-4">
            <span className="mb-2 block text-xs text-text-muted">Sets</span>
            <div className="flex flex-wrap gap-2">
              {draft.config.setNames.map((setName) => (
                <span
                  key={setName}
                  className="rounded-lg border border-border bg-bg-elevated/50 px-2.5 py-1 text-sm text-text-secondary"
                >
                  {setName}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}