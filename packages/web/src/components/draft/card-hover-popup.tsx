import { useEffect } from "react";
import Image from "next/image";
import { Shield, Swords, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardSummary } from "@/lib/card-types";

interface CardHoverPopupProps {
  card: CardSummary;
  position: { left: number; top: number };
  imageError: boolean;
  onImageError: () => void;
  dismissible?: boolean;
  onDismiss?: () => void;
}

export function CardHoverPopup({ card, position, imageError, onImageError, dismissible = false, onDismiss }: CardHoverPopupProps) {
  const isMonster = card.type.toLowerCase().includes("monster");

  useEffect(() => {
    if (!dismissible || !onDismiss) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissible, onDismiss]);

  return (
    <>
      {dismissible && (
        <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onDismiss} />
      )}
      <div
        className={cn(
          "fixed z-50",
          dismissible ? "block" : "pointer-events-none hidden lg:block",
        )}
        style={{ left: `${position.left}px`, top: `${position.top}px` }}
      >
        <div className="relative max-h-[calc(100vh-2rem)] w-72 overflow-auto rounded-xl border border-border bg-bg-surface shadow-card">
          {dismissible && onDismiss && (
            <button
              type="button"
              aria-label="Close preview"
              onClick={onDismiss}
              className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-bg-elevated text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <div className="relative isolate aspect-[3/4] w-full overflow-hidden rounded-t-xl bg-bg-elevated">
            {imageError ? (
              <div className="flex h-full items-center justify-center text-sm text-text-secondary">No image</div>
            ) : (
              <Image src={card.imageUrl} alt={card.name} fill className="object-contain" sizes="288px" onError={onImageError} />
            )}
          </div>
          <div className="space-y-3 p-4">
            <h3 className="mb-1 font-display text-lg text-text-primary">{card.name}</h3>
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              {card.attribute && <span className="rounded-md bg-bg-elevated px-2 py-1">{card.attribute}</span>}
              {card.level !== undefined && <span className="rounded-md bg-bg-elevated px-2 py-1">Level {card.level}</span>}
              <span className="rounded-md bg-bg-elevated px-2 py-1">{card.type}</span>
              <span className="rounded-md bg-bg-elevated px-2 py-1 capitalize">{card.frameType}</span>
            </div>
            <p className="text-sm leading-relaxed text-text-secondary">{card.effectText}</p>
            {isMonster && (card.atk !== undefined || card.def !== undefined) && (
              <div className="flex items-center gap-4 text-sm font-semibold text-text-primary">
                {card.atk !== undefined && (
                  <div className="flex items-center gap-1.5"><Swords className="h-4 w-4 text-accent-cta" aria-hidden="true" /><span>ATK {card.atk}</span></div>
                )}
                {card.def !== undefined && (
                  <div className="flex items-center gap-1.5"><Shield className="h-4 w-4 text-accent-primary" aria-hidden="true" /><span>DEF {card.def}</span></div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
