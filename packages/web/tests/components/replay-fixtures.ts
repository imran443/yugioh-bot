import {
  defaultDuelSettings,
  type DuelCard,
  type DuelEngineView,
  type DuelFormat,
  type DuelReplay,
  type DuelReplayV2,
  type DuelSeatView,
  type DuelSession,
  type ReplayFrameV2,
  type ReplayVisibility,
} from "@yugidraft/shared/duels";

/** Typed v2 fixtures. Server code for the v2 contract is built apart from the client, so tests carry the shape. */

const SEAT_COUNT: Record<DuelFormat, number> = { "1v1": 2, tag: 4, ffa3: 3, ffa4: 4 };
const NAMES = ["Ada", "Bo", "Cy", "Di"];

export function card(code: number | undefined, seat = 0): DuelCard {
  return { controller: seat, location: 2, sequence: 0, position: 1, code, name: code ? `Card ${code}` : undefined };
}

export function seatView(seat: number, hand: DuelCard[] = []): DuelSeatView {
  return {
    seat, lp: 8000, hand, deckCount: 30, extraCount: 0, extra: [],
    monsters: [null, null, null, null, null], spells: [null, null, null, null, null, null],
    graveyard: [], banished: [], team: seat,
  };
}

export function session(format: DuelFormat = "1v1", over: Partial<DuelSession> = {}): DuelSession {
  const count = SEAT_COUNT[format];
  return {
    id: 1, slug: "game-1", kind: "play", name: "Replay table", guildId: "guild-1", organizerPlayerId: 1,
    mode: "normal", format, masterRule: 5, status: "completed",
    settings: defaultDuelSettings("normal", format),
    seats: Array.from({ length: count }, (_, seat) => ({
      seat, playerId: seat + 1, displayName: NAMES[seat]!, ready: true, isBot: false,
    })),
    createdAt: "2026-10-10T00:00:00.000Z", endedAt: "2026-10-10T00:10:00.000Z", archivedAt: null,
    winnerPlayerId: null, winnerSeat: null, resultReason: null,
    ...over,
  };
}

export interface FrameOptions {
  step: number;
  format?: DuelFormat;
  /** Hand codes per seat. Omit a seat for an empty hand; use `undefined` entries for hidden cards. */
  hands?: Record<number, Array<number | undefined>>;
  log?: number[];
  events?: DuelEngineView["events"];
  actorSeat?: number | null;
  kind?: ReplayFrameV2["kind"];
  cursor?: string | null;
  frameId?: string;
  result?: DuelEngineView["result"];
}

export function frame(options: FrameOptions): ReplayFrameV2 {
  const { step, format = "1v1", hands = {}, log = [], events = [], result = null } = options;
  const count = SEAT_COUNT[format];
  const view = {
    revision: step, format, turn: 1, turnSeat: 0, phase: "main1",
    seats: Array.from({ length: count }, (_, seat) => seatView(seat, (hands[seat] ?? []).map((code) => card(code, seat)))),
    prompt: null, prioritySeat: null, chain: [], events, log: log.map((id) => ({ id, text: `line ${id}` })), result,
  } satisfies ReplayFrameV2["view"];
  const kind = options.kind ?? (step === 0 ? "opening" : "engine");
  const base = {
    frameId: options.frameId ?? `f${step}`,
    step,
    actorSeat: options.actorSeat === undefined ? (step === 0 ? null : 0) : options.actorSeat,
    view,
  };
  return kind === "result" ? { ...base, kind, cursor: null } : { ...base, kind, cursor: options.cursor ?? (step === 0 ? null : `c${step}`) };
}

export function replayV2(options: {
  visibility?: ReplayVisibility;
  format?: DuelFormat;
  frames?: ReplayFrameV2[];
  mySeat?: number | null;
  sessionOver?: Partial<DuelSession>;
} = {}): DuelReplayV2 {
  const { visibility = "mine", format = "1v1", mySeat = 0 } = options;
  const frames = options.frames ?? [
    frame({ step: 0, format, hands: { 0: [100, 101] } }),
    frame({ step: 1, format, hands: { 0: [100, 101] }, log: [1] }),
    frame({ step: 2, format, hands: { 0: [100] }, log: [2], actorSeat: 1 }),
    frame({ step: 3, format, kind: "result", actorSeat: null, result: { winnerSeat: 0, reason: "Surrender" } }),
  ];
  return {
    version: 2,
    sourceVersion: "src-1",
    visibility,
    session: session(format, options.sessionOver),
    role: mySeat == null ? "spectator" : "player",
    mySeat,
    dataSeat: visibility === "public" ? null : mySeat,
    frames,
  };
}

/** The answer of a server that has no version 2 yet. */
export function replayV1(format: DuelFormat = "1v1", mySeat: number | null = 0): DuelReplay {
  const v2 = replayV2({ format, mySeat });
  return {
    session: v2.session,
    role: v2.role,
    mySeat,
    frames: v2.frames.map((entry) => ({ step: entry.step, actorSeat: entry.actorSeat, view: entry.view })),
  };
}
