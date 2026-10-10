import { createHash } from "node:crypto";
import type { DuelCard, DuelDeck, DuelEngineView, DuelMode, DuelPrompt } from "@yugidraft/shared/duels";
import type { Catalog } from "./card-pool.js";

export type Viewer = 0 | 1 | null;
export interface Views {
  v0: DuelEngineView;
  v1: DuelEngineView;
  vs: DuelEngineView;
}

export interface Violation {
  invariant: string;
  message: string;
  detail?: unknown;
}

export const LOC = { DECK: 0x1, HAND: 0x2, MZONE: 0x4, SZONE: 0x8, GRAVE: 0x10, REMOVED: 0x20, EXTRA: 0x40, DECKMASTER: 0x4000 };
const TOKEN = 0x4000;
const FACEDOWN = 0x2 | 0x8;

/**
 * Who may see which hidden zones. Today a seat sees only its own hand and face-down cards.
 * ADR-0002 lets 2v2 partners see each other, so a team game replaces this function.
 */
export function canSeeHidden(viewer: Viewer, owner: number): boolean {
  return viewer === owner;
}

/** Whose turn it is after `turn` turns, given seat count and the first turn player. */
export function expectedTurnSeat(firstTurnSeat: number, turn: number, seatCount: number): number {
  return (firstTurnSeat + turn - 1) % seatCount;
}

export function viewFor(views: Views, viewer: Viewer): DuelEngineView {
  return viewer === 0 ? views.v0 : viewer === 1 ? views.v1 : views.vs;
}

export function sha1(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

/** Hash of everything a viewer can observe (used for replay determinism). */
export function viewsHash(views: Views): string {
  return sha1([views.v0, views.v1, views.vs]);
}

/** Hash of the board without log, events and revision (used to detect loops). */
export function stateHash(views: Views): string {
  const strip = (v: DuelEngineView) => ({
    turn: v.turn,
    turnSeat: v.turnSeat,
    phase: v.phase,
    battleStep: v.battleStep,
    seats: v.seats,
    chain: v.chain,
    result: v.result,
    prompt: v.prompt ? { ...v.prompt, id: undefined } : null,
  });
  return sha1([strip(views.v0), strip(views.v1)]);
}

function allCards(seat: DuelEngineView["seats"][number]): DuelCard[] {
  const out: DuelCard[] = [];
  const push = (card: DuelCard | null | undefined) => {
    if (!card) return;
    out.push(card);
    for (const material of card.materials ?? []) out.push(material);
  };
  seat.hand.forEach(push);
  seat.monsters.forEach(push);
  seat.spells.forEach(push);
  seat.graveyard.forEach(push);
  seat.banished.forEach(push);
  seat.extra.forEach(push);
  return out;
}

// handId is the opaque animation id of a hand card (hand-identities.ts). It carries no card identity.
const HIDDEN_KEYS = new Set(["controller", "location", "sequence", "position", "handId"]);
function isRedacted(card: DuelCard): boolean {
  return Object.keys(card).every((key) => HIDDEN_KEYS.has(key));
}

/** Printed card text names other cards ("Polymerization", "Fusion"), so it is not a leak source. */
/** Card names that are also plain words in engine text ("Return X to the Deck Master Zone?"). Not scanned. */
const COMMON_WORD_NAMES = new Set([
  "Return", "Bat", "Set", "Draw", "Fire", "Dark", "Light", "Earth", "Wind", "Water", "Change", "Flip", "Attack",
  "Defense", "Pass", "Shuffle", "Turn", "Battle", "Main", "End", "Standby", "Summon", "Activate", "Select", "Choose",
  "Destroy", "Banish", "Tribute", "Cancel", "Finish", "Yes", "No", "Honest",
]);
const PRINTED_TEXT_KEYS = new Set(["description", "cardText", "effectText", "race"]);
function walkStrings(value: unknown, visit: (text: string) => void, depth = 0): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit, depth + 1);
  else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (PRINTED_TEXT_KEYS.has(key)) continue;
      // DuelPromptSource.text is printed text too; `card` infos carry only printed text and stats.
      if (key === "text" && typeof item === "string" && "code" in (value as object)) continue;
      // Effect options carry the printed effect text after the first ": " ("Activate X: ...").
      if (key === "label" && typeof item === "string" && /^Activate /.test(item) && item.length > 60) {
        visit(item.slice(0, Math.max(item.indexOf(": "), 0) || item.length));
        continue;
      }
      walkStrings(item, visit, depth + 1);
    }
  }
}

function walkCodes(value: unknown, visit: (code: number, key: string) => void, depth = 0): void {
  if (depth > 8 || value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkCodes(item, visit, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "code" || key === "sourceCode" || key === "cardCode") && typeof item === "number") visit(item, key);
    else walkCodes(item, visit, depth + 1);
  }
}

export interface CheckerOptions {
  /** Exact printed strings of an already known card; references in those strings are public rules. */
  printedText?: (code: number) => string[];
  mode: DuelMode;
  decks: [DuelDeck, DuelDeck];
  disjoint: boolean;
  catalog: Catalog;
}

/** Stateful checker. Call `check` once for the opening board and once after every accepted answer. */
export class InvariantChecker {
  private lastTurn = 0;
  private firstTurnSeat: number | null = null;
  private turnSeatByTurn = new Map<number, number>();
  private readonly known: [Set<number>, Set<number>, Set<number>] = [new Set(), new Set(), new Set()];
  private readonly lastLog = [0, 0, 0];
  private readonly lastEvent = [0, 0, 0];
  private readonly codeOwner = new Map<number, 0 | 1>();
  private readonly initialCount: [number, number];
  private readonly deckCodes: [Set<number>, Set<number>];
  private readonly codeTotals = new Map<number, number>();
  private readonly namesByCode = new Map<number, string>();
  private readonly codesByName = new Map<string, number[]>();
  private namesByLength: string[] = [];
  /** Codes a viewer was legitimately shown by a Confirmed/Excavated log entry (hand looks, searches). */
  private readonly revealed: [Set<number>, Set<number>, Set<number>] = [new Set(), new Set(), new Set()];
  /** Codes the engine announced publicly (summon, activation, chain link). A hand card may be public after its activation. */
  private readonly announced: [Set<number>, Set<number>, Set<number>] = [new Set(), new Set(), new Set()];
  /** Diagnostics: counts of soft observations. */
  readonly stats: Record<string, number> = {};

  constructor(private readonly options: CheckerOptions) {
    const initial: [number, number] = [0, 0];
    const deckCodes: [Set<number>, Set<number>] = [new Set(), new Set()];
    options.decks.forEach((deck, seat) => {
      const codes = [...deck.main, ...deck.extra, ...(deck.deckMaster ? [deck.deckMaster] : [])];
      initial[seat] = codes.length;
      for (const code of codes) {
        deckCodes[seat].add(code);
        this.codeTotals.set(code, (this.codeTotals.get(code) ?? 0) + 1);
        if (options.disjoint) this.codeOwner.set(code, seat as 0 | 1);
        const name = options.catalog.byId.get(code)?.name;
        if (name) {
          this.namesByCode.set(code, name);
          this.codesByName.set(name, [...(this.codesByName.get(name) ?? []), code]);
        }
      }
    });
    this.namesByLength = [...this.codesByName.keys()].filter((name) => name.length >= 3).sort((a, b) => b.length - a.length);
    this.initialCount = initial;
    this.deckCodes = deckCodes;
    this.known[0] = new Set(deckCodes[0]);
    this.known[1] = new Set(deckCodes[1]);
  }

  /** Card names that occur in `text`. Longest names match first, so "Trap Hole" does not match inside "Bottomless Trap Hole". */
  /** Set once a card that reveals both hands was activated; the rest of the duel skips the hand check (lenient). */
  private handRevealSeen = false;
  /** Set once Parasite Paracide (shuffles itself into the opponent's Deck) appeared; per-owner counts are then skipped. */
  private deckSwapSeen = false;

  private namesIn(text: string): Array<[string, number[]]> {
    const out: Array<[string, number[]]> = [];
    let rest = text;
    const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9]/.test(ch);
    for (const name of this.namesByLength) {
      // Whole-word matches only ("Bat" must not match inside "Battle Phase"); longest names go first.
      let from = 0;
      let found = false;
      for (;;) {
        const at = rest.indexOf(name, from);
        if (at < 0) break;
        if (!isWord(rest[at - 1]) && !isWord(rest[at + name.length])) {
          found = true;
          rest = rest.slice(0, at) + "\u0000".repeat(name.length) + rest.slice(at + name.length);
        }
        from = at + 1;
      }
      if (found) out.push([name, this.codesByName.get(name) ?? []]);
    }
    return out;
  }

  private bump(name: string): void {
    this.stats[name] = (this.stats[name] ?? 0) + 1;
  }

  check(step: number, views: Views): Violation[] {
    const out: Violation[] = [];
    const add = (invariant: string, message: string, detail?: unknown) => out.push({ invariant, message, ...(detail === undefined ? {} : { detail }) });
    this.checkRouting(views, add);
    this.checkScalars(views, add);
    this.checkConsistency(views, add);
    const prompt = views.v0.prompt ?? views.v1.prompt;
    const stable = views.v0.result !== null || prompt === null || prompt.context?.type === "action" || prompt.context?.type === "chain";
    // Inside a summon procedure or an effect the core may hold cards in limbo. Only settled boards are checked.
    if (stable) this.checkConservation(views, add);
    else this.bump("conservation-skipped-unsettled");
    if (this.options.mode === "domain") this.checkDomain(views, add);
    this.checkPrivacy(views, add);
    void step;
    return out;
  }

  private checkRouting(views: Views, add: (i: string, m: string, d?: unknown) => void): void {
    const { v0, v1, vs } = views;
    if (vs.prompt) add("prompt-routing", "Spectator view has a prompt");
    const holders = [v0, v1].filter((v) => v.prompt);
    const ended = v0.result !== null;
    if (ended && holders.length > 0) add("prompt-routing", "A prompt exists after the duel ended");
    if (!ended && holders.length !== 1) add("prompt-routing", `${holders.length} seats hold a prompt while the duel runs`);
    [v0, v1].forEach((view, seat) => {
      if (view.prompt && view.prompt.seat !== seat) add("prompt-routing", `Seat ${seat} view holds a prompt addressed to seat ${view.prompt.seat}`);
    });
    if (!ended && holders.length === 1) {
      const a = v0.prompt ?? v1.prompt;
      if (a && a.options.length === 0 && !["announce-card", "number"].includes(a.kind) && !a.cancelable && !a.finishable) {
        add("prompt-empty", `Prompt "${a.title}" (${a.kind}) has no options and no way out`);
      }
    }
    if (JSON.stringify(v0.result) !== JSON.stringify(v1.result) || JSON.stringify(v0.result) !== JSON.stringify(vs.result)) {
      add("view-consistency", "Result differs between views");
    }
  }

  private checkScalars(views: Views, add: (i: string, m: string, d?: unknown) => void): void {
    const { v0 } = views;
    for (const viewer of [0, 1, null] as const) {
      const view = viewFor(views, viewer);
      view.seats.forEach((seat, index) => {
        if (!Number.isInteger(seat.lp) || seat.lp < 0) add("lp", `Seat ${index} LP ${String(seat.lp)} is not a non-negative integer`, { viewer });
        if (!Number.isInteger(seat.deckCount) || seat.deckCount < 0) add("deck-count", `Seat ${index} deck count ${String(seat.deckCount)}`);
      });
    }
    if (v0.turn < this.lastTurn) add("turn-monotonic", `Turn went from ${this.lastTurn} to ${v0.turn}`);
    if (v0.turn >= 1) {
      const known = this.turnSeatByTurn.get(v0.turn);
      if (known !== undefined && known !== v0.turnSeat) add("turn-seat-stable", `Turn ${v0.turn} changed turn seat from ${known} to ${v0.turnSeat}`);
      this.turnSeatByTurn.set(v0.turn, v0.turnSeat);
      if (this.firstTurnSeat === null) this.firstTurnSeat = (((v0.turnSeat - (v0.turn - 1)) % v0.seats.length) + v0.seats.length) % v0.seats.length;
      const expected = expectedTurnSeat(this.firstTurnSeat, v0.turn, v0.seats.length);
      if (expected !== v0.turnSeat) add("turn-seat-alternates", `Turn ${v0.turn} belongs to seat ${v0.turnSeat}, expected seat ${expected}`);
    }
    this.lastTurn = Math.max(this.lastTurn, v0.turn);
    if (v0.seats.length !== 2) add("seat-count", `${v0.seats.length} seats in view`);
  }

  /** Public facts must match across the three views. */
  private checkConsistency(views: Views, add: (i: string, m: string, d?: unknown) => void): void {
    const base = views.vs;
    for (const [label, view] of [["seat 0", views.v0], ["seat 1", views.v1]] as const) {
      if (view.turn !== base.turn || view.phase !== base.phase || view.turnSeat !== base.turnSeat || view.revision !== base.revision) {
        add("view-consistency", `${label} and spectator disagree on turn, phase or revision`);
      }
      if (JSON.stringify(view.chain.map((l) => [l.index, l.seat])) !== JSON.stringify(base.chain.map((l) => [l.index, l.seat]))) {
        add("view-consistency", `${label} and spectator disagree on chain shape`);
      }
      base.seats.forEach((seat, index) => {
        const other = view.seats[index];
        if (!other) return;
        const pairs: Array<[string, unknown, unknown]> = [
          ["lp", seat.lp, other.lp],
          ["hand size", seat.hand.length, other.hand.length],
          ["deckCount", seat.deckCount, other.deckCount],
          ["extraCount", seat.extraCount, other.extraCount],
          ["graveyard size", seat.graveyard.length, other.graveyard.length],
          ["banished size", seat.banished.length, other.banished.length],
          ["monster occupancy", seat.monsters.map((c) => (c ? 1 : 0)).join(""), other.monsters.map((c) => (c ? 1 : 0)).join("")],
          ["spell occupancy", seat.spells.map((c) => (c ? 1 : 0)).join(""), other.spells.map((c) => (c ? 1 : 0)).join("")],
        ];
        for (const [name, a, b] of pairs) if (a !== b) add("view-consistency", `${label} and spectator disagree on seat ${index} ${name}`, { a, b });
      });
    }
    // Audience-limited log entries must not reach the spectator.
    const both = new Set(views.v0.log.map((e) => e.id));
    const other = new Set(views.v1.log.map((e) => e.id));
    for (const entry of views.vs.log) {
      if (!(both.has(entry.id) && other.has(entry.id))) add("privacy-log-audience", `Spectator log entry ${entry.id} "${entry.text}" is not public`);
    }
  }

  private checkConservation(views: Views, add: (i: string, m: string, d?: unknown) => void): void {
    const own = [views.v0, views.v1];
    let total = 0;
    const owned: [number, number] = [0, 0];
    const perCode = new Map<number, number>();
    const domain = this.options.mode === "domain";
    for (const seatIndex of [0, 1]) {
      const view = own[seatIndex] as DuelEngineView;
      const seat = view.seats[seatIndex];
      if (!seat) continue;
      if (seat.extra.length !== seat.extraCount) add("conservation", `Seat ${seatIndex} extra list has ${seat.extra.length} cards but extraCount is ${seat.extraCount}`);
      const cards = allCards(seat);
      let tokens = 0;
      for (const card of cards) {
        if (card.code === undefined) {
          add("conservation", `Seat ${seatIndex} sees its own card without a code`, card);
          continue;
        }
        const info = this.options.catalog.byId.get(card.code);
        const type = card.type ?? info?.type ?? 0;
        if (!this.codeTotals.has(card.code)) {
          if (type & TOKEN) {
            tokens++;
            if (card.location !== LOC.MZONE && card.location !== LOC.SZONE) add("token-off-field", `Token ${card.code} is outside the field`, card);
            continue;
          }
          add("conservation", `Card ${card.code} (${card.name ?? "?"}) is in play but in neither deck`, card);
          continue;
        }
        perCode.set(card.code, (perCode.get(card.code) ?? 0) + 1);
        const owner = this.codeOwner.get(card.code);
        if (owner !== undefined) owned[owner]++;
        total++;
      }
      total += seat.deckCount;
      if (domain && seat.deckMaster?.inZone) {
        const code = seat.deckMaster.card.code;
        if ((this.codeTotals.get(code) ?? 0) === 1 && cards.some((card) => card.code === code)) {
          // The Deck Master is reported as still in its zone while a card with its code is also in play.
          add("domain-deckmaster-duplicate", `Seat ${seatIndex} Deck Master ${seat.deckMaster.card.name} is in its zone and also in play`, { code });
        } else {
          total += 1;
          perCode.set(code, (perCode.get(code) ?? 0) + 1);
          const owner = this.codeOwner.get(code);
          if (owner !== undefined) owned[owner]++;
        }
      }
      void tokens;
      if (this.options.disjoint) owned[seatIndex] += seat.deckCount;
    }
    const expected = this.initialCount[0] + this.initialCount[1];
    if (total !== expected) add("conservation", `Card total ${total} differs from deck total ${expected}`, { owned, initial: this.initialCount });
    if (this.options.disjoint && !this.deckSwapSeen) {
      for (const seatIndex of [0, 1] as const) {
        if (owned[seatIndex] !== this.initialCount[seatIndex]) add("conservation-owner", `Seat ${seatIndex} owns ${owned[seatIndex]} cards, deck had ${this.initialCount[seatIndex]}`, { owned });
      }
    }
    for (const [code, count] of perCode) {
      if (count > (this.codeTotals.get(code) ?? 0)) add("conservation-code", `Card ${code} appears ${count} times outside the deck, decks hold ${this.codeTotals.get(code) ?? 0}`);
    }
  }

  private checkDomain(views: Views, add: (i: string, m: string, d?: unknown) => void): void {
    for (const view of [views.v0, views.v1, views.vs]) {
      view.seats.forEach((seat, index) => {
        const dm = seat.deckMaster;
        if (!dm) return add("domain-deck-master", `Seat ${index} has no Deck Master state in Domain mode`);
        if (!Number.isInteger(dm.returns) || dm.returns < 0) add("domain-deck-master", `Seat ${index} returns ${String(dm.returns)}`);
        if (dm.nextCost !== dm.returns * 500) add("domain-deck-master", `Seat ${index} nextCost ${dm.nextCost} differs from ${dm.returns * 500}`);
      });
    }
  }

  private checkPrivacy(views: Views, add: (i: string, m: string, d?: unknown) => void): void {
    const viewers: Viewer[] = [0, 1, null];
    // Everything visible as a structured card is public knowledge for that viewer from now on.
    viewers.forEach((viewer, vi) => {
      const view = viewFor(views, viewer);
      const known = this.known[vi] as Set<number>;
      for (const seat of view.seats) {
        for (const card of allCards(seat)) if (card.code !== undefined) known.add(card.code);
        if (seat.deckMaster) known.add(seat.deckMaster.card.code);
      }
      const announced = this.announced[vi] as Set<number>;
      for (const link of view.chain) if (link.code !== undefined) { known.add(link.code); announced.add(link.code); }
      // The engine only writes these log lines for public actions (face-down summons use a generic line).
      for (const entry of view.log) {
        if (entry.id <= (this.lastLog[vi] as number)) continue;
        if (/^(Mutually Affured Destruction|Respect Play) is activating$/.test(entry.text)) this.handRevealSeen = true;
        if (/Parasite Paracide/.test(entry.text)) this.deckSwapSeen = true;
        if (/^(Confirmed|Excavated) /.test(entry.text)) {
          for (const [, codes] of this.namesIn(entry.text)) for (const code of codes) (this.revealed[vi] as Set<number>).add(code);
        }
        if (/^Player \d (Normal Summons|Special Summons|Flip Summons) |is activating$| moved$/.test(entry.text)) {
          for (const [, codes] of this.namesIn(entry.text)) for (const code of codes) { known.add(code); announced.add(code); }
        }
      }
      for (const event of view.events) {
        if (event.id <= (this.lastEvent[vi] as number) || !event.card) continue;
        // A card that turns face-up is public, also when it leaves the field before the next check
        // (a face-down monster flipped by an attack, then shuffled into the Deck).
        if (event.kind === "position" && event.toPosition !== undefined && (event.toPosition & FACEDOWN) === 0) {
          known.add(event.card.code);
          this.bump("flipped-face-up");
          continue;
        }
        if (event.kind !== "move" && event.kind !== "set" && event.kind !== "position") {
          known.add(event.card.code);
          announced.add(event.card.code);
        }
      }
    });
    viewers.forEach((viewer, vi) => {
      const view = viewFor(views, viewer);
      const known = this.known[vi] as Set<number>;
      // Structural: hidden zones of other seats must be redacted.
      // A face-up continuous effect such as Respect Play shows both hands; the core then makes hands public.
      const handsShown = this.handRevealSeen || view.seats.some((seat) =>
        [...seat.monsters, ...seat.spells].some(
          (card) => card && (card.position & FACEDOWN) === 0 && /show their opponent their hand|hands?.{0,30}revealed|reveal(s|ed)?.{0,30}hands?/i.test(card.description ?? ""),
        ),
      );
      if (handsShown) {
        this.bump("hands-shown-by-effect");
        for (const seat of view.seats) for (const card of seat.hand) if (card.code !== undefined) known.add(card.code);
      }
      view.seats.forEach((seat, owner) => {
        if (canSeeHidden(viewer, owner)) return;
        const revealed = this.revealed[vi] as Set<number>;
        const check = (card: DuelCard | null, what: string, mustBeHidden: boolean) => {
          if (!card) return;
          const faceDown = (card.position & FACEDOWN) !== 0;
          // Cards such as Shining Draw say "draw it for your normal draw, reveal it": a legal public hand card.
          if (mustBeHidden && /reveal it/i.test(card.description ?? "")) return;
          // The core keeps a hand card face-up while EFFECT_PUBLIC applies, and until its next adjust step
          // after the effect ends (Ceremonial Bell used as Link Material). A face-up hand card is public.
          if (mustBeHidden && !faceDown) {
            this.bump("hand-public-by-core");
            return;
          }
          if (card.code !== undefined && (revealed.has(card.code) || (this.announced[vi] as Set<number>).has(card.code))) return;
          if ((mustBeHidden || faceDown) && !isRedacted(card)) add("privacy-structure", `Viewer ${String(viewer)} sees ${what} of seat ${owner}: ${card.name ?? card.code}`, card);
          if (card.materials && card.materials.length > 0 && faceDown) add("privacy-structure", `Viewer ${String(viewer)} sees materials under a face-down card of seat ${owner}`, card);
        };
        if (!handsShown) seat.hand.forEach((c) => check(c, "a hand card", true));
        seat.monsters.forEach((c) => check(c, "a face-down monster", false));
        seat.spells.forEach((c) => check(c, "a face-down spell/trap", false));
        seat.banished.forEach((c) => check(c, "a face-down banished card", false));
        seat.extra.forEach((c) => check(c, "an Extra Deck card", false));
      });
      // Text and code scan over everything new in this viewer's stream.
      const secret = (code: number) => this.codeTotals.has(code) && !known.has(code);
      const printed = new Set([...known].flatMap(code => this.options.printedText?.(code) ?? []));
      const scanText = (text: string, where: string, detail: unknown) => {
        if (where.startsWith("prompt ") && printed.has(text)) return;
        for (const match of text.matchAll(/\b\d{5,10}\b/g)) {
          const code = Number(match[0]);
          if (secret(code)) add("privacy-text", `Viewer ${String(viewer)}: ${where} contains code ${code}`, { text, detail });
        }
        for (const [name, codes] of this.namesIn(text)) {
          if (COMMON_WORD_NAMES.has(name)) continue;
          if (codes.every((code) => secret(code))) add("privacy-text", `Viewer ${String(viewer)}: ${where} names hidden card "${name}"`, { text, detail });
        }
      };
      for (const entry of view.log) {
        if (entry.id <= (this.lastLog[vi] as number)) continue;
        if (/^(Confirmed|Excavated) /.test(entry.text)) {
          // A legitimate reveal for this viewer. Their identities become known.
          for (const [, codes] of this.namesIn(entry.text)) for (const code of codes) known.add(code);
          this.bump("reveal-log-entries");
          continue;
        }
        if (/^You drew /.test(entry.text)) {
          const mine = viewer === null ? new Set<number>() : this.deckCodes[viewer];
          const named = this.namesIn(entry.text);
          const ok = named.every(([, codes]) => codes.some((code) => mine.has(code)));
          if (!ok) add("privacy-log-audience", `Viewer ${String(viewer)} log says "${entry.text}" for cards outside own deck`);
          continue;
        }
        scanText(entry.text, `log ${entry.id}`, entry);
      }
      for (const event of view.events) {
        if (event.id <= (this.lastEvent[vi] as number)) continue;
        scanText(event.text, `event ${event.id} text`, event);
        if (event.card && secret(event.card.code)) add("privacy-event-card", `Viewer ${String(viewer)}: event ${event.id} (${event.kind}) shows hidden card ${event.card.name}`, event);
      }
      if (view.log.length > 0) this.lastLog[vi] = Math.max(this.lastLog[vi] as number, ...view.log.map((e) => e.id));
      if (view.events.length > 0) this.lastEvent[vi] = Math.max(this.lastEvent[vi] as number, ...view.events.map((e) => e.id));
      // Prompt: options, source and text must not expose unknown cards.
      const prompt: DuelPrompt | null = view.prompt;
      if (prompt) {
        walkCodes(prompt, (code, key) => {
          if (secret(code)) add("privacy-prompt", `Viewer ${String(viewer)}: prompt "${prompt.title}" shows hidden card code ${code} (${key})`, prompt);
        });
        // A zone prompt "Select a zone for <name>" names the card this seat is placing. After Change of
        // Heart that card is a face-down monster the seat is about to control, so the name is legal
        // there and only there. Every other string in every prompt stays strict.
        const zoneTitle = prompt.kind === "places" && prompt.title.startsWith("Select a zone for ") ? prompt.title : null;
        walkStrings(prompt, (text) => {
          if (zoneTitle !== null && text === zoneTitle) {
            this.bump("zone-prompt-title-exempt");
            return;
          }
          scanText(text, `prompt ${prompt.id}`, { title: prompt.title });
        });
      }
      walkCodes(view.chain, (code) => {
        if (secret(code)) add("privacy-chain", `Viewer ${String(viewer)}: chain shows hidden card code ${code}`, view.chain);
      });
    });
  }
}
