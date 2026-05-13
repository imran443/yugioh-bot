"use client";

import * as React from "react";
import type { DraftConfig } from "@yugidraft/shared/types";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { PoolBuilder } from "@/components/cards/pool-builder";
import type { CardSummary } from "@/lib/card-types";

export const CARDS_PER_PLAYER_MIN = 40;
export const CARDS_PER_PLAYER_MAX = 60;
export const PACK_SIZE_MIN = 5;
export const PICK_SECONDS_MIN = 5;
export const PICK_SECONDS_MAX = 300;

export type DraftConfigFieldsValue = {
  setNames: string[];
  customCardText: string;
  cardsPerPlayerText: string;
  packSizeText: string;
  pickSecondsText: string;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function parseCardsPerPlayer(text: string): number {
  return clamp(parseInt(text) || CARDS_PER_PLAYER_MIN, CARDS_PER_PLAYER_MIN, CARDS_PER_PLAYER_MAX);
}

function parsePackSize(text: string, cardsPerPlayer: number): number {
  return clamp(parseInt(text) || 15, PACK_SIZE_MIN, cardsPerPlayer);
}

function parsePickSeconds(text: string): number {
  return clamp(parseInt(text) || 45, PICK_SECONDS_MIN, PICK_SECONDS_MAX);
}

function derivePacksPerPlayer(cardsPerPlayer: number, packSize: number): number {
  return Math.max(1, Math.ceil(cardsPerPlayer / packSize));
}

export function configFromFields(fields: DraftConfigFieldsValue): DraftConfig {
  const cardsPerPlayer = parseCardsPerPlayer(fields.cardsPerPlayerText);
  const packSize = parsePackSize(fields.packSizeText, cardsPerPlayer);
  const pickSeconds = parsePickSeconds(fields.pickSecondsText);
  const { cardIds: customCardIds } = parseCustomCardIds(fields.customCardText);
  return {
    setNames: fields.setNames,
    customCardIds,
    includeNames: [],
    excludeNames: [],
    cardsPerPlayer,
    packSize,
    packsPerPlayer: derivePacksPerPlayer(cardsPerPlayer, packSize),
    pickSeconds,
    alternatePassDirection: true,
    randomizeSeats: true,
  };
}

export function fieldsFromConfig(config: DraftConfig, customCardIds?: number[]): DraftConfigFieldsValue {
  const ids = customCardIds ?? config.customCardIds ?? [];
  return {
    setNames: config.setNames ?? [],
    customCardText: ids.join("\n"),
    cardsPerPlayerText: String(config.cardsPerPlayer ?? CARDS_PER_PLAYER_MIN),
    packSizeText: String(config.packSize ?? 15),
    pickSecondsText: String(config.pickSeconds ?? 45),
  };
}

export function validateFields(fields: DraftConfigFieldsValue): string | null {
  const { cardIds, errors } = parseCustomCardIds(fields.customCardText);
  if (fields.setNames.length === 0 && cardIds.length === 0) {
    return "Select at least one set or paste custom card IDs";
  }
  if (errors.length > 0) {
    return `Remove invalid card IDs: ${errors.slice(0, 3).join(", ")}`;
  }
  const cards = parseInt(fields.cardsPerPlayerText);
  if (!cards || cards < CARDS_PER_PLAYER_MIN || cards > CARDS_PER_PLAYER_MAX) {
    return `Cards per player must be between ${CARDS_PER_PLAYER_MIN} and ${CARDS_PER_PLAYER_MAX}`;
  }
  const packSize = parseInt(fields.packSizeText);
  if (!packSize || packSize < PACK_SIZE_MIN) {
    return `Pack size must be at least ${PACK_SIZE_MIN}`;
  }
  if (packSize > cards) {
    return "Pack size cannot exceed the number of cards per player";
  }
  const secs = parseInt(fields.pickSecondsText);
  if (!secs || secs < PICK_SECONDS_MIN || secs > PICK_SECONDS_MAX) {
    return `Pick duration must be between ${PICK_SECONDS_MIN} and ${PICK_SECONDS_MAX} seconds`;
  }
  return null;
}

interface DraftConfigFieldsProps {
  value: DraftConfigFieldsValue;
  onChange: (value: DraftConfigFieldsValue) => void;
  poolBuilderShowPreview?: boolean;
  onPool?: (cards: CardSummary[], unknownIds: number[], loading: boolean) => void;
}

export function DraftConfigFields({ value, onChange, poolBuilderShowPreview, onPool }: DraftConfigFieldsProps) {
  const cardsPerPlayer = parseCardsPerPlayer(value.cardsPerPlayerText);
  const packSizeRaw = parseInt(value.packSizeText) || 15;
  const packSize = Math.max(PACK_SIZE_MIN, packSizeRaw);
  const packsPerPlayer = derivePacksPerPlayer(cardsPerPlayer, Math.min(packSize, cardsPerPlayer));

  return (
    <div className="space-y-4">
      <PoolBuilder
        value={{ setNames: value.setNames, customCardText: value.customCardText }}
        onChange={(pb) => onChange({ ...value, setNames: pb.setNames, customCardText: pb.customCardText })}
        showPreview={poolBuilderShowPreview}
        onPool={onPool}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="cards-per-player" className="mb-1 block text-sm font-medium text-text-primary">
            Rounds &mdash; cards drafted per player
          </label>
          <input
            id="cards-per-player"
            type="number"
            value={value.cardsPerPlayerText}
            onChange={(e) => onChange({ ...value, cardsPerPlayerText: e.target.value })}
            min={CARDS_PER_PLAYER_MIN}
            max={CARDS_PER_PLAYER_MAX}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="pack-size" className="mb-1 block text-sm font-medium text-text-primary">
            Size of each pack
          </label>
          <input
            id="pack-size"
            type="number"
            value={value.packSizeText}
            onChange={(e) => onChange({ ...value, packSizeText: e.target.value })}
            min={PACK_SIZE_MIN}
            max={cardsPerPlayer}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="pick-seconds" className="mb-1 block text-sm font-medium text-text-primary">
            Pick duration (seconds)
          </label>
          <input
            id="pick-seconds"
            type="number"
            value={value.pickSecondsText}
            onChange={(e) => onChange({ ...value, pickSecondsText: e.target.value })}
            min={PICK_SECONDS_MIN}
            max={PICK_SECONDS_MAX}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
      </div>
      <p className="text-xs text-text-secondary">
        Each player drafts {cardsPerPlayer} card{cardsPerPlayer !== 1 ? "s" : ""} across {packsPerPlayer} pack
        {packsPerPlayer !== 1 ? "s" : ""} of {Math.min(packSize, cardsPerPlayer)} &mdash; extra cards in the last pack are left out.
      </p>
    </div>
  );
}
