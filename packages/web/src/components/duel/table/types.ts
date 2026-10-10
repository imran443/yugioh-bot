import type { ReactNode } from "react";
import type { DuelAnswer, DuelEngineView, DuelEvent, DuelFormat, DuelMasterRule, DuelPrompt, DuelRoom } from "@yugidraft/shared/duels";
import type { BattleAim } from "../battle-fx";
import type { PromptDraft } from "../prompts";
import type { InspectTarget } from "../inspector";
import type { DuelActivateHandler, DuelHoverHandler } from "../field";
import type { SeatPick, SeatRelation } from "../multi-seat";
import type { AttackAim } from "./attack-aim";
export type { BattleAim, PromptDraft, InspectTarget, DuelActivateHandler, DuelHoverHandler, SeatPick, SeatRelation };

/**
 * The contract of the multiplayer table UI (3-way, 4-way, 2v2 tag). The scaffold wrote it; after that only the
 * 3w-* steps may change it, and only by adding. See docs/architecture.md.
 */

export type TableFormat = Exclude<DuelFormat, "1v1">; // "tag" | "ffa3" | "ffa4"
export type SeatTone = "violet" | "ice" | "verdant" | "rose";
export type Compass = "S" | "W" | "N" | "E";
export const SEAT_TONE_HEX: Readonly<Record<SeatTone, { main: string; ink: string }>> = {
  violet: { main: "#9b7eff", ink: "#c6b6ff" },
  ice: { main: "#5cb8f5", ink: "#a9dcfb" },
  verdant: { main: "#8fd36b", ink: "#c4ecad" },
  rose: { main: "#f08cc4", ink: "#fbc8e4" },
};

export interface SeatSlot {
  seat: number;
  relation: SeatRelation;
  tone: SeatTone;
  compass: Compass;
  baseAngleDeg: number; // true table angle; 0 = viewer side, clockwise
  team: number | null; // tag: seat % 2; ffa: null
  code: string | null; // tag: "1A" | "2A" | "1B" | "2B" (tagSeatCode); ffa: null
  turnOrder: number; // 0-based order in the turn ring
}
/** How the seats still in the duel are placed: the 4-way places, the 3-way places, or a face to face pair. */
export type Arrangement = "ffa4" | "ffa3" | "duo";
export interface TableLayout {
  format: TableFormat;
  /** Set by `aliveLayout` when seats are out. Absent: the places follow the format. */
  arrangement?: Arrangement;
  viewerSeat: number | null;
  anchorSeat: number; // anchor = viewer, or 0 for spectator
  slots: readonly SeatSlot[]; // viewer/anchor first, then placementOrder
  stage: { width: 1100; height: 860 };
}
export interface SeatPose {
  seat: number;
  x: number;
  y: number; // field centre in stage px
  scale: number;
  rotateDeg: number; // effective rotation (text counter-rotates when upright)
  tiltDeg?: number; // perspective tilt of a far field (rotateX), default 0
  /** Width of the field box at scale 1 (default SEAT_BOX.width): a wide 3-way table gives every zone column a card height, for full-size Defense cards. */
  width?: number;
  slot?: PoseSlot; // named place of the pose (3-way and 4-way): the ring, the holo panels and the docks read it
  z: number;
  docked: boolean;
  compact: boolean;
  hidden: boolean;
}

/** Named places of a camera mode. `vN` and `oN` are the far (north) places of a 4-way table. */
export type PoseSlot = "home" | "vL" | "vN" | "vR" | "focus" | "dockL" | "dockR" | "oHome" | "oL" | "oN" | "oR";

export type CameraMode = "home" | "focus" | "look" | "overview" | "fly";
export type CameraLockReason = "chain" | "battle" | "direct" | "destroy" | "elimination";
export interface FlyPose {
  yawDeg: number;
  tiltDeg: number;
  zoom: number;
  targetSeat: number | null;
  free?: boolean; // the player orbited or zoomed: the pose is no longer the preset
}
export interface CameraState {
  mode: CameraMode;
  focusSeat: number | null;
  lookSeat: number | null;
  upright: boolean;
  compact: "auto" | "on" | "off";
  fly: FlyPose;
  lock: { reason: CameraLockReason; untilMs: number } | null; // a preview switch only: the duel never sets it
  flyIn?: boolean; // Overview is the fly-in plaza (default true); false is the flat triangle
}
export type CameraAction =
  | { type: "home" }
  | { type: "overview" }
  | { type: "focus"; seat: number }
  /** A click on a field of a 3-way table: that field is shown larger; a second click on it goes home. */
  | { type: "enlarge"; seat: number }
  | { type: "focusStep"; dir: 1 | -1 }
  | { type: "look"; seat: number | null }
  | { type: "toggleFly" }
  | { type: "flyTo"; seat: number }
  | { type: "orbit"; dYawDeg: number; dTiltDeg: number }
  | { type: "zoom"; factor: number }
  | { type: "toggleUpright" }
  | { type: "toggleCompact" }
  | { type: "lock"; reason: CameraLockReason; nowMs: number; ms: number }
  | { type: "tick"; nowMs: number };

export interface TargetChoice {
  seat: number;
  zones: readonly string[];
  direct: boolean; // direct = option to hit that seat's LP
  optionIds: readonly string[];
  label: string;
}
export type SeatStatus = "active" | "turn" | "choosing" | "next" | "leaving" | "eliminated";

export interface SeatFieldProps {
  engine: DuelEngineView;
  seat: number;
  viewerSeat: number | null;
  masterRule: DuelMasterRule;
  side: "you" | "opp";
  /** Value of the `data-side` attribute when it must differ from `side` (Tag: "partner"). Default: `side`. */
  dataSide?: "you" | "opp" | "partner";
  angleDeg: number;
  upright: boolean;
  tone: SeatTone;
  density: "full" | "rival" | "compact";
  hand: "face" | "backs" | "none";
  /**
   * Extra Monster Zones of the seat: `own` (two of its own), `pair` (the grid: this seat draws the row it shares with the
   * facing seat `pair.other`), `none` (the grid: the facing seat draws it). `pair.left` and `pair.right` are the room left
   * for the life boxes, in card heights; `pair.gap` is the space between the two EMZ (columns 2 and 4), in card heights; `pair.joined` = the facing field is drawn, so the two mats meet at this row.
   */
  emz: "own" | "shared-bottom" | "shared-top" | "pair" | "none";
  /** `framed`: the stage draws one frame round the pair (see grid-stage.tsx `pairFrameRect`), so this field draws no mat. */
  pair?: { other: number | null; left: number; right: number; gap: number; joined: boolean; framed?: boolean };
  showTally: boolean; // false when a holo LP panel owns data-lp-seat
  usable: boolean; // false: legal ring only, no USE glow (partner, spectator)
  name?: string; // display name of the seat (labels and aria text); default "Player <n>"
  scale?: number; // drawn scale of the field (text grows when it is small); default 1
  legalKeys: Set<string>;
  selectedKeys: Set<string>;
  reducedMotion: boolean;
  onActivate: DuelActivateHandler;
  onInspect: (target: InspectTarget) => void;
  onHoverCard?: DuelHoverHandler;
}
export type SeatFieldRenderer = (props: SeatFieldProps) => ReactNode;

export interface TableController {
  room: DuelRoom;
  engine: DuelEngineView;
  viewerSeat: number | null;
  nameOf: (seat: number) => string;
  prompt: DuelPrompt | null;
  promptSeat: number | null;
  canAct: boolean;
  busy: boolean;
  /** Busy because the duel server is unreachable (not just working or catching up): prompts say Reconnecting. */
  offline?: boolean;
  revealed: boolean;
  draft: PromptDraft;
  legalKeys: Set<string>;
  selectedKeys: Set<string>;
  aim: BattleAim | null;
  seatPick: SeatPick | null;
  reducedMotion: boolean;
  onAnswer: (answer: DuelAnswer) => void;
  onActivate: DuelActivateHandler;
  onInspect: (target: InspectTarget) => void;
  onHoverCard?: DuelHoverHandler;
  onAim?: (to: BattleAim["to"] | null) => void; // hover/lock an attack target
  /** An attacker was clicked and its target is not chosen yet: the aim step that comes before the attack is sent. */
  attackAim?: AttackAim | null;
}
export interface TableStageProps {
  controller: TableController;
  layout: TableLayout;
  camera: CameraState;
  dispatchCamera: (action: CameraAction) => void;
  renderSeatField: SeatFieldRenderer; // SeatField from field.tsx; a render prop so tag never imports table code
  fx?: ReactNode;
  promptCenter?: ReactNode;
  overlay?: ReactNode; // slots: FxBoundary tree, PromptCenter, menus
  /** Phase hub card (3-way and 4-way tables): drawn flat on the canvas beside the turn ring, at `hubPose`. */
  hub?: ReactNode;
  masterChip?: ReactNode; // hangs under the viewer's own holo LP panel (the Deck Master chip of a domain duel)
  /** Seats of the legal targets of the attack being aimed (before it is sent, or at the core's own target step). Empty when none. */
  aimSeats?: readonly number[];
}
export type TagStageProps = TableStageProps;
export type FxLockRule = (event: DuelEvent) => { reason: CameraLockReason; ms: number } | null;

/**
 * Replay mode of the shared shells (`TableShell`, `TagShell`). Pass it as `replay` and the shell becomes a read-only
 * viewer of one engine frame. Rules the shell enforces itself, whatever controller it is given:
 * - No prompt, no legal or selected keys, no seat pick, no aim and an answer callback that does nothing, so it can never
 *   send an action (the controller is cleaned by `readOnlyReplayController`).
 * - No clock, series banner, result screen, next-game action, Surrender or connection prompt. `headerTools`,
 *   `settingsTools`, `connection`, `chainMode`, `pickContinuation` and `actions` are ignored; the header says "Replay".
 * - The camera, card inspection, piles and the log stay.
 * - The shell reads "completed" from the frame's own result, not from the saved duel status, so a chain, a prompt line
 *   or a phase of a middle frame is not drawn as a finished duel.
 */
export interface ReplayShellMode {
  /** The transport bar (first, previous, play, next, last, slider, speed). It takes the place of the live prompt dock. */
  transport: ReactNode;
  /**
   * Changes on every seek, rewind, camera seat change or card visibility change, and stays the same while playing
   * forward. A new value restarts the table clean: loss order, running effects, pending camera locks, open menus and
   * the effect schedule are dropped. The camera the viewer chose and the open panel stay.
   */
  resetKey: string | number;
  /** Extra header controls for the replay (for example Jump in). Shown in place of `headerTools`. */
  tools?: ReactNode;
}
