"use client";

import * as React from "react";
import type { DraftConfig } from "@yugidraft/shared/types";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { SetPicker } from "./set-picker";

export type DraftConfigFieldsValue = {
  setNames: string[];
  customCardText: string;
  packsPerPlayerText: string;
  pickSecondsText: string;
  alternatePass: boolean;
  randomizeSeats: boolean;
};

export function configFromFields(fields: DraftConfigFieldsValue): DraftConfig {
  const packsPerPlayer = Math.min(10, Math.max(1, parseInt(fields.packsPerPlayerText) || 5));
  const packSize = Math.ceil(40 / packsPerPlayer);
  const pickSeconds = Math.min(300, Math.max(5, parseInt(fields.pickSecondsText) || 45));
  const { cardIds: customCardIds } = parseCustomCardIds(fields.customCardText);
  return {
    setNames: fields.setNames,
    customCardIds,
    includeNames: [],
    excludeNames: [],
    packsPerPlayer,
    packSize,
    pickSeconds,
    alternatePassDirection: fields.alternatePass,
    randomizeSeats: fields.randomizeSeats,
  };
}

export function fieldsFromConfig(config: DraftConfig, customCardIds?: number[]): DraftConfigFieldsValue {
  const ids = customCardIds ?? config.customCardIds ?? [];
  return {
    setNames: config.setNames ?? [],
    customCardText: ids.join("\n"),
    packsPerPlayerText: String(config.packsPerPlayer ?? 5),
    pickSecondsText: String(config.pickSeconds ?? 45),
    alternatePass: config.alternatePassDirection ?? true,
    randomizeSeats: config.randomizeSeats ?? false,
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
  const packs = parseInt(fields.packsPerPlayerText);
  if (!packs || packs < 1 || packs > 10) {
    return "Packs per player must be between 1 and 10";
  }
  const secs = parseInt(fields.pickSecondsText);
  if (!secs || secs < 5 || secs > 300) {
    return "Pick timer must be between 5 and 300 seconds";
  }
  return null;
}

interface DraftConfigFieldsProps {
  value: DraftConfigFieldsValue;
  onChange: (value: DraftConfigFieldsValue) => void;
}

export function DraftConfigFields({ value, onChange }: DraftConfigFieldsProps) {
  const customCardParse = parseCustomCardIds(value.customCardText);
  const packsPerPlayer = Math.min(10, Math.max(1, parseInt(value.packsPerPlayerText) || 5));
  const cardsPerPack = Math.ceil(40 / packsPerPlayer);

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-text-primary">Sets</label>
        <SetPicker
          selectedSets={value.setNames}
          onSetsChange={(setNames) => onChange({ ...value, setNames })}
        />
      </div>

      <div>
        <label htmlFor="custom-card-ids" className="mb-1 block text-sm font-medium text-text-primary">
          Custom Card IDs
        </label>
        <textarea
          id="custom-card-ids"
          value={value.customCardText}
          onChange={(e) => onChange({ ...value, customCardText: e.target.value })}
          placeholder="46986414&#10;83764718, 12345678"
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <div className="mt-2 flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p className="text-text-secondary">
            Paste YGOPRODeck passcodes separated by new lines, commas, or spaces.
          </p>
          {customCardParse.errors.length > 0 && (
            <p className="text-accent-cta">Invalid: {customCardParse.errors.slice(0, 3).join(", ")}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="packs-per-player" className="mb-1 block text-sm font-medium text-text-primary">
            Packs per Player
          </label>
          <input
            id="packs-per-player"
            type="number"
            value={value.packsPerPlayerText}
            onChange={(e) => onChange({ ...value, packsPerPlayerText: e.target.value })}
            min={1}
            max={10}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
          <p className="mt-1 text-xs text-text-secondary">
            Each player drafts 40 cards across {packsPerPlayer} pack{packsPerPlayer !== 1 ? "s" : ""} of {cardsPerPack}.
          </p>
        </div>

        <div>
          <label htmlFor="pick-seconds" className="mb-1 block text-sm font-medium text-text-primary">
            Pick Timer (s)
          </label>
          <input
            id="pick-seconds"
            type="number"
            value={value.pickSecondsText}
            onChange={(e) => onChange({ ...value, pickSecondsText: e.target.value })}
            min={5}
            max={300}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
      </div>

      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={value.alternatePass}
            onChange={(e) => onChange({ ...value, alternatePass: e.target.checked })}
            className="h-4 w-4 rounded border-border accent-accent-primary"
          />
          Alternate pass direction
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={value.randomizeSeats}
            onChange={(e) => onChange({ ...value, randomizeSeats: e.target.checked })}
            className="h-4 w-4 rounded border-border accent-accent-primary"
          />
          Randomize seats
        </label>
      </div>
    </div>
  );
}
