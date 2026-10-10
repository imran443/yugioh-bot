import type Database from "better-sqlite3";
import type { DuelScriptError } from "./script-errors.js";
import { SCRIPT_ERROR_TELEMETRY_LIMIT } from "./script-errors.js";
import type { AutoBlockPolicy } from "./script-error-autoblock.js";

export interface CardScriptErrorCount {
  code: number;
  count: number;
  last_message: string;
  last_script_file: string;
  last_line: number;
  last_mode: string;
  last_duel_id: number;
  last_seen: string;
}

/** Host-only side effect. Saved seed, journal position, attempted command and request ordinal deduplicate retries. */
export function createScriptErrorRecorder(db: Database.Database, log: (line: string) => void = console.error, autoBlocks?: AutoBlockPolicy) {
  const storedKind = db.prepare<[number], { kind: string }>("SELECT kind FROM duels WHERE id = ?");
  const once = db.prepare(`INSERT OR IGNORE INTO card_script_error_occurrences
    (duel_id, command_hash, error_index, code, created_at, resolved_code, script_hash, script_error_mode, engine_kind, helper_scripts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const prune = db.prepare(`DELETE FROM card_script_error_occurrences
    WHERE julianday(created_at) < julianday('now', '-30 days')
      AND NOT EXISTS (SELECT 1 FROM duels WHERE id = duel_id AND status IN ('active', 'lobby'))
      AND julianday(COALESCE((SELECT ended_at FROM duels WHERE id = duel_id), created_at)) < julianday('now', '-30 days')`);
  let nextPrune = 0;
  const pruneIfDue = () => {
    if (Date.now() < nextPrune) return;
    prune.run();
    nextPrune = Date.now() + 24 * 60 * 60 * 1000;
  };
  // Prune on host startup and daily during telemetry. Cumulative per-card counters survive.
  try { pruneIfDue(); }
  catch (failure) { log(JSON.stringify({ event: "card_script_error_cleanup_failed", failure: String(failure) })); }
  const count = db.prepare("SELECT count(*) AS n FROM card_script_error_occurrences WHERE duel_id = ? AND code = ?");
  const capped = new Set<string>();
  const increment = db.prepare(`INSERT INTO card_script_errors (code, count, last_message, last_script_file, last_line, last_mode, last_duel_id, last_seen)
    VALUES (?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET count = count + 1, last_message = excluded.last_message,
      last_script_file = excluded.last_script_file, last_line = excluded.last_line,
      last_mode = excluded.last_mode, last_duel_id = excluded.last_duel_id, last_seen = excluded.last_seen`);
  const save = db.transaction((duelId: number, error: DuelScriptError) => {
    if ((count.get(duelId, error.code) as { n: number }).n >= SCRIPT_ERROR_TELEMETRY_LIMIT) {
      capped.add(`${duelId}:${error.code}`);
      return false;
    }
    const revision = autoBlocks?.revision(error.code, error);
    if (!once.run(duelId, error.commandHash ?? "", error.index, error.code,
      new Date(autoBlocks?.now() ?? Date.now()).toISOString(), revision?.code ?? error.code,
      revision?.scriptHash ?? null, error.scriptErrorMode, revision?.engineKind ?? null,
      JSON.stringify(revision?.helperScripts ?? [])).changes) return false;
    increment.run(error.code, error.message, error.scriptFile, error.line, error.mode, duelId);
    if (error.scriptErrorMode === "tolerant" && revision) autoBlocks?.consider(revision.code, revision.scriptHash, revision.engineKind);
    return true;
  });
  return (duelId: number, error: DuelScriptError): boolean => {
    if (capped.has(`${duelId}:${error.code}`)) return false;
    try {
      // The kind is immutable and server-owned. Fork diagnostics use a separate log stream;
      // neither their samples nor their retries enter production telemetry or admission policy.
      if (storedKind.get(duelId)?.kind === "replay-fork") {
        log(JSON.stringify({ event: "replay_fork_script_error", duelKind: "replay-fork", duelId, ...error }));
        return true;
      }
      pruneIfDue();
      if (!save.immediate(duelId, error)) return false;
      log(JSON.stringify({ event: "card_script_error", duelId, ...error }));
      return true;
    } catch (failure) {
      // Observability must never turn a recovered Lua failure into a rejected duel answer.
      log(JSON.stringify({ event: "card_script_error_persistence_failed", duelId, ...error, failure: failure instanceof Error ? failure.message : String(failure) }));
      return false;
    }
  };
}

export function topScriptErrors(db: Database.Database, limit = 20): CardScriptErrorCount[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be an integer from 1 to 1000");
  return db.prepare("SELECT * FROM card_script_errors ORDER BY count DESC, code ASC LIMIT ?").all(limit) as CardScriptErrorCount[];
}
