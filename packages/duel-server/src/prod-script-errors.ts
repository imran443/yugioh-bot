import Database from "better-sqlite3";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCardPasscodeRemaps } from "@yugidraft/shared/db";
import { readOnlyCardScriptSource, type CardScriptSource } from "./card-script-source.js";
import { cardScriptHash, scriptHelperNames, type ScriptEngineKind } from "./card-script-hash.js";
import { loadMultiScriptsFor } from "./multi-scripts.js";
import { scriptErrorModeFromEnv } from "./script-errors.js";
import type { AutoBlockRow } from "./script-error-autoblock.js";

export interface ProdScriptErrorCard {
  code: number; name: string; distinctDuels: number; errorCount: number; autoBlocked: boolean; scriptHash: string | null; engineKind?: ScriptEngineKind; helperScripts?: readonly string[];
}
export type ProdScriptErrorSnapshot = { available: true; cards: ProdScriptErrorCard[]; truncated?: boolean } | { available: false };

/** Fixed seven-day read-only query. Private occurrence identities never leave this function. */
export function prodScriptErrors(db: Database.Database, cards: CardScriptSource, remaps: ReadonlyMap<number, number>, now = Date.now()): Extract<ProdScriptErrorSnapshot, { available: true }> {
  return db.transaction(() => {
    // Aggregate in SQLite and return at most twenty rows; private duel identities
    // and unbounded per-duel arrays never enter this short-lived Node process.
    const mappedCode = remaps.size ? `CASE code ${[...remaps].map(() => "WHEN ? THEN ?").join(" ")} ELSE code END` : "code";
    const mappedArgs = [...remaps].flatMap(([old, code]) => [old, code]);
    const window = [new Date(now - 7 * 86400000).toISOString(), new Date(now).toISOString()];
    const aggregate = (codes?: number[]) => db.prepare(`SELECT ${mappedCode} AS resolved, count(DISTINCT duel_id) AS duels, count(*) AS errors
      FROM card_script_error_occurrences WHERE
        NOT EXISTS (SELECT 1 FROM duels d WHERE d.id = card_script_error_occurrences.duel_id AND d.kind != 'play')
        AND code > 0 AND code <= 4294967295
        AND julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?)
        ${codes ? `AND (${mappedCode}) IN (${codes.map(() => "?").join(",")})` : ""}
      GROUP BY resolved ORDER BY errors DESC, resolved ASC ${codes ? "" : "LIMIT 20"}`)
      .all(...mappedArgs, ...window, ...(codes ? [...mappedArgs, ...codes] : [])) as { resolved: number; duels: number; errors: number }[];
    const recent = aggregate();
    const totals = new Map(recent.map(row => [row.resolved, row]));
    const active = new Map<number, AutoBlockRow[]>();
    let scanTruncated = false;
    let overlay: ReturnType<typeof loadMultiScriptsFor> | undefined;
    const hash = (code: number, kind: ScriptEngineKind = "all", helperScripts: readonly string[] = []) => {
      if (kind.startsWith("multi-") && cards.dataDirectory) overlay ??= loadMultiScriptsFor(cards.dataDirectory);
      return cardScriptHash(cards, code, kind, overlay, helperScripts);
    };
    if (scriptErrorModeFromEnv() !== "strict") {
      const rows = db.prepare("SELECT * FROM card_script_auto_blocks WHERE cleared_at IS NULL ORDER BY code, engine_kind LIMIT 101").all() as AutoBlockRow[];
      // Stale revisions still consume the bounded scan. Preserve the sentinel
      // before filtering so omitted active rows cannot look like an empty list.
      scanTruncated = rows.length > 100;
      for (const row of rows.slice(0, 100)) {
        const code = remaps.get(row.code) ?? row.code;
        if (hash(code, row.engine_kind, scriptHelperNames(JSON.parse(row.helper_scripts))) === row.script_hash) active.set(code, [...active.get(code) ?? [], row]);
      }
    }
    const top = recent.map(row => row.resolved);
    if (active.size) for (const row of aggregate([...active.keys()])) totals.set(row.resolved, row);
    // Include blocks with no recent samples. Blocks receive priority when the hard size cap is reached.
    const codes = [...new Set([...active.keys()].sort((a, b) => a - b).concat(top))];
    const result = codes.flatMap(code => (active.get(code) ?? [null]).map(row => {
      const helperScripts = row ? scriptHelperNames(JSON.parse(row.helper_scripts)) : [];
      return { code, name: (cards.deckCard(code)?.name ?? "Name unavailable").slice(0, 200),
        distinctDuels: totals.get(code)?.duels ?? 0, errorCount: totals.get(code)?.errors ?? 0,
        autoBlocked: row !== null, scriptHash: hash(code, row?.engine_kind, helperScripts),
        ...(row ? { engineKind: row.engine_kind } : {}), ...(helperScripts.length ? { helperScripts } : {}) };
    })).slice(0, 100);
    result.sort((a, b) => b.errorCount - a.errorCount || a.code - b.code);
    return { available: true as const, cards: result, truncated: scanTruncated || codes.reduce((n, code) => n + (active.get(code)?.length ?? 1), 0) > 100 };
  })();
}

// The VM invokes this compiled entrypoint in the already running duel container. No dotenv or migrations.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let db: Database.Database | undefined;
  let cards: ReturnType<typeof readOnlyCardScriptSource> | undefined;
  try {
    db = new Database(process.env.DATABASE_PATH ?? "/app/data/bot.sqlite", { readonly: true, fileMustExist: true, timeout: 5000 });
    db.pragma("query_only = ON"); db.pragma("cache_size = -1024");
    const directory = process.env.DUEL_DATA_DIR ?? "/app/data/duel-engine";
    cards = readOnlyCardScriptSource(directory);
    console.log(JSON.stringify(prodScriptErrors(db, cards, loadCardPasscodeRemaps(directory))));
  } catch {
    // Diagnostics are deliberately omitted; this output may become a public workflow artifact.
    console.log(JSON.stringify({ available: false }));
  } finally { cards?.close(); db?.close(); }
}
