"use client";

import { useMemo, type ReactNode, type RefObject } from "react";
import type { DuelEngineView, DuelMasterRule } from "@yugidraft/shared/duels";
import { isBattlePhase } from "./constants";
import { resolveEquipLinks } from "./equip-links";
import { deriveFieldActivity } from "./field-activity";
import { extraMonster, extraMonsterKeys, withExact, type DuelActivateHandler, type DuelHoverHandler, type FieldCallbacks } from "./field-keys";
import { useFieldPriorityReady } from "./field-priority";
import { useFieldTurnSeat } from "./field-turn";
import type { InspectTarget } from "./inspector";
import { disabledZones } from "./multi-seat";

/** The props of the 1v1 board. `DuelField` (classic) and `SolidField` (3D mode) take the same ones. */
export type DuelFieldProps = {
  engine: DuelEngineView;
  mySeat: number | null;
  masterRule: DuelMasterRule;
  reducedMotion: boolean;
  legalKeys: Set<string>;
  selectedKeys: Set<string>;
  onActivate: DuelActivateHandler;
  onInspect: (target: InspectTarget) => void;
  onHoverCard?: DuelHoverHandler;
  bottomName: string;
  topName: string;
  /**
   * Replay camera: the seat drawn in the bottom half when it is not `mySeat` (a spectator, or a player looking from
   * another seat). Default: `mySeat`, or seat 0 for a spectator. Pair it with `mySeat: null` so labels use the names.
   */
  bottomSeat?: number | null;
  /** 3 and 4 seat tables: the seat shown in the top half. Default: the other seat of a 1v1. */
  topSeat?: number | null;
  /** 3 and 4 seat tables: owner name in the top half's aria labels (default "Opponent"). */
  topLabel?: string;
  /** False when MultiSeatStage draws this seat's EMZ in an FFA4 shared row. */
  showExtraZones?: boolean;
  /** Room action/reveal gate. Local priority follows this directly; previews can omit it. */
  priorityLive?: boolean;
  /**
   * The phase hub for a 1v1: a strip in its own lane, directly under the Extra Monster Zone band and above your monster
   * zones. The lane takes height from the board (the zones shrink a little). Leave it out and the board is as before.
   */
  hub?: ReactNode;
};

/**
 * Everything the 1v1 board derives from its props: the two seats, labels, battle flag, the gated priority and
 * turn lights, the Extra Monster Zone cards and keys, and the equip links. It holds the logic, so both looks
 * of the board place the same zones with the same keys and fix the same bugs. `boardRef` is the element the
 * priority gate watches for running board effects (the parent of the board root).
 */
export function useDuelFieldModel(props: DuelFieldProps & { boardRef: RefObject<HTMLElement | null> }) {
  const { engine, mySeat, masterRule, reducedMotion, legalKeys, selectedKeys, onActivate, onInspect, onHoverCard,
    bottomName, topName, topSeat, topLabel: topLabelOverride, priorityLive, boardRef } = props;
  const bottomIndex = props.bottomSeat ?? mySeat ?? 0;
  const topIndex = topSeat ?? (bottomIndex === 0 ? 1 : 0);
  const bottom = engine.seats.find((seat) => seat.seat === bottomIndex);
  const top = engine.seats.find((seat) => seat.seat === topIndex);
  const callbacks: FieldCallbacks = { legalKeys, selectedKeys, onActivate, onInspect, onHoverCard };
  const topLabel = topLabelOverride ?? (mySeat == null ? topName : "Opponent");
  const bottomLabel = mySeat == null ? bottomName : "Your";
  const battle = isBattlePhase(engine.phase);
  const pending = deriveFieldActivity(engine);
  // The room owns local reveal. The parent also contains sibling board effects, which gate
  // private opponent prompts and standalone previews.
  const priorityReady = useFieldPriorityReady({
    events: engine.events,
    waiting: pending.prioritySeat != null,
    revealed: priorityLive === true && pending.prioritySeat === mySeat,
    board: boardRef,
    reducedMotion,
  });
  const priorityShown = priorityLive !== false && priorityReady;
  const turnSeat = useFieldTurnSeat(engine, pending.turnSeat);
  const activity = { ...deriveFieldActivity(engine, !priorityShown), turnSeat };
  const priorityLabel = (seat: number, name: string) => activity.prioritySeat !== seat ? null
    : mySeat == null ? `${name} to act` : mySeat === seat ? "Your move" : "Opponent to act";

  const leftEmz = extraMonster(bottom, top, "left");
  const rightEmz = extraMonster(bottom, top, "right");
  const leftEmzKeys = withExact(leftEmz, extraMonsterKeys(bottomIndex, topIndex, "left"));
  const rightEmzKeys = withExact(rightEmz, extraMonsterKeys(bottomIndex, topIndex, "right"));

  // Extra Monster Zones: the bottom seat's bit 5/6, or the top seat's bit 6/5 (mirrored band, 1v1 only).
  // At 3+ seats the focused opponent's own Extra Monster Zones are drawn in their own row, not here.
  const bottomOff = disabledZones(bottom);
  const topOff = engine.seats.length > 2 ? null : disabledZones(top);
  const emzOff = (left: boolean): string | undefined => {
    if (left ? bottomOff.monsters[5] : bottomOff.monsters[6]) return `${bottomIndex}-m-${left ? 5 : 6}`;
    if (topOff && (left ? topOff.monsters[6] : topOff.monsters[5])) return `${topIndex}-m-${left ? 6 : 5}`;
    return undefined;
  };
  const equipLinks = useMemo(() => resolveEquipLinks(engine.seats), [engine.seats]);

  return {
    bottomIndex, topIndex, bottom, top, callbacks, topLabel, bottomLabel, spectator: mySeat == null, battle,
    activity, priorityLabel, leftEmz, rightEmz, leftEmzKeys, rightEmzKeys, emzOff, equipLinks,
  };
}

export type DuelFieldModel = ReturnType<typeof useDuelFieldModel>;
