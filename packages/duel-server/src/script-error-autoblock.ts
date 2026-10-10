import type Database from "better-sqlite3";
import { scriptEngineKind, scriptHelperNames, type ScriptEngineKind } from "./card-script-hash.js";
import type { DuelScriptError } from "./script-errors.js";
import type { CardBlockEntry } from "./card-block-list.js";
import { scriptErrorModeFromEnv } from "./script-errors.js";

export const AUTO_BLOCK_REASON = "Its effect script is being investigated";
export function autoBlockConfigFromEnv() {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = process.env[name] ? Number(process.env[name]) : fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      console.warn(`${name} must be an integer from ${min} to ${max}; using default ${fallback}`);
      return fallback;
    }
    return value;
  };
  return { threshold: integer("DUEL_SCRIPT_ERROR_BLOCK_DUELS", 3, 2, 1_000_000),
    windowDays: integer("DUEL_SCRIPT_ERROR_BLOCK_WINDOW_DAYS", 7, 1, 30) };
}

export interface AutoBlockRow {
  code: number; reason: string; blocked_at: string; distinct_duels: number; error_count: number;
  threshold: number; window_days: number; bundle_version: string; script_hash: string; card_script_hash: string | null; cleared_at: string | null; engine_kind: ScriptEngineKind; helper_scripts: string;
}

/** Clears admission policy only; keeps telemetry and establishes a fresh counting baseline. */
export function clearAutoBlock(db: Database.Database, code: number, now = Date.now()): boolean {
  if (!Number.isSafeInteger(code) || code <= 0 || code > 0xffffffff) throw new Error("code must be a positive passcode");
  return db.prepare("UPDATE card_script_auto_blocks SET cleared_at = ? WHERE code = ? AND cleared_at IS NULL")
    .run(new Date(now).toISOString(), code).changes > 0;
}

/** Host-only mutable admission policy. Never passed into a worker or saved duel setup. */
export function createAutoBlockPolicy(db: Database.Database, options: {
  bundleVersion: string;
  scriptHash: (code: number, kind: ScriptEngineKind, helperScripts: readonly string[]) => string | null;
  remaps?: ReadonlyMap<number, number>;
  exactCodes?: (code: number) => readonly number[];
  now?: () => number;
}) {
  const enabled = scriptErrorModeFromEnv() !== "strict";
  const config = enabled ? autoBlockConfigFromEnv() : { threshold: 3, windowDays: 7 };
  const now = options.now ?? Date.now;
  const resolveCode = (code: number) => options.remaps?.get(code) ?? code;
  const relatedCodes = (code: number) => [code, ...[...options.remaps ?? []].filter(([, target]) => target === code).map(([old]) => old)];
  const rows = db.prepare("SELECT * FROM card_script_auto_blocks WHERE cleared_at IS NULL ORDER BY code");
  const block = db.prepare(`INSERT INTO card_script_auto_blocks
    (code, reason, blocked_at, distinct_duels, error_count, threshold, window_days, bundle_version, script_hash, card_script_hash, engine_kind, helper_scripts, cleared_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(code, engine_kind) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at,
      distinct_duels = excluded.distinct_duels, error_count = excluded.error_count, threshold = excluded.threshold,
      window_days = excluded.window_days, bundle_version = excluded.bundle_version, script_hash = excluded.script_hash,
      card_script_hash = excluded.card_script_hash, helper_scripts = excluded.helper_scripts, cleared_at = NULL`);
  const empty: readonly CardBlockEntry[] = [];
  let signature: string | undefined;
  const cachedEntries = new Map<ScriptEngineKind | undefined, readonly CardBlockEntry[]>();
  const refresh = () => {
    if (!enabled) return;
    for (const row of rows.all() as AutoBlockRow[]) {
      let currentHash: string | null = null;
      try { currentHash = options.scriptHash(resolveCode(row.code), row.engine_kind, scriptHelperNames(JSON.parse(row.helper_scripts))); }
      catch (failure) {
        console.error(JSON.stringify({ event: "card_script_auto_block_hash_failed", code: row.code,
          engineKind: row.engine_kind, failure: failure instanceof Error ? failure.message : String(failure) }));
      }
      if (currentHash !== row.script_hash) {
        db.prepare("UPDATE card_script_auto_blocks SET cleared_at = ? WHERE code = ? AND engine_kind = ?")
          .run(new Date(now()).toISOString(), row.code, row.engine_kind);
      }
    }
  };
  refresh(); // Startup revision checks; admission reads never hash scripts or write.
  return {
    now, refresh,
    revision(rawCode: number, error?: DuelScriptError) {
      const code = resolveCode(rawCode);
      const engineKind = error ? scriptEngineKind(error.mode, error.format, error.engine) : "all";
      const helperScripts = scriptHelperNames([error?.scriptFile ?? "", ...error?.helperScripts ?? []]);
      // Counting follows the card revision, independent of which helpers an error names.
      return { code, engineKind, helperScripts, scriptHash: options.scriptHash(code, engineKind, []) };
    },
    /** Called inside the recorder's immediate transaction, after an accepted new sample. */
    consider(code: number, hash: string | null, kind: ScriptEngineKind = "all") {
      if (!enabled || hash === null) return;
      refresh();
      const codes = relatedCodes(code), placeholders = codes.map(() => "?").join(",");
      const previous = db.prepare(`SELECT * FROM card_script_auto_blocks WHERE code IN (${placeholders}) AND engine_kind = ?`).all(...codes, kind) as AutoBlockRow[];
      if (previous.some(row => row.cleared_at === null)) return;
      // Lift hashes include helpers. Clears reset the count for the same card revision;
      // legacy blocks with an unknown card revision also establish a fresh baseline.
      const clearedAt = previous.filter(row => row.card_script_hash === null || row.card_script_hash === hash)
        .map(row => row.cleared_at).filter((at): at is string => at !== null).sort().at(-1) ?? null;
      const time = now(), at = new Date(time).toISOString();
      const result = db.prepare(`WITH eligible AS (SELECT duel_id, helper_scripts FROM card_script_error_occurrences WHERE resolved_code IN (${placeholders}) AND script_hash = ? AND script_error_mode = 'tolerant' AND engine_kind = ?
          AND NOT EXISTS (SELECT 1 FROM duels d WHERE d.id = card_script_error_occurrences.duel_id AND d.kind != 'play')
          AND julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?)
          AND (? IS NULL OR julianday(created_at) > julianday(?)))
        SELECT count(DISTINCT duel_id) AS duels, count(*) AS errors,
          (SELECT count(DISTINCT p.user_id) FROM (SELECT DISTINCT duel_id FROM eligible) e
            JOIN duel_seats s ON s.duel_id = e.duel_id AND s.is_bot = 0
            JOIN players p ON p.id = s.player_id) AS humans,
          (SELECT json_group_array(DISTINCT helper.value) FROM eligible e
            JOIN json_each(e.helper_scripts) helper) AS helper_scripts FROM eligible`)
        .get(...codes, hash, kind, new Date(time - config.windowDays * 86400000).toISOString(), at, clearedAt, clearedAt) as { duels: number; errors: number; humans: number; helper_scripts: string };
      if (result.duels < config.threshold || result.humans < 2) return;
      const helperScripts = scriptHelperNames(JSON.parse(result.helper_scripts));
      const liftHash = options.scriptHash(code, kind, helperScripts);
      if (liftHash === null) return;
      block.run(code, AUTO_BLOCK_REASON, at, result.duels, result.errors, config.threshold, config.windowDays, options.bundleVersion, liftHash, hash, kind, JSON.stringify(helperScripts));
    },
    entries(kind?: ScriptEngineKind): readonly CardBlockEntry[] {
      if (!enabled) return empty;
      // External operator clears remain visible. Only the small active-row signature
      // changes admission array identity, allowing catalog indexes to stay cached.
      const active = rows.all() as AutoBlockRow[];
      const current = JSON.stringify(active.map(row => [row.code, row.engine_kind, row.script_hash]));
      if (signature !== current) { signature = current; cachedEntries.clear(); }
      const cached = cachedEntries.get(kind);
      if (cached) return cached;
      const entries = active.filter(row => !kind || row.engine_kind === "all" || row.engine_kind === kind)
        .map(row => ({ code: resolveCode(row.code), reason: AUTO_BLOCK_REASON, exactCodes: options.exactCodes?.(resolveCode(row.code)) ?? relatedCodes(resolveCode(row.code)) }));
      cachedEntries.set(kind, entries);
      return entries;
    },
  };
}
export type AutoBlockPolicy = ReturnType<typeof createAutoBlockPolicy>;
