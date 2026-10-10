// Pure event grouping for the duel history rail. No React, no DOM.
//
// The engine sends a rolling window of DuelEvent (ids only grow). This module folds fresh events into an
// accumulated list of tiles and separators, so older tiles persist while the window rolls.
//
// Grouping rules:
//   attack   opens a battle tile. Later battle damage and destroy events (zone matches, or zone unknown)
//            merge into that tile until the next attack or phase event.
//   activate opens a chain-link tile. chain-resolving / resolved / negated update the SAME tile by chain index.
//            Effect damage and destroy events that arrive while a link resolves merge into that link's tile.
//   summon / set   one tile each.
//   move     draw, discard, banish, send to the Graveyard and return events get a tile (destroy, summon, set and
//            activate moves already have their own tile). Back-to-back draws by one seat fold into one tile.
//   position battle position changes and flip reveals get a tile.
//   heal     the engine sends no LP gain event, so a rise in LP that damage events do not explain becomes a tile.
//   damage / destroy that belong to no open attack or chain become their own tile.
//   phase    a thin separator (not a tile). "Main Phase 1" also marks the turn start.
//
// Why a card left: destroy events carry the engine's reason flags (battle / effect / cost / rule) and the
// card that caused it (`sourceCode`). The source name is only ever taken from a card the log already shows,
// never from the passcode alone. The engine reports no reason for other moves, so those are read from
// context: a move while a chain link resolves is that link's effect, and moves right before a Tribute,
// Fusion, Synchro, Link or Ritual Summon are its Tributes or materials.
import type { DuelCard, DuelCardInfo, DuelEvent, DuelMoveReason, DuelSummonKind, DuelZoneRef } from "@yugidraft/shared/duels";
import {
  LOCATION_DECK,
  LOCATION_EXTRA,
  LOCATION_GRAVE,
  LOCATION_HAND,
  LOCATION_MZONE,
  LOCATION_REMOVED,
  LOCATION_SZONE,
  phaseLabel,
  zoneKey,
} from "./constants";

export type HistoryCard = DuelCard | DuelCardInfo;
export type SummonKind = DuelSummonKind;
export type DamageCause = "battle" | "effect" | "cost";
export type ChainStatus = "pending" | "resolving" | "resolved" | "negated";

export interface HistoryHit {
  seat: number;
  amount: number;
  cause: DamageCause;
  /** LP of `seat` just before and after this hit. Absent when the batch gave no way to know. */
  before?: number;
  after?: number;
}

/** Why a card left the field or moved. */
export type LeaveCause = "battle" | "effect" | "cost" | "rule" | "other";

/** The card behind a destruction or move. `name` is null when the log never showed that card. */
export interface HistorySource {
  code: number;
  name: string | null;
  seat: number | null;
  kind?: "monster" | "spell" | "trap";
}

export type MoveDest = "hand" | "deck" | "extra" | "grave" | "banished" | "field";

/** An LP rise the engine did not report as an event (a recovery effect). */
export interface HistoryGain {
  seat: number;
  amount: number;
  /** LP of `seat` just before and after the rise. */
  before?: number;
  after?: number;
}

export interface HistoryLoss {
  seat: number | null;
  card: HistoryCard | null;
  role: "attacker" | "target" | "card";
  /** The engine's reason. Absent on events recorded before the field existed. */
  cause?: LeaveCause;
  source?: HistorySource;
}

export interface HistoryTile {
  type: "tile";
  /** Id of the first event in the group. Stable React key. */
  key: number;
  lastEventId: number;
  kind: "summon" | "set" | "activate" | "attack" | "damage" | "destroy" | "move" | "position" | "heal" | "confirm";
  seat: number | null;
  /** The subject: summoned / set / activated card, the attacker, or the destroyed card. */
  card: HistoryCard | null;
  summonKind?: SummonKind;
  text: string;
  description?: string;
  turn: number;
  /** Seat whose turn it was. null: not known and not safe to guess (a seat is out). Absent: not worked out. */
  turnSeat?: number | null;
  /** Phase label when this happened; empty when unknown. */
  phase: string;
  /** `targets`: who the link targets, as the engine words it for this viewer ("Black Luster Soldier ...", "a face-down card"). */
  chain?: { index: number; size: number; status: ChainStatus; targets?: string; targetEventId?: number };
  /** attack only */
  target?: { seat: number | null; card: HistoryCard | null; direct: boolean };
  hits: HistoryHit[];
  destroyed: HistoryLoss[];
  attackerZone?: string;
  targetZone?: string;
  /** move only. `count` is above 1 when back-to-back draws were folded in. */
  move?: {
    dest: MoveDest;
    reason: DuelMoveReason;
    count: number;
    faceDown: boolean;
    /** "effect" (a chain link was resolving), "tribute" or "material" (sent for a summon). Absent when unknown. */
    cause?: "effect" | "tribute" | "material";
    source?: HistorySource;
  };
  /** position only: POS_* bitmasks before and after. */
  position?: { from?: number; to?: number; flip: boolean };
  /** heal only */
  gain?: HistoryGain;
}

export interface HistorySeparator {
  type: "sep";
  key: number;
  label: string;
  /** Set when this separator starts a turn. */
  turn?: number;
  /** Seat whose turn it is. null: not known and not safe to guess (a seat is out). */
  turnSeat?: number | null;
}

export type HistoryItem = HistoryTile | HistorySeparator;

export interface HistoryState {
  items: HistoryItem[];
  lastId: number;
  revision: number;
  /** Tiles whose first event id is above this slide in; older ones (first render, reload) do not. */
  animateAfter: number;
  phase: string | null;
  /** LP per seat at the last ingest, to spot recovery. */
  lp: number[] | null;
  /** How many heal tiles exist, so each gets a fresh fractional key. */
  healCount: number;
  memory: Record<string, HistoryCard>;
  battleKey: number | null;
  chain: { keys: Record<number, number>; current: number | null; size: number } | null;
}

export interface HistoryContext {
  revision: number;
  turn: number;
  turnSeat: number;
  phase: string;
  seatCount: number;
  /**
   * The engine log (`DuelEngineView.log`). Its "Turn N — Player X" lines name the seat of each turn. Without
   * them the seat is only worked out from the turn seat now, and only while no seat is out.
   */
  log?: readonly { id: number; text: string }[];
  /** True when a seat is eliminated or leaving. Turns skip such a seat, so counting turns would guess wrong. */
  anySeatOut?: boolean;
  /** LP per seat right now. Omit when unknown: no recovery tiles are made then. */
  lp?: readonly number[];
  /** Cards on the field right now (monsters and spells). Used to look up attackers and targets. */
  cards: readonly DuelCard[];
}

const MAX_ITEMS = 400;

export function emptyHistory(): HistoryState {
  return {
    items: [],
    lastId: -1,
    revision: -1,
    animateAfter: -1,
    phase: null,
    lp: null,
    healCount: 0,
    memory: {},
    battleKey: null,
    chain: null,
  };
}

export function isHiddenHistoryCard(card: HistoryCard | null | undefined): boolean {
  if (!card) return true;
  return card.code == null;
}

function fieldKey(zone: DuelZoneRef): string {
  return zoneKey(zone.controller, zone.location, zone.sequence);
}

function snapshotMemory(cards: readonly DuelCard[]): Record<string, HistoryCard> {
  const memory: Record<string, HistoryCard> = {};
  for (const card of cards) {
    if (card.location !== LOCATION_MZONE && card.location !== LOCATION_SZONE) continue;
    memory[zoneKey(card.controller, card.location, card.sequence)] = card;
  }
  return memory;
}

function summonKindFor(event: DuelEvent): SummonKind {
  if (event.summonKind) return event.summonKind;
  const text = event.text.toLowerCase();
  if (text.includes("tribute")) return "tribute";
  if (text.includes("special")) return "special";
  if (text.includes("flip")) return "flip";
  return "normal";
}

/** True when the engine event ids belong to a different duel than the accumulated state. */
export function shouldResetHistory(state: HistoryState, events: readonly DuelEvent[], revision: number): boolean {
  if (state.lastId < 0) return false;
  if (revision < state.revision) return true;
  let max = -1;
  for (const event of events) if (typeof event.id === "number" && event.id > max) max = event.id;
  return events.length > 0 && max < state.lastId;
}

const MOVE_SHOWN: ReadonlySet<DuelMoveReason> = new Set(["draw", "add", "discard", "banish", "send", "return"]);

/** Summons whose cost or materials are sent away just before the monster arrives. */
const MATERIAL_SUMMONS: ReadonlySet<SummonKind> = new Set(["tribute", "fusion", "synchro", "link", "ritual"]);
const MATERIAL_MOVES: ReadonlySet<DuelMoveReason> = new Set(["send", "discard", "banish"]);

function moveDest(location: number | undefined): MoveDest {
  switch (location) {
    case LOCATION_HAND:
      return "hand";
    case LOCATION_DECK:
      return "deck";
    case LOCATION_EXTRA:
      return "extra";
    case LOCATION_GRAVE:
      return "grave";
    case LOCATION_REMOVED:
      return "banished";
    default:
      return "field";
  }
}

/** Seats whose LP rose by more than the damage events in this batch explain. */
export function detectGains(
  before: readonly number[] | null,
  after: readonly number[] | undefined,
  damage: ReadonlyMap<number, number> = new Map(),
): HistoryGain[] {
  if (!before || !after) return [];
  const gains: HistoryGain[] = [];
  after.forEach((lp, seat) => {
    const prev = before[seat];
    if (prev == null) return;
    const rise = lp - (prev - (damage.get(seat) ?? 0));
    if (rise > 0) gains.push({ seat, amount: rise, before: lp - rise, after: lp });
  });
  return gains;
}

function targetLabelsPhrase(labels: readonly string[]): string | undefined {
  if (labels.length === 0) return undefined;
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function ingestHistory(state: HistoryState, events: readonly DuelEvent[], ctx: HistoryContext): HistoryState {
  // Naming notes can arrive after a prompt, refining an event whose id was already ingested. Only the latest
  // announcement on each tile may refresh its labels, including when the chain has since ended.
  const settledTargets = new Map(events.filter((event) => event.kind === "target" && event.targetLabels && event.id <= state.lastId)
    .map((event) => [event.id, event.targetLabels!]));
  let refreshed = false;
  const refreshedItems = state.items.map((item) => {
    if (item.type !== "tile" || item.chain?.targetEventId == null) return item;
    const labels = settledTargets.get(item.chain.targetEventId);
    if (!labels) return item;
    const targets = targetLabelsPhrase(labels);
    if (targets === item.chain.targets) return item;
    refreshed = true;
    return { ...item, chain: { ...item.chain, targets } };
  });
  if (refreshed) state = { ...state, items: refreshedItems };
  const fresh = events
    .filter((event) => typeof event.id === "number" && event.id > state.lastId)
    .sort((a, b) => a.id - b.id);
  const seen = new Set<number>();
  const batch = fresh.filter((event) => (seen.has(event.id) ? false : (seen.add(event.id), true)));
  if (batch.length === 0) {
    if (state.revision === ctx.revision) return state;
    const gains = detectGains(state.lp, ctx.lp);
    const lp = ctx.lp ? [...ctx.lp] : state.lp;
    if (gains.length === 0) return { ...state, revision: ctx.revision, lp, memory: snapshotMemory(ctx.cards) };
    const grown = state.items.slice();
    let healCount = state.healCount;
    for (const gain of gains) {
      grown.push(healTile(state.lastId + 1 - 1 / (healCount + 2), gain, ctx, state.phase ?? ""));
      healCount += 1;
    }
    return {
      ...state,
      items: grown.length > MAX_ITEMS ? grown.slice(grown.length - MAX_ITEMS) : grown,
      revision: ctx.revision,
      lp,
      healCount,
      memory: snapshotMemory(ctx.cards),
    };
  }

  const isFirst = state.lastId < 0;
  const items = state.items.slice();
  const memory = { ...state.memory };
  let battleKey = state.battleKey;
  let chain = state.chain ? { ...state.chain, keys: { ...state.chain.keys } } : null;

  const indexOf = (key: number) => items.findIndex((item) => item.type === "tile" && item.key === key);
  const patch = (key: number, fn: (tile: HistoryTile) => HistoryTile) => {
    const index = indexOf(key);
    if (index < 0) return;
    const item = items[index];
    if (item.type === "tile") items[index] = fn({ ...item });
  };
  const tileAt = (key: number | null | undefined): HistoryTile | null => {
    if (key == null) return null;
    const item = items[indexOf(key)];
    return item && item.type === "tile" ? item : null;
  };

  // Turn numbers: every Main Phase 1 event after this one starts a later turn.
  const mp1After: number[] = new Array(batch.length).fill(0);
  let seenMp1 = 0;
  for (let i = batch.length - 1; i >= 0; i -= 1) {
    mp1After[i] = seenMp1;
    if (batch[i].kind === "phase" && isMainPhaseOne(batch[i].text)) seenMp1 += 1;
  }
  const seatCount = Math.max(2, ctx.seatCount);

  // Seat of a turn. The server's "Turn N — Player X" line (engine.ts, NEW_TURN) is the truth. The current turn
  // has the engine's own turn seat. Older turns are counted back by modular arithmetic only while no seat is
  // out; a skipped seat breaks the count, so then the seat stays off the label.
  const loggedSeats = loggedTurnSeats(ctx.log, seatCount);
  const seatForTurn = (turn: number): number | null => {
    const logged = loggedSeats.get(turn);
    if (logged != null) return logged;
    if (turn === ctx.turn) return ctx.turnSeat;
    if (ctx.anySeatOut) return null;
    return (((ctx.turnSeat - (ctx.turn - turn)) % seatCount) + seatCount) % seatCount;
  };

  // LP before and after each hit, worked back from the LP now. Skipped for a seat that also gained LP in
  // this batch, because then the sums cannot be trusted.
  const damage = new Map<number, number>();
  for (const event of batch) {
    if (event.kind === "damage" && event.seat != null && event.amount && event.amount > 0) {
      damage.set(event.seat, (damage.get(event.seat) ?? 0) + event.amount);
    }
  }
  const lpTrail = new Map<number, { before: number; after: number }>();
  if (ctx.lp) {
    const gainSeats = new Set((isFirst ? [] : detectGains(state.lp, ctx.lp, damage)).map((gain) => gain.seat));
    const running = new Map<number, number>();
    for (let i = batch.length - 1; i >= 0; i -= 1) {
      const event = batch[i];
      if (event.kind !== "damage" || event.seat == null || !event.amount || event.amount <= 0 || gainSeats.has(event.seat)) continue;
      const after = running.get(event.seat) ?? ctx.lp[event.seat];
      if (after == null) continue;
      lpTrail.set(event.id, { before: after + event.amount, after });
      running.set(event.seat, after + event.amount);
    }
  }

  let phase = state.phase;
  if (phase == null) {
    const hasPhaseEvent = batch.some((event) => event.kind === "phase");
    phase = hasPhaseEvent ? "" : phaseLabelText(ctx.phase);
  }

  const lookupZone = (zone: DuelZoneRef | undefined): HistoryCard | null => {
    if (!zone) return null;
    const key = fieldKey(zone);
    return memory[key] ?? snapshotMemory(ctx.cards)[key] ?? null;
  };
  const otherSeat = (seat: number | null | undefined) => (seat == null ? null : (seat + 1) % seatCount);

  /** A card's name, but only from a card the log or the board already shows. */
  const nameOfCode = (code: number): string | null => {
    const named = (card: HistoryCard | null | undefined) => (card && card.code === code && card.name ? card.name : null);
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.type !== "tile") continue;
      const found = named(item.card) ?? named(item.target?.card);
      if (found) return found;
    }
    for (const card of Object.values(memory)) {
      const found = named(card);
      if (found) return found;
    }
    for (const card of ctx.cards) {
      const found = named(card);
      if (found) return found;
    }
    return null;
  };
  const sourceOf = (event: DuelEvent): HistorySource | undefined => {
    if (!event.sourceCode) return undefined;
    const source: HistorySource = { code: event.sourceCode, name: nameOfCode(event.sourceCode), seat: event.sourceSeat ?? null };
    if (event.sourceKind) source.kind = event.sourceKind;
    return source;
  };
  /** The chain link that is resolving right now, as a source. */
  const resolvingSource = (): HistorySource | undefined => {
    const tile = chain?.current != null ? tileAt(chain.keys[chain.current]) : null;
    if (!tile || isHiddenHistoryCard(tile.card)) return undefined;
    return { code: tile.card!.code as number, name: tile.card!.name ?? null, seat: tile.seat };
  };
  /** Cards sent just before a Tribute or material Summon were its Tributes or materials. */
  const tagMaterials = (summon: HistoryTile) => {
    const cause = summon.summonKind === "tribute" ? "tribute" : "material";
    // The summoned monster's own move sits between them and the summon event, so the first gap may be 2.
    let previous = summon.key;
    let allowed = 2;
    for (let i = items.length - 2; i >= 0; i -= 1) {
      const item = items[i];
      if (item.type !== "tile" || item.kind !== "move" || !item.move || !MATERIAL_MOVES.has(item.move.reason)) break;
      if (item.seat !== summon.seat || previous - item.key > allowed) break;
      items[i] = { ...item, move: { ...item.move, cause, source: undefined } };
      previous = item.key;
      allowed = 1;
    }
  };

  const make = (event: DuelEvent, index: number, kind: HistoryTile["kind"], card: HistoryCard | null): HistoryTile => ({
    type: "tile",
    key: event.id,
    lastEventId: event.id,
    kind,
    seat: event.seat ?? null,
    card,
    text: event.text,
    description: event.description,
    turn: Math.max(1, ctx.turn - mp1After[index]),
    turnSeat: seatForTurn(Math.max(1, ctx.turn - mp1After[index])),
    phase: phase ?? "",
    hits: [],
    destroyed: [],
  });

  const addHit = (key: number, hit: HistoryHit, eventId: number) =>
    patch(key, (tile) => ({ ...tile, lastEventId: eventId, hits: [...tile.hits, hit] }));

  batch.forEach((event, index) => {
    switch (event.kind) {
      case "toss":
        // Keep outcomes out of the rail until the toss layer can release them after landing.
        break;
      case "target": {
        // Only announcements carry labels. Movement updates the board markers without rewriting history.
        const labels = event.targetLabels;
        const named = labels ? targetLabelsPhrase(labels) : undefined;
        const key = chain?.keys[event.chainIndex ?? 1];
        if (labels && key != null) patch(key, (t) => (t.chain ? { ...t, chain: { ...t.chain, targets: named, targetEventId: event.id } } : t));
        break;
      }
      case "summon":
      case "set": {
        const card = event.card ?? null;
        if (event.zone && card) memory[fieldKey(event.zone)] = card;
        const tile = make(event, index, event.kind, card);
        if (event.kind === "summon") tile.summonKind = summonKindFor(event);
        items.push(tile);
        if (tile.summonKind && MATERIAL_SUMMONS.has(tile.summonKind)) tagMaterials(tile);
        break;
      }
      case "attack": {
        battleKey = event.id;
        const attacker = event.card ?? lookupZone(event.zone);
        const tile = make(event, index, "attack", attacker);
        const direct = !event.target && (/direct/i.test(event.text) || Boolean(event.zone));
        tile.target = event.target
          ? { seat: event.target.controller, card: lookupZone(event.target), direct: false }
          : { seat: event.targetSeat ?? otherSeat(event.seat), card: null, direct };
        if (event.zone) tile.attackerZone = fieldKey(event.zone);
        if (event.target) tile.targetZone = fieldKey(event.target);
        items.push(tile);
        break;
      }
      case "activate": {
        const idx = event.chainIndex ?? 1;
        if (!chain || idx <= 1) chain = { keys: {}, current: null, size: 0 };
        const tile = make(event, index, "activate", event.card ?? null);
        chain.keys[idx] = event.id;
        chain.size = Math.max(chain.size, idx);
        tile.chain = { index: idx, size: chain.size, status: "pending" };
        items.push(tile);
        const size = chain.size;
        for (const key of Object.values(chain.keys)) {
          patch(key, (t) => (t.chain ? { ...t, chain: { ...t.chain, size } } : t));
        }
        break;
      }
      case "chain-resolving":
      case "chain-resolved":
      case "chain-negated": {
        const idx = event.chainIndex ?? 1;
        if (!chain) chain = { keys: {}, current: null, size: idx };
        let key = chain.keys[idx];
        if (key == null || !tileAt(key)) {
          // The window started mid-chain: make a tile for the link so its effects have a home.
          const tile = make(event, index, "activate", event.card ?? null);
          tile.chain = { index: idx, size: Math.max(chain.size, idx), status: "pending" };
          items.push(tile);
          chain.keys[idx] = key = event.id;
          chain.size = Math.max(chain.size, idx);
        }
        const status: ChainStatus =
          event.kind === "chain-resolving" ? "resolving" : event.kind === "chain-resolved" ? "resolved" : "negated";
        // The engine reports a negation before the link's own resolving and resolved events. The link stays negated.
        patch(key, (tile) => ({
          ...tile,
          lastEventId: event.id,
          card: tile.card ?? event.card ?? null,
          chain: tile.chain
            ? { ...tile.chain, status: tile.chain.status === "negated" ? "negated" : status }
            : { index: idx, size: idx, status },
        }));
        chain.current = event.kind === "chain-resolving" ? idx : null;
        break;
      }
      case "chain-end":
        chain = null;
        break;
      case "phase": {
        battleKey = null;
        phase = event.text;
        // The Draw and Standby Phase play as beats on the board (phase-beats.ts); the log keeps one
        // header per turn, Main Phase 1, as it always had.
        if (/^(draw|standby)\b/i.test(event.text.trim())) break;
        const label = isMainPhaseOne(event.text);
        const last = items[items.length - 1];
        if (!label && last && last.type === "sep" && last.turn == null) items.pop();
        const sep: HistorySeparator = { type: "sep", key: event.id, label: event.text };
        if (label) {
          const turn = Math.max(1, ctx.turn - mp1After[index]);
          sep.turn = turn;
          sep.turnSeat = seatForTurn(turn);
        }
        items.push(sep);
        break;
      }
      case "damage": {
        if (!event.amount || event.amount <= 0 || event.seat == null) break;
        const cause: DamageCause = (event.cause === "rule" || event.cause === "other" ? "effect" : event.cause) ?? (chain?.current != null ? "effect" : battleKey != null ? "battle" : "effect");
        const hit: HistoryHit = { seat: event.seat, amount: event.amount, cause, ...lpTrail.get(event.id) };
        const battle = tileAt(battleKey);
        if (cause === "battle" && battle) {
          addHit(battle.key, hit, event.id);
        } else if (cause !== "battle" && chain?.current != null && tileAt(chain.keys[chain.current])) {
          addHit(chain.keys[chain.current], hit, event.id);
        } else {
          const tile = make(event, index, "damage", null);
          tile.hits = [hit];
          items.push(tile);
        }
        break;
      }
      case "destroy": {
        const card = event.card ?? lookupZone(event.zone);
        const key = event.zone ? fieldKey(event.zone) : null;
        const battle = tileAt(battleKey);
        const chainOpen = chain?.current != null && tileAt(chain.keys[chain.current]) != null;
        const battleCause = event.cause === "battle" || (event.cause == null && !chainOpen);
        const inBattle =
          battle != null &&
          battleCause &&
          (key == null || key === battle.attackerZone || key === battle.targetZone || (!battle.attackerZone && !battle.targetZone));
        if (inBattle && battle) {
          let role: HistoryLoss["role"] = "card";
          if (key != null && key === battle.attackerZone) role = "attacker";
          else if (key != null && key === battle.targetZone) role = "target";
          else if (card?.code != null && card.code === battle.card?.code) role = "attacker";
          else if (card?.code != null && card.code === battle.target?.card?.code) role = "target";
          const loss: HistoryLoss = { seat: event.zone?.controller ?? event.seat ?? null, card, role, cause: event.cause ?? "battle" };
          const source = sourceOf(event);
          if (source) loss.source = source;
          patch(battle.key, (tile) => ({ ...tile, lastEventId: event.id, destroyed: [...tile.destroyed, loss] }));
        } else if (chainOpen && chain?.current != null && event.cause !== "battle") {
          const loss: HistoryLoss = { seat: event.zone?.controller ?? event.seat ?? null, card, role: "card", cause: event.cause ?? "effect" };
          const source = sourceOf(event) ?? resolvingSource();
          if (source) loss.source = source;
          patch(chain.keys[chain.current], (tile) => ({ ...tile, lastEventId: event.id, destroyed: [...tile.destroyed, loss] }));
        } else {
          const tile = make(event, index, "destroy", card);
          tile.seat = event.zone?.controller ?? event.seat ?? null;
          const loss: HistoryLoss = { seat: tile.seat, card, role: "card" };
          if (event.cause) loss.cause = event.cause;
          const source = sourceOf(event);
          if (source) loss.source = source;
          tile.destroyed = [loss];
          items.push(tile);
        }
        break;
      }
      case "confirm": {
        // A confirmation is historical knowledge, never live field-slot memory.
        if (!event.card) break;
        const added = tileAt(event.moveId);
        if (added?.kind === "move" && added.move?.dest === "hand" && added.move.reason !== "draw") {
          patch(added.key, (tile) => ({ ...tile, card: event.card!, lastEventId: event.id }));
        } else {
          items.push(make(event, index, "confirm", event.card));
        }
        break;
      }
      case "move": {
        // Older events marked effect additions but still called deck-to-hand moves draws.
        const reason = event.addedToHand && event.reason === "draw" ? "add" : event.reason;
        if (!reason || !MOVE_SHOWN.has(reason)) break;
        const dest = moveDest(event.zone?.location);
        const seat = event.seat ?? event.zone?.controller ?? null;
        const last = items[items.length - 1];
        if (reason === "draw" && last && last.type === "tile" && last.kind === "move" &&
            last.move?.reason === "draw" && last.seat === seat) {
          patch(last.key, (tile) => ({
            ...tile,
            lastEventId: event.id,
            move: tile.move ? { ...tile.move, count: tile.move.count + 1 } : tile.move,
          }));
          break;
        }
        const tile = make(event, index, "move", event.card ?? null);
        tile.seat = seat;
        tile.move = { dest, reason, count: 1, faceDown: event.faceDown === true };
        if (reason !== "draw") {
          const source = resolvingSource();
          if (source) {
            tile.move.cause = "effect";
            tile.move.source = source;
          }
        }
        items.push(tile);
        break;
      }
      case "position": {
        const tile = make(event, index, "position", event.card ?? lookupZone(event.zone));
        tile.position = { from: event.fromPosition, to: event.toPosition, flip: event.flip === true };
        items.push(tile);
        break;
      }
      default:
        break;
    }
  });

  const lastId = batch[batch.length - 1].id;
  let healCount = state.healCount;
  for (const gain of detectGains(state.lp, ctx.lp, damage)) {
    items.push(healTile(lastId + 1 - 1 / (healCount + 2), gain, ctx, phase ?? ""));
    healCount += 1;
  }
  return {
    items: items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items,
    lastId,
    revision: ctx.revision,
    animateAfter: isFirst ? lastId : state.animateAfter,
    phase,
    lp: ctx.lp ? [...ctx.lp] : state.lp,
    healCount,
    memory: snapshotMemory(ctx.cards),
    battleKey,
    chain,
  };
}

function healTile(key: number, gain: HistoryGain, ctx: HistoryContext, phase: string): HistoryTile {
  return {
    type: "tile",
    key,
    lastEventId: key,
    kind: "heal",
    seat: gain.seat,
    card: null,
    text: "",
    turn: Math.max(1, ctx.turn),
    turnSeat: ctx.turnSeat,
    phase,
    hits: [],
    destroyed: [],
    gain,
  };
}

const TURN_LINE = /^Turn (\d+) [—–-] Player (\d+)$/;

/** Turn number to seat, read from the server's "Turn N — Player X" log lines (engine.ts, NEW_TURN). */
function loggedTurnSeats(log: HistoryContext["log"], seatCount: number): Map<number, number> {
  const seats = new Map<number, number>();
  for (const entry of log ?? []) {
    const match = TURN_LINE.exec(entry.text.trim());
    if (!match) continue;
    const seat = Number(match[2]) - 1;
    if (seat >= 0 && seat < seatCount) seats.set(Number(match[1]), seat);
  }
  return seats;
}

function isMainPhaseOne(text: string): boolean {
  return /^main\s*(phase)?\s*1$/i.test(text.trim()) || phaseLabel(text) === "Main 1";
}

function phaseLabelText(phase: string): string {
  const label = phaseLabel(phase);
  return label === "—" ? "" : label;
}

/** Newest first, at most `maxTiles` tiles, with the separators between them. */
export function visibleHistory(items: readonly HistoryItem[], maxTiles = 12): HistoryItem[] {
  let tiles = 0;
  let start = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].type === "tile") {
      tiles += 1;
      if (tiles > maxTiles) {
        start = i + 1;
        break;
      }
    }
  }
  const slice = items.slice(start);
  while (slice.length > 0 && slice[0].type === "sep") slice.shift();
  return slice.reverse();
}
