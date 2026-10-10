import { isReplayForkSetup } from "./replay-fork.js";

export const DUEL_KINDS = ["play", "replay-fork"] as const;
export type DuelKind = (typeof DUEL_KINDS)[number];
export const DEFAULT_DUEL_KIND: DuelKind = "play";

export function isDuelKind(value: unknown): value is DuelKind {
  return value === "play" || value === "replay-fork";
}

/** The single fork predicate. Use the server-resolved session kind, never a name, private setting or bot seat. */
export function isReplayFork<T extends { kind: unknown }>(duel: T): duel is T & { kind: "replay-fork" } {
  return duel.kind === "replay-fork";
}

/** Check a stored kind/setup pair before trusting it. This does not check creator access or validate normal setup fields. */
export function isDuelKindSetup(kind: unknown, setup: unknown): boolean {
  if (!isDuelKind(kind)) return false;
  if (setup === undefined || setup === null) return kind === "play";
  if (typeof setup !== "object" || Array.isArray(setup)) return false;
  if (kind === "play") return !("replayFork" in setup);
  return "replayFork" in setup && isReplayForkSetup(setup.replayFork);
}
