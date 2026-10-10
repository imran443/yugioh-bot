import { loadCardPasscodeRemaps } from "@yugidraft/shared/db";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** A card named by exact printed name, or by passcode. */
export type CardRef = string | number;

let configured: string | undefined;

/** The duel host calls this with its engine data directory, so rule and preset card names resolve against the same cards.cdb. */
export function setCatalogDirectory(dir: string | undefined): void {
  configured = dir ? resolve(dir) : undefined;
}

/** Engine data of the running process: the configured directory, else DUEL_DATA_DIR, else the canonical bundle. */
export function defaultEngineDataDirectory(): string {
  if (configured) return configured;
  return resolve(process.env.DUEL_DATA_DIR ?? fileURLToPath(new URL("../../../../data/duel-engine/", import.meta.url)));
}

interface Entry {
  code: number;
  name: string;
  alias?: number;
}

interface Catalog {
  byName: Map<string, Entry[]>;
  byCode: Map<number, Entry>;
  all: Entry[];
}

const catalogs = new Map<string, Catalog>();

function load(dir: string): Catalog {
  const cached = catalogs.get(dir);
  if (cached) return cached;
  const path = join(dir, "cards.cdb");
  if (!existsSync(path)) throw new Error(`cards.cdb not found in ${dir}. Set DUEL_DATA_DIR to a duel engine data directory.`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare("SELECT d.id AS code, d.alias, t.name AS name FROM datas d JOIN texts t USING(id) WHERE (d.ot&3)!=0 ORDER BY d.id")
      .all() as Entry[];
    const byName = new Map<string, Entry[]>();
    const byCode = new Map<number, Entry>();
    for (const row of rows) {
      byCode.set(row.code, row);
      if (row.alias) continue; // Exact numeric references retain artwork identity; names resolve only to main artworks.
      const list = byName.get(row.name) ?? [];
      list.push(row);
      byName.set(row.name, list);
    }
    const catalog = { byName, byCode, all: rows.filter(row => !row.alias) };
    catalogs.set(dir, catalog);
    return catalog;
  } finally {
    db.close();
  }
}

/** Resolve a name or code to a passcode. Fails fast on unknown or ambiguous names. */
export function resolveCard(ref: CardRef, dir: string = defaultEngineDataDirectory()): number {
  const catalog = load(dir);
  if (typeof ref === "number") {
    ref = loadCardPasscodeRemaps(dir).get(ref) ?? ref;
    if (!catalog.byCode.has(ref)) throw new Error(`Unknown card code ${ref} (not in cards.cdb)`);
    return ref;
  }
  const exact = catalog.byName.get(ref);
  if (!exact || exact.length === 0) {
    const needle = ref.toLowerCase();
    const close = catalog.all.filter((card) => card.name.toLowerCase().includes(needle)).slice(0, 8).map((card) => `${card.name} (${card.code})`);
    throw new Error(
      `Unknown card name "${ref}". Names must match cards.cdb exactly.` +
        (close.length > 0 ? ` Close matches: ${close.join("; ")}` : " No close matches."),
    );
  }
  if (exact.length > 1) throw new Error(`Ambiguous card name "${ref}". Use a code: ${exact.map((card) => card.code).join(", ")}`);
  return exact[0]!.code;
}

/** Name for a code, for messages. Falls back to the code. */
export function cardName(code: number, dir: string = defaultEngineDataDirectory()): string {
  return load(dir).byCode.get(code)?.name ?? String(code);
}
