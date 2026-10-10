import { describe, expect, expectTypeOf, it } from "vitest";
import {
  defaultDuelSettings,
  isEngineIdentity,
  isDuelKind,
  isDuelKindSetup,
  isReplayErrorCode,
  isReplayFork,
  isReplayForkRequest,
  isReplayForkSetup,
  isReplaySeed,
  REPLAY_ERROR_CODES,
  REPLAY_ERROR_HTTP_STATUSES,
  REPLAY_FORK_REQUEST_ID_MAX_LENGTH,
  REPLAY_SOURCE_SLUG_MAX_LENGTH,
  REPLAY_FRAME_ID_MAX_LENGTH,
  REPLAY_SOURCE_DISPLAY_NAME_MAX_LENGTH,
  sameEngineIdentity,
  seatCountFor,
  toOrdinaryReplayView,
  type DuelCommand,
  type DuelFormat,
  type DuelEngineView,
  type DuelReplay,
  type DuelReplayV2,
  type DuelSession,
  type EngineIdentity,
  type ForkOrigin,
  type ReplayForkControl,
  type ReplayForkRequest,
  type ReplayForkResult,
  type ReplayForkSetup,
  type ReplayErrorResponse,
  type ReplayFrameV2,
  type ReplayJournalEntry,
  type ReplaySeed,
  type ReplaySource,
} from "../../src/duels/index.js";

function origin(count: number): ForkOrigin {
  return {
    sourceSlug: "source-game",
    sourceVersion: "source-v1",
    frameId: "frame-2",
    step: 2,
    prefixCount: 7,
    prefixHash: "a".repeat(64),
    sourceSeats: Array.from({ length: count }, (_, seat) => ({ seat, displayName: `Seat ${seat}` })),
  };
}

function forkSetup(count = 2): ReplayForkSetup {
  return { ownerUserId: 101, control: "all-manual", origin: origin(count) };
}

function engineIdentity(): EngineIdentity {
  return {
    version: 1, coreFamily: "multi", mode: "domain", wasmHash: "a".repeat(64),
    wrapperVersion: "0.1.2", wrapperHash: "b".repeat(64), protocolVersion: "1",
    cardDatabaseHash: "c".repeat(64), cardRemapsHash: "d".repeat(64), cardScriptsHash: "e".repeat(64),
    domainScriptHash: "f".repeat(64), multiOverlayHash: "0".repeat(64), hostRuleVersion: "1",
  };
}

function session(format: DuelFormat): DuelSession {
  return {
    id: 1, slug: "source-game", kind: "play", name: "Source", guildId: "test-guild",
    organizerPlayerId: 9, mode: "normal", format, masterRule: 5, status: "completed",
    settings: defaultDuelSettings("normal"),
    seats: Array.from({ length: seatCountFor(format) }, (_, seat) => ({
      seat, playerId: 9 + seat, displayName: `Seat ${seat}`, ready: true, isBot: false,
    })),
    createdAt: "2026-10-10T00:00:00Z", endedAt: "2026-10-10T01:00:00Z", archivedAt: null,
    winnerPlayerId: null, winnerSeat: null, resultReason: "Draw",
  };
}

describe("replay and fork contracts", () => {
  it.each(["1v1", "ffa3", "tag", "ffa4"] as const)("supports %s without exposing the source journal", (format) => {
    const sourceSession = session(format);
    const opening: ReplayFrameV2 = {
      frameId: "frame-0", step: 0, kind: "opening", actorSeat: null, cursor: "opaque-checkpoint",
      view: {
        revision: 1, format, turn: 1, turnSeat: 0, phase: "main1",
        seats: sourceSession.seats.map(({ seat }) => ({
          seat, lp: 8000, hand: [], deckCount: 35, extraCount: 0, extra: [],
          monsters: [], spells: [], graveyard: [], banished: [],
        })),
        prompt: null, prioritySeat: null, chain: [], events: [], log: [], result: null,
      },
    };
    const replay: DuelReplayV2 = {
      version: 2, sourceVersion: "source-v1", visibility: "public", session: sourceSession, role: "spectator",
      mySeat: null, dataSeat: null, frames: [opening],
    };
    expect(replay.frames[0]!.view.seats).toHaveLength(seatCountFor(format));
    for (const key of ["capabilities", "prefixCount", "prefixHash", "commands", "seed", "decks", "setup"]) {
      expect(replay).not.toHaveProperty(key);
    }
    for (const key of ["seq", "prefixCount", "prefixHash", "promptId", "options"]) {
      expect(opening).not.toHaveProperty(key);
    }
    expect(opening.view.prompt).toBeNull();
    expect(opening.view).not.toHaveProperty("chainMode");
    const legacy: DuelReplay = {
      session: sourceSession, role: "spectator", mySeat: null,
      frames: [{ step: opening.step, actorSeat: null, view: opening.view }],
    };
    expect(legacy).not.toHaveProperty("version");
    expectTypeOf<ReplayFrameV2["view"]["prompt"]>().toEqualTypeOf<null>();
    expectTypeOf<ReplayFrameV2["view"]["prioritySeat"]>().toEqualTypeOf<null>();
    expectTypeOf<Extract<keyof DuelReplayV2, "seed" | "decks" | "setup" | "commands" | "prefixCount">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof ReplayFrameV2, "seq" | "prefixCount" | "prefixHash" | "promptId" | "options">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<ReplayFrameV2, { kind: "result" }>["cursor"]>().toEqualTypeOf<null>();
  });

  it("keeps identity seat 0 when the creator acts as another seat", () => {
    const control: ReplayForkControl = {
      identitySeat: 0, actingSeat: 3, manualSeats: [0, 1, 2, 3],
      origin: { sourceSlug: "source-game", sourceFrameId: "frame-2", sourceStep: 2, sourceSeats: origin(4).sourceSeats },
      revealHands: true, chainModes: { 0: "always", 1: "always", 2: "always", 3: "always" },
    };
    const result: ReplayForkResult = {
      slug: "new-fork", sourceFrameId: "frame-2", initialSeat: 3,
      room: {
        session: { ...session("ffa4"), slug: "new-fork", kind: "replay-fork", status: "active" },
        role: "player", mySeat: 0, myDeck: null, engine: null, clock: null, metadataOnly: false, fork: control,
      },
    };
    expect(result.room.mySeat).toBe(0);
    expect(result.room.fork?.actingSeat).toBe(3);
    expect(result.room.fork?.origin.sourceStep).toBe(2);
    expect(result.room.fork?.revealHands).toBe(true);
    expect(result.room.fork?.chainModes[3]).toBe("always");
    expectTypeOf<Extract<keyof ReplayForkControl["origin"], "prefixCount" | "prefixHash" | "sourceVersion" | "ownerUserId">>().toEqualTypeOf<never>();
    expectTypeOf<ReplayForkControl["identitySeat"]>().toEqualTypeOf<0>();
  });

  it("keeps complete engine identity and ordered input on the private source", () => {
    const identity = engineIdentity();
    const entry: ReplayJournalEntry = { storedSeq: 17, seat: 3, command: { promptId: "chain-mode:off", revision: 4, answer: {} } };
    const source: ReplaySource = {
      session: { ...session("ffa4"), mode: "domain" }, decks: Array.from({ length: 4 }, () => ({ main: [], extra: [], side: [] })),
      seed: ["1", "2", "3", "4"], bundleVersion: "bundle-v1", engineIdentity: identity,
      setup: { firstTurnDraw: true, scriptErrorMode: "strict" }, commands: [entry],
    };
    expect(source.commands[0]?.storedSeq).toBe(17);
    expect(source.engineIdentity).toEqual(identity);
    expectTypeOf<Extract<keyof NonNullable<ReplaySource["setup"]>, "engineIdentity" | "replayFork">>().toEqualTypeOf<never>();
    expectTypeOf<ReplaySeed>().toEqualTypeOf<[string, string, string, string]>();
    expectTypeOf<ReplayJournalEntry["command"]>().toEqualTypeOf<DuelCommand>();
  });

  it("echoes the privileged request for an owner with no source seat", () => {
    const replay: DuelReplayV2 = {
      version: 2, sourceVersion: "source-v1", visibility: "public", reveal: true,
      session: session("ffa4"), role: "spectator", mySeat: null, dataSeat: 3, frames: [],
      capabilities: { canFork: true, privateSeats: [0, 1, 2, 3] },
    };
    expect(replay).toMatchObject({ visibility: "public", reveal: true, role: "spectator", mySeat: null });
  });

  it("removes live response data from a real projection without changing card or delta data", () => {
    const view: DuelEngineView = {
      revision: 4, turn: 1, turnSeat: 0, phase: "main1", seats: [], chain: [],
      prompt: { id: "private-prompt", seat: 0, kind: "choice", title: "Main", options: [{ id: "private-option", label: "Pass" }] },
      prioritySeat: 0, chainMode: "always", events: [], log: [{ id: 1, text: "Perspective log" }], result: null,
    };
    const ordinary = toOrdinaryReplayView(view);
    expect(ordinary).toEqual({ ...view, prompt: null, prioritySeat: null, chainMode: undefined });
    expect(ordinary).not.toHaveProperty("chainMode");
    expect(JSON.stringify(ordinary)).not.toMatch(/private-prompt|private-option|chainMode/);
    expect(ordinary.seats).toBe(view.seats);
    expect(ordinary.log).toBe(view.log);
    expect(ordinary.events).toBe(view.events);
    expect(view.prompt?.id).toBe("private-prompt");
    expect(view.chainMode).toBe("always");
    expect(view.prioritySeat).toBe(0);
  });
});

describe("engine identity and seed validation", () => {
  it.each(["legacy", "pinned", "multi"] as const)("checks resource null rules for the %s core in both modes", (coreFamily) => {
    for (const mode of ["normal", "domain"] as const) {
      const identity = { ...engineIdentity(), coreFamily, mode,
        domainScriptHash: mode === "normal" ? null : "f".repeat(64),
        multiOverlayHash: coreFamily === "multi" ? "0".repeat(64) : null,
      };
      expect(isEngineIdentity(identity)).toBe(true);
      expect(isEngineIdentity({ ...identity, cardRemapsHash: null })).toBe(true);
      expect(isEngineIdentity({ ...identity, domainScriptHash: identity.domainScriptHash === null ? "f".repeat(64) : null })).toBe(false);
      expect(isEngineIdentity({ ...identity, multiOverlayHash: identity.multiOverlayHash === null ? "0".repeat(64) : null })).toBe(false);
    }
  });

  it("requires all identity fields, the supported version, core family and mode", () => {
    for (const value of [null, [], {}, { ...engineIdentity(), version: 2 }, { ...engineIdentity(), version: "1" },
      { ...engineIdentity(), coreFamily: "unknown" }, { ...engineIdentity(), mode: "unknown" },
      { ...engineIdentity(), path: "/fixture/core" }]) expect(isEngineIdentity(value)).toBe(false);
    for (const key of Object.keys(engineIdentity())) {
      const value = { ...engineIdentity() } as Record<string, unknown>;
      delete value[key];
      expect(isEngineIdentity(value)).toBe(false);
    }
    for (const key of ["wrapperVersion", "protocolVersion", "hostRuleVersion"]) {
      for (const value of [undefined, null, "", " ", 1]) expect(isEngineIdentity({ ...engineIdentity(), [key]: value })).toBe(false);
    }
  });

  it.each(["wasmHash", "wrapperHash", "cardDatabaseHash", "cardRemapsHash", "cardScriptsHash", "domainScriptHash", "multiOverlayHash"])("checks lowercase SHA-256 for %s", (key) => {
    for (const value of [undefined, 1, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
      expect(isEngineIdentity({ ...engineIdentity(), [key]: value })).toBe(false);
    }
  });

  it("compares all identity fields without depending on object key order", () => {
    const identity = engineIdentity();
    const reordered = Object.fromEntries(Object.entries(identity).reverse()) as unknown as EngineIdentity;
    expect(sameEngineIdentity(identity, reordered)).toBe(true);
    for (const key of Object.keys(identity) as Array<keyof EngineIdentity>) {
      const changed = { ...identity, [key]: typeof identity[key] === "number" ? 2 : "changed" } as EngineIdentity;
      expect(sameEngineIdentity(identity, changed)).toBe(false);
    }
    expect(sameEngineIdentity({ ...identity, cardRemapsHash: null }, { ...identity, cardRemapsHash: null })).toBe(true);
    expect(sameEngineIdentity(identity, { ...identity, cardRemapsHash: null })).toBe(false);
  });

  it("accepts four original nonzero uint64 decimal seed words", () => {
    expect(isReplaySeed(["1", "2", "3", "18446744073709551615"])).toBe(true);
  });

  it("rejects malformed, zero, out-of-range and noncanonical seed words", () => {
    for (const value of [null, {}, [], ["1", "2", "3"], ["1", "2", "3", "4", "5"], new Array(4)]) {
      expect(isReplaySeed(value)).toBe(false);
    }
    for (const word of [undefined, null, 1, 1n, "", "0", "00", "01", "-1", "+1", "1.0", "1e2", "0x1", " 1", "1\n",
      "18446744073709551616", "9".repeat(1000)]) {
      for (let index = 0; index < 4; index++) {
        const seed: unknown[] = ["1", "2", "3", "4"];
        seed[index] = word;
        expect(isReplaySeed(seed)).toBe(false);
      }
    }
  });
});

describe("duel kind and private fork setup validation", () => {
  it("uses only the explicit duel kind as the fork mark", () => {
    expect(isDuelKind("play")).toBe(true);
    expect(isDuelKind("replay-fork")).toBe(true);
    for (const value of [undefined, null, "sandbox", "", 1]) expect(isDuelKind(value)).toBe(false);
    expect(isReplayFork({ kind: "replay-fork" })).toBe(true);
    expect(isReplayFork({ kind: "play" })).toBe(false);
    expect(isReplayFork({ kind: "unknown" })).toBe(false);
  });

  it.each([2, 3, 4])("accepts an ordered %i-seat origin", (count) => {
    expect(isReplayForkSetup(forkSetup(count))).toBe(true);
    expect(isDuelKindSetup("replay-fork", { replayFork: forkSetup(count) })).toBe(true);
  });

  it("rejects missing or inconsistent kind/setup pairs", () => {
    expect(isDuelKindSetup("play", undefined)).toBe(true);
    expect(isDuelKindSetup("play", null)).toBe(true);
    expect(isDuelKindSetup("play", { engine: "legacy" })).toBe(true);
    for (const [kind, setup] of [
      ["unknown", undefined], [undefined, undefined], ["play", { replayFork: forkSetup() }],
      ["play", { replayFork: null }], ["replay-fork", undefined], ["replay-fork", {}],
      ["replay-fork", { replayFork: null }], ["play", []],
    ]) expect(isDuelKindSetup(kind, setup)).toBe(false);
  });

  it("requires a positive safe application user ID, with no player or Discord substitute", () => {
    for (const ownerUserId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, "101", "discord-fixture", null]) {
      expect(isReplayForkSetup({ ...forkSetup(), ownerUserId })).toBe(false);
    }
    const { ownerUserId: _ownerUserId, ...withoutOwner } = forkSetup();
    expect(isReplayForkSetup({ ...withoutOwner, playerId: 9 })).toBe(false);
    expect(isReplayForkSetup({ ...withoutOwner, discordUserId: "discord-fixture" })).toBe(false);
  });

  it("rejects invalid control, prefix or source seat metadata", () => {
    expect(isReplayForkSetup({ ...forkSetup(), control: "bot" })).toBe(false);
    for (const prefixCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7"]) {
      expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), prefixCount } })).toBe(false);
    }
    expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), prefixCount: 0 } })).toBe(true);
    for (const prefixHash of ["", "not-a-hash", "A".repeat(64)]) {
      expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), prefixHash } })).toBe(false);
    }
    for (const sourceSeats of [[], origin(1).sourceSeats, origin(5).sourceSeats,
      [{ seat: 1, displayName: null }, { seat: 0, displayName: null }],
      [{ seat: 0, displayName: null }, { seat: 0, displayName: null }],
      [{ seat: 0, displayName: null }, { seat: 1, displayName: 9 }]]) {
      expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), sourceSeats } })).toBe(false);
    }
  });

  it("rejects holes in an in-memory source seat array", () => {
    const sourceSeats = new Array(2);
    sourceSeats[0] = { seat: 0, displayName: null };
    expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), sourceSeats } })).toBe(false);
  });

  it.each(["playerId", "discordUserId", "isOwner", "unknown"])("rejects extra %s at every private metadata level", (key) => {
    expect(isReplayForkSetup({ ...forkSetup(), [key]: 9 })).toBe(false);
    expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), [key]: 9 } })).toBe(false);
    for (const seat of [0, 1]) {
      const sourceSeats = origin(2).sourceSeats.map((entry) => entry.seat === seat ? { ...entry, [key]: 9 } : entry);
      expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), sourceSeats } })).toBe(false);
    }
  });

  it.each(["botPolicies", "presetId", "scenarioId"])("rejects %s on a Manual fork, including an undefined property", (key) => {
    for (const value of [undefined, null, {}, "fixture-policy"]) {
      expect(isDuelKindSetup("replay-fork", { replayFork: forkSetup(), [key]: value })).toBe(false);
    }
    expect(isDuelKindSetup("play", { [key]: "fixture-policy" })).toBe(true);
  });

  it("requires a visible step, separate from the private prefix count", () => {
    for (const step of [undefined, null, -1, 1.5, "2", NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), step } })).toBe(false);
    }
    expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), step: 0 } })).toBe(true);
  });

  it("bounds source slugs, frame IDs and display names separately", () => {
    expect(REPLAY_SOURCE_SLUG_MAX_LENGTH).toBe(128);
    expect(REPLAY_FRAME_ID_MAX_LENGTH).toBe(128);
    expect(REPLAY_SOURCE_DISPLAY_NAME_MAX_LENGTH).toBe(100);
    for (const key of ["sourceSlug", "frameId"] as const) {
      expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), [key]: "a".repeat(128) } })).toBe(true);
      for (const value of ["", "a".repeat(129), "bad\nvalue"]) {
        expect(isReplayForkSetup({ ...forkSetup(), origin: { ...origin(2), [key]: value } })).toBe(false);
      }
    }
    const withName = (displayName: string | null) => ({ ...forkSetup(), origin: { ...origin(2),
      sourceSeats: [{ seat: 0, displayName }, { seat: 1, displayName: null }],
    } });
    expect(isReplayForkSetup(withName(null))).toBe(true);
    expect(isReplayForkSetup(withName(""))).toBe(true);
    expect(isReplayForkSetup(withName("a".repeat(100)))).toBe(true);
    expect(isReplayForkSetup(withName("a".repeat(101)))).toBe(false);
  });
});

describe("fork request and stable error contracts", () => {
  const request: ReplayForkRequest = { cursor: "opaque-checkpoint", sourceVersion: "source-v1", requestId: "retry-1" };

  it("accepts a bounded retry key without decoding the opaque cursor", () => {
    expect(isReplayForkRequest(request)).toBe(true);
    expect(isReplayForkRequest({ ...request, requestId: "a".repeat(REPLAY_FORK_REQUEST_ID_MAX_LENGTH) })).toBe(true);
  });

  it("rejects malformed requests and caller-supplied private authority", () => {
    for (const value of [null, [], {}, { ...request, cursor: "" }, { ...request, cursor: "a".repeat(4097) },
      { ...request, sourceVersion: "" }, { ...request, sourceVersion: "a".repeat(257) },
      { ...request, requestId: "" }, { ...request, requestId: "bad\nkey" },
      { ...request, requestId: "a".repeat(REPLAY_FORK_REQUEST_ID_MAX_LENGTH + 1) }]) {
      expect(isReplayForkRequest(value)).toBe(false);
    }
    for (const key of ["isOwner", "ownerUserId", "decks", "seed", "prefixCount", "promptId", "path", "lua"]) {
      expect(isReplayForkRequest({ ...request, [key]: true })).toBe(false);
    }
  });

  it("exports every stable error and its allowed HTTP status", () => {
    expect(REPLAY_ERROR_CODES).toEqual([
      "ACCESS_DENIED", "ACCESS_UNAVAILABLE", "INVALID_CURSOR", "SOURCE_CHANGED", "REQUEST_CONFLICT", "ENGINE_UNAVAILABLE_FOR_SOURCE",
      "REPLAY_MISMATCH", "NOT_PLAYABLE", "FORK_LIMIT", "ENGINE_BUSY",
    ]);
    for (const code of REPLAY_ERROR_CODES) expect(isReplayErrorCode(code)).toBe(true);
    for (const value of [undefined, null, "INVALID", "invalid_cursor"]) expect(isReplayErrorCode(value)).toBe(false);
    expect(REPLAY_ERROR_HTTP_STATUSES).toEqual({
      ACCESS_DENIED: [401, 403, 404], ACCESS_UNAVAILABLE: [503], INVALID_CURSOR: [400], SOURCE_CHANGED: [409], REQUEST_CONFLICT: [409],
      ENGINE_UNAVAILABLE_FOR_SOURCE: [409], REPLAY_MISMATCH: [409], NOT_PLAYABLE: [409],
      FORK_LIMIT: [429], ENGINE_BUSY: [503],
    });
  });

  it.each(["ENGINE_UNAVAILABLE_FOR_SOURCE", "REPLAY_MISMATCH", "NOT_PLAYABLE"] as const)("reports saved final-board availability for %s", (code) => {
    for (const finalBoard of ["available", "none"] as const) {
      const response: ReplayErrorResponse = { code, error: "Replay cannot be restored", finalBoard };
      expect(response.finalBoard).toBe(finalBoard);
    }
    expectTypeOf<ReplayErrorResponse["finalBoard"]>().toEqualTypeOf<"available" | "none" | undefined>();
  });
});
