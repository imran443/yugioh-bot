"use client";

import Image from "next/image";
import { useState } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";
import { cn } from "@/lib/utils";

interface DraftCardPreviewProps {
  className?: string;
}

export function DraftCardPreview({ className }: DraftCardPreviewProps) {
  const currentPack = useDraftStore((s) => s.currentPack);
  const previewCardId = useDraftStore((s) => s.previewCardId);
  const [imageErrors, setImageErrors] = useState<Set<number>>(new Set());
  const previewCard = currentPack.find((card) => card.id === previewCardId) ?? null;

  if (!previewCard) return null;

  return (
    <div
      data-testid="draft-card-preview"
      className={cn(
        "pointer-events-none fixed bottom-[5.625rem] left-[17.5rem] z-30 hidden w-full max-w-[30.45rem] rounded-xl border border-border bg-surface p-2 shadow-card xl:block",
        className
      )}
      aria-label="Card preview"
    >
      <div
        data-testid="draft-card-preview-art"
        className="relative aspect-[421/614] w-full overflow-hidden rounded-lg bg-bg-elevated"
      >
        {imageErrors.has(previewCard.id) ? (
          <div className="flex h-full items-center justify-center text-sm text-text-secondary">
            No image
          </div>
        ) : (
          <Image
            data-testid="draft-card-preview-image"
            src={previewCard.imageUrl}
            alt={previewCard.name}
            fill
            priority
            className="object-contain"
            sizes="(min-width: 1536px) 488px, 0px"
            onError={() => setImageErrors((prev) => new Set(prev).add(previewCard.id))}
          />
        )}
      </div>
    </div>
  );
}
