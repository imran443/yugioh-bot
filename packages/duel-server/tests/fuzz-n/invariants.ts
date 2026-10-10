import { createHash } from "node:crypto";
import type { DuelCard, DuelEngineView, DuelFormat } from "@yugidraft/shared/duels";
import { partnerSeatOf, seatCountFor, seatsOfTeam, teamOfSeat } from "@yugidraft/shared/duels";

/**
 * The named checks of the N-seat fuzz. Every violation carries one of these names.
 * The list is the contract with `known-issues.ts` and with the report table.
 */
export const CHECKS = {
  viewAgreement: "view-agreement",
  progress: "progress",
  promptLivingSeat: "prompt-living-seat",
  promptSingleSeat: "prompt-single-seat",
  eliminatedEmpty: "eliminated-empty",
  eliminatedSticky: "eliminated-sticky",
  eliminatedTurn: "eliminated-turn",
  turnOrder: "turn-order",
  firstAttack: "first-attack",
  tagTeamLp: "tag-team-lp",
  tagTeamLoss: "tag-team-loss",
  responseOrder: "response-order",
  singleResult: "single-result",
  winnerLiving: "winner-living",
  winMissing: "win-missing",
  privacy: "privacy",
  lpRange: "lp-range",
} as const;

export interface Violation {
  /** One of `CHECKS`. */
  invariant: string;
  /** Step number of the check (0 = opening board; step k = after the k-th accepted action). */
  step: number;
  /** The seat the violation is about, or the seat that holds the prompt; undefined when neither applies. */
  seat?: number;
  message: string;
  detail?: unknown;
}

/** One line of the engine triage ring buffer (`EngineGame.diagnostics()`); the same shape as `EngineDiagnostic` in src/engine.ts. */
export interface DiagnosticEntry {
  turn: number;
  phase: string;
  kind: string;
  seat: number | null;
  detail: string;
}

/** One view per seat, plus the spectator view. */
export interface NViews {
  seats: DuelEngineView[];
  spectator: DuelEngineView;
}

const FACEDOWN = 0x2 | 0x8;
const REVEAL_WORDS = /reveal|show|confirm|excavat|look|hand/i;
/**
 * Face-up cards whose script gives hand cards EFFECT_PUBLIC (the core then reports QUERY_IS_PUBLIC, so the view shows the
 * card with its code although it is face-down in the hand): Ceremonial Bell, Click & Echo, Clear World, Mind Scan, The
 * Eye of Truth, Contract with Don Thousand, Mind on Air, Thousand-Eyes Jellyfish, Respect Play, Mutually Affured
 * Destruction. While one of them is on a field, a revealed hand card is no leak (seed 12 at Tag: Don Thousand revealed
 * the card that seat 3 drew).
 */
const PUBLIC_HAND_EFFECT_CODES = new Set([20228463, 2992467, 33900648, 34298391, 34694160, 56673480, 66690411, 81434470, 8951260, 75364199]);

/** True when a face-up card of PUBLIC_HAND_EFFECT_CODES is on any field of the view. */
export function publicHandEffectOnField(view: DuelEngineView): boolean {
  return view.seats.some((seat) =>
    [...seat.monsters, ...seat.spells].some((card) => card && card.code !== undefined && (card.position & FACEDOWN) === 0 && PUBLIC_HAND_EFFECT_CODES.has(card.code)),
  );
}

export function sha1(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

/** Hash of everything every viewer can observe. At two seats it is the hash the old fuzz makes (`viewsHash`). */
export function nViewsHash(views: NViews): string {
  return sha1([...views.seats, views.spectator]);
}

/** Hash of the board without log, events and revision (loop detection). */
export function nStateHash(views: NViews): string {
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
  return sha1([...views.seats.map(strip)]);
}

/** Seat that is asked for an answer: the seat whose own view holds the prompt. */
export function promptSeats(views: NViews): number[] {
  const out: number[] = [];
  views.seats.forEach((view, seat) => {
    if (view.prompt) out.push(seat);
  });
  return out;
}

/** The response order after a Chain Link of `linkSeat` (ADR-0002, R-FFA-CHAIN and R-TAG-RESPONSE). */
export function expectedResponseOrder(format: DuelFormat, linkSeat: number, _turnSeat: number, living: readonly number[]): number[] {
  const n = seatCountFor(format);
  let order: number[];
  if (format === "tag") {
    // The opposing team first (L+1, then L+3), then the partner L+2, then L.
    order = [(linkSeat + 1) % n, (linkSeat + 3) % n, (linkSeat + 2) % n, linkSeat];
  } else {
    // Each new link restarts clockwise after its activating seat, with that seat last.
    order = Array.from({ length: n }, (_, i) => (linkSeat + 1 + i) % n);
  }
  return order.filter((seat) => living.includes(seat));
}

/** True when `sequence` (distinct, in order) is a subsequence of `order`. */
export function isSubsequence(sequence: readonly number[], order: readonly number[]): boolean {
  let at = 0;
  for (const seat of sequence) {
    const found = order.indexOf(seat, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

interface ChainWindow {
  length: number;
  linkSeat: number;
  turnSeat: number;
  order: number[];
  seen: number[];
}

/**
 * Stateful checker. Call `check` once for the opening board and once after every accepted action.
 * It works at two seats as well (then the Tag and elimination checks do nothing).
 */
export class NChecker {
  readonly stats: Record<string, number> = {};
  private readonly seatCount: number;
  private prev: { revision: number; turn: number; turnSeat: number } | null = null;
  private readonly eliminatedEver = new Set<number>();
  private resultSeen: DuelEngineView["result"] = null;
  private window: ChainWindow | null = null;
  private prevChainLength = 0;
  private lastEventId = 0;
  private readonly startedTurns = new Set<number>();
  private readonly lastLogId: number[];
  private readonly publicCodes = new Set<number>();
  private readonly revealLenient: boolean[];

  constructor(private readonly format: DuelFormat) {
    this.seatCount = seatCountFor(format);
    this.lastLogId = new Array<number>(this.seatCount + 1).fill(0);
    this.revealLenient = new Array<boolean>(this.seatCount).fill(false);
  }

  private bump(key: string): void {
    this.stats[key] = (this.stats[key] ?? 0) + 1;
  }

  /**
   * `diagnostics` are the triage entries that are new since the last call. When they are given, the response order
   * (invariant 6) reads the `response` entries; without them it reads the prompt sequence.
   */
  check(step: number, views: NViews, diagnostics?: readonly DiagnosticEntry[]): Violation[] {
    const out: Violation[] = [];
    const defaultSeat = promptSeats(views)[0];
    const add = (invariant: string, message: string, detail?: unknown, seat: number | undefined = defaultSeat) =>
      out.push({ invariant, step, ...(seat !== undefined ? { seat } : {}), message, ...(detail !== undefined ? { detail } : {}) });
    const n = this.seatCount;
    const vs = views.spectator;
    const eliminatedNow = new Set<number>();
    vs.seats.forEach((seat, index) => {
      if (seat.eliminated) eliminatedNow.add(index);
    });
    const living = Array.from({ length: n }, (_, seat) => seat).filter((seat) => !eliminatedNow.has(seat));

    // The views of all viewers describe the same moment.
    for (const [seat, view] of views.seats.entries()) {
      if (view.revision !== vs.revision || view.turn !== vs.turn || view.turnSeat !== vs.turnSeat || view.phase !== vs.phase) {
        add(CHECKS.viewAgreement, `Seat ${seat} view differs from the spectator view (revision ${view.revision}/${vs.revision}, turn ${view.turn}/${vs.turn}, turn seat ${view.turnSeat}/${vs.turnSeat})`);
      }
      if (JSON.stringify(view.result) !== JSON.stringify(vs.result)) add(CHECKS.viewAgreement, `Seat ${seat} sees another result than the spectator`);
    }
    if (vs.seats.length !== n) add(CHECKS.viewAgreement, `View has ${vs.seats.length} seats, the format has ${n}`);

    // 2. Progress: every accepted step changes the revision or ends the duel.
    if (this.prev && vs.revision <= this.prev.revision && !(vs.result && !this.resultSeen)) {
      add(CHECKS.progress, `Revision did not advance (${this.prev.revision} -> ${vs.revision})`);
    }

    // LP is never negative.
    for (const seat of vs.seats) if (!Number.isFinite(seat.lp) || seat.lp < 0) add(CHECKS.lpRange, `Seat ${seat.seat} has LP ${seat.lp}`);

    // 3. Elimination: sticky, empty fields, no prompt, no turn.
    for (const seat of this.eliminatedEver) {
      if (!eliminatedNow.has(seat)) add(CHECKS.eliminatedSticky, `Seat ${seat} was eliminated and is alive again`);
    }
    const aliveBefore = Array.from({ length: n }, (_, seat) => seat).filter((seat) => !this.eliminatedEver.has(seat));
    for (const seat of eliminatedNow) this.eliminatedEver.add(seat);
    for (const seat of eliminatedNow) {
      const view = vs.seats[seat]!;
      const onField = [...view.monsters, ...view.spells].filter((card) => card !== null).length;
      if (onField > 0 || view.hand.length > 0) {
        add(CHECKS.eliminatedEmpty, `Eliminated seat ${seat} still has ${onField} card(s) on the field and ${view.hand.length} in the hand`, view);
      }
    }
    const asked = promptSeats(views);
    if (asked.length > 1) add(CHECKS.promptSingleSeat, `Seats ${asked.join(", ")} all hold a prompt`);
    for (const seat of asked) {
      if (eliminatedNow.has(seat)) add(CHECKS.promptLivingSeat, `Eliminated seat ${seat} is asked: "${views.seats[seat]!.prompt!.title}"`);
      const declared = views.seats[seat]!.prompt!.seat;
      if (declared !== seat) add(CHECKS.promptLivingSeat, `Prompt of seat ${seat} says seat ${declared}`);
    }
    // The turn player can lose in the middle of its own turn (battle damage, a cost, a chain). The core then lets the open
    // chain or the open damage step finish (a Flip effect of another seat can still ask for a target) and ends the turn
    // after it (core.force_turn_end). So the dead seat keeping the turn number for a short time is legal. What is not
    // legal is a free action (idle or battle command) in the turn of a dead seat: that means the turn did not end.
    if (!vs.result && eliminatedNow.has(vs.turnSeat)) {
      const action = asked.find((seat) => views.seats[seat]!.prompt?.context?.type === "action");
      if (action !== undefined) {
        add(CHECKS.eliminatedTurn, `Eliminated seat ${vs.turnSeat} has the turn (turn ${vs.turn}) and seat ${action} is asked for a free action: "${views.seats[action]!.prompt!.title}"`);
      }
    }

    // 4. Turn order skips eliminated seats.
    if (this.prev && !vs.result) {
      if (vs.turn < this.prev.turn) add(CHECKS.turnOrder, `Turn went back from ${this.prev.turn} to ${vs.turn}`);
      else if (vs.turn === this.prev.turn) {
        if (vs.turnSeat !== this.prev.turnSeat) add(CHECKS.turnOrder, `Turn seat changed inside turn ${vs.turn} (${this.prev.turnSeat} -> ${vs.turnSeat})`);
      } else if (living.length > 0) {
        // A seat that loses on its own draw (empty Deck) still used a turn number: the core starts its turn, the draw
        // eliminates it, and the next turn skips it. So every turn but the last may belong to a seat alive at the previous check.
        let expected = this.prev.turnSeat;
        const steps = vs.turn - this.prev.turn;
        for (let i = 0; i < steps; i++) {
          const pool = i < steps - 1 ? aliveBefore : living;
          do expected = (expected + 1) % n;
          while (!pool.includes(expected));
        }
        if (vs.turnSeat !== expected) {
          add(CHECKS.turnOrder, `Turn ${vs.turn} belongs to seat ${vs.turnSeat}, expected seat ${expected} (living ${living.join(",")}, previous turn seat ${this.prev.turnSeat})`);
        }
      }
    }

    // C2: each living FFA seat must have started its first turn.
    if (vs.turn > 0) this.startedTurns.add(vs.turnSeat);
    const firstAttackTurn = this.format === "tag" ? 4 : n;
    const beforeFirstAttack = this.format === "tag" ? vs.turn < 4 : living.some(seat => !this.startedTurns.has(seat));
    let resolutionStarted = false;
    for (const event of vs.events) {
      if (event.id <= this.lastEventId) continue;
      if (event.kind === "chain-resolving" || event.kind === "chain-end") resolutionStarted = true;
      if (n > 2 && event.kind === "attack" && beforeFirstAttack) {
        add(CHECKS.firstAttack, `Attack in turn ${vs.turn}, the first attack is allowed in turn ${firstAttackTurn}: ${event.text}`, event);
      }
    }
    for (const event of vs.events) this.lastEventId = Math.max(this.lastEventId, event.id);

    // 5. Tag: one LP per team, and a team loses only as a team.
    if (this.format === "tag") {
      for (let team = 0; team < 2; team++) {
        const seats = seatsOfTeam(this.format, team);
        const lps = seats.map((seat) => vs.seats[seat]!.lp);
        if (new Set(lps).size > 1) add(CHECKS.tagTeamLp, `Team ${team} partners show different LP: ${lps.join(" / ")}`);
        const flags = seats.map((seat) => eliminatedNow.has(seat));
        if (new Set(flags).size > 1) add(CHECKS.tagTeamLoss, `Team ${team} is eliminated for one partner only (${seats.join(",")}: ${flags.join("/")})`);
      }
    }

    // 6. Response order after a Chain Link.
    const chain = vs.chain;
    if (chain.length !== this.prevChainLength) {
      if (chain.length > this.prevChainLength) {
        const linkSeat = chain[chain.length - 1]!.seat;
        this.window = {
          length: chain.length,
          linkSeat,
          turnSeat: vs.turnSeat,
          order: expectedResponseOrder(this.format, linkSeat, vs.turnSeat, living),
          seen: [],
        };
      } else this.window = null;
      this.prevChainLength = chain.length;
    }
    // The window ends when the chain starts to resolve: triggers during resolution follow other rules.
    if (resolutionStarted) this.window = null;
    if (this.window) {
      const window = this.window;
      // Seats that got a chain answer slot since the last check, in order.
      const slots: number[] = [];
      if (diagnostics) {
        for (const entry of diagnostics) {
          if (entry.kind !== "response" || entry.seat === null) continue;
          const size = /chain (\d+)/.exec(entry.detail)?.[1];
          // A trigger prompt (the core marks the optional trigger choice of one seat with 0x7f) is no response window: a seat that has
          // more triggers is asked again with the link on the chain, and the response windows of the other seats come after it.
          if (/forced|trigger/.test(entry.detail) || (size !== undefined && Number(size) !== window.length)) continue;
          slots.push(entry.seat);
        }
      } else {
        const prompt = asked.length === 1 ? views.seats[asked[0]!]!.prompt! : null;
        if (prompt && prompt.context?.type === "chain" && !prompt.context.forced) slots.push(prompt.seat);
      }
      for (const seat of slots) {
        // The same seat asked twice in a row is one answer slot (a re-prompt is not an order error).
        if (window.seen[window.seen.length - 1] === seat) continue;
        window.seen.push(seat);
        if (!isSubsequence(window.seen, window.order)) {
          add(
            CHECKS.responseOrder,
            `After link ${window.length} of seat ${window.linkSeat} (turn seat ${window.turnSeat}) the answers came in the order ${window.seen.join(",")}, expected a subsequence of ${window.order.join(",")}`,
            undefined,
            seat,
          );
          window.seen.length = 0;
        }
      }
    }

    // 7. Exactly one result, for a living winner, and no prompt after it.
    if (this.resultSeen && JSON.stringify(vs.result) !== JSON.stringify(this.resultSeen)) {
      add(CHECKS.singleResult, `The result changed after it was set: ${JSON.stringify(this.resultSeen)} -> ${JSON.stringify(vs.result)}`);
    }
    if (vs.result) {
      if (asked.length > 0) add(CHECKS.singleResult, `Seat ${asked[0]} is asked after the duel ended`);
      const winner = vs.result.winnerSeat;
      if (winner === null) {
        if (n > 2 && vs.result.winnerTeam != null) add(CHECKS.singleResult, `Draw with winnerTeam ${vs.result.winnerTeam}`);
        if (n > 2 && living.length === 1) add(CHECKS.winnerLiving, `Draw although only seat ${living[0]} is alive`);
      } else {
        if (!Number.isInteger(winner) || winner < 0 || winner >= n) add(CHECKS.winnerLiving, `Winner seat ${winner} is out of range`);
        else {
          const team = teamOfSeat(this.format, winner);
          const teamSeats = seatsOfTeam(this.format, team);
          if (teamSeats.some((seat) => eliminatedNow.has(seat)) && this.format === "tag") add(CHECKS.winnerLiving, `Winning team ${team} is eliminated`);
          if (eliminatedNow.has(winner)) add(CHECKS.winnerLiving, `Winner seat ${winner} is eliminated`);
          const otherAlive = living.filter((seat) => teamOfSeat(this.format, seat) !== team);
          if (n > 2 && otherAlive.length > 0) add(CHECKS.winnerLiving, `Seat ${winner} won while seat(s) ${otherAlive.join(",")} of other teams are alive`);
          if (this.format === "tag") {
            if (vs.result.winnerTeam !== team) add(CHECKS.winnerLiving, `winnerTeam is ${vs.result.winnerTeam}, the team of seat ${winner} is ${team}`);
            if (winner !== teamSeats[0]) add(CHECKS.winnerLiving, `Tag winnerSeat ${winner} is not the lowest seat of team ${team}`);
          }
        }
      }
    } else if (n > 2) {
      const teamsAlive = new Set(living.map((seat) => teamOfSeat(this.format, seat)));
      if (teamsAlive.size <= 1 && step > 0) add(CHECKS.winMissing, `${teamsAlive.size} team(s) left alive (seats ${living.join(",")}) and no result`);
    }
    if (vs.result) this.resultSeen = vs.result;

    // 8. Privacy.
    this.checkPrivacy(views, add);

    this.prev = { revision: vs.revision, turn: vs.turn, turnSeat: vs.turnSeat };
    return out;
  }

  private checkPrivacy(views: NViews, add: (invariant: string, message: string, detail?: unknown) => void): void {
    const vs = views.spectator;
    // Codes that the spectator view shows are public now.
    const note = (code: number | undefined) => {
      if (code !== undefined) this.publicCodes.add(code);
    };
    for (const seat of vs.seats) {
      for (const card of [...seat.monsters, ...seat.spells, ...seat.graveyard, ...seat.banished, ...seat.extra]) note(card?.code);
    }
    for (const event of vs.events) note(event.card?.code);
    for (const link of vs.chain) note(link.code);
    // A Normal or Special Summon is announced to everyone ("Player 3 Normal Summons ..."), and the core marks the card
    // public while it is summoned from the hand. The spectator event hides the card (it starts in a hand), but the
    // summoner's own event names it.
    for (const view of views.seats) {
      for (const event of view.events) if (event.kind === "summon" && event.seat !== undefined) note(event.card?.code);
    }
    const handEffectOnField = publicHandEffectOnField(vs);
    const revealNow = views.seats.map((view, viewer) => {
      const fresh = view.log.filter((entry) => entry.id > (this.lastLogId[viewer] ?? 0));
      for (const entry of fresh) this.lastLogId[viewer] = Math.max(this.lastLogId[viewer] ?? 0, entry.id);
      return fresh.some((entry) => REVEAL_WORDS.test(entry.text));
    });
    views.seats.forEach((view, viewer) => {
      // A prompt must not show the viewer another seat's hidden card; the seat that is asked sees only its own prompt.
      if (view.prompt && view.prompt.seat !== viewer) add(CHECKS.privacy, `Seat ${viewer} holds the prompt of seat ${view.prompt.seat}`);
      const friend = partnerSeatOf(this.format, viewer);
      // Tag: a duelist sees what the partner sees (ADR-0002), and the core's confirm log line goes to the looker only.
      if (revealNow[viewer] || (friend !== null && revealNow[friend])) this.revealLenient[viewer] = true;
      view.seats.forEach((seat, owner) => {
        if (owner === viewer || owner === friend) return;
        const check = (card: DuelCard | null, what: string, mustBeHidden: boolean) => {
          if (!card) return;
          const faceDown = (card.position & FACEDOWN) !== 0;
          if (mustBeHidden && !faceDown) {
            this.bump("hand-public-by-core");
            return;
          }
          if (card.code === undefined) return;
          if (this.publicCodes.has(card.code)) return;
          if (mustBeHidden && handEffectOnField) {
            this.bump("hand-public-by-effect");
            return;
          }
          // A legal reveal (CONFIRM_CARDS, a flip effect that looks at Set cards) covers face-down field cards too.
          if (this.revealLenient[viewer]) return;
          add(CHECKS.privacy, `Viewer seat ${viewer} sees ${what} of seat ${owner}: ${card.name ?? card.code}`, card);
        };
        seat.hand.forEach((card) => check(card, "a hand card", true));
        seat.monsters.forEach((card) => check(card, "a face-down monster", false));
        seat.spells.forEach((card) => check(card, "a face-down spell/trap", false));
        seat.banished.forEach((card) => check(card, "a face-down banished card", false));
        seat.extra.forEach((card) => check(card, "an Extra Deck card", false));
      });
    });
    // Spectator: no hand, no face-down card.
    vs.seats.forEach((seat, owner) => {
      const hidden = (card: DuelCard | null, what: string, mustBeHidden: boolean) => {
        if (!card || card.code === undefined) return;
        // A hand card that is being summoned is public (see the summon events above).
        if (mustBeHidden && this.publicCodes.has(card.code)) return;
        if (mustBeHidden && handEffectOnField) return;
        const faceDown = (card.position & FACEDOWN) !== 0;
        if ((mustBeHidden || faceDown) && !(mustBeHidden && !faceDown)) add(CHECKS.privacy, `Spectator sees ${what} of seat ${owner}: ${card.name ?? card.code}`, card);
      };
      seat.hand.forEach((card) => hidden(card, "a hand card", true));
      seat.monsters.forEach((card) => hidden(card, "a face-down monster", false));
      seat.spells.forEach((card) => hidden(card, "a face-down spell/trap", false));
    });
  }
}

/** One step of a recorded duel: the views of every seat and the spectator, and the new triage entries of that step. */
export interface RecordedStep {
  views: NViews;
  diagnostics?: readonly DiagnosticEntry[];
}

/**
 * Pure form of the checks: run every invariant over a recorded view sequence (step 0 = opening board) and return
 * all violations in step order. Used by the fuzz driver (one checker for the whole duel) and by other tools that have
 * a recording (Playwright runs, the triage tool). No I/O, no engine.
 */
export function checkViewSequence(format: DuelFormat, steps: readonly RecordedStep[]): Violation[] {
  const checker = new NChecker(format);
  const out: Violation[] = [];
  steps.forEach((step, index) => out.push(...checker.check(index, step.views, step.diagnostics)));
  return out;
}
