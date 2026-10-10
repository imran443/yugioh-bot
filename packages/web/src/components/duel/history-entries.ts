// Pure display mapping for the duel history list. No React, no DOM.
//
// history-model.ts folds engine events into tiles and separators. This module turns those into what the
// list draws: grouped by turn (newest first), each entry with an icon kind, thumbnails, signed LP numbers,
// the acting side and a full sentence for screen readers.
//
// Wording: Yu-Gi-Oh! terms, no abbreviations. "LP" always comes with its number and the player's name,
// and a player is "You", their display name, or "Opponent" (never "Opp"). Action labels are short and
// complete ("Attack", "Direct attack", "Normal Summon"); long text lives in the sentence and the title.
//
// Privacy: the server only sends card identity the viewer may see. On top of that, an opponent's Set card,
// face-down position change and drawn card never get a face here, and a spectator never sees a Set card.
import { formatLp } from "./constants";
import {
  isHiddenHistoryCard,
  type HistoryCard,
  type HistoryItem,
  type HistoryLoss,
  type HistorySource,
  type HistoryTile,
  type LeaveCause,
  type MoveDest,
} from "./history-model";

export type HistorySide = "you" | "opp";

export type HistoryIconKind =
  | "normal" | "tribute" | "special" | "flip" | "fusion" | "synchro" | "xyz" | "link" | "ritual" | "pendulum"
  | "set" | "activate" | "chain" | "attack" | "direct" | "destroy"
  | "banish" | "grave" | "draw" | "hand" | "deck"
  | "lp-loss" | "lp-gain" | "position" | "flip-up";

export interface HistoryThumb {
  role: "main" | "attacker" | "target" | "portrait";
  /** The card to inspect. Null for a card back or a portrait. */
  card: HistoryCard | null;
  /** The art to load. Null shows a card back (or the portrait). */
  code: number | null;
  name: string | null;
  struck: boolean;
  side: HistorySide;
  /** The seat the tile belongs to (its controller). Tables of 3 or more seats colour the tile edge with it. */
  seat?: number | null;
  /** Portrait only: the player the plate stands for ("You", a name or "Opponent"). */
  label?: string;
}

export interface HistoryLpChange {
  side: HistorySide;
  seat: number;
  /** Negative for LP lost or paid, positive for LP gained. */
  delta: number;
  cause: "battle" | "effect" | "cost" | "heal";
  /** "−3,000" or "+1,000" */
  text: string;
  unit: "LP";
  /** "−3,000 LP" */
  label: string;
  /** Whose LP it is: "You", a display name or "Opponent". */
  who: string;
  /** "8,000 → 5,000". Null when the LP before and after are not known. */
  total: string | null;
}

export interface HistoryTag {
  label: string;
  tone: "chain" | "loss" | "quiet";
  /** Sentence case instead of the small-caps pill look. For reasons that name a card. */
  plain?: true;
}

export interface HistoryEntry {
  type: "entry";
  key: number;
  lastEventId: number;
  icon: HistoryIconKind;
  side: HistorySide;
  /** The acting seat. Tables of 3 or more seats colour the row with it. */
  seat?: number | null;
  actor: string;
  verb: string;
  /** The short line: card name, "Attacker → Target", or the player for LP rows. */
  title: string;
  /** One full sentence for screen readers. */
  sentence: string;
  thumbs: HistoryThumb[];
  lp: HistoryLpChange[];
  tags: HistoryTag[];
  negated: boolean;
  turn: number;
}

export interface HistoryPhaseRow {
  type: "phase";
  key: number;
  label: string;
  battle: boolean;
}

export type HistoryRow = HistoryEntry | HistoryPhaseRow;

export interface HistoryGroup {
  key: string;
  turn: number | null;
  seat: number | null;
  /** "Turn 3 · You" */
  label: string;
  /** Newest row first. */
  rows: HistoryRow[];
}

export interface HistoryView {
  /** Newest turn first. */
  groups: HistoryGroup[];
  /** Key of the newest entry (not phase row). Null when there is none. */
  latestKey: number | null;
  entryCount: number;
}

export interface HistoryViewOptions {
  mySeat: number | null;
  /** Display name for a seat ("You" for the viewer). */
  who: (seat: number | null) => string;
  seatCount?: number;
}

const PLACEHOLDER_NAME = /^Player \d+$/;

/**
 * How a player is named in the history: "You" for the viewer, their display name, or "Opponent" when a
 * two-player seat still has the placeholder name. With three or more seats the placeholder stays, because
 * "Opponent" would not say which one.
 */
export function historyWho(
  seat: number | null,
  mySeat: number | null,
  playerName: (seat: number) => string,
  seatCount: number,
): string {
  if (seat == null) return "Unknown";
  if (mySeat != null && seat === mySeat) return "You";
  const name = playerName(seat);
  if (mySeat != null && seatCount <= 2 && PLACEHOLDER_NAME.test(name)) return "Opponent";
  return name;
}

export function sideOf(seat: number | null, mySeat: number | null): HistorySide {
  if (seat == null) return "opp";
  if (mySeat == null) return seat === 0 ? "you" : "opp";
  return seat === mySeat ? "you" : "opp";
}

const SUMMON_VERB = {
  normal: "Normal Summon",
  tribute: "Tribute Summon",
  special: "Special Summon",
  flip: "Flip Summon",
  fusion: "Fusion Summon",
  synchro: "Synchro Summon",
  xyz: "Xyz Summon",
  link: "Link Summon",
  ritual: "Ritual Summon",
  pendulum: "Pendulum Summon",
} as const;

const SUMMON_PAST = {
  normal: "Normal Summoned",
  tribute: "Tribute Summoned",
  special: "Special Summoned",
  flip: "Flip Summoned",
  fusion: "Fusion Summoned",
  synchro: "Synchro Summoned",
  xyz: "Xyz Summoned",
  link: "Link Summoned",
  ritual: "Ritual Summoned",
  pendulum: "Pendulum Summoned",
} as const;

const CAUSE_LABEL = { battle: "battle damage", effect: "effect damage", cost: "LP paid" } as const;

const POS_FACEDOWN_ATTACK = 0x2;
const POS_FACEUP_DEFENSE = 0x4;
const POS_FACEDOWN_DEFENSE = 0x8;

function isFaceDownPosition(position: number | undefined): boolean {
  return position != null && (position & (POS_FACEDOWN_ATTACK | POS_FACEDOWN_DEFENSE)) !== 0;
}

function positionName(position: number | undefined): string {
  if (position == null) return "another position";
  if (position & POS_FACEDOWN_DEFENSE) return "face-down Defense Position";
  if (position & POS_FACEUP_DEFENSE) return "Defense Position";
  if (position & POS_FACEDOWN_ATTACK) return "face-down Attack Position";
  return "Attack Position";
}

function nameOf(card: HistoryCard | null | undefined): string | null {
  return card && !isHiddenHistoryCard(card) ? (card.name ?? null) : null;
}

/** May this card's face show for this tile? Identity must be present first; then the extra rules apply. */
function mayReveal(tile: HistoryTile, card: HistoryCard | null | undefined, mySeat: number | null): boolean {
  if (!card || isHiddenHistoryCard(card)) return false;
  const mine = mySeat != null && tile.seat === mySeat;
  switch (tile.kind) {
    case "set":
      return mine;
    case "position":
      return mine || !isFaceDownPosition(tile.position?.to);
    case "move":
      if (mine) return true;
      // The server only sends public cards; an opponent's draw and face-down moves stay backs on top of that.
      return !tile.move?.faceDown && tile.move?.reason !== "draw";
    default:
      return true;
  }
}

function thumbFor(tile: HistoryTile, card: HistoryCard | null | undefined, role: HistoryThumb["role"], side: HistorySide, mySeat: number | null, struck = false): HistoryThumb {
  const show = mayReveal(tile, card, mySeat);
  return {
    role,
    card: show ? (card ?? null) : null,
    code: show && card ? (card.code ?? null) : null,
    name: show ? nameOf(card) : null,
    struck,
    side,
  };
}

function destVerb(dest: MoveDest, reason: string, count: number, cause: string | undefined): string {
  if (reason === "add") return "Add to hand";
  if (reason === "draw") return count > 1 ? `Draw ${count}` : "Draw";
  if (cause === "tribute") return "Tributed";
  if (cause === "material") return "Used as material";
  switch (dest) {
    case "grave":
      return reason === "discard" ? "Discard" : "Sent to Graveyard";
    case "banished":
      return "Banished";
    case "hand":
      return "Returned to hand";
    case "deck":
      return "Returned to Deck";
    case "extra":
      return "Returned to Extra Deck";
    default:
      return "Moved";
  }
}

/** "by battle", "by Raigeki's effect", "by card effect", "as a cost", "by game rule", or null when unknown. */
function reasonPhrase(cause: LeaveCause | undefined, source: HistorySource | undefined): string | null {
  switch (cause) {
    case "battle":
      return "by battle";
    case "effect":
      return source?.name ? `by ${source.name}'s effect` : "by card effect";
    case "cost":
      return "as a cost";
    case "rule":
      return "by game rule";
    default:
      return null;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function iconFor(tile: HistoryTile): HistoryIconKind {
  switch (tile.kind) {
    case "summon":
      return tile.summonKind ?? "normal";
    case "confirm":
      return "hand";
    case "set":
      return "set";
    case "activate":
      return tile.chain && tile.chain.size > 1 ? "chain" : "activate";
    case "attack":
      return tile.target?.direct ? "direct" : "attack";
    case "damage":
      return "lp-loss";
    case "destroy":
      return "destroy";
    case "move":
      switch (tile.move?.dest) {
        case "grave":
          return "grave";
        case "banished":
          return "banish";
        case "hand":
          return tile.move.reason === "draw" ? "draw" : "hand";
        case "deck":
        case "extra":
          return "deck";
        default:
          return "hand";
      }
    case "position":
      return tile.position?.flip ? "flip-up" : "position";
    case "heal":
      return "lp-gain";
  }
}

function verbFor(tile: HistoryTile): string {
  switch (tile.kind) {
    case "summon":
      return SUMMON_VERB[tile.summonKind ?? "normal"];
    case "confirm":
      return "Confirmed";
    case "set":
      return "Set";
    case "activate":
      return "Activate";
    case "attack":
      return tile.target?.direct ? "Direct attack" : "Attack";
    case "damage":
      return { battle: "Battle damage", effect: "Effect damage", cost: "LP paid" }[tile.hits[0]?.cause ?? "effect"];
    case "destroy":
      return "Destroyed";
    case "move":
      return destVerb(tile.move?.dest ?? "field", tile.move?.reason ?? "other", tile.move?.count ?? 1, tile.move?.cause);
    case "position":
      return tile.position?.flip ? "Flips face-up" : `To ${positionName(tile.position?.to)}`;
    case "heal":
      return "LP gained";
  }
}

function titleFor(tile: HistoryTile, who: HistoryViewOptions["who"], mySeat: number | null): string {
  const name = mayReveal(tile, tile.card, mySeat) ? nameOf(tile.card) : null;
  switch (tile.kind) {
    case "attack": {
      const attacker = name ?? "Monster";
      if (tile.target?.direct) return `${attacker} → ${who(tile.target.seat)}`;
      return `${attacker} → ${nameOf(tile.target?.card) ?? "Monster"}`;
    }
    case "set":
      return name ?? "Face-down card";
    case "summon":
      return name ?? "Face-down monster";
    case "damage":
    case "heal":
      return "Life Points";
    case "move":
      if (tile.move?.reason === "draw") return name ?? (tile.move.count > 1 ? `${tile.move.count} cards` : "1 card");
      return name ?? "Card";
    default:
      return name ?? "Card";
  }
}

function destroyedSentence(name: string | null, loss: HistoryLoss | undefined): string {
  const phrase = reasonPhrase(loss?.cause, loss?.source);
  return `${name ?? "A card"} was destroyed${phrase ? ` ${phrase}` : ""}.`;
}

function sentenceFor(tile: HistoryTile, who: HistoryViewOptions["who"], mySeat: number | null, seatCount: number): string {
  const actor = who(tile.seat);
  const name = mayReveal(tile, tile.card, mySeat) ? nameOf(tile.card) : null;
  const parts: string[] = [];
  switch (tile.kind) {
    case "summon":
      parts.push(`${actor} ${SUMMON_PAST[tile.summonKind ?? "normal"]} ${name ?? "a face-down monster"}.`);
      break;
    case "confirm":
      parts.push(`${actor} confirmed ${name ?? "a card"}.`);
      break;
    case "set":
      parts.push(name ? `${actor} Set ${name}.` : `${actor} Set a card.`);
      break;
    case "activate":
      parts.push(`${actor} activated ${name ?? "a card"}.`);
      if (tile.chain && tile.chain.size > 1) parts.push(`Chain link ${tile.chain.index} of ${tile.chain.size}.`);
      if (tile.chain?.targets) parts.push(`Targeting ${tile.chain.targets}.`);
      if (tile.chain?.status === "negated") parts.push("Negated.");
      else if (tile.chain?.status === "resolved") parts.push("Resolved.");
      else if (tile.chain?.status === "resolving") parts.push("Resolving.");
      break;
    case "attack": {
      const attacker = name ?? "a monster";
      if (tile.target?.direct) {
        const defender = seatCount > 2 && tile.target.seat != null ? `${who(tile.target.seat)} ` : "";
        parts.push(`${actor} attacked ${defender}directly with ${attacker}.`);
      } else parts.push(`${actor} attacked ${nameOf(tile.target?.card) ?? "a monster"} with ${attacker}.`);
      break;
    }
    case "destroy":
      parts.push(destroyedSentence(name, tile.destroyed[0]));
      break;
    case "move": {
      const move = tile.move;
      const what = name ?? "a card";
      if (move?.reason === "add") {
        parts.push(`${actor} added ${what} to the hand.`);
      } else if (move?.reason === "draw") {
        parts.push(move.count > 1 ? `${actor} drew ${move.count} cards.` : name ? `${actor} drew ${name}.` : `${actor} drew a card.`);
      } else if (move?.cause === "tribute") {
        parts.push(`${actor} Tributed ${what}.`);
      } else if (move?.cause === "material") {
        parts.push(`${actor} used ${what} as material.`);
      } else {
        const where = { grave: " to the Graveyard", hand: " to the hand", deck: " to the Deck", extra: " to the Extra Deck", banished: "", field: "" }[move?.dest ?? "field"];
        const by = move?.cause === "effect" ? ` ${reasonPhrase("effect", move.source)}` : "";
        parts.push(move?.dest === "banished" ? `${actor} banished ${what}${by}.` : `${actor} sent ${what}${where}${by}.`);
      }
      break;
    }
    case "position":
      parts.push(tile.position?.flip
        ? `${name ?? "A card"} was flipped face-up.`
        : `${actor} changed ${name ?? "a monster"} to ${positionName(tile.position?.to)}.`);
      break;
    case "heal":
    case "damage":
      break;
  }
  for (const hit of tile.hits) parts.push(`${who(hit.seat)} took ${formatLp(hit.amount)} ${CAUSE_LABEL[hit.cause]}.`);
  if (tile.gain) parts.push(`${who(tile.gain.seat)} gained ${formatLp(tile.gain.amount)} LP.`);
  if (tile.kind !== "destroy") {
    for (const loss of tile.destroyed) parts.push(destroyedSentence(nameOf(loss.card), loss));
  }
  return parts.join(" ");
}

function lpTotal(before: number | undefined, after: number | undefined): string | null {
  return before != null && after != null ? `${formatLp(before)} → ${formatLp(after)}` : null;
}

function lpFor(tile: HistoryTile, mySeat: number | null, who: HistoryViewOptions["who"]): HistoryLpChange[] {
  const out: HistoryLpChange[] = tile.hits.map((hit) => {
    const text = `−${formatLp(hit.amount)}`;
    return {
      side: sideOf(hit.seat, mySeat),
      seat: hit.seat,
      delta: -hit.amount,
      cause: hit.cause,
      text,
      unit: "LP",
      label: `${text} LP`,
      who: who(hit.seat),
      total: lpTotal(hit.before, hit.after),
    };
  });
  if (tile.gain) {
    const text = `+${formatLp(tile.gain.amount)}`;
    out.push({
      side: sideOf(tile.gain.seat, mySeat),
      seat: tile.gain.seat,
      delta: tile.gain.amount,
      cause: "heal",
      text,
      unit: "LP",
      label: `${text} LP`,
      who: who(tile.gain.seat),
      total: lpTotal(tile.gain.before, tile.gain.after),
    });
  }
  return out;
}

function tagsFor(tile: HistoryTile): HistoryTag[] {
  const tags: HistoryTag[] = [];
  if (tile.chain && tile.chain.size > 1) tags.push({ label: `Chain ${tile.chain.index}`, tone: "chain" });
  if (tile.chain && tile.chain.status !== "pending") {
    const label = { resolving: "Resolving", resolved: "Resolved", negated: "Negated" }[tile.chain.status];
    tags.push({ label, tone: tile.chain.status === "negated" ? "loss" : "quiet" });
  }
  // The link's target, worded for this viewer; plain so a long card name wraps instead of being cut.
  if (tile.chain?.targets) tags.push({ label: `Targets ${tile.chain.targets}`, tone: "chain", plain: true });
  if (tile.kind === "destroy") {
    // The row is the destroyed card, so its verb already says "Destroyed": the tag only gives the reason.
    const loss = tile.destroyed[0];
    const phrase = reasonPhrase(loss?.cause, loss?.source);
    if (phrase) tags.push({ label: capitalize(phrase), tone: "loss", plain: true });
  } else {
    // One tag per reason, with a count when several cards went the same way.
    const groups = new Map<string, number>();
    for (const loss of tile.destroyed) {
      const phrase = reasonPhrase(loss.cause, loss.source) ?? "";
      groups.set(phrase, (groups.get(phrase) ?? 0) + 1);
    }
    for (const [phrase, count] of groups) {
      const label = count > 1 ? `${count} destroyed` : "Destroyed";
      tags.push({ label: phrase ? `${label} ${phrase}` : label, tone: "loss" });
    }
  }
  if (tile.move?.cause === "effect") tags.push({ label: capitalize(reasonPhrase("effect", tile.move.source) ?? ""), tone: "quiet", plain: true });
  if (tile.move && tile.move.count > 1) tags.push({ label: `×${tile.move.count}`, tone: "quiet" });
  return tags;
}

function plate(side: HistorySide, label: string): HistoryThumb {
  return { role: "portrait", card: null, code: null, name: null, struck: false, side, label };
}

function thumbsFor(tile: HistoryTile, side: HistorySide, mySeat: number | null, who: HistoryViewOptions["who"]): HistoryThumb[] {
  switch (tile.kind) {
    case "attack": {
      const target = tile.target;
      const attackerStruck = tile.destroyed.some((loss) => loss.role === "attacker");
      const targetStruck = tile.destroyed.some((loss) => loss.role === "target");
      const targetSide = sideOf(target?.seat ?? null, mySeat);
      return [
        thumbFor(tile, tile.card, "attacker", side, mySeat, attackerStruck),
        target?.direct || !target?.card
          ? target?.direct
            ? plate(targetSide, who(target?.seat ?? null))
            : thumbFor(tile, null, "target", targetSide, mySeat, targetStruck)
          : thumbFor(tile, target.card, "target", targetSide, mySeat, targetStruck),
      ];
    }
    case "damage":
      return [plate(sideOf(tile.hits[0]?.seat ?? tile.seat, mySeat), who(tile.hits[0]?.seat ?? tile.seat))];
    case "heal":
      return [plate(sideOf(tile.gain?.seat ?? tile.seat, mySeat), who(tile.gain?.seat ?? tile.seat))];
    case "destroy":
      return [thumbFor(tile, tile.card, "main", side, mySeat, true)];
    default:
      return [thumbFor(tile, tile.card, "main", side, mySeat)];
  }
}

/** Each thumb carries the seat it belongs to: the attacker's, the target's, or the acting seat. */
function withThumbSeats(thumbs: HistoryThumb[], tile: HistoryTile, actorSeat: number | null): HistoryThumb[] {
  return thumbs.map((thumb) => {
    const seat = tile.kind === "attack" ? (thumb.role === "attacker" ? tile.seat : (tile.target?.seat ?? null)) : actorSeat;
    return { ...thumb, seat };
  });
}

/** One tile as a list entry. */
export function entryFor(tile: HistoryTile, options: HistoryViewOptions): HistoryEntry {
  const { mySeat, who } = options;
  const actorSeat = tile.kind === "damage" ? (tile.hits[0]?.seat ?? tile.seat) : tile.kind === "heal" ? (tile.gain?.seat ?? tile.seat) : tile.seat;
  const side = sideOf(actorSeat, mySeat);
  return {
    type: "entry",
    key: tile.key,
    lastEventId: tile.lastEventId,
    icon: iconFor(tile),
    side,
    seat: actorSeat,
    actor: who(actorSeat),
    verb: verbFor(tile),
    title: titleFor(tile, who, mySeat),
    sentence: sentenceFor(tile, who, mySeat, options.seatCount ?? 2),
    thumbs: withThumbSeats(thumbsFor(tile, side, mySeat, who), tile, actorSeat),
    lp: lpFor(tile, mySeat, who),
    tags: tagsFor(tile),
    negated: tile.chain?.status === "negated",
    turn: tile.turn,
  };
}

/**
 * Group model items by turn. Groups and rows come back newest first, so the list needs no reversing and
 * the newest entry sits at the top. Turn seats the model could not read (the window began mid-turn) are
 * worked out from any turn that has one, by parity.
 */
export function buildHistoryView(items: readonly HistoryItem[], options: HistoryViewOptions): HistoryView {
  const seatCount = Math.max(2, options.seatCount ?? 2);
  // seat undefined: the model did not work it out (hand-built items), so parity may fill it in.
  // seat null: the model could not tell (a seat is out), so the label stays without a player.
  type Draft = { turn: number | null; seat: number | null | undefined; rows: HistoryRow[] };
  const drafts: Draft[] = [];
  const cursor: { current: Draft | null } = { current: null };
  let latestKey: number | null = null;
  let entryCount = 0;

  const open = (turn: number | null, seat: number | null | undefined) => {
    const draft: Draft = { turn, seat, rows: [] };
    cursor.current = draft;
    drafts.push(draft);
    return draft;
  };

  for (const item of items) {
    if (item.type === "sep") {
      if (item.turn != null) {
        open(item.turn, item.turnSeat);
      } else {
        const group = cursor.current ?? open(null, null);
        group.rows.push({ type: "phase", key: item.key, label: item.label, battle: /battle/i.test(item.label) });
      }
      continue;
    }
    const group = cursor.current && cursor.current.turn === item.turn ? cursor.current : open(item.turn, item.turnSeat);
    group.rows.push(entryFor(item, options));
    entryCount += 1;
    if (latestKey == null || item.key > latestKey) latestKey = item.key;
  }

  // Parity is only used for turns the model left unread, and only while every read turn follows it.
  const known = drafts.find((draft) => draft.turn != null && draft.seat != null);
  const parityHolds = drafts.every(
    (draft) =>
      draft.turn == null ||
      draft.seat == null ||
      !known ||
      known.turn == null ||
      known.seat == null ||
      draft.seat === (((known.seat + (draft.turn - known.turn)) % seatCount) + seatCount) % seatCount,
  );
  const groups: HistoryGroup[] = [];
  for (const draft of drafts) {
    if (draft.rows.length === 0) continue;
    let seat = draft.seat ?? null;
    if (draft.seat === undefined && parityHolds && draft.turn != null && known && known.turn != null && known.seat != null) {
      seat = (((known.seat + (draft.turn - known.turn)) % seatCount) + seatCount) % seatCount;
    }
    const label = draft.turn == null ? "Earlier" : seat == null ? `Turn ${draft.turn}` : `Turn ${draft.turn} · ${options.who(seat)}`;
    groups.push({
      key: `g${draft.turn ?? "x"}-${draft.rows[0].key}`,
      turn: draft.turn,
      seat,
      label,
      rows: draft.rows.slice().reverse(),
    });
  }
  groups.reverse();
  return { groups, latestKey, entryCount };
}
