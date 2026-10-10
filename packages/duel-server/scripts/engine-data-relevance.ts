/** Compare the data the engine loads, rather than upstream commit/archive bytes. */
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

export interface LoadedData {
  cards: Map<number, string>;
  scripts: Map<string, string>;
  strings: string;
  remaps: Record<string, number>;
}
export interface RelevantChanges {
  relevant: boolean;
  comparisonAvailable: boolean;
  newCards: number | null;
  changedCards: number | null;
  removedCards: number | null;
  changedScripts: string[];
  stringsChanged: boolean;
  remapsChanged: boolean;
}

const canonical = (row: Record<string, unknown>) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
  (_key, value) => typeof value === "bigint" ? { integer: value.toString() } : value);

/** All datas/texts columns matter, including 64-bit setcode/race and effect strings.
 * The prepared merge already excludes Rush rows and resolves duplicate previews.
 */
export function readCardRows(path: string): Map<number, string> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = (table: "datas" | "texts") => new Map((db.prepare(`SELECT * FROM ${table} ORDER BY id`).safeIntegers().all() as Array<Record<string, unknown>>)
      .map(row => [Number(row.id), canonical(row)]));
    const datas = rows("datas"), texts = rows("texts");
    // Base cards.cdb is copied wholesale. The runtime reads tables separately,
    // so orphan rows still affect stats or labels and cannot be discarded here.
    return new Map([...new Set([...datas.keys(), ...texts.keys()])].sort((a, b) => a - b)
      .map(code => [code, createHash("sha256").update((datas.get(code) ?? "null") + "\n" + (texts.get(code) ?? "null")).digest("hex")]));
  } finally { db.close(); }
}

/** Keep shipped Lua, including numbered dependencies without a database row.
 * Match prepare-data's removal of shadowed/absent previews; exclude Rush cards.
 */
export function loadedScriptTree(tree: Map<string, string>, codes: ReadonlySet<number>, knownRushCodes: ReadonlySet<number> = new Set()): Map<string, string> {
  const rushPath = (path: string) => /(?:^|\/)rush\//i.test(path);
  const rushCodes = new Set(knownRushCodes);
  for (const path of tree.keys()) {
    const card = /(?:^|\/)c(\d+)\.lua$/.exec(path);
    if (card && rushPath(path)) rushCodes.add(Number(card[1]));
  }
  return new Map([...tree].filter(([path]) => {
    if (!path.endsWith(".lua") || rushPath(path)) return false;
    const card = /(?:^|\/)c(\d+)\.lua$/.exec(path);
    if (!card) return true;
    const code = Number(card[1]);
    if (rushCodes.has(code) && !codes.has(code)) return false;
    return !/^pre-release\/c\d+\.lua$/.test(path) || (codes.has(code) && !tree.has(`official/c${card[1]}.lua`));
  }));
}

export function compareLoadedData(previous: (Omit<LoadedData, "cards" | "remaps"> & {
  cards: Map<number, string> | null; remaps: Record<string, number> | null;
}) | null, next: LoadedData): RelevantChanges {
  const changedScripts = [...new Set([...(previous?.scripts.keys() ?? []), ...next.scripts.keys()])]
    .filter(path => previous?.scripts.get(path) !== next.scripts.get(path)).sort();
  const oldCards = previous?.cards;
  const newCards = oldCards ? [...next.cards.keys()].filter(code => !oldCards.has(code)).length : null;
  const changedCards = oldCards ? [...next.cards].filter(([code, row]) => oldCards.has(code) && oldCards.get(code) !== row).length : null;
  const removedCards = oldCards ? [...oldCards.keys()].filter(code => !next.cards.has(code)).length : null;
  const stringsChanged = previous?.strings !== next.strings;
  const remapsChanged = !previous?.remaps || canonical(previous.remaps) !== canonical(next.remaps);
  return { relevant: !oldCards || !!(newCards || changedCards || removedCards || changedScripts.length || stringsChanged || remapsChanged),
    comparisonAvailable: oldCards != null, newCards, changedCards, removedCards, changedScripts, stringsChanged, remapsChanged };
}

export function renderRelevantChanges(changes: RelevantChanges, setCodes: string[]): string {
  const count = (n: number | null) => n ?? "unknown";
  const codes = [...new Set(setCodes)].sort().map(code => code.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean);
  return ["## Relevance gate", "",
    changes.relevant ? "Relevant loaded data changed; candidate validation and PR publication may proceed."
      : "Skipped: upstream pins moved, but no loaded card rows, scripts, strings or remaps changed. Current pins retained; no PR is opened or updated.", "",
    `New cards: ${count(changes.newCards)}. Changed cards: ${count(changes.changedCards)}. Removed cards: ${count(changes.removedCards)}. Changed scripts: ${changes.changedScripts.length}.`,
    `New set codes: ${codes.join(", ") || "None"}.`,
    `strings.conf changed: ${changes.stringsChanged ? "Yes" : "No"}. Passcode remaps changed: ${changes.remapsChanged ? "Yes" : "No"}.`,
    ...(!changes.comparisonAvailable ? ["Previous snapshot unavailable; relevance cannot be ruled out. Card counts are unknown and review is required."] : []), ""].join("\n");
}
