"use client";

import Image from "next/image";
import { DraftCardDetail } from "@/lib/stores/draft-store";
import { Button } from "@/components/ui/button";
import { Swords, Shield } from "lucide-react";

interface CardPreviewProps {
  card: DraftCardDetail;
  onPick: () => void;
  onBack: () => void;
}

export function CardPreview({ card, onPick, onBack }: CardPreviewProps) {
  const isMonster = card.type.toLowerCase().includes("monster");

  return (
    <div className="flex flex-col gap-4">
      {/* Full art image */}
      <div className="relative mx-auto aspect-[3/4] w-full max-w-xs overflow-hidden rounded-xl bg-bg-elevated shadow-card">
        <Image
          src={card.imageUrl}
          alt={card.name}
          fill
          className="object-cover"
          sizes="(max-width: 768px) 100vw, 384px"
        />
      </div>

      {/* Card details */}
      <div className="space-y-3">
        <h2 className="font-display text-2xl text-text-primary">{card.name}</h2>

        <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
          {card.attribute && (
            <span className="rounded-md bg-bg-elevated px-2 py-1">
              {card.attribute}
            </span>
          )}
          {card.level !== undefined && (
            <span className="rounded-md bg-bg-elevated px-2 py-1">
              Level {card.level}
            </span>
          )}
          <span className="rounded-md bg-bg-elevated px-2 py-1">{card.type}</span>
          <span className="rounded-md bg-bg-elevated px-2 py-1 capitalize">
            {card.frameType}
          </span>
        </div>

        <p className="text-sm leading-relaxed text-text-secondary">
          {card.effectText}
        </p>

        {isMonster && (card.atk !== undefined || card.def !== undefined) && (
          <div className="flex items-center gap-4 text-sm font-semibold text-text-primary">
            {card.atk !== undefined && (
              <div className="flex items-center gap-1.5">
                <Swords className="h-4 w-4 text-accent-cta" aria-hidden="true" />
                <span>ATK {card.atk}</span>
              </div>
            )}
            {card.def !== undefined && (
              <div className="flex items-center gap-1.5">
                <Shield className="h-4 w-4 text-accent-primary" aria-hidden="true" />
                <span>DEF {card.def}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 pt-2">
        <Button
          variant="danger"
          size="lg"
          onClick={onPick}
          className="w-full bg-accent-cta hover:bg-red-600"
        >
          Pick this card
        </Button>
        <Button variant="ghost" size="md" onClick={onBack} className="w-full">
          Back to pack
        </Button>
      </div>
    </div>
  );
}
