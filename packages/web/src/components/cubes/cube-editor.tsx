"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Upload, Trash2, Sparkles, Plus, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
import type { CardSummary } from "@/lib/card-types";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { putCards } from "@/lib/cards-cache";
import {
  isExtraDeckCardClient,
  poolToGridCards,
  type CubePoolsDto,
} from "@/lib/cube-pools";

interface CubeDto {
  id: number;
  name: string;
  archetype: string | null;
  banlist: string | null;
}

const gridClassName = "grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";

const SEARCH_POPUP_WIDTH = 288;
const SEARCH_POPUP_HEIGHT = 560;
const SEARCH_POPUP_MARGIN = 16;

function getSearchPopupPosition(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const leftOfItem = rect.left - SEARCH_POPUP_WIDTH - SEARCH_POPUP_MARGIN;
  const left = Math.min(vw - SEARCH_POPUP_WIDTH - SEARCH_POPUP_MARGIN, Math.max(SEARCH_POPUP_MARGIN, leftOfItem));
  const top = Math.min(
    vh - SEARCH_POPUP_HEIGHT - SEARCH_POPUP_MARGIN,
    Math.max(SEARCH_POPUP_MARGIN, rect.top + rect.height / 2 - SEARCH_POPUP_HEIGHT / 2),
  );
  return { left, top };
}

export function CubeEditor({ cubeId }: { cubeId: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // When opened from a draft's cube builder, return there instead of the library.
  const from = searchParams.get("from");
  const backHref = from && from.startsWith("/draft/") ? from : "/cubes";
  const backLabel = from && from.startsWith("/draft/") ? "Back to draft" : "Back to Cubes";
  const [cube, setCube] = React.useState<CubeDto | null>(null);
  const [pools, setPools] = React.useState<CubePoolsDto>({ main: [], extra: [] });
  const [cardsById, setCardsById] = React.useState<Map<number, CardSummary>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [importText, setImportText] = React.useState("");
  const [archetypeQuery, setArchetypeQuery] = React.useState("");
  const [archetypeSuggestions, setArchetypeSuggestions] = React.useState<string[]>([]);
  const archetypeReqId = React.useRef(0);
  const [cardSearchQuery, setCardSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<CardSummary[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [searchFocused, setSearchFocused] = React.useState(false);
  const [hoveredSearchCard, setHoveredSearchCard] = React.useState<CardSummary | null>(null);
  const [searchPopupPosition, setSearchPopupPosition] = React.useState<{ left: number; top: number } | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [savingName, setSavingName] = React.useState(false);
  const searchReqId = React.useRef(0);

  const applyDetail = React.useCallback(
    (data: { cube?: CubeDto; pools: CubePoolsDto; cards: CardSummary[] }) => {
      if (data.cube) setCube(data.cube);
      setPools(data.pools);
      putCards(data.cards);
      setCardsById(new Map(data.cards.map((c) => [c.id, c])));
    },
    [],
  );

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/cubes/${cubeId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data) => {
        if (cancelled) return;
        applyDetail(data);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load cube.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cubeId, applyDetail]);

  const mutate = async (op: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cubes/${cubeId}/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(op),
      });
      const data = (await res.json().catch(() => ({}))) as {
        pools?: CubePoolsDto;
        cards?: CardSummary[];
        error?: string;
      };
      if (!res.ok || !data.pools || !data.cards) {
        setError(data.error ?? "Update failed.");
        return null;
      }
      applyDetail({ pools: data.pools, cards: data.cards });
      return data;
    } finally {
      setBusy(false);
    }
  };

  const importPasscodes = async () => {
    setStatus(null);
    const parsed = parseCustomCardIds(importText);
    if (parsed.errors.length > 0) {
      setError(`Remove invalid passcodes: ${parsed.errors.slice(0, 3).join(", ")}`);
      return;
    }
    if (parsed.cardIds.length === 0) {
      setError("Paste at least one passcode to import.");
      return;
    }
    const result = await mutate({ op: "import", codes: parsed.cardIds });
    if (result) {
      setImportText("");
      setStatus(`Imported ${parsed.cardIds.length} passcode${parsed.cardIds.length === 1 ? "" : "s"}.`);
    }
  };

  const readImportFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const addCard = (card: CardSummary) => {
    putCards([card]);
    const pool = isExtraDeckCardClient(card) ? "extra" : "main";
    void mutate({ op: "add", catalogCardId: card.id, pool });
  };

  const removeCard = (card: CardSummary) => {
    void mutate({ op: "remove", catalogCardId: card.id });
  };

  const seedArchetype = async (name: string) => {
    const archetype = name.trim();
    if (!archetype) return;
    setStatus(null);
    const result = await mutate({ op: "seedArchetype", archetype });
    if (result) {
      setArchetypeQuery("");
      setArchetypeSuggestions([]);
      setStatus(`Added all "${archetype}" cards.`);
    }
  };

  const startRename = () => {
    setNameDraft(cube?.name ?? "");
    setEditingName(true);
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next || next === cube?.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setError(null);
    try {
      const res = await fetch(`/api/cubes/${cubeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to rename cube.");
        return;
      }
      setCube((cur) => (cur ? { ...cur, name: next } : cur));
      setEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  const deleteCube = async () => {
    if (typeof window !== "undefined" && !window.confirm("Delete this cube? This can't be undone.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cubes/${cubeId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to delete cube.");
        return;
      }
      router.push("/cubes");
    } finally {
      setBusy(false);
    }
  };

  // Archetype type-ahead suggestions (graceful when the API can't be reached).
  React.useEffect(() => {
    const q = archetypeQuery.trim();
    if (q.length < 2) {
      setArchetypeSuggestions([]);
      return;
    }
    const myReq = ++archetypeReqId.current;
    const t = setTimeout(() => {
      fetch(`/api/archetypes?query=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : { archetypes: [] }))
        .then((data: { archetypes: string[] }) => {
          if (myReq === archetypeReqId.current) setArchetypeSuggestions((data.archetypes ?? []).slice(0, 8));
        })
        .catch(() => {
          if (myReq === archetypeReqId.current) setArchetypeSuggestions([]);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [archetypeQuery]);

  React.useEffect(() => {
    const trimmedQuery = cardSearchQuery.trim();
    if (trimmedQuery.length === 0) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const myReq = ++searchReqId.current;
    const timeout = setTimeout(() => {
      setSearching(true);
      fetch("/api/cards/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fuzzyName: trimmedQuery }),
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("search failed"))))
        .then((data: { cards: CardSummary[] }) => {
          if (myReq !== searchReqId.current) return;
          putCards(data.cards);
          setSearchResults(data.cards.slice(0, 8));
        })
        .catch(() => {
          if (myReq === searchReqId.current) setSearchResults([]);
        })
        .finally(() => {
          if (myReq === searchReqId.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timeout);
  }, [cardSearchQuery]);

  const mainGrid = poolToGridCards(pools.main, cardsById);
  const extraGrid = poolToGridCards(pools.extra, cardsById);

  if (loading) return <p className="text-sm text-text-secondary">Loading cube...</p>;

  return (
    <div className="space-y-6">
      <Link href={backHref} className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                aria-label="Cube name"
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setEditingName(false);
                }}
                className="w-full max-w-md rounded-lg border border-border bg-bg-deep px-3 py-1.5 font-display text-2xl text-text-primary focus:border-accent-primary focus:outline-none sm:text-3xl"
              />
              <Button type="button" variant="primary" size="sm" loading={savingName} onClick={() => void saveName()}>
                <Check className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditingName(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="font-display text-2xl text-text-primary sm:text-3xl">{cube?.name ?? "Cube"}</h1>
              <button
                type="button"
                onClick={startRename}
                title="Rename cube"
                aria-label="Rename cube"
                className="rounded-lg border border-border p-1.5 text-text-secondary transition-colors hover:text-text-primary motion-safe:active:translate-y-px"
              >
                <Pencil className="h-4 w-4" />
              </button>
            </div>
          )}
          <p className="mt-2 text-sm text-text-secondary">
            {cube?.archetype ? `Archetype: ${cube.archetype} · ` : ""}
            {mainGrid.cards.length + mainGrid.unknownIds.length} main · {extraGrid.cards.length + extraGrid.unknownIds.length} extra
            {busy ? " · saving…" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void deleteCube()}
          disabled={busy}
          className="inline-flex items-center gap-2 self-start rounded-lg border border-accent-cta/50 px-3 py-2 text-sm font-semibold text-accent-cta hover:bg-accent-cta/10 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" /> Delete cube
        </button>
      </div>

      {error && <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error}</p>}
      {status && <p className="rounded-lg border border-accent-primary/40 bg-accent-primary/10 px-4 py-3 text-sm text-accent-primary">{status}</p>}

      <div className="grid items-start gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent-gold" />
          <h2 className="font-display text-lg text-text-primary">Add a whole archetype</h2>
        </div>
        <div className="relative">
          <label htmlFor="cube-archetype-search" className="mb-1 block text-sm font-medium text-text-primary">Search archetype</label>
          <div className="flex gap-2">
            <input
              id="cube-archetype-search"
              aria-label="Search archetype"
              value={archetypeQuery}
              onChange={(event) => setArchetypeQuery(event.target.value)}
              placeholder="Blue-Eyes, Dark Magician, ..."
              autoComplete="off"
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
            />
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="shrink-0 whitespace-nowrap"
              disabled={busy || archetypeQuery.trim().length === 0}
              onClick={() => void seedArchetype(archetypeQuery)}
            >
              <Plus className="h-4 w-4" /> Add all
            </Button>
          </div>
          {archetypeSuggestions.length > 0 && (
            <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-bg-surface shadow-card">
              {archetypeSuggestions.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => void seedArchetype(name)}
                  className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-elevated"
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-text-secondary">Adds every card in the archetype (main + extra) to this cube. Needs the card database; if it can&apos;t be reached, use passcode import below.</p>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Upload className="h-4 w-4 text-accent-primary" />
          <h2 className="font-display text-lg text-text-primary">Add single card</h2>
        </div>
        <div className="relative">
          <label htmlFor="cube-card-search" className="mb-1 block text-sm font-medium text-text-primary">Search card name</label>
          <input
            id="cube-card-search"
            aria-label="Search card name"
            value={cardSearchQuery}
            onChange={(event) => setCardSearchQuery(event.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
            placeholder="blue-eyes, dark magician, ..."
            autoComplete="off"
            className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
          />
          {searchFocused && (searching || searchResults.length > 0) && (
            <div className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-bg-surface shadow-card">
              {searching && searchResults.length === 0 && (
                <div className="px-3 py-2 text-sm text-text-secondary">Searching...</div>
              )}
              {searchResults.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  data-testid="card-search-result"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => addCard(card)}
                  onMouseEnter={(event) => {
                    setHoveredSearchCard(card);
                    setSearchPopupPosition(getSearchPopupPosition(event.currentTarget.getBoundingClientRect()));
                  }}
                  onMouseLeave={() => {
                    setHoveredSearchCard(null);
                    setSearchPopupPosition(null);
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-elevated focus:bg-bg-elevated focus:outline-none"
                >
                  <img src={card.imageUrlSmall} alt="" className="h-10 w-8 rounded object-contain" />
                  <span className="flex-1">{card.name}</span>
                  <span className="text-xs text-text-secondary">{card.type}</span>
                </button>
              ))}
            </div>
          )}
          {hoveredSearchCard && searchPopupPosition && (
            <CardHoverPopup card={hoveredSearchCard} position={searchPopupPosition} imageError={false} onImageError={() => {}} />
          )}
        </div>
        <p className="mt-2 text-xs text-text-secondary">
          Click a result to add one copy. Extra-Deck cards are routed to the Extra pool automatically.
        </p>
      </section>
      </div>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Upload className="h-4 w-4 text-accent-primary" />
          <h2 className="font-display text-lg text-text-primary">Import passcodes</h2>
        </div>
        <label htmlFor="cube-import-file" className="mb-1 block text-sm font-medium text-text-primary">Upload text file</label>
        <input
          id="cube-import-file"
          type="file"
          accept=".txt,text/plain"
          onChange={(event) => readImportFile(event.target.files?.[0] ?? null)}
          className="mb-3 block w-full text-sm text-text-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-accent-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
        />
        <label htmlFor="cube-import-text" className="mb-1 block text-sm font-medium text-text-primary">Paste passcodes</label>
        <textarea
          id="cube-import-text"
          aria-label="Paste passcodes"
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          rows={5}
          placeholder={"46986414\n83764718, 12345678"}
          className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-text-secondary">Imported cards are added to the cube, routed to main/extra automatically.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void importPasscodes()} disabled={busy}>
            Add passcodes
          </Button>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <div>
          <h2 className="mb-2 font-display text-lg text-text-primary">Main pool</h2>
          <CardPoolGrid
            cards={mainGrid.cards}
            unknownIds={mainGrid.unknownIds}
            loading={false}
            emptyMessage="Import passcodes or add cards to build the main pool."
            heightClassName="h-[40rem]"
            gridClassName={gridClassName}
            cubeEditMode
            tileMinPx={150}
            onCardClick={removeCard}
            cardActionLabel={(card) => `Remove ${card.name} from cube`}
          />
        </div>
        <div>
          <h2 className="mb-2 font-display text-lg text-text-primary">Extra pool</h2>
          <CardPoolGrid
            cards={extraGrid.cards}
            unknownIds={extraGrid.unknownIds}
            loading={false}
            emptyMessage="Extra-Deck cards land here automatically."
            heightClassName="h-[40rem]"
            gridClassName={gridClassName}
            cubeEditMode
            tileMinPx={150}
            onCardClick={removeCard}
            cardActionLabel={(card) => `Remove ${card.name} from cube`}
          />
        </div>
      </div>
    </div>
  );
}
