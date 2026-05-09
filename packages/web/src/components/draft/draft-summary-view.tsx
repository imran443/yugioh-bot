"use client";

import * as React from "react";
import Image from "next/image";
import { Clock, Download, Layers, Package, Trash2, User, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
import type { DraftCardDetail } from "@/lib/stores/draft-store";

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
    participantPickCount?: number;
  };
  isParticipant: boolean;
  isCreator: boolean;
  onExportYdk: () => Promise<string>;
  onDelete: () => Promise<void>;
  myPool?: DraftCardDetail[];
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
  isCreator,
  onExportYdk,
  onDelete,
  myPool,
}: DraftSummaryViewProps) {
  const [exporting, setExporting] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hoveredCard, setHoveredCard] = React.useState<DraftCardDetail | null>(null);
  const [popupPosition, setPopupPosition] = React.useState<{ left: number; top: number } | null>(null);
  const [imageErrors, setImageErrors] = React.useState<Set<number>>(new Set());

  const handleCardHover = React.useCallback((card: DraftCardDetail, rect: DOMRect) => {
    const POPUP_WIDTH = 288;
    const POPUP_HEIGHT = 560;
    const MARGIN = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rightLeft = rect.right + MARGIN;
    const leftLeft = rect.left - POPUP_WIDTH - MARGIN;
    const left =
      rightLeft + POPUP_WIDTH + MARGIN <= vw ? rightLeft : Math.max(MARGIN, leftLeft);
    const top = Math.min(
      vh - POPUP_HEIGHT - MARGIN,
      Math.max(MARGIN, rect.top + rect.height / 2 - POPUP_HEIGHT / 2),
    );
    setHoveredCard(card);
    setPopupPosition({ left, top });
  }, []);

  const handleCardLeave = React.useCallback(() => {
    setHoveredCard(null);
    setPopupPosition(null);
  }, []);

  const isCompleted = draft.status === "completed";
  const participantPickCount = draft.participantPickCount ?? 0;
  const canExportYdk = isCompleted && isParticipant && participantPickCount >= 40;
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
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export YDK");
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete draft");
      setDeleting(false);
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
          <div className="flex shrink-0 items-center gap-2">
            {canExportYdk && (
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
            {isCreator && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            )}
          </div>
        </div>
        {isCompleted && isParticipant && !canExportYdk && (
          <p className="mt-4 text-sm text-text-secondary">
            YDK export requires 40 picks. This draft completed with {participantPickCount}.
          </p>
        )}
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

      {isParticipant && myPool && myPool.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-4 font-display text-lg text-text-primary">
            <Package className="mr-2 inline h-5 w-5 text-accent-primary" />
            Your Pool ({myPool.length} cards)
          </h2>
          <ul className="flex flex-col gap-0.5" role="list">
            {myPool.map((card) => {
              const isMonster = card.type.toLowerCase().includes("monster");
              return (
                <li key={card.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition-colors duration-150 hover:border-border hover:bg-bg-elevated/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
                    onMouseEnter={(e) =>
                      handleCardHover(card, e.currentTarget.getBoundingClientRect())
                    }
                    onMouseLeave={handleCardLeave}
                    onFocus={(e) =>
                      handleCardHover(card, e.currentTarget.getBoundingClientRect())
                    }
                    onBlur={handleCardLeave}
                  >
                    {/* 36×48 thumbnail */}
                    <div className="relative h-12 w-9 shrink-0 overflow-hidden rounded bg-bg-elevated">
                      {imageErrors.has(card.id) ? (
                        <div className="flex h-full w-full items-center justify-center text-xs text-text-muted">
                          ?
                        </div>
                      ) : (
                        <Image
                          src={card.imageUrlSmall || card.imageUrl}
                          alt=""
                          fill
                          className="object-cover"
                          sizes="36px"
                          onError={() =>
                            setImageErrors((prev) => new Set(prev).add(card.id))
                          }
                        />
                      )}
                    </div>

                    {/* Name + type + attribute + level */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {card.name}
                      </p>
                      <p className="truncate text-xs text-text-muted">
                        {card.type}
                        {card.attribute &&
                          card.attribute !== "SPELL" &&
                          card.attribute !== "TRAP" &&
                          ` · ${card.attribute}`}
                        {card.level !== undefined && ` · Lv ${card.level}`}
                      </p>
                    </div>

                    {/* ATK/DEF for monsters */}
                    {isMonster && card.atk !== undefined && (
                      <span className="shrink-0 rounded bg-bg-elevated px-1.5 py-0.5 text-xs font-semibold tabular-nums text-text-secondary">
                        {card.atk}/{card.def ?? "?"}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Hover preview */}
          {hoveredCard && popupPosition && (
            <CardHoverPopup
              card={hoveredCard}
              position={popupPosition}
              imageError={imageErrors.has(hoveredCard.id)}
              onImageError={() =>
                setImageErrors((prev) => new Set(prev).add(hoveredCard.id))
              }
            />
          )}
        </div>
      )}

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

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Delete draft?"
      >
        <p className="text-sm text-text-secondary">
          This will permanently delete <span className="font-semibold text-text-primary">{draft.name}</span> and all pick history. This cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" loading={deleting} onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}
