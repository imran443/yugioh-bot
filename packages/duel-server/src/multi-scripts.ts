import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lua overlay for duels with more than two seats (design F7, section 4). The folder `multi-scripts` holds
 * `mp-utility.lua`, one `cNNN.lua` per card named in `MANIFEST.json`, and the manifest itself.
 *   - A card file is appended to the original script text.
 *   - A card file that starts with `--@replace` replaces the original script.
 * A 1v1 duel never reads this folder: the caller passes no overlay and the script text stays the original.
 */

export const MULTI_SCRIPTS_DIRECTORY_NAME = "multi-scripts";
export const MULTI_SCRIPTS_ENV = "DUEL_MULTI_SCRIPTS_DIR";
export const MP_UTILITY_FILE = "mp-utility.lua";
export const MULTI_MANIFEST_FILE = "MANIFEST.json";
export const REPLACE_MARKER = "--@replace";

const MANIFEST_KINDS = new Set(["whole", "expr", "trig", "hand", "chooser", "fix", "seat"]);
const CARD_FILE = /^c(\d+)\.lua$/;

export interface MultiScriptsCard {
  code: number;
  file: string;
  kind: string;
}

/** What `CardDatabase.readScript` takes: maps the original script text of a card to the text the duel loads. */
export interface ScriptOverlay {
  apply(name: string, original: string | null): string | null;
}

export interface MultiScripts extends ScriptOverlay {
  directory: string;
  /** Hash of the folder (see `multiScriptsFolderHash`). */
  hash: string;
  /** Text of `mp-utility.lua`. The host loads it before any card exists. */
  utility: string;
  cards: MultiScriptsCard[];
}

/** The folder of this repo (packages/duel-server/domain-core/multi-scripts), reached from src/ or dist/. */
export function repoMultiScriptsDirectory(): string {
  return fileURLToPath(new URL(`../domain-core/${MULTI_SCRIPTS_DIRECTORY_NAME}/`, import.meta.url)).replace(/[\\/]$/, "");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the overlay folder is, in this order: (1) env DUEL_MULTI_SCRIPTS_DIR, (2) the repo folder, outside
 * production only, (3) `<data>/multi-scripts` (the deployed bundle). Outside production the repo folder comes
 * before `<data>`: an older copy that `duel:prepare` left in the data folder must not hide an edit of the repo.
 * Production uses (3) only; (1) is a test and tooling hook that production must not honour either.
 * Returns null when no folder exists. Throws when (1) is set and names a missing folder.
 */
export function resolveMultiScriptsDirectory(
  dataDirectory: string,
  options: { env?: NodeJS.ProcessEnv; repoDirectory?: string } = {},
): string | null {
  const env = options.env ?? process.env;
  const production = env.NODE_ENV === "production";
  const named = env[MULTI_SCRIPTS_ENV];
  if (named && !production) {
    const directory = resolve(named);
    if (!isDirectory(directory)) throw new Error(`${MULTI_SCRIPTS_ENV} names ${directory}, which is not a directory`);
    return directory;
  }
  if (!production) {
    const repo = options.repoDirectory ?? repoMultiScriptsDirectory();
    if (isDirectory(repo)) return repo;
  }
  const bundled = join(resolve(dataDirectory), MULTI_SCRIPTS_DIRECTORY_NAME);
  return isDirectory(bundled) ? bundled : null;
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(relative(root, full).replaceAll("\\", "/"));
      else throw new Error(`Engine resource folder contains a non-regular entry: ${full}`);
    }
  };
  visit(root);
  return found;
}

/**
 * sha256 over the lines `<relative path>\0<sha256 of the file>\n`, sorted bytewise by relative path
 * (the same order as `LC_ALL=C sort`). scripts/install-engine-bundle.sh computes the same value in sh.
 */
export function multiScriptsFolderHash(directory: string): string {
  const files = listFiles(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const hash = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256").update(readFileSync(join(directory, file))).digest("hex");
    hash.update(`${file}\0${digest}\n`);
  }
  return hash.digest("hex");
}

/**
 * Hash of the overlay folder a duel with more than two seats would load from this data directory, or null when
 * there is none (or it cannot be read). The host pins this value for such duels, so an edit of the overlay
 * interrupts only duels that used it. Resolves the folder the same way as the engine does.
 */
export function activeMultiScriptsHash(dataDirectory: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const directory = resolveMultiScriptsDirectory(dataDirectory, { env });
    return directory ? multiScriptsFolderHash(directory) : null;
  } catch {
    return null;
  }
}

/**
 * The engine version a duel pins when it starts, and recovery and replay compare. A duel of two seats pins the
 * bundle alone. A duel with more than two seats also pins the Lua overlay it loads (`overlayHash`, null when
 * there is none), so an edit of the overlay interrupts only the duels that used it and never a 1v1 duel.
 */
export function pinnedEngineVersion(bundleVersion: string, seatCount: number, overlayHash: string | null): string {
  if (seatCount <= 2) return bundleVersion;
  return createHash("sha256").update(`${bundleVersion}\0multi-scripts:${overlayHash ?? "none"}`).digest("hex");
}

/** Reads and checks `MANIFEST.json`. Throws one error that names the folder and the fault. */
export function readMultiScriptsManifest(directory: string): MultiScriptsCard[] {
  const path = join(directory, MULTI_MANIFEST_FILE);
  const fail = (message: string): never => {
    throw new Error(`Multi-scripts manifest ${path}: ${message}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`missing or unreadable (${error instanceof Error ? error.message : String(error)})`);
  }
  const root = parsed as { version?: unknown; cards?: unknown } | null;
  if (!root || typeof root !== "object") return fail("not an object");
  if (root.version !== 1) return fail(`unknown version ${JSON.stringify(root.version)} (expected 1)`);
  if (!Array.isArray(root.cards)) return fail("`cards` is not a list");
  const cards: MultiScriptsCard[] = [];
  const seen = new Set<number>();
  for (const entry of root.cards as unknown[]) {
    const card = entry as { code?: unknown; file?: unknown; kind?: unknown } | null;
    if (!card || typeof card !== "object") return fail("a card entry is not an object");
    const { code, kind } = card;
    if (typeof code !== "number" || !Number.isInteger(code) || code <= 0) return fail(`bad card code ${JSON.stringify(code)}`);
    if (seen.has(code)) return fail(`card ${code} is listed twice`);
    seen.add(code);
    const file = card.file ?? `c${code}.lua`;
    if (file !== `c${code}.lua`) return fail(`card ${code} must use the file c${code}.lua, got ${JSON.stringify(file)}`);
    if (typeof kind !== "string" || !MANIFEST_KINDS.has(kind)) return fail(`card ${code} has unknown kind ${JSON.stringify(kind)}`);
    if (!existsSync(join(directory, file))) return fail(`card ${code} lists ${file}, which is missing`);
    cards.push({ code, file, kind });
  }
  for (const file of listFiles(directory)) {
    const match = CARD_FILE.exec(file);
    if (match && !seen.has(Number(match[1]))) return fail(`${file} is in the folder but not in the manifest`);
  }
  return cards;
}

/** The card code of a script name such as `c123.lua`, `script/c123.lua` or `.\script\c123.lua`. Null for any other name. */
export function cardCodeOfScript(name: string): number | null {
  const match = CARD_FILE.exec(basename(name.replaceAll("\\", "/")));
  return match ? Number(match[1]) : null;
}

/** Loads and checks the overlay folder. The check runs once per call: the caller keeps the result. */
export function loadMultiScripts(directory: string): MultiScripts {
  const root = resolve(directory);
  const utilityPath = join(root, MP_UTILITY_FILE);
  if (!existsSync(utilityPath)) throw new Error(`Multi-scripts folder ${root} has no ${MP_UTILITY_FILE}`);
  const utility = readFileSync(utilityPath, "utf8");
  const cards = readMultiScriptsManifest(root);
  const texts = new Map<number, string>();
  for (const card of cards) texts.set(card.code, readFileSync(join(root, card.file), "utf8"));
  return {
    directory: root,
    hash: multiScriptsFolderHash(root),
    utility,
    cards,
    apply(name, original) {
      const code = cardCodeOfScript(name);
      const suffix = code == null ? undefined : texts.get(code);
      if (suffix === undefined) return original;
      if (suffix.startsWith(REPLACE_MARKER)) return suffix;
      if (original == null) return original;
      return original.endsWith("\n") ? original + suffix : `${original}\n${suffix}`;
    },
  };
}

/** Resolve and load in one step for a duel with more than two seats. Throws when no folder exists. */
export function loadMultiScriptsFor(dataDirectory: string, explicitDirectory?: string): MultiScripts {
  const directory = explicitDirectory ? resolve(explicitDirectory) : resolveMultiScriptsDirectory(dataDirectory);
  if (!directory) {
    throw new Error(
      `Multi-scripts folder is missing: expected ${join(resolve(dataDirectory), MULTI_SCRIPTS_DIRECTORY_NAME)}. Duels with more than two seats need it. Run npm run duel:prepare.`,
    );
  }
  return loadMultiScripts(directory);
}

/**
 * Copies the repo overlay folder to `<data>/multi-scripts` (replacing what is there) and returns the folder hash
 * for manifest.integrity.multiScripts. The copy goes through a sibling folder and two renames. The old folder
 * is moved aside, not deleted, so a failed swap puts it back and a reader never finds no folder for long.
 */
export function installMultiScripts(dataDirectory: string, source: string = repoMultiScriptsDirectory()): string {
  const from = resolve(source);
  loadMultiScripts(from); // refuses a broken folder before anything is replaced
  const target = join(resolve(dataDirectory), MULTI_SCRIPTS_DIRECTORY_NAME);
  const staging = `${target}.new`;
  const aside = `${target}.old`;
  mkdirSync(dirname(target), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  rmSync(aside, { recursive: true, force: true });
  cpSync(from, staging, { recursive: true });
  const hadOld = existsSync(target);
  if (hadOld) renameSync(target, aside);
  try {
    renameSync(staging, target);
  } catch (error) {
    if (hadOld) renameSync(aside, target);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(aside, { recursive: true, force: true });
  return multiScriptsFolderHash(target);
}
