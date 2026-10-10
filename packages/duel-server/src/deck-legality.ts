// Domain membership and singleton rules follow DarknessCatt/Yugioh-Domain-Toolbox
// (GPL-3.0): src/classes/domain.py, deckChecker.py, textParsers/archetypes.py.
// Official format: https://www.domainformat.com/rules and /deckvalidator.
import { loadCardPasscodeRemaps } from "@yugidraft/shared/db";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import type {
  DuelCardPool,
  DuelDeck,
  DuelDeckCardRef,
  DuelDeckIssue,
  DuelDeckValidation,
  DuelMode,
  DuelSettings,
} from "@yugidraft/shared/duels";
import { canonicalCardCode, checkDeckAgainstPool, mapDeckCodes } from "@yugidraft/shared/duels";
import { banlistLimitsFor, type BanlistLimit } from "./banlists/index.js";
import { MULTIPLAYER_TABLE_LABEL, multiplayerForbiddenFor, type MultiplayerTable } from "./banlists/multiplayer.js";
import { cardBlockIndex, type CardBlockEntry } from "./card-block-list.js";

export type { MultiplayerTable };

export interface InspectDeckOptions {
  /** Current host admission policy (manual entries first). Never used by engine recovery. */
  cardBlocks?: readonly CardBlockEntry[];
  /** Table the deck is for. Default "1v1" adds no multiplayer rule. */
  table?: MultiplayerTable;
  /** Server-loaded picks only. Each forced pick adds one copy to the draft limit. */
  draftPool?: { counts: ReadonlyMap<number, number>; forcedCopies: ReadonlyMap<number, number> };
}

export class DeckLegalityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeckLegalityError";
  }
}

const TYPE_MONSTER = 0x1;
const TYPE_SPELL = 0x2;
const TYPE_TRAP = 0x4;
const TYPE_NORMAL = 0x10;
const TYPE_EFFECT = 0x20;
const TYPE_FUSION = 0x40;
const TYPE_TOKEN = 0x4000;
const TYPE_MAXIMUM = 0x8000;
const TYPE_SYNCHRO = 0x2000;
const TYPE_XYZ = 0x800000;
const TYPE_PENDULUM = 0x1000000;
const TYPE_LINK = 0x4000000;
const TYPE_SKILL = 0x8000000;
const TYPE_ACTION = 0x10000000;
const TYPE_PLUS = 0x20000000;
const TYPE_MINUS = 0x40000000;
const TYPE_ARMOR = 0x80000000;
const TYPE_EXTRA = TYPE_FUSION | TYPE_SYNCHRO | TYPE_XYZ | TYPE_LINK;
const UNPLAYABLE_TYPES = TYPE_TOKEN | TYPE_SKILL | TYPE_ACTION | TYPE_MAXIMUM | TYPE_PLUS | TYPE_MINUS | TYPE_ARMOR;
const SCRIPT_TYPES = TYPE_SPELL | TYPE_TRAP | TYPE_EFFECT | TYPE_PENDULUM;

const OT_OCG = 0x1;
const OT_TCG = 0x2;
const OT_ILLEGAL = 0x8;
const OT_VIDEO_GAME = 0x10;
const OT_CUSTOM = 0x20;
const OT_RUSH = 0x200;
const OT_HIDDEN = 0x1000;

const ATTRIBUTE_DIVINE = 0x40;
const RACE_DIVINE = 0x200000;

const ATTRIBUTES: Record<string, number> = {
  earth: 0x1,
  water: 0x2,
  fire: 0x4,
  wind: 0x8,
  light: 0x10,
  dark: 0x20,
  divine: ATTRIBUTE_DIVINE,
};

const RACES: Record<string, number> = {
  warrior: 0x1,
  spellcaster: 0x2,
  fairy: 0x4,
  fiend: 0x8,
  zombie: 0x10,
  machine: 0x20,
  aqua: 0x40,
  pyro: 0x80,
  rock: 0x100,
  wingedbeast: 0x200,
  plant: 0x400,
  insect: 0x800,
  thunder: 0x1000,
  dragon: 0x2000,
  beast: 0x4000,
  beastwarrior: 0x8000,
  dinosaur: 0x10000,
  fish: 0x20000,
  seaserpent: 0x40000,
  reptile: 0x80000,
  psychic: 0x100000,
  divine: RACE_DIVINE,
  wyrm: 0x800000,
  cyberse: 0x1000000,
  illusion: 0x2000000,
};

const RACE_PATTERN =
  "\\b(aqua|beast[ -]warrior|beast|cyberse|dinosaur|divine[ -]beast|dragon|fairy|fairies|fiend|fish|fishes|illusion|insect|machine|plant|psychic|pyro|reptile|rock|sea[ -]serpent|spellcaster|thunder|warrior|winged[ -]beast|wyrm|zombie)(?:s)?\\b";
const ATTRIBUTE_PATTERN = `\\b(${Object.keys(ATTRIBUTES).join("|")})\\b`;
const QUOTED_DOMAIN_MENTION = new RegExp(`^(?:${RACE_PATTERN}|${ATTRIBUTE_PATTERN})$`, "i");
const NOT_TREATED_AS = "\\(This card is not treated as an? (\".*?\") card\\.\\)";
const MENTIONED_QUOTES = "\"(.*?)\"";
const NAME_IDENTITY =
  /\(This card(?:'s name is always treated as| is also always treated as| is always treated as) "([^"]+)"\.\)/gi;
const HEX_BASE_SETCODE = 0xfff;

const IGNORE_ARCHETYPES = new Set([
  "genex ally",
  "xx-saber",
  "evol",
  "dark lucius",
  "ultimate insect",
  "iron",
  "tin",
  "lightray",
  "djinn of rituals",
  "noble",
  "envy",
  "spiritual beast tamer",
  "entity",
  "supreme king",
  "spiritual art",
  "of the forest",
  "byssted",
  "kshatri-la",
  "purery",
  "earthbound servant",
  "infernoble",
  "helios",
]);

const ARCH_REPLACES: Record<number, number> = {
  0xa2: 0x98,
  0x16c: 0x48,
};

const EXTRA_ARCHETYPES: Record<string, number> = {
  "true draco": 0xf9,
  "true king": 0xf9,
  magician: 0x98,
};

const BASE_ARCH_EXCEPTIONS: Record<number, number[]> = {
  0x507a: [0x107a],
  0x607a: [0x207a],
  0x10a2: [0x10a2],
  0x20a2: [0x20a2],
  0x30a2: [0x10a2, 0x20a2],
  0x1048: [0x48, 0xcf],
  0x5048: [0x48, 0xcf],
  0x1073: [0xcf, 0x73],
  0x307b: [0x7b, 0x1ab],
};

interface EngineCard {
  id: number;
  ot: number;
  alias: number;
  type: number;
  race: number;
  attribute: number;
  name: string;
  desc: string;
  setcodes: number[];
  identityNames: string[];
}

interface Domain {
  attributes: Set<number>;
  races: Set<number>;
  setcodes: Set<number>;
  namedCards: Set<string>;
}

interface Catalog {
  mtime: number;
  cards: Map<number, EngineCard>;
  hexName: Map<number, string>;
  nameHex: Map<string, number>;
  constants: Map<string, number>;
  scripts: Map<number, string>;
  quoteCardNames: string[];
}

const catalogs = new Map<string, Catalog>();

function fail(message: string): never {
  throw new DeckLegalityError(message);
}

function unpackSetcodes(setcode: bigint): number[] {
  const codes: number[] = [];
  for (let shift = 0n; shift <= 48n; shift += 16n) {
    const code = Number((setcode >> shift) & 0xffffn);
    if (code > 0) codes.push(code);
  }
  return codes;
}

function parseNameIdentity(desc: string): string[] {
  const names: string[] = [];
  NAME_IDENTITY.lastIndex = 0;
  for (const match of desc.matchAll(NAME_IDENTITY)) {
    const name = match[1]?.trim();
    if (name) names.push(name.toLowerCase());
  }
  return names;
}

function parseSetnames(text: string): { hexName: Map<number, string>; nameHex: Map<string, number> } {
  const hexName = new Map<number, string>();
  const nameHex = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^!setname\s+(0x[0-9a-fA-F]+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const code = Number.parseInt(match[1], 16);
    for (const raw of match[2].split("|")) {
      const name = raw.trim().toLowerCase();
      if (!name) continue;
      hexName.set(code, name);
      nameHex.set(name, code);
    }
  }
  for (const [from, to] of Object.entries(ARCH_REPLACES)) {
    const original = Number(from);
    const name = hexName.get(original);
    if (!name) continue;
    hexName.delete(original);
    hexName.set(to, name);
    nameHex.set(name, to);
  }
  for (const name of IGNORE_ARCHETYPES) {
    const code = nameHex.get(name);
    if (code === undefined) continue;
    nameHex.delete(name);
    if (hexName.get(code) === name) hexName.delete(code);
  }
  for (const [name, code] of Object.entries(EXTRA_ARCHETYPES)) nameHex.set(name, code);
  return { hexName, nameHex };
}

function parseLuaConstants(text: string, into: Map<string, number>): void {
  const pattern = /^(CARD|SET)_[A-Z0-9_]+\s*=\s*(0x[0-9A-Fa-f]+|\d+)/gm;
  for (const match of text.matchAll(pattern)) {
    const value = match[2].startsWith("0x") || match[2].startsWith("0X") ? Number.parseInt(match[2], 16) : Number(match[2]);
    if (Number.isFinite(value)) into.set(match[0].split(/\s*=/)[0]!.trim(), value);
  }
}

function indexScripts(directory: string): Map<number, string> {
  const scripts = new Map<number, string>();
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const match = /^c(\d+)\.lua$/.exec(entry.name);
      if (!match) continue;
      const id = Number(match[1]);
      const previous = scripts.get(id);
      if (!previous || path.includes(`${sep}official${sep}`)) scripts.set(id, path);
    }
  };
  walk(directory);
  return scripts;
}

function loadCatalog(dataDirectory: string): Catalog {
  const root = resolve(dataDirectory);
  const cdbPath = join(root, "cards.cdb");
  const stringsPath = join(root, "strings.conf");
  if (!existsSync(cdbPath)) fail(`Cannot read engine card database at ${cdbPath}`);
  if (!existsSync(stringsPath)) fail(`Cannot read engine strings.conf at ${stringsPath}`);
  const mtime = statSync(cdbPath).mtimeMs;
  const cached = catalogs.get(root);
  if (cached && cached.mtime === mtime) return cached;

  const db = new Database(cdbPath, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  const cards = new Map<number, EngineCard>();
  try {
    const rows = db
      .prepare(
        "SELECT datas.id, datas.ot, datas.alias, datas.setcode, datas.type, datas.race, datas.attribute, texts.name, texts.desc FROM datas JOIN texts USING (id)",
      )
      .all() as Array<{
      id: bigint;
      ot: bigint;
      alias: bigint;
      setcode: bigint;
      type: bigint;
      race: bigint;
      attribute: bigint;
      name: string;
      desc: string;
    }>;
    for (const row of rows) {
      const id = Number(row.id);
      const name = row.name ?? "";
      const desc = row.desc ?? "";
      const identity = new Set<string>([name.toLowerCase(), ...parseNameIdentity(desc)]);
      cards.set(id, {
        id,
        ot: Number(row.ot),
        alias: Number(row.alias),
        type: Number(row.type),
        race: Number(row.race),
        attribute: Number(row.attribute),
        name,
        desc,
        setcodes: unpackSetcodes(BigInt(row.setcode)),
        identityNames: [...identity],
      });
    }
  } finally {
    db.close();
  }

  for (const card of cards.values()) {
    if (!card.alias) continue;
    const original = cards.get(card.alias);
    if (!original) fail(`Unknown alias ${card.alias} for card ${card.id} (${card.name})`);
    if (!card.identityNames.includes(original.name.toLowerCase())) card.identityNames.push(original.name.toLowerCase());
  }

  const { hexName, nameHex } = parseSetnames(readFileSync(stringsPath, "utf8"));
  const scriptsDir = join(root, "card-scripts");
  const constants = new Map<string, number>();
  const scripts = existsSync(scriptsDir) ? indexScripts(scriptsDir) : new Map<number, string>();
  if (existsSync(scriptsDir)) {
    for (const file of ["card_counter_constants.lua", "archetype_setcode_constants.lua"]) {
      const path = join(scriptsDir, file);
      if (existsSync(path)) parseLuaConstants(readFileSync(path, "utf8"), constants);
    }
  }

  const quoteCardNames = [...new Set([...cards.values()].map((card) => card.name).filter((name) => name.includes('"')))];
  const catalog: Catalog = { mtime, cards, hexName, nameHex, constants, scripts, quoteCardNames };
  catalogs.set(root, catalog);
  return catalog;
}

function baseArchetypes(code: number, catalog: Catalog): number[] | null {
  const exception = BASE_ARCH_EXCEPTIONS[code];
  if (exception) return exception;
  const base = code & HEX_BASE_SETCODE;
  if (catalog.hexName.has(base)) return [base];
  if (catalog.hexName.has(code)) return [code];
  return null;
}

function expandSetcodes(codes: Iterable<number>, catalog: Catalog): Set<number> {
  const expanded = new Set<number>();
  for (const code of codes) {
    const bases = baseArchetypes(code, catalog);
    if (bases) for (const base of bases) expanded.add(base);
  }
  return expanded;
}

function cleanDesc(text: string, regex: string): { matches: Set<string>; cleaned: string } {
  const matches = new Set<string>();
  const cleaned = text.replace(new RegExp(regex, "gi"), (...args) => {
    const groups = args.slice(1, -2) as Array<string | undefined>;
    const captured = groups.find((group) => group !== undefined);
    if (captured) matches.add(captured.toLowerCase());
    return "";
  });
  return { matches, cleaned };
}

function extractTable(source: string, field: "listed_names" | "listed_series"): string | null {
  const match = source.match(new RegExp(`\\b${field}\\s*=\\s*\\{`, "i"));
  if (!match || match.index === undefined) return null;
  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < source.length; index++) {
    const ch = source[index];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(match.index + match[0].length, index);
    }
  }
  fail(`Malformed ${field} table in engine script`);
}

function resolveScriptToken(token: string, cardId: number, catalog: Catalog): number {
  const trimmed = token.trim();
  if (!trimmed) fail(`Empty identifier in listed names/series for card ${cardId}`);
  if (trimmed.toLowerCase() === "id") return cardId;
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed, 16);
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const constant = catalog.constants.get(trimmed);
  if (constant === undefined) fail(`Cannot resolve script identifier ${trimmed} for card ${cardId}`);
  return constant;
}

function listedValues(cardId: number, field: "listed_names" | "listed_series", catalog: Catalog): number[] {
  // Alternate-art script wrappers need not repeat their main's Domain metadata.
  cardId = canonicalCardCode(cardId, catalog.cards);
  const path = catalog.scripts.get(cardId);
  if (!path) return [];
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    fail(`Cannot read engine script at ${path}`);
  }
  const body = extractTable(source, field);
  if (body === null) return [];
  const values: number[] = [];
  for (const raw of body.split(",")) {
    const token = raw.replace(/--.*$/, "").trim();
    if (!token) continue;
    values.push(resolveScriptToken(token, cardId, catalog));
  }
  return values;
}

function isMonster(card: EngineCard): boolean {
  return (card.type & TYPE_MONSTER) === TYPE_MONSTER && (card.type & TYPE_TOKEN) === 0;
}

function isExtraDeckMonster(card: EngineCard): boolean {
  return isMonster(card) && (card.type & TYPE_EXTRA) !== 0;
}

function isPlayable(card: EngineCard): boolean {
  if ((card.type & UNPLAYABLE_TYPES) !== 0) return false;
  if ((card.ot & (OT_OCG | OT_TCG)) === 0) return false;
  if ((card.ot & OT_RUSH) !== 0) return false;
  if ((card.ot & (OT_ILLEGAL | OT_VIDEO_GAME | OT_CUSTOM | OT_HIDDEN)) !== 0) return false;
  return true;
}

function deckMasterTypeProblem(card: EngineCard): string | null {
  if ((card.type & (TYPE_SPELL | TYPE_TRAP)) !== 0) {
    return "You can't use a Spell or Trap as your Deck Master.";
  }
  if (!isMonster(card) || !isPlayable(card)) return "Deck Master must be a playable monster card";
  return null;
}

/** Checks an engine-normalized master without requiring a complete saved deck. */
export function validateDeckMasterType(mode: DuelMode, deck: DuelDeck, dataDirectory: string): void {
  if (mode !== "domain" || deck.deckMaster === undefined) return;
  const card = readCard(loadCatalog(dataDirectory), deck.deckMaster);
  if (!card) fail(`Unknown card ${deck.deckMaster}`);
  const problem = deckMasterTypeProblem(card);
  if (problem) fail(problem);
}

function readCard(catalog: Catalog, id: number): EngineCard | undefined {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return catalog.cards.get(id);
}

function unionFind(): { find(name: string): string; union(a: string, b: string): void } {
  const parent = new Map<string, string>();
  const find = (name: string): string => {
    const current = parent.get(name) ?? name;
    if (!parent.has(name)) parent.set(name, name);
    if (current !== name) {
      const root = find(current);
      parent.set(name, root);
      return root;
    }
    return name;
  };
  const union = (a: string, b: string) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(left, right);
  };
  return { find, union };
}

function identityIndex(catalog: Catalog): { find(name: string): string } {
  const uf = unionFind();
  for (const card of catalog.cards.values()) {
    const names = card.identityNames;
    const first = names[0];
    if (!first) continue;
    for (const name of names) uf.union(first, name);
  }
  return uf;
}

function componentOf(card: EngineCard, identities: { find(name: string): string }): string {
  const name = card.identityNames[0] ?? card.name.toLowerCase();
  return identities.find(name);
}

function domainEffectText(dm: EngineCard): string {
  if ((dm.type & TYPE_NORMAL) === 0) return dm.desc;
  if ((dm.type & TYPE_PENDULUM) === 0) return "";
  // Normal Pendulums have an effect box above their separate flavor/monster box.
  return /\[\s*Pendulum Effect\s*\]([\s\S]*?)(?:\[\s*(?:Monster Effect|Flavor Text)\s*\]|$)/i.exec(dm.desc)?.[1] ?? "";
}

function buildDomain(dm: EngineCard, catalog: Catalog): Domain {
  const attributes = new Set<number>([dm.attribute, ATTRIBUTE_DIVINE]);
  const races = new Set<number>([dm.race, RACE_DIVINE]);
  const setcodes = new Set<number>(dm.setcodes);
  const namedCards = new Set<string>();

  const addNamed = (name: string) => {
    if (name.toLowerCase() === dm.name.toLowerCase()) return;
    let match: EngineCard | undefined;
    for (const card of catalog.cards.values()) {
      if (card.name.toLowerCase() !== name) continue;
      if (!match || (match.alias !== 0 && card.alias === 0)) match = card;
    }
    if (!match) return;
    namedCards.add(match.name.toLowerCase());
    for (const code of match.setcodes) setcodes.add(code);
  };

  let text = domainEffectText(dm);
  if (text) {
    ({ cleaned: text } = cleanDesc(text, NOT_TREATED_AS));
    if (catalog.quoteCardNames.length > 0) {
      const quoteCards = catalog.quoteCardNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const quotes = cleanDesc(text, `"(${quoteCards})"`);
      text = quotes.cleaned;
      for (const name of quotes.matches) addNamed(name);
    }
    const mentions = cleanDesc(text, MENTIONED_QUOTES);
    text = mentions.cleaned;
    for (const mention of mentions.matches) {
      const archetype = catalog.nameHex.get(mention);
      if (archetype !== undefined) setcodes.add(archetype);
      else addNamed(mention);
      // A quoted Attribute/Type label is a mention; words inside card names are not.
      if (archetype === undefined && QUOTED_DOMAIN_MENTION.test(mention)) text += ` ${mention}`;
    }
    const raceMentions = cleanDesc(text, RACE_PATTERN);
    text = raceMentions.cleaned;
    for (const race of raceMentions.matches) {
      const key = race.replace(/\W/g, "").replace(/^fairies$/, "fairy").replace(/^fishes$/, "fish");
      const raceCode = RACES[key === "divinebeast" ? "divine" : key];
      if (raceCode === undefined) fail(`Unknown mentioned Type "${race}" on ${dm.name}`);
      races.add(raceCode);
    }
    const attributeMentions = cleanDesc(text, ATTRIBUTE_PATTERN);
    for (const attribute of attributeMentions.matches) {
      const code = ATTRIBUTES[attribute];
      if (code === undefined) fail(`Unknown mentioned Attribute "${attribute}" on ${dm.name}`);
      attributes.add(code);
    }
  }

  for (const id of listedValues(dm.id, "listed_names", catalog)) {
    const named = catalog.cards.get(id);
    if (!named) fail(`Unknown listed_names passcode ${id} on ${dm.name}`);
    addNamed(named.name.toLowerCase());
  }
  for (const code of listedValues(dm.id, "listed_series", catalog)) setcodes.add(code);

  return {
    attributes,
    races,
    setcodes: expandSetcodes(setcodes, catalog),
    namedCards,
  };
}

function inDomain(card: EngineCard, domain: Domain, catalog: Catalog): boolean {
  if (domain.attributes.has(card.attribute) || domain.races.has(card.race)) return true;
  if (domain.namedCards.has(card.name.toLowerCase())) return true;
  for (const code of expandSetcodes(card.setcodes, catalog)) {
    if (domain.setcodes.has(code)) return true;
  }
  return false;
}

interface LocatedCard {
  section: "main" | "extra" | "side";
  index: number;
  code: number;
  card: EngineCard;
}

function locatedRef(item: LocatedCard): DuelDeckCardRef {
  return { section: item.section, index: item.index, code: item.code, name: item.card.name };
}

function playableSectionMessage(card: EngineCard, section: "main" | "extra" | "side"): string | undefined {
  if (!isPlayable(card)) return `${card.name} is not a playable deck card`;
  const extra = isExtraDeckMonster(card);
  if (section === "extra") {
    if (!extra) return `${card.name} belongs in the Main Deck`;
    return undefined;
  }
  if (extra) return `${card.name} belongs in the Extra Deck`;
  return undefined;
}

function listedLimitForIdentity(
  key: string,
  identities: { find(name: string): string },
  catalog: Catalog,
  limits: Record<number, BanlistLimit>,
): number | undefined {
  let listed: number | undefined;
  for (const card of catalog.cards.values()) {
    if (componentOf(card, identities) !== key) continue;
    for (const code of [card.id, card.alias]) {
      if (!code || !Object.hasOwn(limits, code)) continue;
      listed = listed === undefined ? limits[code] : Math.min(listed, limits[code]);
    }
  }
  return listed;
}

function cardPoolMessage(card: EngineCard, pool: DuelCardPool): string | undefined {
  if (pool === "tcg") {
    if ((card.ot & OT_TCG) === 0) return `${card.name} is not TCG legal`;
    return undefined;
  }
  if (pool === "ocg") {
    if ((card.ot & OT_OCG) === 0) return `${card.name} is not OCG legal`;
  }
  return undefined;
}

function cardScriptMessage(card: EngineCard, catalog: Catalog): string | undefined {
  if ((card.type & SCRIPT_TYPES) === 0) return undefined;
  if (catalog.scripts.has(card.id)) return undefined;
  if (card.alias !== 0 && catalog.scripts.has(card.alias)) return undefined;
  if (catalog.scripts.has(canonicalCardCode(card.id, catalog.cards))) return undefined;
  return `${card.name} is missing a card script`;
}

function engineLoadableMessage(
  card: EngineCard,
  section: "main" | "extra" | "side",
  catalog: Catalog,
  pool: DuelCardPool | undefined,
): string | undefined {
  return (
    playableSectionMessage(card, section) ??
    (pool ? cardPoolMessage(card, pool) : undefined) ??
    (pool !== undefined ? cardScriptMessage(card, catalog) : undefined)
  );
}

function resolveSection(
  catalog: Catalog,
  section: "main" | "extra" | "side",
  ids: number[],
  issues: DuelDeckIssue[],
): LocatedCard[] {
  const located: LocatedCard[] = [];
  for (let index = 0; index < ids.length; index++) {
    const code = ids[index]!;
    const card = readCard(catalog, code);
    if (!card) {
      issues.push({ message: `Unknown card ${code}`, cards: [{ section, index, code }] });
      continue;
    }
    located.push({ section, index, code, card });
  }
  return located;
}

function collectLoadableIssues(
  items: LocatedCard[],
  sectionFor: (item: LocatedCard) => "main" | "extra" | "side",
  catalog: Catalog,
  pool: DuelCardPool | undefined,
  issues: DuelDeckIssue[],
): void {
  for (const item of items) {
    const message = engineLoadableMessage(item.card, sectionFor(item), catalog, pool);
    if (message) issues.push({ message, cards: [locatedRef(item)] });
  }
}

function collectCopyLimitIssues(
  cards: LocatedCard[],
  identities: { find(name: string): string },
  formatMax: number,
  catalog: Catalog,
  limits: Record<number, BanlistLimit> | null,
  issues: DuelDeckIssue[],
): void {
  const groups = new Map<string, LocatedCard[]>();
  for (const item of cards) {
    const key = componentOf(item.card, identities);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const [key, group] of groups) {
    let max = formatMax;
    if (limits) {
      const listed = listedLimitForIdentity(key, identities, catalog, limits);
      if (listed !== undefined) max = Math.min(max, listed);
    }
    if (group.length <= max) continue;
    const lead = group[0];
    if (!lead) continue;
    const name = lead.card.identityNames[0] ?? lead.card.name;
    const message =
      max === 0
        ? `${name} is forbidden`
        : formatMax === 1
          ? `Duplicate card: ${name}`
          : `More than ${max} ${max === 1 ? "copy" : "copies"} of ${name}`;
    const offending = max === 0 ? group : group.slice(max);
    issues.push({ message, cards: offending.map(locatedRef) });
  }
}

function collectMultiplayerIssues(
  cards: LocatedCard[],
  table: MultiplayerTable,
  deckMaster: EngineCard | undefined,
  issues: DuelDeckIssue[],
): void {
  if (table === "1v1") return;
  const label = MULTIPLAYER_TABLE_LABEL[table];
  const groups = new Map<number, DuelDeckCardRef[]>();
  const add = (card: EngineCard, ref: DuelDeckCardRef) => {
    const entry = multiplayerForbiddenFor(table, card.id, card.alias);
    if (!entry) return;
    const refs = groups.get(entry.code);
    if (refs) refs.push(ref);
    else groups.set(entry.code, [ref]);
  };
  for (const item of cards) add(item.card, locatedRef(item));
  if (deckMaster) add(deckMaster, { section: "deckMaster", index: 0, code: deckMaster.id, name: deckMaster.name });
  for (const [code, refs] of groups) {
    const entry = multiplayerForbiddenFor(table, code);
    if (!entry) continue;
    issues.push({ message: `${entry.name} is forbidden in ${label}: ${entry.reason}`, cards: refs });
  }
}

function collectBlockedIssues(deck: DuelDeck, catalog: Catalog, issues: DuelDeckIssue[], dataDirectory: string, entries?: readonly CardBlockEntry[]): void {
  const blocked = cardBlockIndex(catalog.cards, entries, dataDirectory);
  const groups = new Map<CardBlockEntry, DuelDeckCardRef[]>();
  const add = (section: DuelDeckCardRef["section"], code: number, index: number) => {
    const entry = blocked.get(code);
    if (!entry) return;
    const name = catalog.cards.get(code)?.name;
    const ref = { section, index, code, ...(name ? { name } : {}) };
    const refs = groups.get(entry) ?? [];
    refs.push(ref);
    groups.set(entry, refs);
  };
  for (const section of ["main", "extra", "side"] as const) {
    deck[section].forEach((code, index) => add(section, code, index));
  }
  if (deck.deckMaster !== undefined) add("deckMaster", deck.deckMaster, 0);
  // Put operational blocks first so duel admission gives the card and the configured reason.
  issues.unshift(...[...groups].map(([entry, cards]) => ({
    message: `${catalog.cards.get(entry.code)?.name ?? cards[0]?.name ?? entry.code} is unavailable: ${entry.reason}`,
    cards,
  })));
}

export function inspectDeck(
  mode: DuelMode,
  deck: DuelDeck,
  dataDirectory: string,
  settings?: DuelSettings,
  options: InspectDeckOptions = {},
): DuelDeckValidation {
  const table: MultiplayerTable = options.table ?? "1v1";
  if (mode !== "normal" && mode !== "domain") {
    return { issues: [{ message: `Unknown duel mode ${String(mode)}`, cards: [] }] };
  }
  if (!Array.isArray(deck?.main) || !Array.isArray(deck.extra) || !Array.isArray(deck.side)) {
    return { issues: [{ message: "Deck must include main, extra, and side arrays", cards: [] }] };
  }

  const remaps = loadCardPasscodeRemaps(dataDirectory);
  deck = mapDeckCodes(deck, code => remaps.get(code) ?? code);
  const issues: DuelDeckIssue[] = [];
  const competitive = settings ? settings.validateDeck : true;
  let limits: Record<number, BanlistLimit> | null = null;
  if (settings) {
    try {
      limits = banlistLimitsFor(settings.banlist);
    } catch {
      return { issues: [{ message: `Unknown banlist ${settings.banlist}`, cards: [] }] };
    }
  }

  const mainOversize = deck.main.length > 60;
  if (mainOversize) {
    issues.push({
      message:
        competitive && mode === "normal"
          ? "Main Deck must have 40-60 cards"
          : competitive && mode === "domain"
            ? "Main Deck must have exactly 60 cards"
            : "Main Deck must have 60 or fewer cards",
      cards: [],
    });
  }
  if (deck.extra.length > 15) issues.push({ message: "Extra Deck must have 15 or fewer cards", cards: [] });
  if (deck.side.length > 15) issues.push({ message: "Side Deck must have 15 or fewer cards", cards: [] });

  const catalog = loadCatalog(dataDirectory);
  collectBlockedIssues(deck, catalog, issues, dataDirectory, options.cardBlocks);
  const identities = identityIndex(catalog);
  const main = resolveSection(catalog, "main", deck.main, issues);
  const extra = resolveSection(catalog, "extra", deck.extra, issues);
  const side = resolveSection(catalog, "side", deck.side, issues);
  const cardPool = settings?.cardPool;

  if (settings && deck.main.length < settings.startingHand) {
    issues.push({ message: `Main Deck must have at least ${settings.startingHand} cards`, cards: [] });
  }

  const collectEngineCards = () => {
    collectLoadableIssues(main, () => "main", catalog, cardPool, issues);
    collectLoadableIssues(extra, () => "extra", catalog, cardPool, issues);
    collectLoadableIssues(side, (item) => (isExtraDeckMonster(item.card) ? "extra" : "side"), catalog, cardPool, issues);
  };

  if (mode === "normal") {
    if (competitive && deck.deckMaster !== undefined) {
      const master = readCard(catalog, deck.deckMaster);
      issues.push({
        message: "Normal Format does not use a Deck Master",
        cards: [
          master
            ? { section: "deckMaster", index: 0, code: deck.deckMaster, name: master.name }
            : { section: "deckMaster", index: 0, code: deck.deckMaster },
        ],
      });
    }
    if (competitive && !mainOversize && (deck.main.length < 40 || deck.main.length > 60)) {
      issues.push({ message: "Main Deck must have 40-60 cards", cards: [] });
    }
    collectEngineCards();
    collectMultiplayerIssues([...main, ...extra, ...side], table, undefined, issues);
    if (options.draftPool) {
      const resolve = (code: number) => canonicalCardCode(remaps.get(code) ?? code, catalog.cards);
      for (const issue of checkDeckAgainstPool(deck, options.draftPool.counts, resolve, options.draftPool.forcedCopies)) {
        issues.push({
          message: `${readCard(catalog, issue.code)?.name ?? issue.code}: at most ${issue.available} copies allowed by your draft picks (${issue.used} used)`,
          cards: [...main, ...extra, ...side].filter((item) => resolve(item.code) === issue.code).map(locatedRef),
        });
      }
    } else if (competitive) collectCopyLimitIssues([...main, ...extra, ...side], identities, 3, catalog, limits, issues);
    return { issues };
  }

  let dm: EngineCard | undefined;
  let dmValid = false;
  if (deck.deckMaster === undefined) {
    issues.push({ message: "Deck Master is required for Domain Format", cards: [] });
  } else {
    dm = readCard(catalog, deck.deckMaster);
    if (!dm) {
      issues.push({
        message: `Unknown card ${deck.deckMaster}`,
        cards: [{ section: "deckMaster", index: 0, code: deck.deckMaster }],
      });
    } else {
      const dmRef: DuelDeckCardRef = { section: "deckMaster", index: 0, code: deck.deckMaster, name: dm.name };
      const typeProblem = deckMasterTypeProblem(dm);
      if (typeProblem) {
        issues.push({ message: typeProblem, cards: [dmRef] });
      } else {
        dmValid = true;
        if (cardPool) {
          const message = cardPoolMessage(dm, cardPool);
          if (message) issues.push({ message, cards: [dmRef] });
        }
        if (settings) {
          const message = cardScriptMessage(dm, catalog);
          if (message) issues.push({ message, cards: [dmRef] });
        }
      }
    }
  }

  if (competitive) {
    if (!mainOversize && deck.main.length !== 60) {
      issues.push({ message: "Main Deck must have exactly 60 cards", cards: [] });
    }
    if (deck.side.length !== 0) {
      issues.push({
        message: "Domain Format does not use a Side Deck; put the Deck Master in deckMaster",
        cards: deck.side.map((code, index) => {
          const card = readCard(catalog, code);
          return card
            ? { section: "side" as const, index, code, name: card.name }
            : { section: "side" as const, index, code };
        }),
      });
    }
  }

  collectEngineCards();
  // The engine cannot play these cards at a multiplayer table, so casual tables check them too.
  collectMultiplayerIssues([...main, ...extra, ...side], table, dmValid ? dm : undefined, issues);
  if (!competitive) return { issues };

  const copies = [...main, ...extra];
  if (dmValid && dm) {
    const dmKey = componentOf(dm, identities);
    if (limits && listedLimitForIdentity(dmKey, identities, catalog, limits) === 0) {
      issues.push({
        message: `${dm.name} is forbidden`,
        cards: [{ section: "deckMaster", index: 0, code: dm.id, name: dm.name }],
      });
    }
    const found = copies.filter((item) => componentOf(item.card, identities) === dmKey);
    if (found.length) {
      issues.push({
        message: `Deck Master ${dm.name} cannot appear in the Main, Extra, or Side Deck`,
        cards: found.map(locatedRef),
      });
    }
  }
  collectCopyLimitIssues(copies, identities, 1, catalog, limits, issues);
  if (dmValid && dm) {
    const domain = buildDomain(dm, catalog);
    for (const item of copies) {
      if (!isMonster(item.card)) continue;
      if (!inDomain(item.card, domain, catalog)) {
        issues.push({
          message: `${item.card.name} is outside the Deck Master's Domain`,
          cards: [locatedRef(item)],
        });
      }
    }
  }
  return { issues };
}

export function validateDeck(
  mode: DuelMode,
  deck: DuelDeck,
  dataDirectory: string,
  settings?: DuelSettings,
  options: InspectDeckOptions = {},
): void {
  const issue = inspectDeck(mode, deck, dataDirectory, settings, options).issues[0];
  if (issue) fail(issue.message);
}
