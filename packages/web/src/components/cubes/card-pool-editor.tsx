"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
import type { CardSummary } from "@/lib/card-types";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { getCached, putCards } from "@/lib/cards-cache";

interface SavedPool {
  id: number;
  name: string;
  setNames: string[];
  customCardIds: number[];
}

type CardPoolEditorProps =
  | { mode: "create" }
  | { mode: "edit"; poolId: number };

const gridClassName = "grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";

function signature(name: string, setNames: string[], ids: number[]): string {
  return JSON.stringify({ name, setNames, ids });
}

function idsToText(ids: number[]): string {
  return ids.join("\n");
}

const SEARCH_POPUP_WIDTH = 288;
const SEARCH_POPUP_HEIGHT = 560;
const SEARCH_POPUP_MARGIN = 16;

function getSearchPopupPosition(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const leftOfItem = rect.left - SEARCH_POPUP_WIDTH - SEARCH_POPUP_MARGIN;
  const left = Math.min(vw - SEARCH_POPUP_WIDTH - SEARCH_POPUP_MARGIN, Math.max(SEARCH_POPUP_MARGIN, leftOfItem));
  const top = Math.min(vh - SEARCH_POPUP_HEIGHT - SEARCH_POPUP_MARGIN, Math.max(SEARCH_POPUP_MARGIN, rect.top + rect.height / 2 - SEARCH_POPUP_HEIGHT / 2));
  return { left, top };
}

function withQuantities(cards: CardSummary[]): CardSummary[] {
  const byId = new Map<number, CardSummary>();
  const qty = new Map<number, number>();
  for (const card of cards) {
    byId.set(card.id, card);
    qty.set(card.id, (qty.get(card.id) ?? 0) + (card.qty ?? 1));
  }
  return [...byId.values()].map((card) => ({ ...card, qty: qty.get(card.id) ?? 1 }));
}

export function CardPoolEditor(props: CardPoolEditorProps) {
  const router = useRouter();
  const isCreate = props.mode === "create";
  const poolId = props.mode === "edit" ? props.poolId : null;
  const [loadedPool, setLoadedPool] = React.useState<SavedPool | null>(null);
  const [name, setName] = React.useState("");
  const [setNames, setSetNames] = React.useState<string[]>([]);
  const [customCardText, setCustomCardText] = React.useState("");
  const [importText, setImportText] = React.useState("");
  const [cardSearchQuery, setCardSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<CardSummary[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [searchFocused, setSearchFocused] = React.useState(false);
  const [cards, setCards] = React.useState<CardSummary[]>([]);
  const [unknownIds, setUnknownIds] = React.useState<number[]>([]);
  const [loading, setLoading] = React.useState(!isCreate);
  const [resolving, setResolving] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hoveredSearchCard, setHoveredSearchCard] = React.useState<CardSummary | null>(null);
  const [searchPopupPosition, setSearchPopupPosition] = React.useState<{ left: number; top: number } | null>(null);
  const [searchImageErrors, setSearchImageErrors] = React.useState<Set<number>>(new Set());
  const reqId = React.useRef(0);
  const searchReqId = React.useRef(0);

  const parsed = React.useMemo(() => parseCustomCardIds(customCardText), [customCardText]);
  const importParsed = React.useMemo(() => parseCustomCardIds(importText), [importText]);
  const baseline = loadedPool ? signature(loadedPool.name, loadedPool.setNames, loadedPool.customCardIds) : "";
  const current = signature(name.trim(), setNames, parsed.cardIds);
  const dirty = isCreate
    ? name.trim().length > 0 || setNames.length > 0 || parsed.cardIds.length > 0
    : loadedPool !== null && baseline !== current;

  React.useEffect(() => {
    if (isCreate || poolId === null) {
      return;
    }

    let cancelled = false;
    fetch("/api/draft-templates")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data: { templates?: SavedPool[] }) => {
        const pool = (data.templates ?? []).find((template) => template.id === poolId) ?? null;
        if (cancelled) return;
        if (!pool) {
          setError("Saved pool not found.");
          setLoading(false);
          return;
        }
        setLoadedPool(pool);
        setName(pool.name);
        setSetNames(pool.setNames);
        setCustomCardText(idsToText(pool.customCardIds));
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load saved pool.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isCreate, poolId]);

  React.useEffect(() => {
    if (loading) return;
    const myReq = ++reqId.current;
    const ids = parsed.cardIds;
    if (setNames.length === 0 && ids.length === 0) {
      setCards([]);
      setUnknownIds([]);
      setResolving(false);
      return;
    }
    setResolving(true);
    const { hits, missing } = getCached(ids);
    const hitById = new Map(hits.map((card) => [card.id, card]));
    const cachedCustomCards = ids.map((id) => hitById.get(id)).filter((card): card is CardSummary => card !== undefined);
    if (setNames.length === 0 && missing.length === 0) {
      setCards(withQuantities(cachedCustomCards));
      setUnknownIds([]);
      setResolving(false);
      return;
    }
    fetch("/api/cards/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setNames, customCardIds: missing }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("resolve failed"))))
      .then((data: { cards: CardSummary[]; unknownIds: number[] }) => {
        if (myReq !== reqId.current) return;
        putCards(data.cards);
        const resolvedById = new Map<number, CardSummary>();
        for (const card of [...hits, ...data.cards]) resolvedById.set(card.id, card);
        const customCards = ids.map((id) => resolvedById.get(id)).filter((card): card is CardSummary => card !== undefined);
        const resolvedSetCards = [...data.cards];
        for (const id of missing) {
          const index = resolvedSetCards.findIndex((card) => card.id === id);
          if (index >= 0) resolvedSetCards.splice(index, 1);
        }
        setCards(withQuantities([...resolvedSetCards, ...customCards]));
        setUnknownIds(data.unknownIds);
      })
      .catch(() => {
        if (myReq === reqId.current) setError("Failed to resolve cards.");
      })
      .finally(() => {
        if (myReq === reqId.current) setResolving(false);
      });
  }, [customCardText, setNames, loading, parsed.cardIds]);

  const replaceFromImport = () => {
    setStatus(null);
    setError(null);
    if (importParsed.errors.length > 0) {
      setError(`Remove invalid passcodes: ${importParsed.errors.slice(0, 3).join(", ")}`);
      return;
    }
    if (importParsed.cardIds.length === 0) {
      setError("Paste at least one passcode to import.");
      return;
    }
    setSetNames([]);
    setCustomCardText(idsToText(importParsed.cardIds));
    setStatus(`Imported ${importParsed.cardIds.length} passcode${importParsed.cardIds.length === 1 ? "" : "s"}. Save changes to persist.`);
  };

  const replaceFromImportText = (text: string) => {
    const parsedImport = parseCustomCardIds(text);
    setStatus(null);
    setError(null);
    if (parsedImport.errors.length > 0) {
      setError(`Remove invalid passcodes: ${parsedImport.errors.slice(0, 3).join(", ")}`);
      return;
    }
    if (parsedImport.cardIds.length === 0) {
      setError("Paste at least one passcode to import.");
      return;
    }
    setImportText(text);
    setSetNames([]);
    setCustomCardText(idsToText(parsedImport.cardIds));
    setStatus(`Imported ${parsedImport.cardIds.length} passcode${parsedImport.cardIds.length === 1 ? "" : "s"}. Save changes to persist.`);
  };

  const readImportFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => replaceFromImportText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const addCardToPool = (card: CardSummary) => {
    putCards([card]);
    const nextIds = setNames.length > 0
      ? cards.flatMap((resolved) => Array(resolved.qty ?? 1).fill(resolved.id))
      : [...parsed.cardIds];
    nextIds.push(card.id);
    setSetNames([]);
    setCustomCardText(idsToText(nextIds));
  };

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

  const removeOneCopy = (card: CardSummary) => {
    const ids = [...parsed.cardIds];
    const index = ids.indexOf(card.id);
    if (setNames.length > 0) {
      const expandedIds = cards.flatMap((resolved) => Array(resolved.qty ?? 1).fill(resolved.id));
      const resolvedIndex = expandedIds.indexOf(card.id);
      if (resolvedIndex === -1) return;
      expandedIds.splice(resolvedIndex, 1);
      setSetNames([]);
      setCustomCardText(idsToText(expandedIds));
    } else if (index >= 0) {
      ids.splice(index, 1);
      setCustomCardText(idsToText(ids));
    } else {
      return;
    }
  };

  const save = async () => {
    setError(null);
    setStatus(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Pool name is required.");
      return;
    }
    if (parsed.errors.length > 0) {
      setError(`Remove invalid passcodes: ${parsed.errors.slice(0, 3).join(", ")}`);
      return;
    }
    setSaving(true);
    try {
      if (isCreate) {
        const res = await fetch("/api/draft-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            config: { setNames, customCardIds: parsed.cardIds },
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `Save failed (${res.status}).`);
          return;
        }
        const data = (await res.json()) as { template?: SavedPool };
        const createdId = data.template?.id;
        if (createdId) {
          router.push(`/cubes/${createdId}`);
        }
        return;
      }

      const res = await fetch(`/api/draft-templates/${poolId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, setNames, customCardIds: parsed.cardIds }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { template?: SavedPool };
      const saved = data.template ?? { id: poolId!, name: trimmedName, setNames, customCardIds: parsed.cardIds };
      setLoadedPool(saved);
      setName(saved.name);
      setSetNames(saved.setNames);
      setCustomCardText(idsToText(saved.customCardIds));
      setStatus("Saved changes.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-text-secondary">Loading saved pool...</p>;

  if (!isCreate && !loadedPool) {
    return (
      <div className="space-y-4">
        <Link href="/cubes" className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft className="h-4 w-4" /> Back to My Cubes
        </Link>
        <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error ?? "Saved pool not found."}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/cubes" className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft className="h-4 w-4" /> Back to My Cubes
      </Link>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <input
            aria-label="Pool name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-display text-2xl text-text-primary focus:border-accent-primary focus:outline-none sm:text-3xl"
          />
          <p className="mt-2 text-sm text-text-secondary">
            {parsed.cardIds.length} passcodes · {setNames.length} sets {dirty ? "· Unsaved changes" : ""}
          </p>
        </div>
        <Button type="button" variant="primary" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "Saving..." : isCreate ? "Create Card Pool" : "Save Changes"}
        </Button>
      </div>

      {error && <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error}</p>}
      {status && <p className="rounded-lg border border-accent-primary/40 bg-accent-primary/10 px-4 py-3 text-sm text-accent-primary">{status}</p>}

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
                  onClick={() => addCardToPool(card)}
                  onMouseEnter={(event) => {
                    setHoveredSearchCard(card);
                    setSearchPopupPosition(getSearchPopupPosition(event.currentTarget.getBoundingClientRect()));
                  }}
                  onMouseLeave={() => {
                    setHoveredSearchCard(null);
                    setSearchPopupPosition(null);
                  }}
                  onFocus={(event) => {
                    setHoveredSearchCard(card);
                    setSearchPopupPosition(getSearchPopupPosition(event.currentTarget.getBoundingClientRect()));
                  }}
                  onBlur={() => {
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
            <CardHoverPopup
              card={hoveredSearchCard}
              position={searchPopupPosition}
              imageError={searchImageErrors.has(hoveredSearchCard.id)}
              onImageError={() => setSearchImageErrors((prev) => new Set(prev).add(hoveredSearchCard.id))}
            />
          )}
        </div>
        <p className="mt-2 text-xs text-text-secondary">Type to search, then click a card in the dropdown to add one copy. Click the same card again for another copy. Added cards are local until you save changes.</p>
      </section>

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
          <p className="text-xs text-text-secondary">Import replaces the current cube contents in this editor. Click Save Changes to persist.</p>
          <Button type="button" variant="secondary" size="sm" onClick={replaceFromImport}>Replace cube with import</Button>
        </div>
      </section>

      <CardPoolGrid
        cards={cards}
        unknownIds={unknownIds}
        loading={resolving}
        emptyMessage="Import passcodes to preview this cube."
        heightClassName="h-[42rem]"
        gridClassName={gridClassName}
        cubeEditMode
        onCardClick={removeOneCopy}
        cardActionLabel={(card) => `Remove ${card.name} from cube`}
      />
    </div>
  );
}
