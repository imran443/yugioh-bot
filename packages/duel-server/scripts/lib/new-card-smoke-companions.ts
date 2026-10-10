import type { DeckCardInfo } from "@yugidraft/shared/duels";
import { loadCardDatabase, type CardDatabase } from "../../src/cards.js";

export const smokeIsSetCard = (candidate: number, requested: number): boolean =>
  (candidate & 0xfff) === (requested & 0xfff) && (candidate & requested) === requested;
const EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;
const indexes = new WeakMap<CardDatabase, { constants: Map<string, number>; mentions: Map<number, Set<number>> }>();
const constantsIn = (text: string) => [...text.matchAll(/\b((?:CARD|SET|RACE)_[A-Z0-9_]+)\s*=\s*(0x[\da-f]+|\d+)/gi)].map(m => [m[1]!, Number(m[2])] as const);
function listed(text: string, field: string, constants: Map<string, number>, code: number): number[] {
  const body = new RegExp(`\\b${field}\\s*=\\s*\\{([^}]+)\\}`).exec(text)?.[1] ?? "";
  return [...body.matchAll(/\b(?:0x[\da-f]+|\d+|(?:CARD|SET)_[A-Z0-9_]+|id)\b/gi)]
    .map(m => m[0] === "id" ? code : constants.get(m[0]) ?? Number(m[0])).filter(Number.isFinite);
}
function supportIndex(cards: CardDatabase) {
  let index = indexes.get(cards);
  if (index) return index;
  const constants = new Map(["constant.lua", "archetype_setcode_constants.lua", "card_counter_constants.lua"].flatMap(name => constantsIn(cards.readScript(name) ?? "")));
  const mentions = new Map<number, Set<number>>();
  for (const card of cards.all()) {
    if (card.alias || card.type! & (0x4000 | 0x8000000 | 0x10000000)) continue;
    const text = cards.readScript(`c${card.code}.lua`) ?? "";
    const local = new Map([...constants, ...constantsIn(text)]);
    for (const named of listed(text, "listed_names", local, card.code)) {
      const codes = mentions.get(named) ?? new Set<number>(); codes.add(card.code); mentions.set(named, codes);
    }
  }
  index = { constants, mentions }; indexes.set(cards, index); return index;
}

export function companionOptions(code: number, directory: string) {
  const cards = loadCardDatabase(directory), tested = cards.cardData(code)!, info = cards.get(code)!;
  const script = cards.readScript(`c${code}.lua`) ?? "";
  const index = supportIndex(cards), constants = new Map([...index.constants, ...constantsIn(script)]);
  const names = [...info.description.matchAll(/["“]([^"”]+)["”]/g)].map(m => m[1]!.toLowerCase());
  const eligible = [...cards.all()].filter(c => c.code !== code && c.code !== info.canonicalPasscode && !c.alias && !(c.type! & (0x4000 | 0x8000000 | 0x10000000)));
  const named = new Set([...listed(script, "listed_names", constants, code), ...eligible.filter(c => names.includes(c.name.toLowerCase())).map(c => c.code)]);
  const series = [...tested.setcodes, ...[...script.matchAll(/\bSET_[A-Z0-9_]+\b/g)].map(m => constants.get(m[0])).filter((n): n is number => n != null),
    ...[...cards.setnames()].filter(([, name]) => names.includes(name.toLowerCase())).map(([set]) => set)];
  const mentioned = new Set(/\bmentions\b/i.test(info.description) ? [...named].flatMap(n => [...index.mentions.get(n) ?? []]) : []);
  const races = new Set([...script.matchAll(/\bRACE_[A-Z0-9_]+\b/g)].map(m => constants.get(m[0])).filter((n): n is number => n != null && n !== 0x3ffffff));
  const inSeries = (c: DeckCardInfo) => cards.cardData(c.code)!.setcodes.some(s => series.some(t => smokeIsSetCard(s, t)));
  const family = eligible.filter(c => named.has(c.code) || mentioned.has(c.code) || inSeries(c))
    .sort((a, b) => (named.has(a.code) ? 0 : mentioned.has(a.code) ? 1 : 2) - (named.has(b.code) ? 0 : mentioned.has(b.code) ? 1 : 2) || a.code - b.code);
  const typed = eligible.filter(c => (c.type! & 1) && [...races].some(r => cards.cardData(c.code)!.race & BigInt(r)))
    .sort((a, b) => ((a.type! & 0x10) ? 0 : 1) - ((b.type! & 0x10) ? 0 : 1) || (a.level ?? 0) - (b.level ?? 0) || a.code - b.code);
  const main = [...new Set([...family.filter(c => c.type! & 2).slice(0, 2), ...family.filter(c => c.type! & 4).slice(0, 2),
    ...family.filter(c => !(c.type! & EXTRA)), ...typed.filter(c => !(c.type! & EXTRA)).slice(0, 4)].map(c => c.code))].slice(0, 16);
  const extra = [...new Set([...family.filter(c => (c.type! & 1) && (c.type! & EXTRA)),
    ...[0x40, 0x2000, 0x800000, 0x4000000].flatMap(mask => typed.filter(c => c.type! & mask).slice(0, 2))].map(c => c.code))].slice(0, 16);
  const placesFamilyExtra = family.some(c => /place 1 "[^"]+" monster from your Extra Deck.*?Spell & Trap Zone.*?Continuous Spell/is.test(c.description));
  const synchroMaterial = (tested.type & 0x2000) && tested.level > 3 ? eligible.find(c =>
    (c.type! & (0x11 | 0x4000 | EXTRA)) === 0x11 && cards.cardData(c.code)!.level === tested.level - 3)?.code : undefined;
  const levels = new Set([...info.description.matchAll(/\bLevel (\d+)\b/g)].map(m => Number(m[1])));
  const handCompanions = family.filter(c => !(c.type! & EXTRA)).sort((a, b) =>
    (named.has(a.code) ? 0 : levels.has(a.level ?? 0) ? 1 : 2) - (named.has(b.code) ? 0 : levels.has(b.level ?? 0) ? 1 : 2)).slice(0, 6).map(c => c.code);
  return { companions: main, handCompanions, extraCompanions: extra,
    typeCompanions: typed.filter(c => !(c.type! & EXTRA)).slice(0, 2).map(c => c.code),
    spellCompanions: family.filter(c => (c.type! & 1) && (/(?:as a|treated as a) Continuous Spell/i.test(c.description) || (placesFamilyExtra && (c.type! & EXTRA)))).slice(0, 5).map(c => c.code),
    synchroMaterial,
    fieldSpellCompanion: family.find(c => c.type! & 0x80000)?.code,
    fieldCompanion: (family.find(c => (c.type! & 1) && named.has(c.code)) ?? family.find(c => (c.type! & 1) && !(c.type! & EXTRA)) ?? family.find(c => (c.type! & 1) && (c.type! & EXTRA)))?.code };
}
