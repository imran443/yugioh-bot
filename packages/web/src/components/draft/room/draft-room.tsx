"use client";

/**
 * The cube-night draft room: the full-screen layer shown while a draft is active.
 * Ported from the approved mock; the simulator is replaced by the live draft (see use-room-state.ts).
 */
import { cardImageUrl } from "@/lib/card-image-url";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PLAYER_COPY_CAP } from "@/components/cubes/readiness";
import { useDraftStore } from "@/lib/stores/draft-store";
import { useTalkStore } from "@/lib/stores/talk-store";
import { TALK_COOLDOWN_MS, type TalkLineId } from "@yugidraft/shared/ws/talk";
import { Binder, type BinderHandle } from "./binder";
import { CardReader, TAG_CHOSEN, TAG_PICKED, TAG_POINTING } from "./card-reader";
import { FullscreenLayer } from "./layer";
import { CancelConfirm } from "./cancel-confirm";
import { MotionMenu } from "./motion-menu";
import { SayMenu } from "./say-menu";
import { animate, canTravel, flight, motionOff, prefersReducedMotion, useMotionSetting, wait } from "./motion";
import { RoomBar } from "./room-bar";
import {
  EMPTY_FILTER,
  KINDS,
  attributeTint,
  blockedLabel,
  dialModel,
  forcedPackNote,
  filterWords,
  isFiltering,
  joinNames,
  kindOf,
  matchesFilter,
  dealRibbon,
  passLabel,
  restoredPick,
  seatPackSize,
  themeProgress,
  tint,
  toggled,
  urgencyFor,
  type Kind,
  type RoomCard,
  type RoomConfigLike,
  type RoomFilter,
  type SeatState,
} from "./room-model";
import { SeatStrip, Seats, type FriendView } from "./seats";
import { measureTable } from "./table-geometry";
import { Table } from "./table";
import { Tray } from "./tray";
import { useMedia } from "./use-media";
import { usePick, type PickAttempt } from "./use-pick";
import { useRoomState } from "./use-room-state";

export interface DraftRoomProps {
  slug: string;
  name: string;
  config: RoomConfigLike;
  isParticipant: boolean;
  /**
   * The host or an owner passes this to get the Cancel draft button. It sends the request and resolves when the
   * draft has changed; it rejects with the words to show. Left out, the room has no Cancel button.
   */
  onCancel?: () => Promise<void>;
}

const PHONE = "(max-width: 900px)";
const DRAWER = "(max-width: 1359px) and (min-width: 901px)";
// seconds left on the store clock at which a selected card is picked; early enough for the POST to beat the server sweep
const AUTO_PICK_AT = 2;

const parseNumberKey = (key: string): number | null => {
  if (key >= "1" && key <= "9") return Number(key);
  if (key.startsWith("Numpad") && key.length === 7 && key[6] >= "1" && key[6] <= "9") return Number(key[6]);
  return null;
};

const inField = (t: EventTarget | null) => t instanceof Element && !!t.closest("input, textarea, select");

const canRestoreFocus = (el: HTMLElement | null | undefined): el is HTMLElement => {
  if (!el?.isConnected || el === document.body || el.closest("[inert], [hidden]") || el.matches(":disabled")) return false;
  const visibility = getComputedStyle(el).visibility;
  if (visibility === "hidden" || visibility === "collapse") return false;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
  }
  return true;
};

export function DraftRoom({ slug, name, config, isParticipant, onCancel }: DraftRoomProps) {
  const rs = useRoomState(config, isParticipant);
  const { sizes, deal, turn, direction } = rs;
  const [motion, setMotion] = useMotionSetting();
  const phone = useMedia(PHONE);
  const drawer = useMedia(DRAWER);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const motionBtn = useRef<HTMLButtonElement>(null);
  const binderRef = useRef<BinderHandle>(null);
  const readerPanelRef = useRef<HTMLDivElement>(null);
  const binderPanelRef = useRef<HTMLDivElement>(null);
  const panelFocusRef = useRef<{ opener: HTMLElement | null; panel: HTMLDivElement } | null>(null);
  const [stage, setStage] = useState<HTMLElement | null>(null);

  /* ---------- state ---------- */
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ card: RoomCard; tag: string } | null>(null);
  const [lastPick, setLastPick] = useState<RoomCard | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);
  const sentPicks = useRef<{ stepKey: string | null; ids: Set<number> }>({ stepKey: null, ids: new Set() });
  const currentDeal = useRef(deal);
  currentDeal.current = deal;
  const [filter, setFilter] = useState<RoomFilter>(EMPTY_FILTER);
  const [sheet, setSheet] = useState<"card" | "binder" | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [motionOpen, setMotionOpen] = useState(false);
  const [sayAnchor, setSayAnchor] = useState<HTMLElement | null>(null);
  const [sayWait, setSayWait] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const cancelBtn = useRef<HTMLElement | null>(null);
  const sayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [kbd, setKbd] = useState(false);
  const [newId, setNewId] = useState<number | null>(null);
  const [landed, setLanded] = useState<{ kind: Kind; seq: number } | null>(null);
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const [ribbonOn, setRibbonOn] = useState(false);
  /** The deal whose ribbon has finished. The cards wait for it, as the mock's deal waits for its ribbon. */
  const [ribbonDone, setRibbonDone] = useState(-1);
  const [passing, setPassing] = useState(false);
  const [positions, setPositions] = useState<Record<number, { x: number; y: number }>>({});
  const [size, setSize] = useState({ w: 1100, h: 700, diskH: 112 });
  const clicking = useRef(false);

  const theme = sizes.theme;
  const pool = useMemo(() => rs.pool.filter((c) => !pending.has(c.id)), [rs.pool, pending]);
  const poolCount = pool.length;
  const tp = themeProgress(poolCount, sizes);
  const phase: "main" | "extra" = theme && tp.inExtra ? "extra" : "main";
  /** Booster drafts: the one Extra Deck pack after the main rounds is smaller than the main packs. */
  const boosterPackSize =
    sizes.boosterExtraSize > 0 && rs.packRound > sizes.packsPerPlayer ? sizes.boosterExtraSize : sizes.packSize;
  /** Pool size at which this round's packs stop passing: the last main pack is followed by a new Extra pack, not a pass. */
  const passEnd = rs.packRound > sizes.packsPerPlayer ? sizes.total : sizes.cardsPerPlayer;
  const urgency = useDraftStore((s) => urgencyFor(s.timerSeconds, turn));

  /* ---------- the pack ribbon plays first, then the cards deal in ---------- */
  // Worked out while rendering, so the first frame of a new deal already has an empty table.
  const ribbon = useMemo(
    () =>
      dealRibbon({
        seq: deal.seq,
        theme,
        poolCount,
        pickStep: rs.pickStep,
        packRound: rs.packRound,
        direction,
        sizes,
      }),
    // only a new deal raises the ribbon
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deal.seq],
  );
  const holdDeal = ribbon != null && ribbonDone !== ribbon.seq;

  /* ---------- table talk: a few fixed words to the table ---------- */
  const heard = useTalkStore((s) => s.heard);
  const myPlayerId = useDraftStore((s) => s.seats.find((x) => x.isCurrentPlayer)?.playerId ?? null);
  const canSay = isParticipant && myPlayerId != null;
  const sayOpen = sayAnchor != null;
  const cancelling = cancelOpen && !!onCancel;
  useEffect(() => {
    useTalkStore.getState().clear();
    return () => {
      useTalkStore.getState().clear();
      if (sayTimer.current) clearTimeout(sayTimer.current);
    };
  }, []);
  const toggleSay = useCallback((anchor: HTMLElement) => {
    setMotionOpen(false);
    setSayAnchor((cur) => (cur === anchor ? null : anchor));
  }, []);
  // the Say button moves between the bar and the seat strip at the phone breakpoint
  useEffect(() => setSayAnchor(null), [phone]);
  const waitToSay = useCallback((ms: number) => {
    setSayWait(true);
    if (sayTimer.current) clearTimeout(sayTimer.current);
    sayTimer.current = setTimeout(() => setSayWait(false), ms);
  }, []);
  const say = useCallback(
    (line: TalkLineId) => {
      const anchor = sayAnchor;
      setSayAnchor(null);
      anchor?.focus();
      waitToSay(TALK_COOLDOWN_MS);
      // The line comes back to everyone, you included, through the live feed.
      void fetch(`/api/drafts/${encodeURIComponent(slug)}/talk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line }),
      })
        .then(async (res) => {
          if (res.status !== 429) return;
          const body = (await res.json().catch(() => null)) as { retryAfterMs?: number } | null;
          waitToSay(Math.min(TALK_COOLDOWN_MS, Math.max(500, body?.retryAfterMs ?? TALK_COOLDOWN_MS)));
        })
        .catch(() => {});
    },
    [sayAnchor, slug, waitToSay],
  );

  /* ---------- geometry ---------- */
  useLayoutEffect(() => {
    if (!stage) return;
    const measure = () => {
      const r = stage.getBoundingClientRect();
      const diskH =
        parseFloat(getComputedStyle(rootRef.current ?? stage).getPropertyValue("--disk-h")) || 112;
      setSize((cur) =>
        Math.abs(cur.w - r.width) < 1 && Math.abs(cur.h - r.height) < 1 && cur.diskH === diskH
          ? cur
          : { w: r.width, h: r.height, diskH },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [stage]);
  const geometry = useMemo(
    () => measureTable({
      width: size.w, height: size.h, phone, theme, diskH: size.diskH,
      packSize: Math.max(theme ? sizes.themePackSize : sizes.packSize, deal.dealt.length),
    }),
    [size, phone, theme, sizes.packSize, sizes.themePackSize, deal.dealt.length],
  );

  const seatCount = rs.tableSeats.length;
  // friends are drawn upright in the room, pinned to where their anchor lands on the tilted table
  useLayoutEffect(() => {
    if (!stage) return;
    const place = () => {
      const sr = stage.getBoundingClientRect();
      const next: Record<number, { x: number; y: number }> = {};
      stage.querySelectorAll<HTMLElement>(".anchor[data-anchor]").forEach((a) => {
        const i = Number(a.dataset.anchor);
        if (!i) return;
        const r = a.getBoundingClientRect();
        next[i] = { x: Math.round(r.left - sr.left + stage.scrollLeft), y: Math.round(r.top - sr.top + stage.scrollTop) };
      });
      setPositions((cur) => {
        const keys = Object.keys(next);
        const same = keys.length === Object.keys(cur).length && keys.every((k) => cur[+k]?.x === next[+k].x && cur[+k]?.y === next[+k].y);
        return same ? cur : next;
      });
    };
    place();
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [stage, geometry, seatCount]);

  /* ---------- sheets ---------- */
  const binderOpen = phone ? sheet === "binder" : drawer ? drawerOpen : true;
  const openPanel = phone ? sheet : drawer && binderOpen ? "binder" : null;
  const openSheet = useCallback(
    (which: "card" | "binder") => {
      if (phone) {
        setSheet(which);
        setDrawerOpen(false);
      } else if (which === "binder" && drawer) setDrawerOpen(true);
    },
    [phone, drawer],
  );
  const closeSheets = useCallback(() => {
    setSheet(null);
    setDrawerOpen(false);
  }, []);
  const closeCardSheet = useCallback(() => setSheet((s) => (s === "card" ? null : s)), []);
  useLayoutEffect(() => {
    const previous = panelFocusRef.current;
    panelFocusRef.current = null;
    const opener = previous?.opener;
    // Leave focus alone when it stayed on the table or moved outside the closing panel.
    const needsRestore = previous && (previous.panel.contains(document.activeElement) || document.activeElement === document.body);
    // React restores pre-commit focus after layout cleanups. Restore here, after that and the inert updates.
    if (needsRestore) {
      const root = rootRef.current;
      const toggle = previous.panel === binderPanelRef.current
        ? root?.querySelector<HTMLElement>('.dial[aria-controls="binder"]')
        : null;
      const target = [
        opener,
        toggle,
        ...Array.from(root?.querySelectorAll<HTMLElement>('.stage .tcard[tabindex="0"]') ?? []),
        root?.querySelector<HTMLElement>(".stage"),
      ].find(canRestoreFocus);
      if (target) {
        // Focusing a table card normally opens the reader. Restoration only moves focus.
        const wasClicking = clicking.current;
        clicking.current = true;
        target.focus({ preventScroll: true });
        clicking.current = wasClicking;
      }
    }
    if (!openPanel) return;
    const panel = openPanel === "card" ? readerPanelRef.current : binderPanelRef.current;
    if (!panel) return;
    const nextOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelFocusRef.current = { opener: nextOpener, panel };
    // The reader previews the focused table card without taking focus away from it.
    if (openPanel === "card" && nextOpener?.matches(".tcard")) return;
    const first = panel.querySelector<HTMLElement>(
      'button:not(:disabled):not([hidden]), input:not(:disabled):not([hidden]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panel).focus({ preventScroll: true });
  }, [openPanel]);
  useEffect(() => {
    setSelectedId(null);
    closeSheets();
  }, [phone, drawer, closeSheets]);

  /* ---------- a new deal: forget the last selection ---------- */
  useEffect(() => {
    setSelectedId(null);
    setHoverId(null);
    setPeek(null);
    setPickNote(null);
    setPassing(false);
    closeCardSheet();
  }, [deal.seq, closeCardSheet]);
  // The table shows the small pictures, so they go first. The dock swaps to the big pictures the moment the
  // pointer moves, so those are fetched after the small ones are done and do not slow the pack down.
  const warmImages = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    let cancelled = false;
    const start = (variant: "small" | "full") =>
      rs.cards.map((c) => {
        const img = new Image();
        img.src = cardImageUrl(c.passcode ?? c.id, variant);
        return img;
      });
    const small = start("small");
    warmImages.current = small;
    let pending = small.length;
    let full: HTMLImageElement[] = [];
    const loadFull = () => {
      if (cancelled) return;
      full = start("full");
      warmImages.current = [...small, ...full];
    };
    if (!pending) return;
    const settle = () => {
      if (--pending === 0) loadFull();
    };
    for (const img of small) {
      if (img.complete) settle();
      else {
        img.addEventListener("load", settle, { once: true });
        img.addEventListener("error", settle, { once: true });
      }
    }
    return () => {
      cancelled = true;
      // The next pack's small pictures must not wait behind the old pack's large ones.
      for (const img of full) if (!img.complete) img.src = "";
    };
  }, [rs.cards]);
  useEffect(() => {
    if (selectedId != null && !rs.cards.some((c) => c.id === selectedId)) setSelectedId(null);
  }, [rs.cards, selectedId]);
  useEffect(() => {
    if (rs.settle > 0) setPassing(true);
  }, [rs.settle]);

  /* ---------- picking ---------- */
  const flightRef = useRef<{ card: RoomCard; from: DOMRect | null; to: DOMRect | null } | null>(null);
  const reconcilePick = useCallback((attempt: PickAttempt, pool: RoomCard[]) => {
    const card = pool.find((c) => attempt.packIds.has(c.id)) ?? null;
    setLastPick(card);
    if (currentDeal.current.stepKey !== attempt.stepKey) return;
    if (card) rs.picked(card.id);
    else rs.unpicked();
    const sentHere = sentPicks.current.stepKey === attempt.stepKey && card && sentPicks.current.ids.has(card.id);
    setPickNote(card && !sentHere ? `Time ran out. You got ${card.name}.` : null);
  }, [rs.picked, rs.unpicked]);

  // Polls also resolve picks made by the timer or another tab.
  useEffect(() => {
    if (deal.stepKey == null || deal.stepKey !== rs.stepKey || !deal.dealt.length) return;
    const packIds = new Set(deal.dealt.map((c) => c.id));
    if (rs.pool.some((c) => packIds.has(c.id))) {
      reconcilePick({ stepKey: deal.stepKey, packIds }, rs.pool);
    }
  }, [deal.stepKey, deal.dealt, rs.stepKey, rs.pool, reconcilePick]);

  const landCard = useCallback((card: RoomCard) => {
    setPending((cur) => {
      const next = new Set(cur);
      next.delete(card.id);
      return next;
    });
    setLanded((cur) => ({ kind: kindOf(card), seq: (cur?.seq ?? 0) + 1 }));
    setNewId(card.id);
  }, []);
  const hooks = useMemo(
    () => ({
      onSent: (cardId: number, attempt: PickAttempt) => {
        if (sentPicks.current.stepKey !== attempt.stepKey) {
          sentPicks.current = { stepKey: attempt.stepKey, ids: new Set() };
        }
        sentPicks.current.ids.add(cardId);
        const f = flightRef.current;
        flightRef.current = null;
        const card = f?.card ?? useDraftStore.getState().myPool.find((c) => c.id === cardId);
        if (!card) return;
        rs.picked(cardId);
        setSelectedId(null);
        setHoverId(null);
        setPeek(null);
        setLastPick(card);
        setPickNote(null);
        closeCardSheet();
        if (!f || !f.from || !f.to || !canTravel()) {
          landCard(card);
          return;
        }
        setPending((cur) => new Set(cur).add(cardId));
        let landedOnce = false;
        const land = () => {
          if (landedOnce) return;
          landedOnce = true;
          landCard(card);
        };
        flight({
          layer: layerRef.current,
          from: f.from,
          to: f.to,
          src: cardImageUrl(card.passcode ?? card.id, "small"),
          glow: tint(card).main,
          arc: window.matchMedia?.(PHONE).matches ? 24 : 48,
          duration: 300,
        }).then(land);
        // a hidden tab can stall animations: land anyway
        wait(1500).then(land);
      },
      onRejected: () => {
        rs.unpicked();
        setLastPick(null);
        setPickNote(null);
        setPending(new Set());
      },
      onReconciled: reconcilePick,
    }),
    // rs.picked / rs.unpicked are stable callbacks
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rs.picked, rs.unpicked, closeCardSheet, landCard, reconcilePick],
  );
  const { pick, pending: pickPending } = usePick(slug, hooks);

  const doPick = useCallback(
    (cardId: number): Promise<boolean> => {
      const root = rootRef.current;
      const card = deal.dealt.find((c) => c.id === cardId);
      // a card the player holds the maximum copies of cannot be picked
      if (!root || !card || card.blocked) return Promise.resolve(false);
      const el = root.querySelector<HTMLElement>(`.tcard[data-id="${cardId}"] .face`);
      const win = root.querySelector<HTMLElement>(`.slot[data-kind="${kindOf(card)}"] .win`);
      flightRef.current = {
        card,
        from: el ? el.getBoundingClientRect() : null,
        to: win ? win.getBoundingClientRect() : null,
      };
      return pick(cardId).then((sent) => {
        if (!sent) flightRef.current = null;
        return sent;
      });
    },
    [deal.dealt, pick],
  );

  useEffect(() => {
    if (rs.completed) setPending(new Set());
  }, [rs.completed]);

  /* ---------- time's nearly up: a selected card is the pick (hover alone never counts) ---------- */
  const forcedPack = useDraftStore((s) => s.currentPack.some((card) => card.forced));
  const lastCall = useDraftStore((s) => s.timerSeconds <= AUTO_PICK_AT);
  const passed = useDraftStore((s) => s.passed);
  const autoPicked = useRef(-1);
  useEffect(() => {
    if (!lastCall || pickPending || turn !== "picking" || rs.completed || selectedId == null) return;
    if (autoPicked.current === deal.seq || !deal.dealt.some((c) => c.id === selectedId)) return;
    const seq = deal.seq;
    void doPick(selectedId).then((sent) => {
      if (sent) autoPicked.current = seq;
    });
  }, [lastCall, pickPending, turn, rs.completed, selectedId, deal.seq, deal.dealt, doPick]);

  /* ---------- selecting ---------- */
  const select = useCallback(
    (id: number | null, focus: boolean) => {
      if (turn !== "picking" || holdDeal) return;
      setSelectedId(id);
      if (id == null) return;
      if (focus) {
        const el = rootRef.current?.querySelector<HTMLElement>(`.tcard[data-id="${id}"]`);
        if (el && document.activeElement !== el) el.focus({ preventScroll: true });
      }
      if (phone) openSheet("card");
    },
    [turn, holdDeal, phone, openSheet],
  );
  const onCardClick = useCallback(
    (card: RoomCard) => {
      if (turn !== "picking") return;
      if (phone) return select(card.id, false);
      if (selectedId === card.id) return doPick(card.id);
      select(card.id, false);
    },
    [turn, phone, selectedId, select, doPick],
  );
  const onCardFocus = useCallback(
    (card: RoomCard) => {
      if (!clicking.current) select(card.id, false);
    },
    [select],
  );
  const onCardPointerDown = useCallback(() => {
    clicking.current = true;
    setTimeout(() => (clicking.current = false), 0);
    setKbd(false);
  }, []);
  const onCardHover = useCallback(
    (card: RoomCard | null) => setHoverId(turn === "picking" && card ? card.id : null),
    [turn],
  );

  /* ---------- the filter: one lens for the binder and the table ---------- */
  const filtering = isFiltering(filter);
  const lens = useMemo(
    () => (filtering && turn !== "done" ? (card: RoomCard) => matchesFilter(card, filter) : null),
    [filtering, filter, turn],
  );
  const clearFilter = useCallback(() => setFilter(EMPTY_FILTER), []);
  const lensHits = lens ? rs.cards.filter(lens).length : 0;

  /* ---------- the ribbon ---------- */
  const ribbonRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ribbon) {
      setRibbonOn(false);
      return;
    }
    setRibbonOn(true);
    const r = ribbonRef.current;
    let alive = true;
    const hide = () => {
      if (!alive) return;
      setRibbonOn(false);
      setRibbonDone(ribbon.seq);
    };
    // the ribbon is information, so reduced motion shows it still rather than flashing it for 140ms
    if (motionOff() || prefersReducedMotion() || !r) {
      wait(1300).then(hide);
    } else {
      Promise.all([
        animate(
          r,
          [
            { opacity: 0, transform: "scaleX(0.1)" },
            { opacity: 1, transform: "scaleX(1)", offset: 0.18 },
            { opacity: 1, transform: "scaleX(1)", offset: 0.82 },
            { opacity: 0, transform: "scaleX(1)" },
          ],
          { duration: 1500, easing: "cubic-bezier(0.2,0.8,0.25,1)" },
        ),
        animate(r.querySelector("b"), [{ letterSpacing: "0.14em", opacity: 0 }, { letterSpacing: "0.02em", opacity: 1 }], {
          duration: 420,
          delay: 80,
          fill: "backwards",
        }),
      ]).then(hide);
      wait(2200).then(hide);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ribbon?.seq]);

  /* ---------- friends passing their packs ---------- */
  const packRect = useCallback(
    (seat: number): DOMRect | null => {
      const root = rootRef.current;
      if (!root) return null;
      const sel = phone ? `.chip-seat[data-seat="${seat}"] .mp` : `.seat[data-seat="${seat}"] .pk i`;
      return root.querySelector(sel)?.getBoundingClientRect() ?? null;
    },
    [phone],
  );
  const lastSettle = useRef(0);
  useEffect(() => {
    if (rs.settle === 0 || rs.settle === lastSettle.current) return;
    lastSettle.current = rs.settle;
    if (theme || motionOff() || rs.cards.length === 0 || poolCount >= passEnd) return;
    const n = seatCount;
    const back = phase === "extra" ? "/duel/card-back-extra-hd.webp" : "/duel/card-back-main-hd.webp";
    for (let i = 1; i < n; i++) {
      const to = (i + direction + n) % n;
      const from = packRect(i);
      if (!from) continue;
      let dest: { left: number; top: number; width: number; height: number } | null;
      if (to === 0) {
        const z = rootRef.current?.querySelector(".dr-table")?.getBoundingClientRect();
        dest = z ? { left: z.left + z.width / 2 - from.width, top: z.top + z.height * 0.45, width: from.width * 2, height: from.height * 2 } : null;
      } else dest = packRect(to);
      if (!dest) continue;
      void flight({
        layer: layerRef.current,
        from,
        to: dest,
        src: back,
        glow: "228 182 79",
        arc: phone ? 16 : 36,
        duration: 300,
        swell: 0.12,
        keepRatio: true,
        rotate: direction * 12,
        className: "pack-ghost",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rs.settle]);

  /* ---------- a reload while waiting: bring your last pick back into the reader ---------- */
  useEffect(() => {
    if (lastPick) return;
    const card = restoredPick({ turn, seats: rs.seats, pool: rs.pool, passed });
    if (card) setLastPick(card);
  }, [lastPick, turn, rs.seats, rs.pool, passed]);

  /* ---------- derived views ---------- */
  const waitingOn = useMemo(
    () => rs.seats.filter((s) => !s.isCurrentPlayer && !s.hasPicked).map((s) => s.displayName),
    [rs.seats],
  );
  const friends: FriendView[] = useMemo(
    () =>
      rs.tableSeats
        .filter((t) => !t.isMe && t.seat)
        .map((t) => {
          const seat = t.seat!;
          const state: SeatState = passing ? "passing" : seat.hasPicked ? "picked" : "picking";
          return {
            index: t.index,
            seat,
            state,
            packN: seatPackSize({
              packSize: theme ? sizes.themePackSize : boosterPackSize,
              pickStep: rs.pickStep,
              hasPicked: seat.hasPicked,
            }),
          };
        }),
    [rs.tableSeats, passing, theme, sizes.themePackSize, boosterPackSize, rs.pickStep],
  );

  const dial = dialModel(pool, sizes);
  const last = useMemo(() => {
    const out: Partial<Record<Kind, RoomCard>> = {};
    for (const c of [...pool].reverse()) {
      const k = kindOf(c);
      if (!out[k]) out[k] = c;
    }
    return out;
  }, [pool]);

  let status: React.ReactNode = null;
  if (isParticipant) {
    if (turn === "settling") {
      const willPass = !theme && rs.cards.length > 0 && poolCount < passEnd;
      status = willPass
        ? `Everyone's in. Passing ${direction > 0 ? "left" : "right"}.`
        : theme
          ? "Everyone's in. Next round."
          : "Pack finished.";
    } else if (turn === "waiting" && waitingOn.length) {
      status = passed ? (
        <>
          Nothing here you can take. You pass this pick. Waiting on <em>{joinNames(waitingOn)}</em>
        </>
      ) : (
        <>
          Picked. Waiting on <em>{joinNames(waitingOn)}</em>
        </>
      );
    }
  }

  // the card in the dock: the one under the pointer, else the chosen one, else your last pick
  const dealtCard = (id: number | null) => (id == null ? null : (rs.cards.find((c) => c.id === id) ?? null));
  const hovered = turn === "picking" ? dealtCard(hoverId) : null;
  const chosen = turn === "picking" ? dealtCard(selectedId) : null;
  const reading = hovered ?? chosen;
  const peeking = peek && !hoverId ? peek : null;
  const showLast = !!lastPick && turn !== "picking";
  const readerCard = peeking?.card ?? reading ?? (showLast ? lastPick : null);
  const readerTag = peeking
    ? peeking.tag
    : reading
      ? reading.id === selectedId
        ? TAG_CHOSEN
        : TAG_POINTING
      : showLast
        ? TAG_PICKED
        : "";
  // The Pick button follows the chosen card, never the one the pointer is over.
  const pickable = !!chosen && !chosen.blocked;
  const blockedNote = chosen?.blocked ? blockedLabel(chosen) : null;

  /* ---------- keys: 1-9 choose, arrows move, Enter picks, / searches, Esc closes ---------- */
  const latest = useRef({ rs, holdDeal, turn, selectedId, geometry, phone, drawer, binderOpen, motionOpen: motionOpen || sayOpen || cancelling, sheet, drawerOpen, doPick, select, openSheet, closeSheets });
  latest.current = { rs, holdDeal, turn, selectedId, geometry, phone, drawer, binderOpen, motionOpen: motionOpen || sayOpen || cancelling, sheet, drawerOpen, doPick, select, openSheet, closeSheets };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = latest.current;
      if (inField(e.target)) {
        if (e.key === "Escape" && !L.motionOpen && L.binderOpen && (L.phone || L.drawer)) L.closeSheets();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const num = parseNumberKey(e.key);
      if (num != null || e.key.startsWith("Arrow")) {
        if (L.motionOpen || L.sheet != null || L.drawerOpen) return;
        if (e.key.startsWith("Arrow") && e.target instanceof Element && !e.target.closest(".tcard") &&
          e.target.closest('button, a[href], [role="button"], [role="tab"], [contenteditable="true"]')) return;
        setKbd(true);
      }
      if (e.key === "/") {
        e.preventDefault();
        if (L.phone || L.drawer) L.openSheet("binder");
        requestAnimationFrame(() => binderRef.current?.focusSearch());
        return;
      }
      const order = L.holdDeal ? [] : L.rs.cards.map((c) => c.id);
      if (num != null) {
        e.preventDefault();
        if (order[num - 1] != null) L.select(order[num - 1], true);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        if (!order.length) return;
        let i = Math.max(0, order.indexOf(L.selectedId ?? -1));
        const cols = order.length <= 4 ? order.length : L.geometry.cols;
        if (L.selectedId == null) i = 0;
        else if (e.key === "ArrowLeft") i = Math.max(0, i - 1);
        else if (e.key === "ArrowRight") i = Math.min(order.length - 1, i + 1);
        else if (e.key === "ArrowUp") i = Math.max(0, i - cols);
        else if (e.key === "ArrowDown") i = Math.min(order.length - 1, i + cols);
        L.select(order[i], true);
      } else if (e.key === "Enter") {
        // focused controls handle their own Enter; table cards use the room shortcut
        if (e.target instanceof Element && e.target.closest(
          'a[href], button, [role="button"]:not(.tcard), [role="tab"], [role="menuitem"], summary, [contenteditable]:not([contenteditable="false"])',
        )) return;
        if (L.selectedId != null && L.turn === "picking") {
          e.preventDefault();
          L.doPick(L.selectedId);
        }
      } else if (e.key === "Escape") {
        if (L.motionOpen) return;
        if (L.binderOpen && (L.phone || L.drawer)) return L.closeSheets();
        L.closeSheets();
        setSelectedId(null);
      }
    };
    const onDown = () => setKbd(false);
    document.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);

  /* ---------- binder, tray and dial ---------- */
  const onDial = () => {
    if (phone || drawer) {
      if (binderOpen) closeSheets();
      else openSheet("binder");
    } else binderRef.current?.focusSearch();
  };
  const onKind = (k: Kind) => {
    const next = toggled(filter.kinds, k);
    setFilter({ ...filter, kinds: next });
    if ((phone || drawer) && next.has(k) && !binderOpen) openSheet("binder");
  };

  const subline = theme
    ? `${rs.seats.length} at the table, private packs of ${sizes.themePackSize}`
    : `${rs.seats.length} at the table, ${sizes.packSize}-card packs`;
  const phaseDone = theme ? tp.drafted : 0;
  const attrs = {
    "data-turn": turn,
    "data-dir": String(direction),
    "data-phase": phase,
    "data-mode": theme ? "theme" : "booster",
    "data-urgency": urgency || undefined,
    "data-motion": motion,
    "data-kbd": kbd ? "" : undefined,
    "data-sheet": phone && sheet ? sheet : undefined,
    "data-binder": !phone && drawer && drawerOpen ? "" : undefined,
  };
  const pickConfig = useMemo(
    () => ({ theme, packSize: sizes.packSize, cardsPerPlayer: sizes.cardsPerPlayer }),
    [theme, sizes.packSize, sizes.cardsPerPlayer],
  );

  return (
    <FullscreenLayer ref={rootRef} label="Draft room" attrs={attrs}>
      {/* The confirm dialog is a sibling of .room, so the whole room is locked while it is open: no Tab, click or key reaches it. */}
      <div className="room" inert={cancelling}>
        <RoomBar
          ref={motionBtn}
          name={name}
          sub={subline}
          motion={motion}
          motionOpen={motionOpen}
          onMotion={() => {
            setSayAnchor(null);
            setMotionOpen((v) => !v);
          }}
          canCancel={!!onCancel}
          onCancel={(anchor) => {
            setSayAnchor(null);
            setMotionOpen(false);
            cancelBtn.current = anchor;
            setCancelOpen(true);
          }}
          canSay={canSay}
          sayOpen={sayOpen}
          onSay={toggleSay}
          progress={Math.min(1, poolCount / Math.max(1, sizes.total))}
          where={{
            theme,
            extra: phase === "extra",
            packRound: rs.packRound,
            packsPerPlayer: sizes.packsPerPlayer,
            pickStep: rs.pickStep,
            packSize: sizes.packSize,
            direction,
            phaseDone,
            phaseOf: tp.of,
            boosterExtraSize: sizes.boosterExtraSize,
          }}
        />
        <SeatStrip friends={friends} heard={heard} canSay={canSay} sayOpen={sayOpen} onSay={toggleSay} />
        <div className="body">
          <div
            className="scrim"
            onClick={() => {
              const card = sheet === "card";
              closeSheets();
              if (card) setSelectedId(null);
            }}
          />
          <section
            className="stage"
            aria-label="Draft table"
            ref={setStage}
            tabIndex={-1}
            style={{ "--lift": `${geometry.lift}px` } as React.CSSProperties}
          >
            <Table
              geometry={geometry}
              deal={deal}
              theme={theme}
              phase={phase}
              turn={turn}
              direction={direction}
              seatCount={seatCount}
              hold={holdDeal}
              ribboned={ribbon != null}
              settle={rs.settle}
              stepKey={rs.stepKey}
              pickSeconds={rs.pickSeconds}
              stackLabel={<small>{phase === "extra" ? "Extra deck pool" : "Main deck pool"}</small>}
              selectedId={selectedId}
              lens={lens}
              getLayer={() => layerRef.current}
              packRect={packRect}
              onCardClick={onCardClick}
              onCardFocus={onCardFocus}
              onCardPointerDown={onCardPointerDown}
              onCardHover={onCardHover}
            />
            <Seats friends={friends} positions={positions} theme={theme} heard={heard} stageWidth={size.w} />
            <div className="notes">
              <div className="status" role="status" data-on={status ? "" : undefined}>
                {status}
              </div>
              <p className="status forced" aria-live="polite" data-on={forcedPack && turn === "picking" ? "" : undefined}>
                {forcedPack && turn === "picking" ? forcedPackNote(PLAYER_COPY_CAP) : null}
              </p>
            </div>
            <div className="lens" hidden={!lens}>
              <span>
                {rs.cards.length ? (
                  <>
                    <b>
                      {lensHits} of {rs.cards.length}
                    </b>{" "}
                    in this pack: {filterWords(filter)}
                  </>
                ) : (
                  <>Filter: {filterWords(filter)}</>
                )}
              </span>
              <button type="button" onClick={clearFilter}>
                Clear
              </button>
            </div>
            <div
              className="ribbon"
              ref={ribbonRef}
              data-tone={ribbon?.tone || undefined}
              style={{ visibility: ribbonOn ? "visible" : "hidden" }}
            >
              <b>{ribbon?.title}</b>
              <span>{ribbon?.sub}</span>
            </div>
            <Tray
              said={myPlayerId != null ? heard[myPlayerId] : null}
              done={dial.done}
              of={dial.of}
              label={dial.label}
              phaseCounts={dial.counts}
              poolCounts={dial.counts}
              last={last}
              active={filter.kinds}
              landed={landed}
              onDial={onDial}
              onKind={onKind}
            />
          </section>
          <div className="dock" ref={readerPanelRef} inert={phone && sheet !== "card"} tabIndex={-1}>
            <CardReader
              card={readerCard}
              tag={readerTag}
              pickNote={showLast && !peeking ? pickNote : null}
              buttonHidden={turn === "done"}
              pickable={pickable}
              chosen={chosen}
              blockedNote={blockedNote}
              myTurn={turn === "picking"}
              waitingOn={waitingOn}
              showWaiting={!reading && !peeking && showLast}
              phone={phone}
              onPick={() => chosen && doPick(chosen.id)}
              onClose={() => {
                closeSheets();
                setSelectedId(null);
              }}
            />
          </div>
          <div className="binder-panel" ref={binderPanelRef} inert={!binderOpen} tabIndex={-1}>
            <Binder
              ref={binderRef}
              draftName={name}
              theme={theme}
              pool={pool}
              packCards={rs.cards}
              filter={filter}
              onFilter={setFilter}
              pickConfig={pickConfig}
              target={sizes.total}
              newId={newId}
              phone={phone}
              onClose={closeSheets}
              onPeek={setPeek}
            />
          </div>
        </div>
      </div>
      <SayMenu open={sayAnchor != null && canSay} anchor={sayAnchor} waiting={sayWait} onSay={say} onClose={() => setSayAnchor(null)} />
      <MotionMenu
        open={motionOpen}
        anchor={motionBtn.current}
        level={motion}
        onChoose={setMotion}
        onClose={() => setMotionOpen(false)}
      />
      {onCancel ? (
        <CancelConfirm
          open={cancelOpen}
          onConfirm={onCancel}
          onClose={() => {
            setCancelOpen(false);
            requestAnimationFrame(() => cancelBtn.current?.focus());
          }}
        />
      ) : null}
      <div className="kit-fx" ref={layerRef} aria-hidden="true" />
    </FullscreenLayer>
  );
}
