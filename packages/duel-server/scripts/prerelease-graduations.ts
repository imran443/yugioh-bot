import { hasDedupeIdentity, type CardIdentity } from "./prerelease-history.js";

export class CardRemapValidationError extends Error {}

export interface GraduationTransition { commit: string; removed: CardIdentity[]; added: CardIdentity[] }
export interface UnmatchedGraduation extends CardIdentity { commits: string[]; candidates: number[] }

const stats = ["atk", "def", "level", "attribute", "race"] as const;
/** Exact effect text, changing only this card's own name and whitespace. Never
 * strip all quoted names: references to other cards are identity evidence too. */
export function graduationText(card: CardIdentity): string {
  return (card.description ?? "").replaceAll(`"${card.name}"`, '"<self>"').replace(/\s+/g, " ").trim();
}
function agrees(old: CardIdentity, next: CardIdentity): boolean {
  const text = graduationText(old);
  return hasDedupeIdentity(old) && hasDedupeIdentity(next) && text.length >= 40 && text === graduationText(next)
    && (old.type & 7) === (next.type & 7)
    && stats.every(field => old[field] !== undefined && next[field] !== undefined && old[field] === next[field]);
}

/** A co-occurring removal/addition, complete stats and exact normalized text are
 * independent signals. Both directions must be unique, across all snapshots. */
export function matchGraduations(transitions: GraduationTransition[]): { remaps: Record<string, number>; unmatched: UnmatchedGraduation[] } {
  const sources = new Map<number, { card: CardIdentity; commits: Set<string>; targets: Set<number> }>();
  const reverse = new Map<number, Set<number>>();
  for (const transition of transitions) for (const old of transition.removed.filter(hasDedupeIdentity)) {
    const source = sources.get(old.code) ?? { card: old, commits: new Set<string>(), targets: new Set<number>() };
    source.commits.add(transition.commit);
    for (const next of transition.added.filter(candidate => agrees(old, candidate))) {
      source.targets.add(next.code);
      const olds = reverse.get(next.code) ?? new Set<number>();
      olds.add(old.code); reverse.set(next.code, olds);
    }
    sources.set(old.code, source);
  }
  const remaps: Record<string, number> = {}, unmatched: UnmatchedGraduation[] = [];
  for (const [code, source] of [...sources].sort(([a], [b]) => a - b)) {
    const targets = [...source.targets].sort((a, b) => a - b);
    if (targets.length === 1 && reverse.get(targets[0]!)?.size === 1) remaps[code] = targets[0]!;
    else unmatched.push({ ...source.card, commits: [...source.commits].sort(), candidates: targets });
  }
  return { remaps, unmatched };
}

export function parseRemapOverrides(bytes: string): Record<string, number | null> {
  let value: unknown;
  try { value = JSON.parse(bytes); }
  catch (cause) { throw new CardRemapValidationError("Invalid card remap overrides: malformed JSON", { cause }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CardRemapValidationError("Invalid card remap overrides: expected old-code -> new-code object");
  for (const [old, target] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(old) || !Number.isSafeInteger(Number(old)) || Number(old) > 0xffffffff ||
      (target !== null && (typeof target !== "number" || !Number.isSafeInteger(target) || target <= 0 || target > 0xffffffff || Number(old) === target))) {
      throw new CardRemapValidationError(`Invalid card remap override ${old}`);
    }
  }
  return value as Record<string, number | null>;
}
