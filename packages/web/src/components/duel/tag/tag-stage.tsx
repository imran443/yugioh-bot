"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { seatsOfTeam, teamOfSeat } from "@yugidraft/shared/duels";
import { ChainRoomContext, type ChainStripSize } from "../table/chain-room";
import { duelFontClasses } from "../fonts";
import { formatStartingLp } from "../table-format";
import { zoneKey } from "../constants";
import { isChainStripPrompt } from "../prompt-center";
import { useStripRoom } from "../table/use-strip-room";
import { hexToRgbTriplet } from "../table/seat-angle";
import { SEAT_TONE_HEX, type SeatFieldProps, type SeatTone, type TagStageProps } from "../table/types";
import { sharedExtraPairs } from "../multi-seat";
import { useIsNarrow } from "../side-panel";
import { HelipadHub, type HubSeatTone } from "./helipad-hub";
import { OwnHand, PartnerHand } from "./tag-hand";
import {
  clampCenter,
  easeCam,
  easeFly,
  lockLabel,
  phaseHubSizes,
  poseAt,
  fitSeatPose,
  ROOF_FIELD,
  ROOF_FIELD_Z,
  ROOF_PERSP,
  roofFit,
  roofGap,
  roofSlots,
  roofTransform,
  tweenProgress,
  type CameraEasing,
  type RoofCameraState,
  type RoofPose,
  type RoofView,
} from "./roof-camera";
import { CameraRail } from "./camera-rail";
import { Baton, RoofDecor, TeamStrip } from "./roof-world";
import { SharedExtraBand } from "./shared-band";
import { batonOrder, lastTeamDamage, responseWindow, rivalPickOptions, teamGlyph, teamLoss, teamLp } from "./tag-logic";
import { plateState, TeamLpPlate, type PlateMember } from "./team-lp-plate";
import styles from "./tag-stage.module.css";
import cameraStyles from "./tag-camera.module.css";

export interface TagBoardProps extends Omit<TagStageProps, "camera"> {
  /**
   * The roof camera (`roofReducer`), not the table camera: it carries the pose the world eases to. A plain `CameraState`
   * has no pose, so the room drives this stage with `roofReducer` plus `lockForEvents`.
   */
  camera: RoofCameraState;
  /** Team names are not part of the engine view: the room passes them when it knows them. */
  teamNames?: readonly [string, string];
  /** The HUD pins an idle card's peek while its field comes into focus. */
  inspectIdleCards?: boolean;
  /** Replay: the camera seat is not "you". No YOU tag on the plate, and the partner hand does not claim to be team-only. */
  replay?: boolean;
}

const TAG = "tag" as const;
const HALF_W = ROOF_FIELD.width / 2;
const HALF_H = ROOF_FIELD.height / 2;
/** Space between the phase hub and the chain hub while both are on the helipad. */
const PHASE_HUB_GAP = 8;
/** Anchor above the far strip: the rival plate hangs from here. */
const FAR_ANCHOR_Y = -ROOF_FIELD.offsetY - ROOF_FIELD.height - 46;
/** A screen this wide has free room left of the fields for the camera rail; a narrower one gets a row under the far plate. */
const RAIL_COLUMN_MIN = 900;
const RAIL_ROW = 46;
/** Screen size of a field's focus button, in CSS px: large enough to hit with a finger, whatever the zoom. */
const FOCUS_BTN_PX = 36;
/**
 * A click on one of these does its own job (play a card, pick a zone, press a button): it never moves the camera.
 * On a phone, everything else on a field (the mat, the name label) or on a seat chip focuses that field, and so does a
 * zone that offers no action (see `onStageClickCapture`). On a wide screen no click focuses a field.
 */
const ACTION_TARGET = "button, a, input, select, textarea, summary, [role='button'], [data-legal='true'], [data-pickable='true']";

interface Tween {
  from: RoofPose;
  to: RoofPose;
  start: number;
  dur: number;
  ease: CameraEasing;
  /** The fit the keyframes were built with: a resize that changes it restarts the move. */
  fit: number;
}

/** Length of the short ease that follows a change of the free box (a resize, a hand that grows) in a close-up. */
const REFIT_MS = 220;

function samePose(a: RoofPose, b: RoofPose): boolean {
  return Math.abs(a.zoom - b.zoom) < 0.002 && Math.abs(a.fx - b.fx) < 0.5 && Math.abs(a.fy - b.fy) < 0.5 && Math.abs(a.oy - b.oy) < 0.5 && Math.abs(a.yaw - b.yaw) < 0.1 && Math.abs(a.tilt - b.tilt) < 0.1;
}

/** Where a running animation has moved a node from its resting place, in px (0 when none runs). */
function shiftOf(node: HTMLElement): { x: number; y: number } {
  try {
    const found = /^matrix\(([^)]+)\)$/.exec(getComputedStyle(node).transform);
    if (!found) return { x: 0, y: 0 };
    const parts = found[1].split(",").map(Number);
    return { x: Number.isFinite(parts[4]) ? parts[4] : 0, y: Number.isFinite(parts[5]) ? parts[5] : 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

function toneHex(tone: SeatTone | undefined): HubSeatTone {
  const hex = SEAT_TONE_HEX[tone ?? "violet"];
  return { rgb: hexToRgbTriplet(hex.main), ink: hex.ink };
}
/** The HUD the chain-response panel keeps off (strip-room.ts): the team plates, the camera rail and the card pinned in the peek. */
const STRIP_KEY_HUD = "[data-team-plate], [data-camera-rail], [data-testid='hover-preview'][data-pinned='true']";
/**
 * The HUD it avoids when it can: the helipad hub (its chain line is also in the panel), the chain banner, the lock chip and the partner's hand.
 * The team plates are here too: where the last-resort ranking must cover something, the soft area comes before the count of key pieces, so a plate that is only
 * "key" could be hidden for a small corner of the hub (the 2B chip at 1366 home). Counted in both, a plate costs its area first.
 */
const STRIP_SOFT_HUD = "[data-hub], [data-chain-panel], [data-lock-chip], [data-partner-hand], [data-team-plate]";
const STRIP_OWN_HAND = '[data-hand-seat][data-side="you"] [data-zones]';

/**
 * The 2v2 Rooftop stage: a 3D roof at night with the two team strips, the helipad baton in the middle, the team LP plates,
 * the chain hub and the hands. It draws the fields only through `renderSeatField`. FX, the prompt panel and any overlay
 * are slots over the whole box, so they measure the real screen position of `[data-zones]` and `[data-lp-seat]` nodes.
 */
export function TagStage({ controller, layout, camera, dispatchCamera, renderSeatField, fx, promptCenter, overlay, hub: phaseHub, teamNames, inspectIdleCards = false, replay = false }: TagBoardProps) {
  const { engine, room, viewerSeat, nameOf, legalKeys, selectedKeys, reducedMotion, prompt, promptSeat } = controller;
  const [phone, setPhone] = useState(false);
  const [chainSize, setChainSize] = useState<ChainStripSize | null>(null);
  useLayoutEffect(() => {
    const read = () => setPhone(window.innerWidth <= 640);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  // The entire roof viewport, including its HUD and prompt, stays below the measured phone strip.
  const chainInset = phone && chainSize ? chainSize.height + 12 : 0;
  const target = camera.pose;
  const anchor = layout.anchorSeat;
  const anchorTeam = teamOfSeat(TAG, anchor);
  const slotsOf = useMemo(() => roofSlots(anchor), [anchor]);
  const toneBySeat = useMemo(() => new Map(layout.slots.map((s) => [s.seat, s.tone] as const)), [layout.slots]);
  const toneOf = useCallback((seat: number) => toneHex(toneBySeat.get(seat)), [toneBySeat]);
  const teamName = (team: number) => teamNames?.[team] ?? `Team ${team + 1}`;
  const teamLabel = (team: number) => `${teamName(team)} ${teamGlyph(anchorTeam, team)}`;
  const spectator = viewerSeat == null;
  const viewerView = engine.seats.find((s) => s.seat === viewerSeat);
  const partnerSeat = viewerSeat == null ? null : (viewerSeat + 2) % 4;
  const partnerView = engine.seats.find((s) => s.seat === partnerSeat);

  const loss = teamLoss(engine);
  const window_ = responseWindow(engine, prompt, promptSeat);
  const picks = useMemo(() => (controller.seatPick ? new Map(controller.seatPick.options) : rivalPickOptions(engine, prompt)), [controller.seatPick, engine, prompt]);
  const pickSeats = controller.canAct ? [...picks.keys()] : [];
  const onPick = (seat: number) => {
    if (controller.seatPick) controller.seatPick.onPick(seat);
    else {
      const id = picks.get(seat);
      if (id != null) controller.onAnswer({ choice: id });
    }
  };
  const startLp = formatStartingLp(TAG, room.session.settings);
  const battle = engine.battleStep != null || controller.aim != null;
  const aimedSeat = controller.aim?.to.lpSeat ?? null;

  // ---------- camera ----------
  const rootRef = useRef<HTMLDivElement>(null);
  // The chain-response panel (every option a card): a room of its own with large cards (strip-room.ts), wholly inside the viewport, off the plates and
  // the hub, and over no more than the top strip of your hand. The camera never moves for it.
  const [viewBox, setViewBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const read = () => setViewBox((current) => (current.width === node.clientWidth && current.height === node.clientHeight ? current : { width: node.clientWidth, height: node.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const stripCount = !phone && promptCenter && prompt && isChainStripPrompt(prompt) ? prompt.options.length : 0;
  const stripAnchor = useMemo(() => ({ x: viewBox.width / 2, y: viewBox.height / 2 }), [viewBox.width, viewBox.height]);
  const stripSources = useMemo(() => engine.chain.flatMap((link) => (link.zone ? [zoneKey(link.zone.controller, link.zone.location, link.zone.sequence)] : [])), [engine.chain]);
  const { room: stripRoom, pending: stripPending } = useStripRoom({
    rootRef,
    active: stripCount > 0 && viewBox.width > 0,
    promptId: prompt?.id ?? "",
    count: stripCount,
    box: viewBox,
    anchor: stripAnchor,
    keyHud: STRIP_KEY_HUD,
    softHud: STRIP_SOFT_HUD,
    hand: STRIP_OWN_HAND,
    sourceKeys: stripSources,
    viewKey: `${camera.mode}|${camera.focusSeat ?? ""}|${camera.lock?.reason ?? ""}`,
  });
  const worldRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const farRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<HTMLDivElement | null>(null);
  const hubRef = useRef<HTMLDivElement | null>(null);
  const phaseHubRef = useRef<HTMLDivElement | null>(null);
  const ownPlateRef = useRef<HTMLDivElement | null>(null);
  const farPlateRef = useRef<HTMLDivElement | null>(null);
  // apply() reads the narrow flag from a ref, never from a new media query.
  const narrowRef = useRef(false);
  const isNarrow = useIsNarrow();
  narrowRef.current = isNarrow;
  // apply() also reads the camera mode and the pose it eases to from refs, for the same reason.
  const modeRef = useRef(camera.mode);
  modeRef.current = camera.mode;
  const targetRef = useRef(target);
  targetRef.current = target;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const focusSeatRef = useRef(camera.focusSeat);
  focusSeatRef.current = camera.focusSeat;
  // apply() sizes the phase hub for the gap: shared Extra Monster Zones in it leave less room beside the helipad.
  const sharedRef = useRef(false);
  // poseRef is the pose the world ends on; a move is one animation the compositor runs (see `move`), so nothing here
  // changes per frame. tweenRef holds the running move (to read the pose on screen when a new move cuts in).
  const poseRef = useRef<RoofPose>(target);
  const tweenRef = useRef<Tween | null>(null);
  const animsRef = useRef<Animation[]>([]);
  const fitRef = useRef(1);
  // The fit the world transform was last set with (fitRef already holds the new one while a resize is eased).
  const paintedFitRef = useRef(1);
  const startedRev = useRef(-1);
  // The first measure puts the world straight on its pose; only later changes of the free box ease.
  const shownRef = useRef(false);
  // Set on every render: eases the world to the pose of the new free box (see `glide`). False when it cannot animate.
  const refitRef = useRef<() => boolean>(() => false);
  // Where apply() last put each floating HUD box (hub, phase hub, far plate), so a move can glide them to the new place.
  const placedRef = useRef(new Map<HTMLElement, { x: number; y: number }>());

  const place = (node: HTMLElement, x: number, y: number) => {
    node.style.left = `${x.toFixed(1)}px`;
    node.style.top = `${y.toFixed(1)}px`;
    placedRef.current.set(node, { x, y });
  };

  /** Measures the stage box: the free view rect (above the hands, under the plates) and the overview fit. Null for an empty box. */
  const measure = (root: HTMLElement): { w: number; h: number; view: RoofView; fit: number } | null => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (w <= 0 || h <= 0) return null;
    const handH = Math.max(
      root.querySelector<HTMLElement>("[data-hand-dock]")?.offsetHeight ?? 0,
      root.querySelector<HTMLElement>("[data-partner-hand]")?.offsetHeight ?? 0,
    );
    const narrow = narrowRef.current;
    let hudH = Math.max(ownPlateRef.current?.offsetHeight ?? 0, handH) + 10;
    if (narrow) {
      // A phone has no room for the plate and the hands side by side: the plate takes the bottom row, the own hand sits
      // above it and the partner hand above that (see the narrow block in the CSS). The band is as tall as the stack.
      const ownPlateH = ownPlateRef.current?.offsetHeight ?? 0;
      const ownH = root.querySelector<HTMLElement>("[data-hand-dock]")?.offsetHeight ?? 0;
      root.style.setProperty("--plate-h", `${ownPlateH}px`);
      root.style.setProperty("--hand-h", `${ownH}px`);
      const rootTop = root.getBoundingClientRect().top;
      const tops = [ownPlateRef.current, root.querySelector<HTMLElement>("[data-hand-dock]"), root.querySelector<HTMLElement>("[data-partner-hand]")]
        .filter((node): node is HTMLElement => node != null)
        .map((node) => node.getBoundingClientRect().top - rootTop);
      if (tops.length > 0) hudH = Math.max(hudH, h - Math.min(...tops) + 4);
    }
    // The far team plate hangs from the top edge: its height is not free space for the fields.
    const plateH = farPlateRef.current?.offsetHeight ?? 0;
    const bottom = Math.max(60, h - hudH - 8);
    // A narrow screen has no side room for the camera rail: it takes its own row under the plate, kept in every mode so
    // the fit does not jump when a focus starts.
    const railRow = w < RAIL_COLUMN_MIN ? RAIL_ROW : 0;
    const railTop = 6 + (plateH > 0 ? plateH + 8 : 0);
    root.style.setProperty("--rail-top", `${railTop}px`);
    const view = { left: 8, right: w - 8, top: Math.min(railTop + railRow, bottom - 40), bottom };
    const fit = roofFit(view) || 1;
    fitRef.current = fit;
    return { w, h, view, fit };
  };

  /** The pose the world ends on: a close-up is fitted to the free box so the whole field shows; any other pose is as it is. */
  const resolvePose = (pose: RoofPose, m: { fit: number; view: RoofView }): RoofPose =>
    modeRef.current === "focus" && focusSeatRef.current != null ? fitSeatPose(anchorRef.current, focusSeatRef.current, m.fit, m.view) : pose;

  const apply = useCallback(() => {
    const root = rootRef.current;
    const world = worldRef.current;
    if (!root || !world) return;
    const m = measure(root);
    if (!m) return;
    const { view, fit } = m;
    fitRef.current = fit;
    const cx = (view.left + view.right) / 2;
    const cy = (view.top + view.bottom) / 2;
    root.style.setProperty("--cx", `${cx.toFixed(1)}px`);
    root.style.setProperty("--cy", `${cy.toFixed(1)}px`);
    root.style.setProperty("--persp", `${(ROOF_PERSP * fit).toFixed(1)}px`);
    // A move in flight ends on poseRef; with none, a close-up is fitted again (the box may have changed size). A change
    // of the box (a resize, a hand that grows) during a move or in a close-up eases from the pose on screen to the new
    // fit; it never jumps and never plays two jumps.
    const live = tweenRef.current;
    const end = resolvePose(targetRef.current, m);
    if (shownRef.current) {
      const changed = live ? !samePose(end, live.to) || Math.abs(fit - live.fit) > 0.002 : modeRef.current === "focus" && !samePose(end, poseRef.current);
      if (changed && refitRef.current()) return;
    }
    shownRef.current = true;
    if (!live) poseRef.current = end;
    const pose = poseRef.current;
    world.style.transform = roofTransform(pose, fit);
    paintedFitRef.current = fit;
    // The focus buttons keep one size on screen: world units grow when the view zooms out.
    const unit = FOCUS_BTN_PX / Math.max(fit * pose.zoom, 0.05);
    root.querySelectorAll<HTMLElement>("[data-field-focus]").forEach((node) => node.style.setProperty("--focus-btn", `${unit.toFixed(1)}px`));
    pillsRef.current?.style.setProperty("--flip", Math.cos((pose.yaw * Math.PI) / 180) < 0 ? "180deg" : "0deg");

    const box = root.getBoundingClientRect();
    const pad = padRef.current?.getBoundingClientRect();
    const far = farRef.current?.getBoundingClientRect();
    const hub = hubRef.current;
    const phases = phaseHubRef.current;
    const padAt = pad ? { x: pad.left - box.left, y: pad.top - box.top } : null;
    const padSeen = padAt != null && padAt.x >= view.left && padAt.x <= view.right && padAt.y >= view.top && padAt.y <= view.bottom;
    if (phases && pad && padAt) {
      // The phase hub sits in the gap between the two strips, on the helipad. The size comes from the gap the camera
      // ends on (so it does not flip during a tween): the biggest strip that fits the gap, with the chain hub stacked
      // under it when one is open. When none fits, or on a phone (the bottom bar has the phases) or in a close-up (the
      // helipad is behind the focused field), the hub is hidden.
      const gap = roofGap(targetRef.current, fit, sharedRef.current);
      const usable = !narrowRef.current && modeRef.current !== "focus" && padSeen;
      let stackH = 0;
      let fitted = false;
      if (usable) {
        for (const size of phaseHubSizes(gap.freePx)) {
          phases.setAttribute("data-hub-size", size === "lg" ? "lg" : size === "xs" ? "xs" : "sm");
          if (size === "row" || size === "xs") phases.setAttribute("data-hub-row", "true");
          else phases.removeAttribute("data-hub-row");
          stackH = phases.offsetHeight + (hub ? PHASE_HUB_GAP + hub.offsetHeight : 0);
          if (stackH <= gap.gapPx - 4) {
            fitted = true;
            break;
          }
        }
      }
      if (fitted) {
        phases.removeAttribute("data-off");
        const at = clampCenter(padAt, { w: Math.max(phases.offsetWidth, hub?.offsetWidth ?? 0), h: stackH }, view);
        const top = at.y - stackH / 2;
        place(phases, at.x, top + phases.offsetHeight / 2);
        if (hub) place(hub, at.x, top + phases.offsetHeight + PHASE_HUB_GAP + hub.offsetHeight / 2);
      } else {
        phases.setAttribute("data-off", "true");
        placedRef.current.delete(phases);
      }
      if (!fitted && hub) {
        const at = clampCenter(padAt, { w: hub.offsetWidth, h: hub.offsetHeight }, view);
        place(hub, at.x, at.y);
      }
    } else if (hub && pad) {
      const at = clampCenter({ x: pad.left - box.left, y: pad.top - box.top }, { w: hub.offsetWidth, h: hub.offsetHeight }, view);
      place(hub, at.x, at.y);
    }
    const plate = farPlateRef.current;
    if (plate && far && pad) {
      const at = clampCenter({ x: far.left - box.left, y: 0 }, { w: plate.offsetWidth, h: 0 }, view);
      place(plate, at.x - plate.offsetWidth / 2, 6);
    }
  }, []);

  /** Stops the move in flight; the world keeps the pose it ends on. */
  const stopMove = useCallback(() => {
    for (const anim of animsRef.current) anim.cancel();
    animsRef.current = [];
    tweenRef.current = null;
    const world = worldRef.current;
    if (world) world.style.willChange = "";
  }, []);

  const { rev, dur, intro, from } = camera;
  /**
   * A camera move is ONE animation of the world transform that the compositor runs: apply() puts the world, the focus
   * buttons and the HUD boxes on their end state once, then the world and the boxes glide from where they were. Nothing
   * runs on the main thread per frame (no layout reads, no style writes, no React render) and `will-change` is on only for
   * the move. The path is sampled from the camera ease, so it is the same path as the pure `poseAt`, and a move that is
   * cut in half starts from the pose the clock says is on screen. Without the Web Animations API, or with reduced
   * motion, or for a jump (`dur` 0), the world snaps to its end pose.
   */
  const glide = ({ from: origin, dur: ms, intro: fly }: { from: RoofPose | null | undefined; dur: number; intro: boolean }) => {
    const world = worldRef.current;
    const live = tweenRef.current;
    const visible = live ? poseAt(live.from, live.to, tweenProgress(performance.now(), live.start, live.dur), live.ease) : poseRef.current;
    // The HUD boxes start from the place they are seen at: their resting place plus what a running glide has moved them
    // by. A box that left the page is forgotten.
    for (const node of [...placedRef.current.keys()]) if (!node.isConnected) placedRef.current.delete(node);
    const before = new Map<HTMLElement, { x: number; y: number }>();
    for (const [node, at] of placedRef.current) {
      const shift = live ? shiftOf(node) : { x: 0, y: 0 };
      before.set(node, { x: at.x + shift.x, y: at.y + shift.y });
    }
    // The fit on screen now (a resize changes it): the keyframes ease from it to the new one with the pose.
    const fitBefore = shownRef.current ? live?.fit ?? paintedFitRef.current : null;
    stopMove();
    const animated = !reducedMotion && ms > 0 && world != null && typeof world.animate === "function";
    const root = rootRef.current;
    const m = root ? measure(root) : null;
    const end = m ? resolvePose(targetRef.current, m) : targetRef.current;
    poseRef.current = end;
    apply();
    if (!animated || world == null) return;
    const start = origin ?? visible;
    const ease = fly ? easeFly : easeCam;
    const steps = Math.min(60, Math.max(8, Math.round(ms / 16)));
    const fitEnd = fitRef.current;
    const frames = Array.from({ length: steps + 1 }, (_, index) => {
      const t = ease(index / steps);
      return { transform: roofTransform(poseAt(start, end, index / steps, ease), fitBefore == null ? fitEnd : fitBefore + (fitEnd - fitBefore) * t) };
    });
    const tween: Tween = { from: start, to: end, start: performance.now(), dur: ms, ease, fit: fitRef.current };
    tweenRef.current = tween;
    world.style.willChange = "transform";
    const run = world.animate(frames, { duration: ms, easing: "linear" });
    const anims = [run];
    // The floating boxes glide the same way (a transform from the old place to 0). One that was not on screen fades in.
    for (const [node, now] of placedRef.current) {
      const old = before.get(node);
      if (!node.isConnected) continue;
      if (!old) {
        if (node.hidden || node.dataset.off === "true") continue;
        anims.push(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.min(ms, 260), easing: "ease-out" }));
        continue;
      }
      const dx = old.x - now.x;
      const dy = old.y - now.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
      const path = Array.from({ length: steps + 1 }, (_, index) => {
        const rest = 1 - ease(index / steps);
        return { transform: `translate(${(dx * rest).toFixed(2)}px, ${(dy * rest).toFixed(2)}px)` };
      });
      anims.push(node.animate(path, { duration: ms, easing: "linear" }));
    }
    animsRef.current = anims;
    run.onfinish = () => {
      if (tweenRef.current !== tween) return;
      stopMove();
      // Renders during the move left the HUD boxes alone: measure them once more at the end.
      apply();
    };
  };
  const move = () => glide({ from, dur, intro });
  refitRef.current = () => {
    if (reducedMotion || typeof worldRef.current?.animate !== "function") return false;
    glide({ from: null, dur: REFIT_MS, intro: false });
    return true;
  };

  // Each commit: a new `rev` starts a move; any other render measures the HUD again (it changes size with the data) unless
  // a move is running.
  useLayoutEffect(() => {
    if (startedRev.current !== rev) {
      startedRev.current = rev;
      move();
      return;
    }
    if (!tweenRef.current) apply();
  });
  useEffect(() => stopMove, [stopMove]);

  // The HUD also measures again when the box changes size.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => apply());
    observer.observe(node);
    return () => observer.disconnect();
  }, [apply]);

  // End of an FX lock: the reducer restores the saved view on the first tick after the time.
  const lockUntil = camera.lock?.untilMs ?? null;
  useEffect(() => {
    // An open-ended lock (a preview lock, an infinite time) has no end to wait for. A timer over 2^31 ms would fire at once.
    if (lockUntil == null || !Number.isFinite(lockUntil)) return;
    const wait = Math.min(2 ** 31 - 1, Math.max(0, lockUntil - performance.now()) + 8);
    const timer = window.setTimeout(() => dispatchCamera({ type: "tick", nowMs: performance.now() }), wait);
    return () => window.clearTimeout(timer);
  }, [lockUntil, dispatchCamera]);

  // ---------- focus ----------
  // The switcher lists the fields as they sit on the roof: the far strip first, each strip left to right.
  const railSeats = useMemo(
    () =>
      layout.slots
        .map((slot) => ({ seat: slot.seat, code: slot.code ?? String(slot.seat + 1), rgb: toneOf(slot.seat).rgb, at: slotsOf[slot.seat] }))
        .sort((a, b) => Number(a.at?.near ?? false) - Number(b.at?.near ?? false) || (a.at?.x ?? 0) - (b.at?.x ?? 0))
        .map(({ seat, code, rgb }) => ({ seat, code, rgb })),
    [layout.slots, slotsOf, toneOf],
  );
  // A close-up needs a free camera: not under an FX lock, and not while an attack is aimed (the aim wants every rival).
  // A click on a field never moves the camera on a wide screen (a misclick would zoom): the corner button, the rail, the dock and the
  // keys do. A phone has no room for the corner buttons: a tap on the field, its name or a plate chip focuses it there.
  const focusFree = !camera.lock && !camera.aiming && controller.aim == null;
  const focusField = (seat: number) => {
    if (!focusFree) return;
    // In close-up a tap on a field never moves the camera, not on the field in view and not on a neighbour that
    // shows at its edge: only the toggle button, the rail, the switcher and the keys do.
    if (camera.mode === "focus") return;
    dispatchCamera({ type: "focus", seat });
  };
  const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (camera.mode === "focus") return;
    const node = event.target instanceof Element ? event.target : null;
    if (!node || node.closest(ACTION_TARGET)) return;
    const seat = Number(node.closest<HTMLElement>("[data-field-hold]")?.dataset.fieldHold ?? node.closest<HTMLElement>("[data-member-seat]")?.dataset.memberSeat);
    if (Number.isInteger(seat) && engine.seats.some((s) => s.seat === seat)) focusField(seat);
  };
  // A double click on a field (its mat, its name, a plate chip) focuses it on a wide screen; a card, a zone or a control keeps its own job.
  const onStageDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const node = event.target instanceof Element ? event.target : null;
    if (!node || node.closest(ACTION_TARGET) || node.closest("[data-uid], [data-zones], [data-pile], [data-hand-seat]")) return;
    const seat = Number(node.closest<HTMLElement>("[data-field-hold]")?.dataset.fieldHold ?? node.closest<HTMLElement>("[data-member-seat]")?.dataset.memberSeat);
    if (Number.isInteger(seat) && engine.seats.some((s) => s.seat === seat)) focusField(seat);
  };
  // Every zone is a full-size button, so most taps on a field land on one. A zone that offers no action (not a legal
  // pick, not selected, no pile to open) hands the tap to the camera instead: the field comes into focus and the click
  // does not also inspect a card. The HUD can still pin the occupied card's peek while focusing. A zone with an
  // action, and any zone while a field is in close-up, act as usual.
  const picking = prompt != null && promptSeat === viewerSeat && !(prompt.kind === "choice" && prompt.context?.type === "action");
  const onStageClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (camera.mode === "focus") return;
    const node = event.target instanceof Element ? event.target : null;
    const zone = node?.closest<HTMLElement>("[data-zones]");
    const hold = zone?.closest<HTMLElement>("[data-field-hold]");
    if (!zone || !hold || zone.dataset.legal === "true" || zone.dataset.selected === "true") return;
    if (zone.dataset.pile === "true" && zone.dataset.occupied === "true") return;
    const seat = Number(hold.dataset.fieldHold);
    if (!Number.isInteger(seat)) return;
    if (camera.lock || camera.aiming || controller.aim != null) return;
    // During a pick prompt (a target, a zone, a card to choose) every tap belongs to the prompt: a zone that is not a
    // target does nothing, it never moves the camera. The open action menu of a main phase is no pick.
    if (picking && legalKeys.size > 0) return;
    if (inspectIdleCards && zone.dataset.occupied === "true") {
      focusField(seat);
      return; // Let the card's click handler pin the HUD peek as the camera focuses.
    }
    event.stopPropagation();
    focusField(seat);
  };

  // A button that unmounts takes the keyboard focus with it. After a focus, the focus moves to Back to overview; after
  // the way back (the button, the Esc key), it returns to the focus button of the field that was in close-up.
  const lastFocusRef = useRef<{ mode: RoofCameraState["mode"]; seat: number | null }>({ mode: camera.mode, seat: camera.focusSeat });
  useEffect(() => {
    const last = lastFocusRef.current;
    lastFocusRef.current = { mode: camera.mode, seat: camera.focusSeat };
    const root = rootRef.current;
    const active = document.activeElement;
    if (!root || (active != null && active !== document.body && root.contains(active))) return;
    if (camera.mode === "focus" && last.mode !== "focus") root.querySelector<HTMLElement>("[data-camera-back]")?.focus();
    else if (camera.mode !== "focus" && last.mode === "focus" && last.seat != null) root.querySelector<HTMLElement>(`[data-field-focus="${last.seat}"]`)?.focus();
  }, [camera.mode, camera.focusSeat]);

  // ---------- fields ----------
  // A facing pair (1A-2A, 1B-2B) draws one band of two Extra Monster Zones between its fields (Master Rule 4 and 5 only; an
  // older core without `sharedExtraWith`, or a pair holding both mirrored cells, keeps the rows of its fields).
  const sharedPairs = useMemo(() => (room.session.masterRule >= 4 ? sharedExtraPairs(engine) : []), [engine, room.session.masterRule]);
  const sharedSeats = useMemo(() => new Set(sharedPairs.flatMap((pair) => pair.map((view) => view.seat))), [sharedPairs]);
  sharedRef.current = sharedPairs.length > 0;
  const relationOf = (seat: number) =>
    spectator ? "other" : seat === viewerSeat ? "self" : teamOfSeat(TAG, seat) === teamOfSeat(TAG, viewerSeat) ? "partner" : "opponent";
  const outOf = (seat: number) => (engine.seats.find((s) => s.seat === seat)?.eliminated ?? false) || loss.lostTeam === teamOfSeat(TAG, seat);
  const fieldHold = (seat: number) => {
    const slot = slotsOf[seat];
    const view = engine.seats.find((s) => s.seat === seat);
    if (!slot || !view) return null;
    const near = slot.near;
    const relation = relationOf(seat);
    const props: SeatFieldProps = {
      engine,
      seat,
      viewerSeat,
      masterRule: room.session.masterRule,
      side: near ? "you" : "opp",
      // `data-side="you"` is the viewer's own field only (e2e own-zone locators); a spectator has none.
      dataSide: relation === "self" ? "you" : relation === "partner" ? "partner" : "opp",
      angleDeg: near ? 0 : 180,
      upright: camera.upright,
      tone: layout.slots.find((s) => s.seat === seat)?.tone ?? "violet",
      density: near ? "full" : "rival",
      hand: "none",
      emz: sharedSeats.has(seat) ? "none" : "own",
      showTally: false,
      usable: relation === "self",
      name: nameOf(seat),
      legalKeys,
      selectedKeys,
      reducedMotion,
      onActivate: controller.onActivate,
      onInspect: controller.onInspect,
      onHoverCard: controller.onHoverCard,
    };
    const transform = near
      ? `translate3d(${slot.x - HALF_W}px, ${slot.y - HALF_H}px, ${ROOF_FIELD_Z}px)`
      : `translate3d(${slot.x}px, ${slot.y}px, ${ROOF_FIELD_Z}px) rotate(180deg) translate(${-HALF_W}px, ${-HALF_H}px)`;
    const focused = camera.mode === "focus" && camera.focusSeat === seat;
    return (
      <div
        key={seat}
        className={styles.fieldHold}
        data-field-hold={seat}
        data-relation={relation}
        data-out={outOf(seat) ? "true" : undefined}
        style={{ width: ROOF_FIELD.width, height: ROOF_FIELD.height, transform }}
      >
        {renderSeatField(props)}
        {!focusFree || isNarrow ? null : (
          // One button per field is the zoom toggle: it zooms in from the overview, and in the close-up on this field it
          // is the way back (same place, same button, the icon and the label change).
          <button
            type="button"
            className={cameraStyles.focusBtn}
            data-field-focus={seat}
            data-focused={focused ? "true" : undefined}
            data-near={near ? "true" : "false"}
            aria-label={focused ? "Back to overview" : `Focus ${nameOf(seat)}'s field`}
            title={focused ? "Back to overview (Esc)" : `Focus ${nameOf(seat)}'s field`}
            onClick={() => (focused ? dispatchCamera({ type: "overview" }) : focusField(seat))}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={focused ? "M9 4v5H4M15 4v5h5M4 15h5v5M20 15h-5v5" : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"} />
            </svg>
          </button>
        )}
      </div>
    );
  };

  // ---------- plates ----------
  const outSeats = useMemo(() => new Set(engine.seats.filter((s) => s.eliminated).map((s) => s.seat)), [engine.seats]);
  const plate = (team: number, near: boolean) => {
    const members: PlateMember[] = seatsOfTeam(TAG, team).map((seat, i) => {
      const view = engine.seats.find((s) => s.seat === seat);
      const tone = toneOf(seat);
      const pickIndex = pickSeats.indexOf(seat);
      const response = window_?.team === team ? (window_.members.find((m) => m.seat === seat)?.state ?? null) : null;
      return {
        seat,
        name: nameOf(seat),
        code: layout.slots.find((s) => s.seat === seat)?.code ?? `${team + 1}${i === 0 ? "A" : "B"}`,
        rgb: tone.rgb,
        ink: tone.ink,
        you: !replay && seat === viewerSeat,
        hand: view?.hand.length ?? 0,
        deck: view?.deckCount ?? 0,
        clockMs: room.clock?.remainingMs[seat] ?? null,
        clockRuns: seat === (promptSeat ?? engine.turnSeat),
        now: seat === engine.turnSeat,
        response,
        pickable: pickIndex >= 0,
        hotkey: pickIndex >= 0 ? pickIndex + 1 : null,
        locked: aimedSeat === seat,
      };
    });
    const out = loss.lostTeam === team;
    return (
      <TeamLpPlate
        teamName={teamName(team)}
        glyph={teamGlyph(anchorTeam, team)}
        near={near}
        lp={teamLp(engine, team)}
        startLp={startLp}
        state={plateState({ out, choosing: window_?.team === team, onTurn: teamOfSeat(TAG, engine.turnSeat) === team })}
        cracked={out && loss.cracking}
        damage={lastTeamDamage(engine, team)?.amount ?? null}
        members={members}
        hang={!near}
        reducedMotion={reducedMotion}
        onPick={onPick}
        plateRef={near ? (node) => { ownPlateRef.current = node; } : (node) => { farPlateRef.current = node; }}
      />
    );
  };

  const stops = batonOrder(engine.turnSeat);
  const rootStyle = {
    ["--hx" as string]: "50%",
  } as CSSProperties;

  return (
    <div
      className={`${styles.stage} ${duelFontClasses}`}
      style={rootStyle}
      data-table-stage="tag"
      data-tag-stage
      data-chain-room={phone && chainSize ? `6,4,${chainSize.width},${chainSize.height}` : undefined}
      data-battle={battle ? "true" : "false"}
      data-spectator={spectator ? "true" : undefined}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-camera-mode={camera.mode}
      data-camera-seat={camera.mode === "focus" && camera.focusSeat != null ? camera.focusSeat : undefined}
      onClick={isNarrow ? onStageClick : undefined}
      onClickCapture={isNarrow ? onStageClickCapture : undefined}
      onDoubleClick={isNarrow ? undefined : onStageDoubleClick}
      data-camera-locked={camera.lock ? camera.lock.reason : undefined}
    >
      {fx != null ? (
        <ChainRoomContext.Provider value={phone ? setChainSize : null}>
          <div className={styles.slot}>{fx}</div>
        </ChainRoomContext.Provider>
      ) : null}
      <div
        ref={rootRef}
        className={styles.viewport}
        data-tag-viewport
        data-strip-room={stripRoom ? "true" : undefined}
        data-strip-pending={stripPending ? "true" : undefined}
        style={{ top: chainInset, ...(stripRoom ? ({ ["--sr-x" as string]: `${stripRoom.x}px`, ["--sr-y" as string]: `${stripRoom.y}px`, ["--sr-w" as string]: `${stripRoom.width}px`, ["--sr-h" as string]: `${stripRoom.height}px`, ["--sr-card" as string]: `${stripRoom.card}px` } as CSSProperties) : {}) }}
      >
        <div className={styles.persp}>
          <div className={styles.sky} aria-hidden="true">
            <div className={styles.stars} />
            <span className={styles.beam} data-n="1" style={{ left: "12%" }} />
            <span className={styles.beam} data-n="2" style={{ left: "58%" }} />
            <span className={styles.beam} data-n="3" style={{ left: "84%" }} />
          </div>
          <div ref={worldRef} className={styles.world} data-roof-world>
            <RoofDecor />
            <Baton
              stops={stops}
              anchorSeat={anchor}
              nameOf={nameOf}
              rgbOf={(seat) => toneOf(seat).rgb}
              out={outSeats}
              holderRef={(node) => { pillsRef.current = node; }}
            />
            <TeamStrip near glyph={teamGlyph(anchorTeam, anchorTeam)} teamName={teamName(anchorTeam)} out={loss.lostTeam === anchorTeam} />
            <TeamStrip near={false} glyph={teamGlyph(anchorTeam, 1 - anchorTeam)} teamName={teamName(1 - anchorTeam)} out={loss.lostTeam === 1 - anchorTeam} />
            {engine.seats.map((s) => fieldHold(s.seat))}
            {sharedPairs.map(([first, second]) => {
              const firstAt = slotsOf[first.seat];
              const secondAt = slotsOf[second.seat];
              if (!firstAt || !secondAt || firstAt.near === secondAt.near) return null;
              const [nearView, farView] = firstAt.near ? [first, second] : [second, first];
              return (
                <SharedExtraBand
                  key={`band-${first.seat}-${second.seat}`}
                  near={nearView}
                  far={farView}
                  x={(firstAt.near ? firstAt : secondAt).x}
                  upright={camera.upright}
                  nameOf={nameOf}
                  relationOf={relationOf}
                  outOf={outOf}
                  legalKeys={legalKeys}
                  selectedKeys={selectedKeys}
                  onActivate={controller.onActivate}
                  onHoverCard={controller.onHoverCard}
                />
              );
            })}
            <div ref={padRef} className={styles.anc} style={{ transform: "translate3d(0px, 0px, 2px)" }} />
            <div ref={farRef} className={styles.anc} style={{ transform: `translate3d(0px, ${FAR_ANCHOR_Y}px, 2px)` }} />
          </div>
        </div>
        <div className={styles.fog} aria-hidden="true" />
        <div className={styles.wash} aria-hidden="true" />
        {plate(anchorTeam, true)}
        {plate(1 - anchorTeam, false)}
        {phaseHub != null ? <div ref={phaseHubRef} className={styles.phaseHub} hidden={camera.mode === "focus"} data-phase-hub-slot>{phaseHub}</div> : null}
        <HelipadHub
          chain={engine.chain}
          anchorSeat={anchor}
          nameOf={nameOf}
          toneOf={toneOf}
          response={window_}
          teamLabel={teamLabel}
          pick={pickSeats.length > 0 ? { seats: pickSeats, onPick, title: prompt?.title ?? "Choose a rival" } : null}
          hubRef={(node) => { hubRef.current = node; }}
        />
        {!spectator && viewerView ? (
          <OwnHand
              seat={viewerView.seat}
              cards={viewerView.hand}
              legalKeys={legalKeys}
              selectedKeys={selectedKeys}
              onActivate={controller.onActivate}
              onInspect={controller.onInspect}
              onHoverCard={controller.onHoverCard}
              reducedMotion={reducedMotion}
              label={`${nameOf(viewerView.seat)} hand`}
            />
        ) : null}
        {!spectator && partnerView ? (
          <PartnerHand
            seat={partnerView.seat}
            cards={partnerView.hand}
            legalKeys={legalKeys}
            onInspect={controller.onInspect}
            onHoverCard={controller.onHoverCard}
            label={`${nameOf(partnerView.seat)} hand`}
            partnerName={nameOf(partnerView.seat).split(" ")[0]}
            teamOnly={!replay}
          />
        ) : null}
        {camera.mode === "focus" && !camera.lock ? (
          <CameraRail
            focusSeat={camera.focusSeat}
            seats={railSeats}
            nameOf={nameOf}
            out={outSeats}
            dispatch={dispatchCamera}
          />
        ) : null}
        {camera.lock ? (
          <div className={styles.lockchip} data-lock-chip role="status">
            Camera locked &middot; {lockLabel(camera.lock.reason)}
          </div>
        ) : null}
        {/* PromptCenter measures its parent as the board (card scope, bar place): keep it in the fitted viewport. */}
        {promptCenter}
        {overlay != null ? <div className={styles.slot}>{overlay}</div> : null}
      </div>
    </div>
  );
}
