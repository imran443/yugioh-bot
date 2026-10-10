"use client";

import { useEffect, useState } from "react";
import type { DuelCardInfo } from "@yugidraft/shared/duels";
import { searchDuelCards } from "./api";
import { cardArtUrl } from "./constants";
import { canBeDeckMaster } from "./deck-card-types";
import { SheetButton } from "./sheet-ui";
import ui from "./sheet-ui.module.css";
import styles from "./deck-editor.module.css";

export function DeckMasterPicker({ code, onChange, problem, custom }: {
  code?: number;
  onChange: (code?: number) => void;
  problem?: string;
  custom: boolean;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ query: string; cards?: DuelCardInfo[]; error?: string } | null>(null);
  const [selected, setSelected] = useState<DuelCardInfo | null>(null);
  const trimmed = query.trim();
  const currentSearch = search?.query === trimmed ? search : null;

  useEffect(() => {
    let cancelled = false;
    if (!trimmed) return;
    const timer = setTimeout(() => {
      void searchDuelCards(trimmed).then(
        ({ cards }) => {
          if (!cancelled) setSearch({ query: trimmed, cards: cards.filter((card) => canBeDeckMaster(card.type)) });
        },
        (error: unknown) => {
          if (!cancelled) setSearch({ query: trimmed, error: error instanceof Error ? error.message : "Could not search cards." });
        },
      );
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [trimmed]);

  useEffect(() => {
    if (code === undefined || selected?.code === code) return;
    let cancelled = false;
    void searchDuelCards(String(code)).then(
      ({ cards }) => { if (!cancelled) setSelected(cards.find((card) => card.code === code) ?? null); },
      () => { if (!cancelled) setSelected(null); },
    );
    return () => { cancelled = true; };
  }, [code, selected?.code]);
  const selectedCard = selected?.code === code ? selected : null;
  return (
    <section className={styles.master} aria-label="Deck Master">
      <div className={styles.listHead}>
        <h3 className={styles.listTitle}>Deck Master</h3>
        <span className={styles.target}>{custom ? "Separate monster" : "Separate from your 60 Main Deck cards"}</span>
      </div>
      {code !== undefined ? (
        <div className={styles.masterSelected} data-invalid={problem ? "true" : undefined}>
          <img src={cardArtUrl(code, "small")} alt={selectedCard?.name ?? `Card ${code}`} />
          <div className={styles.masterDetails}>
            <strong>{selectedCard?.name ?? `Card ${code}`}</strong>
            <span className={ui.hint}>{selectedCard ? `${selectedCard.race} · ` : ""}{code}</span>
            <SheetButton size="sm" onClick={() => onChange(undefined)}>Clear Deck Master</SheetButton>
          </div>
        </div>
      ) : <p className={ui.hint}>Choose a monster below or search for one. A Deck Master is required before you can ready up.</p>}
      {problem ? <p id="deck-master-problem" role="alert" className={ui.alert}>{problem}</p> : null}
      <label>
        <span className={ui.label}>Find Deck Master by name or passcode</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)}
          type="search" maxLength={200} placeholder="e.g. Dark Magician or 46986414"
          className={ui.input} aria-describedby="deck-master-help" />
      </label>
      {trimmed ? (
        <div aria-live="polite">
          {currentSearch?.error ? <p role="alert" className={ui.alert}>{currentSearch.error}</p>
            : !currentSearch?.cards ? <p className={ui.hint}>Searching monsters…</p>
              : currentSearch.cards.length === 0 ? <p className={ui.hint}>No monsters found. Try another name or the full passcode.</p>
                : <ul className={styles.masterResults} aria-label="Deck Master search results">
                  {currentSearch.cards.map((card) => (
                    <li key={card.code}>
                      <button type="button" className={styles.masterResult} aria-pressed={code === card.code}
                        onClick={() => { setSelected(card); onChange(card.code); setQuery(""); setSearch(null); }}>
                        <img src={cardArtUrl(card.code, "small")} alt="" loading="lazy" />
                        <span><strong>{card.name}</strong><span>{card.race} · {card.code}</span></span>
                      </button>
                    </li>
                  ))}
                </ul>}
        </div>
      ) : null}
      <p id="deck-master-help" className={ui.hint}>
        Choosing an imported card moves one copy out of its deck. Changing or clearing that choice returns it.
        {custom ? " Custom Domain keeps unselected Side Deck cards." : " A sole Side card in a Domain YDK or YDKE import is selected automatically."}
      </p>
    </section>
  );
}
