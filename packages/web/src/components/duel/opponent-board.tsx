"use client";

import { useState } from "react";
import type { DuelCard, DuelFormat, DuelMasterRule, DuelSeatView } from "@yugidraft/shared/duels";
import { Check } from "lucide-react";
import { CardFace } from "./card-face";
import {
  isDefense,
  LOCATION_DECK,
  LOCATION_DMZONE,
  LOCATION_EXTRA,
  LOCATION_FZONE,
  LOCATION_GRAVE,
  LOCATION_HAND,
  LOCATION_MZONE,
  LOCATION_PZONE,
  LOCATION_REMOVED,
  POS_FACEUP_ATTACK,
  LOCATION_SZONE,
  zoneKey,
} from "./constants";
import { LifePoints } from "./life-points";
import type { DuelActivateHandler, DuelHoverHandler } from "./field";
import type { InspectTarget } from "./inspector";
import { disabledZoneNames, disabledZones, opponentPickLabel, type SeatPick, type SeatRelation } from "./multi-seat";
import styles from "./opponent-board.module.css";

export type SeatBoardCallbacks = {
  legalKeys: ReadonlySet<string>;
  selectedKeys: ReadonlySet<string>;
  onActivate: DuelActivateHandler;
  onInspect: (target: InspectTarget) => void;
  onHoverCard?: DuelHoverHandler;
};

function anyIn(keys: readonly string[], set: ReadonlySet<string>): boolean {
  return keys.some((key) => set.has(key));
}

function cardKey(card: DuelCard): string {
  return zoneKey(card.controller, card.location, card.sequence);
}

function withExact(card: DuelCard | null, keys: string[]): string[] {
  if (!card) return keys;
  const exact = cardKey(card);
  return [exact, ...keys.filter((key) => key !== exact)];
}

function pileKeys(seat: number, location: number, cards: readonly DuelCard[]): string[] {
  return cards.length === 0 ? [zoneKey(seat, location, 0)] : cards.map(cardKey);
}

function Marks({ legal, selected }: { legal: boolean; selected: boolean }) {
  if (!legal && !selected) return null;
  return (
    <>
      <span className={styles.ring} aria-hidden="true" />
      <span className={styles.mark} aria-hidden="true">{selected ? <Check size={9} strokeWidth={2.6} /> : null}</span>
    </>
  );
}

/** A zone name with its state in words: the purple ring and mark are visual only. */
function stateLabel(label: string, state: { disabled?: boolean; negated?: boolean; legal: boolean; selected: boolean }): string {
  const parts = [label];
  if (state.negated) parts.push("effects negated");
  if (state.disabled) parts.push("disabled");
  if (state.legal) parts.push(state.selected ? "selectable, selected" : "selectable");
  return parts.join(", ");
}

function CardCell({
  card,
  label,
  keys,
  kind,
  callbacks,
  disabled = false,
  testId,
}: {
  card: DuelCard | null;
  label: string;
  keys: string[];
  kind: "mz" | "st" | "fz" | "emz" | "dm";
  callbacks: SeatBoardCallbacks;
  /** The zone is disabled for this seat (per-seat disabled zone mask). */
  disabled?: boolean;
  testId?: string;
}) {
  const legal = anyIn(keys, callbacks.legalKeys);
  const selected = anyIn(keys, callbacks.selectedKeys);
  const defense = card != null && card.location === LOCATION_MZONE && isDefense(card.position);
  // The ring and mark are drawn only: the state is also in the name so a screen reader hears it.
  const negated = card?.negated === true;
  const name = stateLabel(label, { disabled, negated, legal, selected });
  return (
    <div className={styles.cell} data-zones={keys.join(" ")} data-kind={kind} data-legal={legal ? "true" : "false"}
      data-selected={selected ? "true" : "false"} data-occupied={card ? "true" : "false"} data-defense={defense ? "true" : "false"}
      data-negated={negated ? "true" : undefined}
      data-disabled={disabled ? "true" : "false"} data-testid={testId}>
      <button type="button" className={styles.cellHit} aria-label={name} aria-pressed={selected}
        aria-disabled={disabled && !card ? true : undefined}
        onClick={(event) => { if (disabled && !card) return; callbacks.onActivate(keys, card, event.currentTarget); }}
        onMouseEnter={(event) => callbacks.onHoverCard?.(card, event.currentTarget)}
        onMouseLeave={() => callbacks.onHoverCard?.(null, null)}
        onFocus={(event) => callbacks.onHoverCard?.(card, event.currentTarget)}
        onBlur={() => callbacks.onHoverCard?.(null, null)}>
        {card ? <CardFace card={card} /> : null}
        <Marks legal={legal} selected={selected} />
      </button>
    </div>
  );
}

function Count({
  label,
  count,
  keys,
  pile,
  owner,
  cards,
  callbacks,
}: {
  label: string;
  count: number;
  keys: string[];
  /** Piles open in the pile viewer when tapped. */
  pile: boolean;
  owner: string;
  cards: readonly DuelCard[];
  callbacks: SeatBoardCallbacks;
}) {
  const legal = anyIn(keys, callbacks.legalKeys);
  const selected = anyIn(keys, callbacks.selectedKeys);
  const title = `${owner} ${label}`;
  function activate(anchor: HTMLElement) {
    if (pile) {
      callbacks.onInspect({ type: "pile", title, cards: [...cards] });
      if (cards.length === 1) {
        callbacks.onActivate([cardKey(cards[0])], cards[0], anchor);
        return;
      }
      if (cards.length === 0) callbacks.onActivate(keys, null, anchor);
      return;
    }
    callbacks.onActivate(keys, cards.length === 1 ? cards[0] : null, anchor);
  }
  return (
    <button type="button" className={styles.count} data-zones={keys.join(" ")} data-legal={legal ? "true" : "false"}
      data-selected={selected ? "true" : "false"} aria-label={stateLabel(`${title} (${count})`, { legal, selected })} aria-pressed={selected}
      onClick={(event) => activate(event.currentTarget)}>
      <span>{label}</span><b>{count}</b>
    </button>
  );
}

/** The Deck Master of a seat as a card, or null when it is not in its zone (shown as a status line). */
function deckMasterCard(view: DuelSeatView): DuelCard | null {
  const master = view.deckMaster;
  if (!master || !master.inZone) return null;
  return {
    controller: view.seat,
    location: LOCATION_DMZONE,
    sequence: 0,
    position: POS_FACEUP_ATTACK,
    code: master.card.code,
    name: master.card.name,
    description: master.card.description,
    attack: master.card.attack,
    defense: master.card.defense,
    level: master.card.level,
    type: master.card.type,
    attribute: master.card.attribute,
    race: master.card.race,
  };
}

function ExtraZoneCells({
  view,
  name,
  callbacks,
}: {
  view: DuelSeatView;
  name: string;
  callbacks: SeatBoardCallbacks;
}) {
  const disabled = disabledZones(view);
  return (
    <>
      {[5, 6].map((sequence) => {
        const card = view.monsters[sequence] ?? null;
        return (
          <CardCell key={`emz-${sequence}`} card={card} kind="emz" label={`${name} extra monster zone ${sequence - 4}`}
            keys={withExact(card, [zoneKey(view.seat, LOCATION_MZONE, sequence)])} callbacks={callbacks}
            disabled={disabled.monsters[sequence]} testId={`seat-emz-${view.seat}-${sequence - 4}`} />
        );
      })}
    </>
  );
}

/**
 * Zone keys of one Spell and Trap cell. Master Rule 3 keeps its Pendulum Zones at sequence 6 and 7 (own cells);
 * Master Rule 4 and 5 use the outer Spell and Trap Zones. Same keys as the field band (`stKeys` in field.tsx).
 */
function spellKeys(seat: number, sequence: number, masterRule: DuelMasterRule): string[] {
  const keys = [zoneKey(seat, LOCATION_SZONE, sequence)];
  if (masterRule >= 4 && sequence === 0) keys.push(zoneKey(seat, LOCATION_PZONE, 0));
  if (masterRule >= 4 && sequence === 4) keys.push(zoneKey(seat, LOCATION_PZONE, 1));
  return keys;
}

/** One physical EMZ pair. Each cell keeps both seat references and the actual card controller. */
export function SharedExtraZones({ pair, viewerSeat, nameOf, callbacks }: {
  pair: [DuelSeatView, DuelSeatView];
  viewerSeat: number | null;
  nameOf: (seat: number) => string;
  callbacks: SeatBoardCallbacks;
}) {
  const reversed = viewerSeat === pair[1].seat;
  const [first, across] = reversed ? [pair[1], pair[0]] : pair;
  const firstName = nameOf(first.seat);
  const acrossName = nameOf(across.seat);
  const firstDisabled = disabledZones(first);
  const acrossDisabled = disabledZones(across);
  return (
    <div className={`${styles.extras} ${styles.sharedPair}`} data-testid={`shared-emz-pair-${pair[0].seat}-${pair[1].seat}`}
      data-seats={`${pair[0].seat} ${pair[1].seat}`} role="group" aria-label={`${firstName} / ${acrossName} shared extra monster zones`}>
      <span className={styles.extraLabel}>{firstName} / {acrossName} shared extra monster zones</span>
      {[5, 6].map((sequence) => {
        const mirror = 11 - sequence;
        const card = first.monsters[sequence] ?? across.monsters[mirror] ?? null;
        const firstOff = firstDisabled.monsters[sequence]!;
        const acrossOff = acrossDisabled.monsters[mirror]!;
        const label = `${firstName} extra monster zone ${sequence - 4} / ${acrossName} extra monster zone ${mirror - 4}, shared`
          + (firstOff ? `, ${firstName} zone disabled` : "") + (acrossOff ? `, ${acrossName} zone disabled` : "");
        return <CardCell key={sequence} card={card} kind="emz" label={label}
          keys={withExact(card, [zoneKey(first.seat, LOCATION_MZONE, sequence), zoneKey(across.seat, LOCATION_MZONE, mirror)])}
          callbacks={callbacks} disabled={firstOff || acrossOff} testId={`shared-emz-${pair[0].seat}-${pair[1].seat}-${(reversed ? mirror : sequence) - 4}`} />;
      })}
    </div>
  );
}

/** Master Rule 3 only: the two Pendulum Zones (Spell and Trap sequence 6 left, 7 right). */
function PendulumCells({ view, name, callbacks }: { view: DuelSeatView; name: string; callbacks: SeatBoardCallbacks }) {
  const off = disabledZones(view).pendulum;
  return (
    <>
      {[6, 7].map((sequence) => {
        const card = view.spells[sequence] ?? null;
        const side = sequence === 6 ? "left" : "right";
        return (
          <CardCell key={`pz-${sequence}`} card={card} kind="st" label={`${name} ${side} pendulum zone`}
            keys={withExact(card, [zoneKey(view.seat, LOCATION_SZONE, sequence), zoneKey(view.seat, LOCATION_PZONE, sequence - 6)])}
            callbacks={callbacks} disabled={off[sequence - 6]} testId={`seat-pz-${view.seat}-${sequence - 5}`} />
        );
      })}
    </>
  );
}

/**
 * The large focused opponent (top half of the field) has no compact board, so an opponent pick gets its own
 * bar above the field. It is a real button: keyboard and screen readers use the same path as the rail boards.
 */
export function FocusedSeatPick({ view, name, pick }: { view: DuelSeatView; name: string; pick?: SeatPick | null }) {
  const seat = view.seat;
  if (view.eliminated === true || pick?.options.has(seat) !== true) return null;
  return (
    <div className={styles.focusPick} data-pickable="true" data-seat={seat} data-testid={`seat-focus-pick-${seat}`}>
      <span className={styles.focusName}>{name}</span>
      <button type="button" className={styles.pick} data-testid={`seat-pick-${seat}`} aria-label={opponentPickLabel(name)}
        onClick={() => pick.onPick(seat)}>Choose</button>
    </div>
  );
}

function DisabledNote({ view }: { view: DuelSeatView }) {
  const names = disabledZoneNames(view);
  if (names.length === 0) return null;
  return (
    <p className={styles.disabledNote} data-testid={`seat-disabled-${view.seat}`} data-count={names.length}>
      <span>Disabled</span> {names.join(", ")}
    </p>
  );
}

/**
 * Separate EMZ of the focused opponent and disabled-zone notes. FFA4 shared EMZ use SharedExtraZones instead.
 */
export function SeatExtras({
  view,
  name,
  masterRule,
  showExtraZones,
  callbacks,
}: {
  view: DuelSeatView;
  name: string;
  masterRule: DuelMasterRule;
  showExtraZones: boolean;
  callbacks: SeatBoardCallbacks;
}) {
  const disabled = disabledZones(view);
  const emz = showExtraZones && masterRule >= 4;
  if (!emz && !disabled.any) return null;
  return (
    <div className={styles.extras} data-testid={`seat-extras-${view.seat}`} data-seat={view.seat}>
      {emz ? (
        <div className={styles.extraRow}>
          <span className={styles.extraLabel}>{name} extra monster zones</span>
          <ExtraZoneCells view={view} name={name} callbacks={callbacks} />
        </div>
      ) : null}
      <DisabledNote view={view} />
    </div>
  );
}

function lpPrefix(format: DuelFormat | undefined, eliminated: boolean): string {
  if (eliminated) return "Final LP";
  return format === "tag" ? "Team LP" : "LP";
}

const RELATION_LABEL: Record<SeatRelation, string> = { self: "You", partner: "Partner", opponent: "Opponent", other: "" };

export function SeatBoard({
  view,
  name,
  relation,
  active,
  answering,
  callbacks,
  reducedMotion,
  focusable,
  onFocusSeat,
  masterRule = 4,
  format,
  pick,
  showExtraZones = true,
}: {
  view: DuelSeatView;
  name: string;
  relation: SeatRelation;
  /** The seat has the turn. */
  active: boolean;
  /** The open prompt is waiting for this seat. */
  answering: boolean;
  callbacks: SeatBoardCallbacks;
  reducedMotion: boolean;
  /** Tapping the name moves this opponent to the main field. */
  focusable?: boolean;
  onFocusSeat?: (seat: number) => void;
  masterRule?: DuelMasterRule;
  format?: DuelFormat;
  /** False when the stage draws this seat's EMZ in an FFA4 shared row. */
  showExtraZones?: boolean;
  /** An opponent pick is open: this board answers it when its seat is offered. */
  pick?: SeatPick | null;
}) {
  const seat = view.seat;
  const eliminated = view.eliminated === true;
  const leaving = !eliminated && view.pendingElimination === true;
  const [open, setOpen] = useState(false);
  const targeted = !eliminated && [...callbacks.legalKeys].some((key) => key.startsWith(`${seat}:`));
  const expanded = open || targeted;
  const fieldSpell = view.spells[5] ?? null;
  const monsters = [0, 1, 2, 3, 4].map((sequence) => view.monsters[sequence] ?? null);
  const disabled = disabledZones(view);
  const master = view.deckMaster;
  const masterFace = deckMasterCard(view);
  const spells = [0, 1, 2, 3, 4].map((sequence) => view.spells[sequence] ?? null);
  const handKeys = view.hand.length === 0 ? [zoneKey(seat, LOCATION_HAND, 0)] : view.hand.map(cardKey);
  const relationText = RELATION_LABEL[relation];
  const pickable = !eliminated && pick?.options.has(seat) === true;

  return (
    <section className={styles.board} aria-label={`${name} board`} data-seat={seat} data-relation={relation}
      data-active={active && !eliminated && !leaving ? "true" : "false"} data-answering={answering && !eliminated && !leaving ? "true" : "false"}
      data-eliminated={eliminated ? "true" : "false"} data-leaving={leaving ? "true" : "false"} data-expanded={expanded ? "true" : "false"}
      data-pickable={pickable ? "true" : undefined} data-team={view.team} data-testid={`seat-board-${seat}`}>
      <header className={styles.head}>
        <button type="button" className={styles.toggle} aria-expanded={expanded} aria-disabled={targeted || undefined}
          aria-label={targeted ? `${name} stays open while it has a selectable target` : `${expanded ? "Collapse" : "Expand"} ${name}`}
          onClick={() => { if (!targeted) setOpen((current) => !current); }}>
          <span className={styles.chev} aria-hidden="true" />
        </button>
        <div className={styles.who}>
          {focusable && !eliminated ? (
            <button type="button" className={styles.nameBtn} onClick={() => onFocusSeat?.(seat)} title="Show this board large">{name}</button>
          ) : <b className={styles.name}>{name}</b>}
          {relationText ? <span className={styles.relation} data-relation={relation}>{relationText}</span> : null}
          {active && !eliminated && !leaving ? <span className={styles.tag} data-kind="turn">To play</span> : null}
          {answering && !eliminated && !leaving ? <span className={styles.tag} data-kind="answer">Choosing</span> : null}
          {leaving ? <span className={styles.tag} data-kind="leaving" data-testid={`seat-leaving-${seat}`}>Leaving</span> : null}
          {eliminated ? <span className={styles.tag} data-kind="out" data-testid={`seat-eliminated-${seat}`}>Eliminated</span> : null}
          {pickable ? (
            <button type="button" className={styles.pick} data-testid={`seat-pick-${seat}`} aria-label={opponentPickLabel(name)}
              onClick={() => pick?.onPick(seat)}>Choose</button>
          ) : null}
        </div>
        <div className={styles.lp} data-lp-seat={seat} data-final={eliminated ? "true" : "false"} data-testid={`seat-lp-${seat}`}
          aria-label={`${name} ${eliminated ? "final " : ""}${format === "tag" ? "team " : ""}life points`}>
          <span className={styles.lpPrefix}>{lpPrefix(format, eliminated)}</span>
          <LifePoints key={seat} value={view.lp} reducedMotion={reducedMotion} size="sm" />
        </div>
      </header>
      {eliminated ? (
        <p className={styles.out} role="status" data-testid={`seat-out-${seat}`}>Eliminated</p>
      ) : (
        <div className={styles.body}>
          <div className={styles.counts}>
            <Count label="Hand" count={view.hand.length} keys={handKeys} pile={false} owner={name} cards={view.hand} callbacks={callbacks} />
            <Count label="Deck" count={view.deckCount} keys={[zoneKey(seat, LOCATION_DECK, 0)]} pile={false} owner={name} cards={[]} callbacks={callbacks} />
            <Count label="Extra" count={view.extraCount ?? view.extra.length} keys={pileKeys(seat, LOCATION_EXTRA, view.extra)} pile owner={name} cards={view.extra} callbacks={callbacks} />
            <Count label="GY" count={view.graveyard.length} keys={pileKeys(seat, LOCATION_GRAVE, view.graveyard)} pile owner={name} cards={view.graveyard} callbacks={callbacks} />
            <Count label="Banished" count={view.banished.length} keys={pileKeys(seat, LOCATION_REMOVED, view.banished)} pile owner={name} cards={view.banished} callbacks={callbacks} />
          </div>
          <div className={styles.rows}>
            <div className={styles.row} data-row="monsters">
              {monsters.map((card, sequence) => (
                <CardCell key={`mz-${sequence}`} card={card} kind="mz" label={`${name} monster zone ${sequence + 1}`}
                  keys={withExact(card, [zoneKey(seat, LOCATION_MZONE, sequence)])} callbacks={callbacks}
                  disabled={disabled.monsters[sequence]} testId={`seat-mz-${seat}-${sequence + 1}`} />
              ))}
            </div>
            {masterRule === 3 || (showExtraZones && masterRule >= 4) || master ? (
              <div className={styles.row} data-row="special">
                {showExtraZones && masterRule >= 4 ? <ExtraZoneCells view={view} name={name} callbacks={callbacks} /> : null}
                {masterRule === 3 ? <PendulumCells view={view} name={name} callbacks={callbacks} /> : null}
                {master ? (
                  <>
                    <CardCell card={masterFace} kind="dm" label={`${name} Deck Master ${master.card.name}${master.inZone ? "" : ", not in its zone"}`}
                      keys={withExact(masterFace, [zoneKey(seat, LOCATION_DMZONE, 0)])} callbacks={callbacks}
                      testId={`seat-deckmaster-${seat}`} />
                    <span className={styles.masterText} data-in-zone={master.inZone ? "true" : "false"}>
                      {master.card.name}{master.inZone ? "" : " (away)"}
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
            <div className={styles.row} data-row="spells">
              <CardCell card={fieldSpell} kind="fz" label={`${name} field spell`}
                keys={withExact(fieldSpell, [zoneKey(seat, LOCATION_FZONE, 0), zoneKey(seat, LOCATION_SZONE, 5)])} callbacks={callbacks}
                disabled={disabled.field} testId={`seat-fz-${seat}`} />
              {spells.map((card, sequence) => (
                <CardCell key={`st-${sequence}`} card={card} kind="st" label={`${name} spell and trap zone ${sequence + 1}`}
                  keys={withExact(card, spellKeys(seat, sequence, masterRule))} callbacks={callbacks}
                  disabled={disabled.spells[sequence]} testId={`seat-st-${seat}-${sequence + 1}`} />
              ))}
            </div>
          </div>
          <DisabledNote view={view} />
        </div>
      )}
    </section>
  );
}
