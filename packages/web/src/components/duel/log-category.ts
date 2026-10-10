// Colour categories for the duel log. Pure, no React, no DOM.
//
// Live Text, history and replay logs colour an entry by what kind of action it was, so the log can be scanned at a glance:
//   summon    Normal, Tribute, Flip, Special and every Extra Deck summon. The method (Fusion, Synchro, Xyz, Link,
//             Ritual, Pendulum, or "monster" for the rest) picks the badge fill and the label colour.
//   chain     activations and chain links (gold, the chain colour everywhere in the duel).
//   battle    attacks, direct attacks, damage and LP paid.
//   destroy   destroyed, including field departures the engine rewrites to "was destroyed".
//   graveyard sent to the Graveyard or discarded, except for Tributes and materials below.
//   material  Tributed or used as material: muted, so a combo turn does not read as a board wipe. In the Text log,
//             the Graveyard sends directly above a summon that takes materials (categoriesForLog).
//   banish    banished.
//   set       Set face-down.
//   hand      drawn, added to hand, or returned to the hand, Deck or Extra Deck.
//   system    LP gained, position changes, flips face-up, reveals and confirms, coin tosses, shuffles.
//
// Colour is never the only cue: every category comes with its own icon and the entry keeps its text label.
// The category is read only from what the entry already shows (its icon kind and action label, or the log text
// the viewer was sent), never from the card, so colour can never say more about a hidden card than the text does.
import type { HistoryEntry, HistoryIconKind } from "./history-entries";

export type LogCategory = "summon" | "chain" | "battle" | "destroy" | "graveyard" | "material" | "banish" | "set" | "hand" | "system";

/** Which card frame a summon echoes. "monster" covers Normal, Tribute, Flip and plain Special Summons. */
export type SummonMethod = "monster" | "fusion" | "synchro" | "xyz" | "link" | "ritual" | "pendulum";

export const LOG_CATEGORIES: readonly LogCategory[] = ["summon", "chain", "battle", "destroy", "graveyard", "material", "banish", "set", "hand", "system"];

export const LOG_CATEGORY_LABEL: Record<LogCategory, string> = {
  summon: "Summon",
  chain: "Activation and chain",
  battle: "Battle and damage",
  destroy: "Destroyed",
  graveyard: "Sent to Graveyard",
  material: "Tributed or used as material",
  banish: "Banished",
  set: "Set face-down",
  hand: "Draw, add to hand or return",
  system: "Life Points, position and game",
};

/**
 * The category of a history-list icon kind.
 *
 * The switch is exhaustive: a new icon kind (an "add to hand" search or a reveal/confirm event, say) fails
 * typecheck here until it is given a category. Add to hand belongs in "hand"; a reveal or confirm in "system".
 */
export function categoryForIcon(icon: HistoryIconKind): LogCategory {
  switch (icon) {
    case "normal":
    case "tribute":
    case "special":
    case "flip":
    case "fusion":
    case "synchro":
    case "xyz":
    case "link":
    case "ritual":
    case "pendulum":
      return "summon";
    case "activate":
    case "chain":
      return "chain";
    case "attack":
    case "direct":
    case "lp-loss":
      return "battle";
    case "destroy":
      return "destroy";
    case "grave":
      return "graveyard";
    case "banish":
      return "banish";
    case "set":
      return "set";
    case "draw":
    case "hand":
    case "deck":
      return "hand";
    case "lp-gain":
    case "position":
    case "flip-up":
      return "system";
    default: {
      const unmapped: never = icon;
      void unmapped;
      return "system";
    }
  }
}

/** Action labels history-entries.ts gives a card sent away for a summon (destVerb), whatever its icon. */
const MATERIAL_VERBS: ReadonlySet<string> = new Set(["Tributed", "Used as material"]);

/** The category of a history-list entry: its icon kind, except that Tributes and materials are "material". */
export function categoryForEntry(entry: Pick<HistoryEntry, "icon" | "verb">): LogCategory {
  if (MATERIAL_VERBS.has(entry.verb)) return "material";
  return categoryForIcon(entry.icon);
}

/** The card frame a summon echoes, or null when the entry is not a summon. */
export function summonMethodForIcon(icon: HistoryIconKind): SummonMethod | null {
  switch (icon) {
    case "fusion":
    case "synchro":
    case "xyz":
    case "link":
    case "ritual":
    case "pendulum":
      return icon;
    case "normal":
    case "tribute":
    case "special":
    case "flip":
      return "monster";
    default:
      return null;
  }
}

// Text log lines come from the engine's fixed sentence templates (duel-server engine.ts and log-lines.ts). Match
// them on the raw text, before "Player N" becomes a display name, and anchor each pattern so a card name or an
// effect hint cannot pass for another template. Older lines ("<card> moved", stored replays) still classify.
const SUMMON_LINE = /^Player \d+ (Normal|Tribute|Special|Flip|Fusion|Synchro|Xyz|Link|Ritual|Pendulum) Summons /;

const TEXT_RULES: ReadonlyArray<readonly [RegExp, LogCategory]> = [
  [SUMMON_LINE, "summon"],
  [/^Player \d+ Sets a card$/, "set"],
  [/^Player \d+ drew \d+ card\(s\)$/, "hand"],
  [/^You drew /, "hand"],
  [/^Player \d+ added a card to their hand$/, "hand"],
  [/^You added .+ to your hand$/, "hand"],
  [/ was added to Player \d+'s hand$/, "hand"],
  [/ returned to (Player \d+'s|your) hand$/, "hand"],
  [/ returned to the (Deck|Extra Deck)$/, "hand"],
  [/ is activating$/, "chain"],
  [/^(A|Player \d+'s) chain link was negated$/, "chain"],
  [/^Chain ended$/, "chain"],
  // "Chain Link 2: Effect Veiler targets Black Luster Soldier ..." and the private "Only legal target: ..." note.
  [/^Chain Link \d+: .+ targets /, "chain"],
  [/^Only legal target: /, "chain"],
  [/^(A monster|Player \d+) declares (an|a direct) attack$/, "battle"],
  [/^Player \d+ attacks Player \d+ directly$/, "battle"],
  [/^Player \d+ is attacked directly$/, "battle"],
  [/^Player \d+ takes \d+ damage$/, "battle"],
  [/^Player \d+ pays \d+ LP$/, "battle"],
  [/ was destroyed$/, "destroy"],
  [/ was destroyed and banished$/, "destroy"],
  [/ was sent to the Graveyard$/, "graveyard"],
  [/ was discarded$/, "graveyard"],
  [/ was banished$/, "banish"],
  [/^Player \d+ gains \d+ LP$/, "system"],
  // Older engine text: "<card> moved" was logged for both the Graveyard and a face-up banish, so it is neutral.
  [/ moved$/, "system"],
  [/^Player \d+ shuffled their (deck|hand)$/, "system"],
  [/^(Confirmed|Excavated) /, "system"],
  [/^(Coin toss|Dice roll): /, "system"],
];

/**
 * The category of a raw engine log line, or null for lines that have their own look (turn headers, phases,
 * the result) and for free-text effect hints.
 */
export function categoryForLogText(text: string): LogCategory | null {
  for (const [pattern, category] of TEXT_RULES) {
    if (pattern.test(text)) return category;
  }
  return null;
}

// Summons whose materials go to the Graveyard. Xyz materials are attached, not sent; Pendulum, Normal, Special and
// Flip Summons take none.
const MATERIAL_SUMMON = /^Player \d+ (Tribute|Fusion|Synchro|Link|Ritual) Summons /;
const GRAVEYARD_LINE = / was sent to the Graveyard$/;

/**
 * The category of every line of a Text log, in order. Like categoryForLogText, except that the Graveyard sends
 * directly above a Tribute, Fusion, Synchro, Link or Ritual Summon line are "material": the engine logs a summon's
 * materials right before the summon itself. Any other line in between ends the run, so an earlier cost or a card
 * sent by an effect stays a plain Graveyard send (the history list's rule for "Tributed" and "Used as material").
 */
export function categoriesForLog(texts: readonly string[]): Array<LogCategory | null> {
  const categories = texts.map(categoryForLogText);
  texts.forEach((text, index) => {
    if (!MATERIAL_SUMMON.test(text)) return;
    for (let above = index - 1; above >= 0 && GRAVEYARD_LINE.test(texts[above]!); above -= 1) categories[above] = "material";
  });
  return categories;
}

const SUMMON_WORD: Record<string, SummonMethod> = {
  Normal: "monster",
  Tribute: "monster",
  Special: "monster",
  Flip: "monster",
  Fusion: "fusion",
  Synchro: "synchro",
  Xyz: "xyz",
  Link: "link",
  Ritual: "ritual",
  Pendulum: "pendulum",
};

/** The card frame a summon line names, or null when the line is not a summon. */
export function summonMethodForLogText(text: string): SummonMethod | null {
  const match = SUMMON_LINE.exec(text);
  return match ? (SUMMON_WORD[match[1]!] ?? null) : null;
}
