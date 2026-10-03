"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  cardLimit,
  emptyCardQuery,
  type CardArchetype,
  type CardFacets,
  type CardQuery,
  type DeckCardInfo,
  type DuelDeck,
  type DuelMode,
  type SavedDeck,
} from "@yugidraft/shared/duels";
import {
  AlertTriangle,
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Download,
  Hand,
  MoreHorizontal,
  Redo2,
  Save,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { TYPE_MONSTER } from "@/components/duel/constants";
import { parseDeckText, selectDomainMaster, type DeckMasterSelection } from "@/components/duel/ydk";
import { SheetRoot, StatusLine, SvButton, Zone } from "@/components/sheet";
import { cn } from "@/lib/utils";
import { useNavigationLeaveGuard } from "@/lib/hooks/use-duel-leave-guard";
import { createSavedDeck, deleteSavedDeck, getDeckCardFacets, getDeckCards, getSavedDeck, readRegistration, saveDraftDeck, updateSavedDeck, type DeckRegistrationMark, type SavedDeckView } from "./api";
import { CardActions, CardCopyCount } from "./card-actions";
import { CardArt } from "./card-art";
import { CardBrowser } from "./card-browser";
import { CardBottomSheet } from "./card-bottom-sheet";
import { CardPreview } from "./card-preview";
import { DeckSegmented, DeckSelect } from "./controls";
import { DeckSummary, type DeckCheckProps } from "./deck-check";
import { hasCardDrag, readCardDrag, writeCardDrag } from "./drag";
import { useEditorViewport } from "./editor-viewport";
import {
  BANLIST_CHOICES,
  banlistLabel,
  loadEditorPrefs,
  saveEditorPrefs,
  type BrowserView,
} from "./filter-model";
import { deckNameFromFile, MAX_IMPORT_FILE_BYTES } from "./import";
import { DeckImportPopover, Popover } from "./import-popover";
import { OwnsPageBar, ShellMenuButton } from "@/components/layout/shell-bar";
import { PageFrame } from "./page-frame";
import { RegistrationMark, lockedNote } from "./registration";
import {
  DEFAULT_NAME,
  EMPTY_DECK,
  MAX_NAME_LENGTH,
  allCodes,
  chooseMaster,
  clearSection,
  cloneDeck,
  copyCounts,
  copyKey,
  copyLimit,
  copyProblems,
  defaultAddSection,
  downloadYdkFile,
  guidanceNotes,
  importForLibrary,
  isNewDeckDirty,
  placeCard,
  removeCard,
  shuffled,
  snapshotOf,
  sortDeck,
  uniqueCodes,
  type CopyProblem,
  type CardSource,
  type DeckSection,
  type SelectedStack,
} from "./model";
import {
  DRAFT_EXTRA_MAX,
  DRAFT_MAIN_MAX,
  canAddFromPool,
  deckUsage,
  draftDeckNotes,
  draftMainMinimum,
  draftRuleText,
  poolCounts,
  remainingCopies,
  type DraftDeckPool,
} from "./pool-model";
import { DeckSectionGrid, type HoveredCopy } from "./section-grid";
import styles from "./editor.module.css";

const MODE_CHOICES = [
  { value: "normal" as const, label: "Standard" },
  { value: "domain" as const, label: "Domain" },
] as const;

const HISTORY_LIMIT = 100;
/** Passcodes per card-details request; the route takes at most 1000. */
const POOL_CHUNK = 500;
const HAND_SIZE = 5;
/** The pointer must rest this long on a card before the preview changes, so crossing cards does not flash them. */
const HOVER_IN_MS = 60;
/** Moving between cards keeps the preview; leaving the cards goes back to the selected card after this wait. */
const HOVER_OUT_MS = 160;

/** One undo step. The format is part of it, because a format change can move the Deck Master. */
type Snapshot = { selection: DeckMasterSelection; mode: DuelMode };
type History = { past: Snapshot[]; future: Snapshot[] };
type TestHand = { drawn: number[]; pile: number[] };
/**
 * The card under the pointer. A deck copy is kept by position, so the preview follows the deck when it changes.
 * A hand card or the Deck Master is kept with its place, so the preview ends when that card goes away.
 */
type HoverTarget =
  | HoveredCopy
  | { code: number; from: "list" | "master" }
  | { code: number; from: "hand"; index: number };

/** The code of the hovered card, or null when that card is gone: a removed element never sends pointerleave. */
function hoveredCode(hover: HoverTarget | null, deck: DuelDeck, hand: TestHand | null, mode: DuelMode): number | null {
  if (hover == null) return null;
  if ("section" in hover) return deck[hover.section][hover.index] ?? null;
  if (hover.from === "hand") return hand?.drawn[hover.index] === hover.code ? hover.code : null;
  if (hover.from === "master") return mode === "domain" && deck.deckMaster === hover.code ? hover.code : null;
  return hover.code;
}

function parseRouteId(raw: string | undefined): number | "new" | "invalid" {
  if (raw == null || raw === "") return "new";
  if (!/^\d+$/.test(raw)) return "invalid";
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) return "invalid";
  return id;
}

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** The name a new draft deck starts with. */
function draftDeckName(draftName: string): string {
  return `${draftName.trim() || "Draft"} deck`.slice(0, MAX_NAME_LENGTH);
}

function copiesText(max: number): string {
  if (max === 0) return "is Forbidden";
  return `allows ${max} ${max === 1 ? "copy" : "copies"}`;
}

/**
 * The deck editor. With `pool` it edits the player's draft deck: the card list holds only the pool,
 * each card has as many copies as the player drafted, and there is no banlist.
 */
/** The loading and error states. A draft deck page keeps its bar and menu button here too. */
function EditorState({ pool, backHref, children }: { pool: boolean; backHref: string; children: ReactNode }) {
  if (pool) {
    return <PageFrame title="Draft deck" back={{ href: backHref, label: "Back to the draft" }}>{children}</PageFrame>;
  }
  return <SheetRoot className={cn(styles.host, styles.center)}>{children}</SheetRoot>;
}

export function SavedDeckEditor({ deckId, pool }: { deckId?: string; pool?: DraftDeckPool }) {
  const router = useRouter();
  const pathname = usePathname();
  const routeId = parseRouteId(deckId ?? (/^\/decks\/(\d+)$/.exec(pathname)?.[1]));

  const [savedId, setSavedId] = useState<number | null>(null);
  // The tournament this deck is registered for, if any. A draft deck's mark comes with its pool.
  const [registration, setRegistration] = useState<DeckRegistrationMark | null>(pool?.registration ?? null);
  const startName = pool ? draftDeckName(pool.draftName) : DEFAULT_NAME;
  const [name, setName] = useState(startName);
  const [mode, setMode] = useState<DuelMode>("normal");
  const [selection, setSelection] = useState<DeckMasterSelection>({ deck: EMPTY_DECK, masterOrigin: null });
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [baseline, setBaseline] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(routeId === "invalid" ? "That deck id is not valid." : null);
  const [loading, setLoading] = useState(typeof routeId === "number");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Map<number, DeckCardInfo>>(() => new Map());
  const [unknown, setUnknown] = useState<Set<number>>(() => new Set());
  const [blocked, setBlocked] = useState<Set<number>>(() => new Set());
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaRetry, setMetaRetry] = useState(0);
  const [selected, setSelected] = useState<SelectedStack | null>(null);
  const [inspectCode, setInspectCode] = useState<number | null>(null);
  const [query, setQuery] = useState<CardQuery>(() => emptyCardQuery());
  const [view, setView] = useState<BrowserView>("grid");
  const [prefsReady, setPrefsReady] = useState(false);
  const [facets, setFacets] = useState<CardFacets | null>(null);
  const [facetsError, setFacetsError] = useState(false);
  const [facetsRetry, setFacetsRetry] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [hand, setHand] = useState<TestHand | null>(null);
  const [masterDropping, setMasterDropping] = useState(false);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [poolCards, setPoolCards] = useState<DeckCardInfo[] | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [poolRetry, setPoolRetry] = useState(0);
  const { editorRef, isPhone } = useEditorViewport(!!pool);
  const [phoneTab, setPhoneTab] = useState<"deck" | "cards">("deck");
  const [cardSheetOpen, setCardSheetOpen] = useState(false);
  const importGeneration = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const inspectScrollRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);

  useEffect(() => { if (!isPhone) setCardSheetOpen(false); }, [isPhone]);

  useEffect(() => () => {
    importGeneration.current += 1;
    window.clearTimeout(hoverTimer.current);
  }, []);

  const { deck, masterOrigin } = selection;
  const busy = saveBusy || deleteBusy;
  const dirty = baseline == null ? isNewDeckDirty(name.trim() === startName ? DEFAULT_NAME : name, mode, deck) : snapshotOf(name.trim(), mode, deck) !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useNavigationLeaveGuard(dirty, "You have unsaved deck changes. Leave without saving?");

  // Preferences are read after mount, so the server render and the first client render agree.
  useEffect(() => {
    const prefs = loadEditorPrefs();
    setQuery((current) => ({
      ...current,
      sort: prefs.sort ?? current.sort,
      order: prefs.order ?? current.order,
      banlist: pool ? "none" : prefs.banlist ?? current.banlist,
      scope: prefs.scope ?? current.scope,
    }));
    if (prefs.view) setView(prefs.view);
    setPrefsReady(true);
  }, []);

  useEffect(() => {
    // A draft deck has no banlist; its choices must not replace the ones for normal decks.
    if (!prefsReady || pool) return;
    saveEditorPrefs({ sort: query.sort, order: query.order, view, banlist: query.banlist, scope: query.scope });
  }, [prefsReady, query.sort, query.order, query.banlist, query.scope, view]);

  // The card list of a draft deck is the pool: its card details load once.
  useEffect(() => {
    if (!pool) return;
    let cancelled = false;
    setPoolError(null);
    const codes = pool.cards.map((card) => card.code);
    const chunks: number[][] = [];
    for (let at = 0; at < codes.length; at += POOL_CHUNK) chunks.push(codes.slice(at, at + POOL_CHUNK));
    void Promise.all(chunks.map((chunk) => getDeckCards(chunk))).then(
      (parts) => {
        if (cancelled) return;
        const cards = parts.flatMap((part) => part.cards);
        const missing = parts.flatMap((part) => part.missing);
        rememberCatalog(cards);
        if (missing.length > 0) {
          setUnknown((prev) => new Set([...prev, ...missing]));
        }
        setPoolCards(cards);
      },
      (reason: unknown) => {
        if (!cancelled) setPoolError(reason instanceof Error ? reason.message : "Could not load your draft pool.");
      },
    );
    return () => { cancelled = true; };
  }, [pool, poolRetry]);

  useEffect(() => {
    let cancelled = false;
    setFacetsError(false);
    void getDeckCardFacets().then(
      (result) => { if (!cancelled) setFacets(result); },
      () => { if (!cancelled) setFacetsError(true); },
    );
    return () => { cancelled = true; };
  }, [facetsRetry]);

  // A deck file dropped outside the import box must not make the browser leave the editor.
  useEffect(() => {
    function stopFileDrop(event: DragEvent) {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    }
    window.addEventListener("dragover", stopFileDrop);
    window.addEventListener("drop", stopFileDrop);
    return () => {
      window.removeEventListener("dragover", stopFileDrop);
      window.removeEventListener("drop", stopFileDrop);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (routeId === "invalid" || routeId === "new" || routeId === savedId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void getSavedDeck(routeId).then(
      (record) => {
        if (cancelled) return;
        setLoading(false);
        if (dirtyRef.current) return;
        applyRecord(record);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setLoadError(reason instanceof Error ? reason.message : "Could not load this deck.");
      },
    );
    return () => { cancelled = true; };
  }, [routeId]);

  useEffect(() => {
    const needed = uniqueCodes(allCodes(deck)).filter((code) => !catalog.has(code) && !unknown.has(code) && !blocked.has(code));
    if (needed.length === 0) return;
    let cancelled = false;
    setMetaError(null);
    void getDeckCards(needed).then(
      ({ cards, missing }) => {
        if (cancelled) return;
        rememberCatalog(cards);
        setUnknown((prev) => {
          const next = new Set(prev);
          for (const code of missing) next.add(code);
          return next;
        });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setBlocked((prev) => {
          const next = new Set(prev);
          for (const code of needed) next.add(code);
          return next;
        });
        setMetaError(reason instanceof Error ? reason.message : "Could not load card details.");
      },
    );
    return () => { cancelled = true; };
  }, [deck, metaRetry]);

  // A test hand shows one draw of the current Main Deck; a changed deck needs a new draw.
  const mainKey = deck.main.join(",");
  useEffect(() => { setHand(null); }, [mainKey]);

  const rememberCatalog = useCallback((cards: DeckCardInfo[]) => {
    if (cards.length === 0) return;
    setCatalog((prev) => {
      if (cards.every((card) => prev.get(card.code) === card)) return prev;
      const next = new Map(prev);
      for (const card of cards) next.set(card.code, card);
      return next;
    });
  }, []);

  function applyRecord(record: SavedDeckView) {
    setSavedId(record.id);
    if (record.registration !== undefined) setRegistration(readRegistration(record.registration));
    setName(record.name);
    setMode(record.mode);
    setSelection({ deck: cloneDeck(record.deck), masterOrigin: null });
    setHistory({ past: [], future: [] });
    setParseError(null);
    setBaseline(snapshotOf(record.name, record.mode, record.deck));
  }

  function commit(next: DeckMasterSelection, nextMode: DuelMode = mode) {
    if (busy || (next === selection && nextMode === mode)) return;
    importGeneration.current += 1;
    setHistory((current) => ({ past: [...current.past.slice(-(HISTORY_LIMIT - 1)), { selection, mode }], future: [] }));
    setSelection(next);
    setMode(nextMode);
    setParseError(null);
    setSavedFlash(false);
  }

  function restore(step: Snapshot) {
    importGeneration.current += 1;
    setSelection(step.selection);
    setMode(step.mode);
    setSavedFlash(false);
  }

  function undo() {
    const previous = history.past.at(-1);
    if (busy || !previous) return;
    setHistory({ past: history.past.slice(0, -1), future: [{ selection, mode }, ...history.future] });
    restore(previous);
  }

  function redo() {
    const next = history.future[0];
    if (busy || !next) return;
    setHistory({ past: [...history.past, { selection, mode }], future: history.future.slice(1) });
    restore(next);
  }

  const banlistOff = pool != null || query.banlist === "none";
  const limits = banlistOff ? null : facets?.banlists[query.banlist] ?? null;
  const limitsPending = !banlistOff && facets == null && !facetsError;
  const banlistName = banlistOff ? null : banlistLabel(query.banlist);
  const counts = useMemo(() => copyCounts(deck, catalog), [deck, catalog]);
  const problems = useMemo(() => (pool ? [] : copyProblems(deck, catalog, limits)), [pool, deck, catalog, limits]);
  const poolMap = useMemo(() => (pool ? poolCounts(pool.cards) : null), [pool]);
  const usage = useMemo(() => deckUsage(deck), [deck]);
  const over = useMemo(() => new Set(problems.map((problem) => problem.key)), [problems]);
  const archetypes = facets?.archetypes ?? [];

  // A draft pool counts copies by passcode: the pool lists each artwork on its own.
  const deckCount = useCallback(
    (card: DeckCardInfo) => (poolMap
      ? usage.get(card.code) ?? 0
      : counts.get(`name:${card.name}`) ?? counts.get(`code:${card.code}`) ?? 0),
    [counts, poolMap, usage],
  );

  function inspect(code: number, stack: SelectedStack | null = null, openSheet = true) {
    window.clearTimeout(hoverTimer.current);
    setHover(null);
    setInspectCode(code);
    setSelected(stack);
    if (isPhone && openSheet) setCardSheetOpen(true);
  }

  function pointAt(target: HoverTarget | null) {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHover(target), target ? HOVER_IN_MS : HOVER_OUT_MS);
  }

  /** Main and Extra only take the cards that belong there; the Side Deck takes any card. */
  function sectionFor(code: number, wanted: DeckSection): DeckSection {
    const card = catalog.get(code);
    if (!card || wanted === "side") return wanted;
    return defaultAddSection(card);
  }

  /** A draft deck can only hold as many copies of a card as the player drafted. */
  function poolRoomFor(code: number): boolean {
    if (!poolMap || canAddFromPool(poolMap, usage, code)) return true;
    setNotice(poolMap.has(code)
      ? `${cardName(code)}: no copies left in your pool.`
      : `${cardName(code)} is not in your draft pool.`);
    return false;
  }

  function roomFor(card: DeckCardInfo): boolean {
    if (poolMap) return poolRoomFor(card.code);
    if (limitsPending) {
      setNotice("Loading the banlist. Try again in a moment.");
      return false;
    }
    const max = limits ? cardLimit(limits, card) : 3;
    const have = deckCount(card);
    if (have < max) return true;
    setNotice(max === 3
      ? `${card.name}: you already have 3 copies.`
      : `${card.name}: ${banlistName ?? "the banlist"} ${copiesText(max)}.`);
    return false;
  }

  function addFromList(card: DeckCardInfo, wanted?: DeckSection) {
    rememberCatalog([card]);
    if (!roomFor(card)) return;
    const to = wanted === "side" ? "side" : defaultAddSection(card);
    commit(placeCard(selection, { code: card.code, from: "list" }, to));
  }

  function dropCard(source: CardSource, wanted: DeckSection, at?: number) {
    const to = sectionFor(source.code, wanted);
    // A card dropped on the wrong section of its own home stays where it is.
    if (to !== wanted && source.from === to) {
      setNotice(`${cardName(source.code)} goes in the ${to === "extra" ? "extra" : "main"} deck.`);
      return;
    }
    if (source.from === "list") {
      const card = catalog.get(source.code);
      if (card ? !roomFor(card) : !poolRoomFor(source.code)) return;
    }
    commit(placeCard(selection, source, to, to === wanted ? at : undefined));
    setSelected({ section: to, code: source.code });
    setInspectCode(source.code);
    if (to !== wanted) {
      setNotice(`${cardName(source.code)} goes in the ${to === "extra" ? "extra" : "main"} deck.`);
    }
  }

  function removeCopy(source: CardSource) {
    const next = removeCard(selection, source);
    commit(next);
    if (source.from !== "list" && source.from !== "master" && !next.deck[source.from].includes(source.code)) {
      setSelected(null);
    }
  }

  function makeMaster(code: number, section?: DeckSection) {
    const card = catalog.get(code);
    if (card && (card.type & TYPE_MONSTER) === 0) {
      setNotice("The Deck Master must be a monster.");
      return;
    }
    // A Deck Master that is not in the deck yet is a new copy, so it must fit the copy limit.
    const inDeck = deck.main.includes(code) || deck.extra.includes(code) || deck.side.includes(code);
    if (card && !inDeck && !roomFor(card)) return;
    commit(chooseMaster(selection, code, section));
    setInspectCode(code);
    setSelected(null);
  }

  function cardName(code: number): string {
    return catalog.get(code)?.name ?? `Passcode ${code}`;
  }

  function showArchetype(archetype: CardArchetype) {
    setQuery((current) => ({ ...current, archetypes: [...archetype.codes], archetypeMode: "member", text: "" }));
    setCardSheetOpen(false);
    focusSearch();
  }

  function focusSearch() {
    setPhoneTab("cards");
    requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); });
  }

  function applyImported(raw: DuelDeck) {
    if (allCodes(raw).length === 0) {
      throw new Error("No cards found. Import a YDK deck or a ydke:// link.");
    }
    const nextMode = raw.deckMaster != null ? "domain" : mode;
    commit(importForLibrary(raw, nextMode), nextMode);
    setSelected(null);
    setImportOpen(false);
    setNotice("Deck imported. Press Ctrl+Z to undo.");
  }

  function onFile(file: File) {
    if (busy) return;
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setParseError("This file is too large to be a YDK deck.");
      return;
    }
    const generation = ++importGeneration.current;
    setFileName(file.name);
    void file.text().then(
      (text) => {
        if (generation !== importGeneration.current) return;
        try {
          applyImported(parseDeckText(text));
          // A new deck that still has the default name takes the file's name.
          if (savedId == null && name.trim() === DEFAULT_NAME) setName(deckNameFromFile(file.name));
        } catch (reason: unknown) {
          setParseError(reason instanceof Error ? reason.message : "Could not parse that deck.");
        }
      },
      (reason: unknown) => {
        if (generation === importGeneration.current) {
          setParseError(reason instanceof Error ? reason.message : "Could not read that file.");
        }
      },
    );
  }

  function onPaste(text: string) {
    importGeneration.current += 1;
    try {
      applyImported(parseDeckText(text));
    } catch (reason: unknown) {
      setParseError(reason instanceof Error ? reason.message : "Could not parse that deck.");
    }
  }

  function dealHand() {
    const pile = shuffled(deck.main);
    setHand({ drawn: pile.slice(0, HAND_SIZE), pile: pile.slice(HAND_SIZE) });
  }

  async function save() {
    // Ctrl+S also works on the loading and error screens; there is no deck to save there.
    if (busy || loading || loadError != null || routeId === "invalid" || (typeof routeId === "number" && savedId == null)) return;
    importGeneration.current += 1;
    const trimmed = name.trim();
    if (!trimmed) {
      setSaveError("Deck name is required.");
      return;
    }
    if (pool && deck.main.length < draftMainMinimum(pool.mainPoolCount)) {
      setSaveError(`A draft deck needs at least ${draftMainMinimum(pool.mainPoolCount)} main deck cards.`);
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    const body = { name: trimmed, mode, deck: cloneDeck(deck) };
    try {
      let record: SavedDeckView;
      if (pool) {
        const saved = await saveDraftDeck(savedId, { ...body, draftId: pool.draftId });
        record = saved.deck;
        if (saved.warning) setNotice(saved.warning);
      } else {
        record = savedId == null ? await createSavedDeck(body) : await updateSavedDeck(savedId, body);
      }
      flushSync(() => {
        // A save that does not say keeps the mark it had.
        if (record.registration !== undefined) setRegistration(readRegistration(record.registration));
        setName(record.name);
        setMode(record.mode);
        setSelection({ deck: cloneDeck(record.deck), masterOrigin });
        setBaseline(snapshotOf(record.name, record.mode, record.deck));
        setSavedId(record.id);
        setSavedFlash(true);
      });
      // Keep selection provenance when a new deck acquires its permanent URL.
      if (savedId == null && !pool) window.history.replaceState(null, "", `/decks/${record.id}`);
    } catch (reason: unknown) {
      setSaveError(reason instanceof Error ? reason.message : "Could not save this deck.");
    } finally {
      setSaveBusy(false);
    }
  }

  async function confirmDelete() {
    if (savedId == null || deleteBusy) return;
    importGeneration.current += 1;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteSavedDeck(savedId);
      flushSync(() => setBaseline(snapshotOf(name.trim(), mode, deck)));
      router.push("/decks");
    } catch (reason: unknown) {
      setDeleteError(reason instanceof Error ? reason.message : "Could not delete this deck.");
      setDeleteBusy(false);
    }
  }

  const shortcuts = useRef({ undo, redo, save, focusSearch });
  shortcuts.current = { undo, redo, save, focusSearch };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "s") {
        event.preventDefault();
        void shortcuts.current.save();
        return;
      }
      if (typingTarget(event.target)) return;
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) shortcuts.current.redo();
        else shortcuts.current.undo();
      } else if (mod && key === "y") {
        event.preventDefault();
        shortcuts.current.redo();
      } else if (!mod && !event.altKey && event.key === "/") {
        event.preventDefault();
        shortcuts.current.focusSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const notes = pool ? draftDeckNotes(deck, pool.mainPoolCount) : guidanceNotes(mode, deck);
  const mainMinimum = pool ? draftMainMinimum(pool.mainPoolCount) : 40;
  const inspected = inspectCode == null ? undefined : catalog.get(inspectCode);
  const hoverCode = hoveredCode(hover, deck, hand, mode);
  const shownCode = hoverCode ?? inspectCode;
  const shown = shownCode == null ? undefined : catalog.get(shownCode);
  // Deck controls belong to the selected card, so they hide while the pane shows another card.
  const previewing = hoverCode != null && hoverCode !== inspectCode;

  useEffect(() => {
    if (inspectScrollRef.current) inspectScrollRef.current.scrollTop = 0;
  }, [shownCode]);
  const backHref = pool ? `/draft/${pool.slug}` : "/decks";
  const statusTone = saveError ? "bad" : dirty ? "warn" : savedId != null ? "ok" : undefined;
  const statusText = saveBusy
    ? "Saving…"
    : saveError
      ? saveError
      : dirty
        ? "Unsaved changes"
        : savedFlash || savedId != null
          ? "Saved"
          : "New deck";

  if (routeId === "invalid" || (loadError && savedId == null)) {
    return (
      <EditorState pool={!!pool} backHref={backHref}>
        <div ref={pool ? undefined : editorRef} role="alert" className={styles["de-fail"]}><StatusLine tone="block">{loadError ?? "That deck id is not valid."}</StatusLine></div>
        <div><SvButton as="a" href={backHref} variant="ghost">{pool ? "Back to the draft" : "Back to decks"}</SvButton></div>
      </EditorState>
    );
  }
  if (loading) {
    return (
      <EditorState pool={!!pool} backHref={backHref}>
        <p ref={pool ? undefined : editorRef} className={styles["de-wait"]} role="status">Loading deck…</p>
      </EditorState>
    );
  }

  const mainLow = pool ? mainMinimum : mode === "domain" ? 60 : 40;
  const tone = problems.length ? "bad" : notes.length ? "warn" : "ok";
  const flag = problems.length
    ? `${problems.length} ${problems.length === 1 ? "card has" : "cards have"} too many copies`
    : deck.main.length < mainLow ? `Main needs ${mainLow - deck.main.length} more ${mainLow - deck.main.length === 1 ? "card" : "cards"}`
      : notes[0] ?? `Deck size is correct for ${pool ? "a draft deck" : mode === "domain" ? "Domain" : "Standard"}.`;

  function showProblem(problem: CopyProblem) {
    const code = allCodes(deck).find((value) => copyKey(value, catalog) === problem.key);
    if (code == null) return;
    const section = (["main", "extra", "side"] as const).find((value) => deck[value].includes(code));
    inspect(code, section ? { section, code } : null);
  }
  const checkProps: DeckCheckProps = { problems, notes, banlistName, flag, tone, pool: !!pool, onProblem: showProblem };
  const sectionProps = {
    catalog, unknown, limits, over, selected,
    onSelect: (stack: SelectedStack, openSheet?: boolean) => inspect(stack.code, stack, openSheet),
    onHover: pointAt,
    onRemove: removeCopy,
    onDrop: dropCard,
  };
  const clearButton = (section: DeckSection, label: string) => (
    <SvButton
      variant="quiet"
      disabled={deck[section].length === 0 || busy}
      aria-label={`Remove every card from the ${label} Deck`}
      onClick={() => {
        commit(clearSection(selection, section));
        setNotice(`${label} deck cleared. Press Ctrl+Z to undo.`);
      }}
    >
      <Trash2 className="ic sm" aria-hidden />
      <span>Clear</span>
    </SvButton>
  );
  const historyControls = (
    <span className={styles["de-hist"]}>
      <button type="button" className={styles["de-ib"]} aria-label="Undo" title="Undo (Ctrl+Z)" disabled={busy || history.past.length === 0} onClick={undo}><Undo2 className="ic" aria-hidden /></button>
      <button type="button" className={styles["de-ib"]} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={busy || history.future.length === 0} onClick={redo}><Redo2 className="ic" aria-hidden /></button>
    </span>
  );
  const cardControls = inspected && !previewing ? (
    <CardActions
      card={inspected}
      deck={deck}
      mode={mode}
      copies={deckCount(inspected)}
      limit={copyLimit(inspected.code, catalog, limits)}
      poolCopies={poolMap ? poolMap.get(inspected.code) ?? 0 : undefined}
      banlistName={banlistName}
      archetypes={archetypes}
      hideSummary={isPhone && cardSheetOpen}
      onAdd={(section) => addFromList(inspected, section)}
      onRemove={(section) => removeCopy({ code: inspected.code, from: section })}
      onMaster={() => makeMaster(inspected.code, selected?.code === inspected.code ? selected.section : undefined)}
      onArchetype={showArchetype}
    />
  ) : null;
  const missingReader = (
    <p className={styles.inspectNotice}>
      Passcode {shownCode}: {unknown.has(shownCode ?? 0)
        ? "this card is not in the card database. It stays in your deck."
        : metaError ? "card details are not available." : "loading card details…"}
    </p>
  );

  return (
    <SheetRoot className={styles.host} data-pool={pool ? "" : undefined} aria-hidden={isPhone && cardSheetOpen ? true : undefined}>
      {pool ? <OwnsPageBar room /> : null}
      <div ref={editorRef} className={styles.de} data-tab={phoneTab}>
        <header className={styles["de-bar"]}>
          <Link href={backHref} className={styles["de-back"]} aria-label={pool ? "Back to the draft" : "Back to decks"}>
            <ChevronLeft size={18} strokeWidth={2} aria-hidden />
            <span>{pool ? "Draft" : "Decks"}</span>
          </Link>
          <label className={styles["de-namef"]}>
            <span className="sr">Deck name</span>
            <input
              className={styles["de-name"]}
              value={name}
              maxLength={MAX_NAME_LENGTH}
              disabled={busy}
              onChange={(event) => {
                importGeneration.current += 1;
                setName(event.target.value);
                setSavedFlash(false);
              }}
            />
          </label>
          <div className={styles["de-prow"]}>
            {pool ? (
              <>
                <p className={styles["de-rule"]}>
                  <b>Draft deck from {pool.draftName}</b>
                  <span>{draftRuleText(pool.mainPoolCount)}</span>
                </p>
                {isPhone ? <SvButton variant="quiet" onClick={() => downloadYdkFile(name, deck)}><Download className="ic sm" aria-hidden />Export YDK</SvButton> : null}
              </>
            ) : (
              <>
                <DeckSegmented label="Format" value={mode} disabled={busy} choices={MODE_CHOICES} className={styles["de-fmt"]} onChange={(value) => commit(selection, value)} />
                <DeckSelect
                  label="Banlist"
                  value={query.banlist}
                  choices={BANLIST_CHOICES}
                  className={styles["de-banf"]}
                  onChange={(banlist) => setQuery((current) => ({ ...current, banlist, limits: banlist === "none" ? [] : current.limits }))}
                />
              </>
            )}
          </div>
          <p className={styles["de-status"]} data-tone={statusTone} aria-live="polite"><span className={styles["de-dot"]} aria-hidden="true" />{statusText}</p>
          <div className={styles["de-acts"]}>
            {!isPhone ? historyControls : null}
            {!pool ? (
              <DeckImportPopover
                className={styles["de-import"]}
                open={importOpen}
                onOpenChange={(open) => { setImportOpen(open); if (open) setParseError(null); }}
                disabled={busy}
                mode={mode}
                fileName={fileName}
                error={parseError}
                onFile={onFile}
                onPaste={onPaste}
              />
            ) : null}
            {!isPhone ? <SvButton variant="quiet" className={styles["de-export"]} onClick={() => downloadYdkFile(name, deck)}><Download className="ic sm" aria-hidden />Export YDK</SvButton> : null}
            {!pool ? (
              <Popover
                label="More deck actions"
                icon={<MoreHorizontal className="ic" aria-hidden />}
                iconOnly
                open={moreOpen || deleteOpen}
                role={deleteOpen ? "dialog" : "menu"}
                dialogLabel={deleteOpen ? `Delete ${name.trim() || "this deck"}?` : "More deck actions"}
                focusKey={deleteOpen ? "delete" : "more"}
                className={styles["de-more"]}
                disabled={busy && !deleteOpen}
                onOpenChange={(open) => { setMoreOpen(open); setDeleteOpen(false); setDeleteError(null); }}
              >
                {deleteOpen ? (
                  <>
                    <p className={styles["de-pop-h"]}>Delete {name.trim() || "this deck"}?</p>
                    <p className="small">You cannot undo this.</p>
                    {deleteError ? <p role="alert" className={styles.errorText}>{deleteError}</p> : null}
                    <div className={styles["de-pop-a"]}>
                      <SvButton variant="quiet" data-autofocus disabled={deleteBusy} onClick={() => { setDeleteOpen(false); setMoreOpen(false); }}>Keep</SvButton>
                      <SvButton variant="danger" aria-busy={deleteBusy || undefined} disabled={deleteBusy} onClick={() => void confirmDelete()}>Delete deck</SvButton>
                    </div>
                  </>
                ) : (
                  <>
                    {isPhone ? <><SvButton variant="quiet" role="menuitem" onClick={() => { setMoreOpen(false); setParseError(null); setImportOpen(true); }}>Import</SvButton><SvButton variant="quiet" role="menuitem" onClick={() => { setMoreOpen(false); downloadYdkFile(name, deck); }}>Export YDK</SvButton></> : null}
                    <SvButton variant="danger" role="menuitem" disabled={savedId == null || busy} onClick={() => { setMoreOpen(false); setDeleteOpen(true); setDeleteError(null); }}>
                      <Trash2 className="ic sm" aria-hidden />Delete
                    </SvButton>
                  </>
                )}
              </Popover>
            ) : null}
            <SvButton variant="primary" className={styles["de-save"]} aria-busy={saveBusy || undefined} disabled={busy} title="Save (Ctrl+S)" onClick={() => void save()}><Save className="ic sm" aria-hidden />Save</SvButton>
          </div>
          {pool ? <span className={styles["de-menu"]}><ShellMenuButton /></span> : null}
        </header>
        <div className={cn("seg", styles["de-tabs"])} role="tablist" aria-label="Editor" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "deck" : event.key === "End" ? "cards" : phoneTab === "deck" ? "cards" : "deck";
          setPhoneTab(next);
          document.getElementById(next === "deck" ? "deck-editor-tab" : "deck-editor-cards-tab")?.focus();
        }}>
          <button type="button" role="tab" tabIndex={phoneTab === "deck" ? 0 : -1} id="deck-editor-tab" aria-controls="deck-editor-deck" aria-selected={phoneTab === "deck"} aria-pressed={phoneTab === "deck"} onClick={() => setPhoneTab("deck")}>Deck <b className="num">{deck.main.length}</b></button>
          <button type="button" role="tab" tabIndex={phoneTab === "cards" ? 0 : -1} id="deck-editor-cards-tab" aria-controls="deck-editor-cards" aria-selected={phoneTab === "cards"} aria-pressed={phoneTab === "cards"} onClick={() => setPhoneTab("cards")}>Cards</button>
        </div>
        <div className={styles["de-body"]}>
          <aside className={styles["de-read"]} aria-label="Card details" ref={inspectScrollRef}>
            {shownCode == null ? <DeckSummary {...checkProps} deck={deck} catalog={catalog} emptyNew={savedId == null && allCodes(deck).length === 0} /> : shown ? <CardPreview card={shown} /> : missingReader}
            {cardControls}
          </aside>
          <main className={styles["de-deck"]} aria-label="Deck" id="deck-editor-deck">
            {registration ? (
              <div className={styles["de-reg"]}>
                <RegistrationMark registration={registration} />
                {lockedNote(registration) ? <StatusLine tone="warn">{lockedNote(registration)}</StatusLine> : null}
              </div>
            ) : null}
            {isPhone ? <details className={styles["de-pchk"]} data-s={tone}><summary>{tone === "ok" ? <Check className="ic sm" aria-hidden /> : <AlertTriangle className="ic sm" aria-hidden />}<span>{flag}</span><ChevronDown className="ic sm" aria-hidden /></summary><DeckSummary {...checkProps} deck={deck} catalog={catalog} emptyNew={savedId == null && allCodes(deck).length === 0} /></details> : null}
            <div className={styles["de-dbar"]}>
              {!isPhone && shownCode != null ? <button className={styles["de-flag"]} type="button" data-s={tone} onClick={() => { window.clearTimeout(hoverTimer.current); setHover(null); setSelected(null); setInspectCode(null); inspectScrollRef.current?.scrollTo?.({ top: 0 }); }}>{tone === "ok" ? <Check className="ic sm" aria-hidden /> : <AlertTriangle className="ic sm" aria-hidden />}{flag}</button> : null}
              <span className={styles["de-tools"]}><SvButton variant="quiet" disabled={busy || allCodes(deck).length === 0} onClick={() => commit(sortDeck(selection, catalog))}><ArrowDownUp className="ic sm" aria-hidden />Sort</SvButton><SvButton variant="quiet" disabled={deck.main.length === 0} aria-pressed={hand != null} onClick={() => hand ? setHand(null) : dealHand()}><Hand className="ic sm" aria-hidden />Test hand</SvButton></span>
              {isPhone ? historyControls : null}
            </div>
            {notice ? <p className={styles.notice} role="status">{notice}<button type="button" className={styles["de-ib"]} aria-label="Close message" onClick={() => setNotice(null)}><X className="ic sm" aria-hidden /></button></p> : null}
            {facetsError ? <div className={styles["de-alert"]}><StatusLine tone="warn"><b>Filters and banlists are not available.</b> {pool ? "Archetype filters do not load." : "Archetype filters do not load and the editor does not check banlist limits."}</StatusLine><SvButton variant="quiet" onClick={() => setFacetsRetry((value) => value + 1)}>Try again</SvButton></div> : null}
            {pool && pool.unresolved.length > 0 ? <div className={styles["de-alert"]}><StatusLine tone="warn"><b>{pool.unresolved.length} {pool.unresolved.length === 1 ? "card" : "cards"} cannot be used.</b> The duel engine does not know {pool.unresolved.length === 1 ? "this card" : "these cards"}, so {pool.unresolved.length === 1 ? "it is" : "they are"} not in the list.</StatusLine></div> : null}
            {poolError ? <div className={styles["de-alert"]}><StatusLine tone="block"><b>Your draft pool is not available.</b> {poolError}</StatusLine><SvButton variant="quiet" onClick={() => setPoolRetry((value) => value + 1)}>Try again</SvButton></div> : null}
            {metaError ? <div className={styles["de-alert"]}><StatusLine tone="warn"><b>Card details are not available.</b> {metaError} The passcodes stay in the deck.</StatusLine><SvButton variant="quiet" onClick={() => { setBlocked(new Set()); setMetaRetry((value) => value + 1); }}>Try again</SvButton></div> : null}
            {hand ? (
              <section className={styles["de-hand"]} aria-label="Test hand">
                <header className={styles["de-sh"]}><h2 className={styles["de-st"]}>Test hand</h2><span className={cn("num", styles["de-tg"])}>{hand.drawn.length} {hand.drawn.length === 1 ? "card" : "cards"}, {hand.pile.length} left</span><span className={styles["de-tools"]}><SvButton variant="quiet" disabled={hand.pile.length === 0} onClick={() => setHand({ drawn: [...hand.drawn, hand.pile[0]!], pile: hand.pile.slice(1) })}>Draw</SvButton><SvButton variant="quiet" onClick={dealHand}>New hand</SvButton><button type="button" className={styles["de-ib"]} aria-label="Close test hand" onClick={() => setHand(null)}><X className="ic sm" aria-hidden /></button></span></header>
                <ul className={cn(styles["de-grid"], styles["de-hand-g"])}>{hand.drawn.map((code, index) => <li key={`${index}-${code}`}><button type="button" className={styles["de-c"]} aria-label={cardName(code)} title={cardName(code)} onClick={(event) => { event.currentTarget.focus(); inspect(code); }} onPointerEnter={(event) => { if (event.pointerType !== "touch") pointAt({ code, from: "hand", index }); }} onPointerLeave={() => pointAt(null)}><CardArt code={code} name={cardName(code)} /></button></li>)}</ul>
              </section>
            ) : null}
            {mode === "domain" ? (
              <section className={styles["de-master"]} aria-label="Deck Master" data-dropping={masterDropping || undefined}
                onDragOver={(event) => { if (hasCardDrag(event)) { event.preventDefault(); setMasterDropping(true); } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMasterDropping(false); }}
                onDrop={(event) => { setMasterDropping(false); const drag = readCardDrag(event); if (!drag || drag.from === "master") return; event.preventDefault(); makeMaster(drag.code, drag.from === "list" ? undefined : drag.from); }}>
                <div className={styles["de-mslot"]}>{deck.deckMaster != null ? <button type="button" className={styles["de-c"]} aria-label={`Deck Master: ${cardName(deck.deckMaster)}`} aria-pressed={inspectCode === deck.deckMaster && selected == null} title={cardName(deck.deckMaster)} draggable onClick={(event) => { event.currentTarget.focus(); inspect(deck.deckMaster!); }} onPointerEnter={(event) => { if (event.pointerType !== "touch") pointAt({ code: deck.deckMaster!, from: "master" }); }} onPointerLeave={() => pointAt(null)} onDragStart={(event) => writeCardDrag(event, { code: deck.deckMaster!, from: "master" })} onContextMenu={(event) => { event.preventDefault(); commit(selectDomainMaster(selection, undefined)); }}><CardArt code={deck.deckMaster} name={cardName(deck.deckMaster)} /></button> : <Zone state="dashed" size="md" style={{ "--zw": "58px" } as CSSProperties} />}</div>
                <div className={styles.masterText}><h2 className={styles["de-st"]}>Deck Master</h2><p className="small">{deck.deckMaster != null ? `${cardName(deck.deckMaster)}. ` : ""}Drag a monster here, or select one and press Use as Deck Master.</p>{deck.deckMaster != null ? <SvButton variant="quiet" disabled={busy} onClick={() => commit(selectDomainMaster(selection, undefined))}>Clear</SvButton> : null}</div>
              </section>
            ) : null}
            <DeckSectionGrid {...sectionProps} title="Main" section="main" codes={deck.main} minimum={mainLow} maximum={DRAFT_MAIN_MAX} target={mode === "domain" ? "60" : `${mainLow}–${DRAFT_MAIN_MAX}`} emptyHint="Add cards from the list on the right." actions={clearButton("main", "Main")} />
            <DeckSectionGrid {...sectionProps} title="Extra" section="extra" codes={deck.extra} maximum={DRAFT_EXTRA_MAX} target="up to 15" emptyHint="Fusion, Synchro, Xyz and Link monsters go here." actions={clearButton("extra", "Extra")} />
            <DeckSectionGrid {...sectionProps} title="Side" section="side" codes={deck.side} unused={mode === "domain"} maximum={mode === "domain" ? 0 : 15} target={mode === "domain" ? "Not used in Domain" : "up to 15"} emptyHint="Drag cards here, or use Side on a selected card." actions={clearButton("side", "Side")} />
          </main>
          <CardBrowser id="deck-editor-cards" pool={poolMap ? { cards: poolCards, remaining: (card) => remainingCopies(poolMap, usage, card.code), totalCopies: [...poolMap.values()].reduce((sum, count) => sum + count, 0), notInDeck: [...poolMap.keys()].reduce((sum, code) => sum + remainingCopies(poolMap, usage, code), 0) } : undefined} query={query} onQueryChange={setQuery} archetypes={archetypes} limits={limits} view={view} onViewChange={setView} deckCount={deckCount} inspectCode={selected == null ? inspectCode : null} onInspect={(card, openSheet) => { rememberCatalog([card]); inspect(card.code, null, openSheet); }} onHover={(card) => { if (card) rememberCatalog([card]); pointAt(card ? { code: card.code, from: "list" } : null); }} onAdd={(card) => addFromList(card)} onCatalog={rememberCatalog} onRemoveDrop={(drag) => removeCopy(drag)} searchRef={searchRef} />
        </div>
        {isPhone && cardSheetOpen && inspectCode != null ? <CardBottomSheet label={cardName(inspectCode)} onClose={() => { setCardSheetOpen(false); setHover(null); }}>{shown ? <CardPreview card={shown} compact copySummary={inspected && !previewing ? <CardCopyCount copies={deckCount(inspected)} limit={copyLimit(inspected.code, catalog, limits)} poolCopies={poolMap ? poolMap.get(inspected.code) ?? 0 : undefined} /> : undefined} /> : missingReader}{cardControls}</CardBottomSheet> : null}
      </div>
    </SheetRoot>
  );
}
