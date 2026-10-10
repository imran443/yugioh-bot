"use client";

import { useEffect, useRef, useState } from "react";
import type { DuelDeck } from "@yugidraft/shared/duels";
import { getDuelCards } from "./api";
import { TYPE_MONSTER, TYPE_SPELL, TYPE_TOKEN, TYPE_TRAP } from "./constants";
import { deckCodes } from "./side-deck-model";

/** A failed lookup is tried once more after this wait. */
export const CARD_META_RETRY_MS = 1500;

/** Only monsters can be the Deck Master, Extra Deck monsters included. Tokens and an unknown type are not offered. */
export function canBeDeckMaster(type: number | undefined): boolean {
  return type !== undefined && (type & TYPE_MONSTER) !== 0 && (type & TYPE_TOKEN) === 0;
}

/** What the player sees when the Deck Master is a Spell or Trap. The server uses the same words. */
export const SPELL_TRAP_MASTER_MESSAGE = "You can't use a Spell or Trap as your Deck Master.";

export function isSpellOrTrapType(type: number | undefined): boolean {
  return type !== undefined && (type & (TYPE_SPELL | TYPE_TRAP)) !== 0;
}

export interface DeckCardMeta { name: string; type: number }

/**
 * Name and type bitmask for every card in a deck. A card is missing from the map until its lookup ends.
 * Only codes not yet known are requested. `enabled: false` sends nothing. A change of `retry` asks again
 * after a failure, and a failed lookup also retries once on its own.
 */
export function useDeckCardMeta(
  deck: DuelDeck,
  { enabled = true, retry = 0, initial }: { enabled?: boolean; retry?: number; initial?: ReadonlyMap<number, DeckCardMeta> } = {},
): ReadonlyMap<number, DeckCardMeta> {
  const known = useRef<ReadonlyMap<number, DeckCardMeta>>(initial ?? new Map());
  const [meta, setMeta] = useState<ReadonlyMap<number, DeckCardMeta>>(known.current);
  const codesKey = [...new Set([...deckCodes(deck), ...(deck.deckMaster != null ? [deck.deckMaster] : [])])].sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (!enabled) return undefined;
    const missing = (codesKey ? codesKey.split(",").map(Number) : []).filter((code) => !known.current.has(code));
    if (missing.length === 0) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (retriesLeft: number) => {
      void getDuelCards(missing).then(
        ({ cards }) => {
          if (cancelled) return;
          known.current = new Map([...known.current, ...cards.map((card) => [card.code, { name: card.name, type: card.type }] as const)]);
          setMeta(known.current);
        },
        () => {
          if (!cancelled && retriesLeft > 0) timer = setTimeout(() => load(retriesLeft - 1), CARD_META_RETRY_MS);
        },
      );
    };
    load(1);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [codesKey, enabled, retry]);
  return meta;
}
