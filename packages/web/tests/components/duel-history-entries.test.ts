import { describe, expect, it } from "vitest";
import type { DuelCardInfo, DuelEvent } from "@yugidraft/shared/duels";
import { emptyHistory, ingestHistory, type HistoryContext } from "../../src/components/duel/history-model";
import {
  buildHistoryView,
  entryFor,
  historyWho,
  sideOf,
  type HistoryEntry,
  type HistoryViewOptions,
} from "../../src/components/duel/history-entries";

const MZONE = 0x04;
const HAND = 0x02;
const GRAVE = 0x10;
const REMOVED = 0x20;

function info(code: number, name: string): DuelCardInfo {
  return { code, name, description: "", type: 1, attack: 1000, defense: 1000, level: 4, attribute: 1, race: "" };
}

function ctx(overrides: Partial<HistoryContext> = {}): HistoryContext {
  return { revision: 1, turn: 3, turnSeat: 0, phase: "main1", seatCount: 2, cards: [], ...overrides };
}

const zone = (controller: number, location: number, sequence = 0) => ({ controller, location, sequence });
const who = (seat: number | null) => (seat == null ? "Unknown" : seat === 0 ? "You" : "Rival");
const opts: HistoryViewOptions = { mySeat: 0, who };

function entries(events: DuelEvent[], context = ctx(), options = opts): HistoryEntry[] {
  const state = ingestHistory(emptyHistory(), events, context);
  const view = buildHistoryView(state.items, options);
  return view.groups.flatMap((group) => group.rows).filter((row): row is HistoryEntry => row.type === "entry");
}

describe("history entries: icon kinds and cards", () => {
  it("maps each summon kind to its own icon and keeps the card", () => {
    const list = entries([
      { id: 1, kind: "summon", seat: 0, card: info(1, "Dragon"), summonKind: "synchro", text: "" },
      { id: 2, kind: "summon", seat: 0, card: info(2, "Imp"), text: "Player 1 Tribute Summons" },
    ]);
    // Newest first.
    expect(list.map((entry) => entry.icon)).toEqual(["tribute", "synchro"]);
    expect(list[1].thumbs[0]).toMatchObject({ role: "main", code: 1, name: "Dragon" });
    expect(list[1].verb).toBe("Synchro Summon");
    expect(list[1].sentence).toBe("You Synchro Summoned Dragon.");
  });

  it("shows attacker and target thumbs, with LP loss and a struck target", () => {
    const list = entries(
      [
        { id: 1, kind: "attack", seat: 0, card: info(1, "Attacker"), text: "", zone: zone(0, MZONE, 0), target: zone(1, MZONE, 0) },
        { id: 2, kind: "damage", seat: 1, amount: 800, cause: "battle", text: "" },
        { id: 3, kind: "destroy", seat: 1, zone: zone(1, MZONE, 0), card: info(2, "Defender"), text: "" },
      ],
      ctx({ cards: [{ controller: 1, location: MZONE, sequence: 0, position: 1, code: 2, name: "Defender" }] }),
    );
    expect(list).toHaveLength(1);
    const [entry] = list;
    expect(entry.icon).toBe("attack");
    expect(entry.thumbs.map((thumb) => thumb.role)).toEqual(["attacker", "target"]);
    expect(entry.thumbs[0]).toMatchObject({ code: 1, struck: false, side: "you" });
    expect(entry.thumbs[1]).toMatchObject({ code: 2, struck: true, side: "opp" });
    expect(entry.lp).toEqual([
      { side: "opp", seat: 1, delta: -800, cause: "battle", text: "−800", unit: "LP", label: "−800 LP", who: "Rival", total: null },
    ]);
    expect(entry.title).toBe("Attacker → Defender");
    expect(entry.tags).toEqual([{ label: "Destroyed by battle", tone: "loss" }]);
  });

  it("shows a direct attack as attacker plus a player portrait", () => {
    const [entry] = entries([
      { id: 1, kind: "attack", seat: 1, card: info(7, "Raider"), text: "Player 2 attacks directly", zone: zone(1, MZONE, 2) },
      { id: 2, kind: "damage", seat: 0, amount: 3000, cause: "battle", text: "" },
    ]);
    expect(entry.icon).toBe("direct");
    expect(entry.thumbs[1]).toMatchObject({ role: "portrait", code: null, side: "you" });
    expect(entry.lp[0]).toMatchObject({ delta: -3000, text: "−3,000", side: "you" });
    expect(entry.side).toBe("opp");
    expect(entry.title).toBe("Raider → You");
  });

  it("maps chain links, with resolution and negation tags", () => {
    const list = entries([
      { id: 1, kind: "activate", seat: 0, card: info(5, "Trap"), chainIndex: 1, text: "" },
      { id: 2, kind: "activate", seat: 1, card: info(6, "Response"), chainIndex: 2, text: "" },
      { id: 3, kind: "chain-negated", seat: 0, chainIndex: 1, text: "" },
    ]);
    const first = list.find((entry) => entry.title === "Trap");
    expect(first?.icon).toBe("chain");
    expect(first?.negated).toBe(true);
    expect(first?.tags).toEqual([
      { label: "Chain 1", tone: "chain" },
      { label: "Negated", tone: "loss" },
    ]);
    expect(first?.sentence).toContain("Chain link 1 of 2");
  });

  it("maps a lone activation, destroy, damage and cost rows", () => {
    const list = entries([
      { id: 1, kind: "activate", seat: 0, card: info(5, "Spell"), chainIndex: 1, text: "" },
      { id: 2, kind: "chain-end", text: "" },
      { id: 3, kind: "destroy", seat: 1, zone: zone(1, MZONE, 1), card: info(8, "Victim"), cause: "effect", text: "" },
      { id: 4, kind: "damage", seat: 0, amount: 1000, cause: "cost", text: "" },
    ]);
    expect(list.map((entry) => entry.icon).reverse()).toEqual(["activate", "destroy", "lp-loss"]);
    const cost = list[0];
    expect(cost.verb).toBe("LP paid");
    expect(cost.lp[0].cause).toBe("cost");
    expect(list[1].thumbs[0]).toMatchObject({ code: 8, struck: true });
  });

  it("maps draws, banishes, Graveyard sends and position changes", () => {
    const list = entries([
      { id: 1, kind: "move", seat: 0, reason: "draw", card: info(1, "Mine"), zone: zone(0, HAND), text: "" },
      { id: 2, kind: "move", seat: 1, reason: "banish", card: info(2, "Gone"), zone: zone(1, REMOVED), text: "" },
      { id: 3, kind: "move", seat: 1, reason: "send", card: info(3, "Sent"), zone: zone(1, GRAVE), text: "" },
      { id: 4, kind: "position", seat: 0, card: info(4, "Wall"), zone: zone(0, MZONE), fromPosition: 1, toPosition: 4, text: "" },
      { id: 5, kind: "position", seat: 1, card: info(9, "Flip"), zone: zone(1, MZONE), fromPosition: 8, toPosition: 1, flip: true, text: "" },
    ]);
    expect(list.map((entry) => entry.icon).reverse()).toEqual(["draw", "banish", "grave", "position", "flip-up"]);
    const byIcon = Object.fromEntries(list.map((entry) => [entry.icon, entry]));
    expect(byIcon.draw.sentence).toBe("You drew Mine.");
    expect(byIcon.banish.sentence).toBe("Rival banished Gone.");
    expect(byIcon.grave.sentence).toBe("Rival sent Sent to the Graveyard.");
    expect(byIcon.position.verb).toBe("To Defense Position");
    expect(byIcon["flip-up"].verb).toBe("Flips face-up");
  });

  it("ignores moves that have their own tile (summon, destroy, set, activate)", () => {
    const list = entries([
      { id: 1, kind: "move", seat: 0, reason: "summon", card: info(1, "A"), zone: zone(0, MZONE), text: "" },
      { id: 2, kind: "move", seat: 1, reason: "destroy", card: info(2, "B"), zone: zone(1, GRAVE), text: "" },
      { id: 3, kind: "move", seat: 1, reason: "set", zone: zone(1, MZONE), text: "" },
    ]);
    expect(list).toHaveLength(0);
  });

  it("folds back-to-back draws by one seat into one entry", () => {
    const list = entries([
      { id: 1, kind: "move", seat: 1, reason: "draw", zone: zone(1, HAND), text: "" },
      { id: 2, kind: "move", seat: 1, reason: "draw", zone: zone(1, HAND), text: "" },
      { id: 3, kind: "move", seat: 1, reason: "draw", zone: zone(1, HAND), text: "" },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].verb).toBe("Draw 3");
    expect(list[0].title).toBe("3 cards");
    expect(list[0].tags).toEqual([{ label: "×3", tone: "quiet" }]);
  });
});

describe("history entries: LP gain", () => {
  it("makes a +LP entry when LP rises without an event", () => {
    const first = ingestHistory(emptyHistory(), [{ id: 1, kind: "phase", text: "Main Phase 1" }], ctx({ lp: [8000, 8000] }));
    const next = ingestHistory(
      first,
      [{ id: 2, kind: "summon", seat: 0, card: info(1, "Healer"), text: "" }],
      ctx({ revision: 2, lp: [9000, 8000] }),
    );
    const view = buildHistoryView(next.items, opts);
    const gain = view.groups[0].rows[0] as HistoryEntry;
    expect(gain.icon).toBe("lp-gain");
    expect(gain.lp).toEqual([
      { side: "you", seat: 0, delta: 1000, cause: "heal", text: "+1,000", unit: "LP", label: "+1,000 LP", who: "You", total: "8,000 → 9,000" },
    ]);
    expect(gain.sentence).toBe("You gained 1,000 LP.");
    expect(view.latestKey).toBe(gain.key);
  });

  it("does not call damage a gain, and counts gain on top of damage", () => {
    const first = ingestHistory(emptyHistory(), [{ id: 1, kind: "phase", text: "Main Phase 1" }], ctx({ lp: [8000, 8000] }));
    const hurt = ingestHistory(
      first,
      [{ id: 2, kind: "damage", seat: 0, amount: 500, cause: "effect", text: "" }],
      ctx({ revision: 2, lp: [7500, 8000] }),
    );
    expect(hurt.items.some((item) => item.type === "tile" && item.kind === "heal")).toBe(false);
    const mixed = ingestHistory(
      hurt,
      [{ id: 3, kind: "damage", seat: 0, amount: 500, cause: "effect", text: "" }],
      ctx({ revision: 3, lp: [8000, 8000] }),
    );
    const heals = mixed.items.filter((item) => item.type === "tile" && item.kind === "heal");
    expect(heals).toHaveLength(1);
    expect(heals[0].type === "tile" && heals[0].gain).toEqual({ seat: 0, amount: 1000, before: 7000, after: 8000 });
  });

  it("gives each recovery its own key, even with no new event", () => {
    let state = ingestHistory(emptyHistory(), [{ id: 4, kind: "phase", text: "Main Phase 1" }], ctx({ lp: [8000, 8000] }));
    state = ingestHistory(state, [], ctx({ revision: 2, lp: [8500, 8000] }));
    state = ingestHistory(state, [], ctx({ revision: 3, lp: [9000, 8000] }));
    const keys = state.items.filter((item) => item.type === "tile").map((item) => item.key);
    expect(new Set(keys).size).toBe(2);
    expect(Math.min(...keys)).toBeGreaterThan(4);
    expect(Math.max(...keys)).toBeLessThan(5);
  });

  it("makes no gain tile when LP is not provided", () => {
    const first = ingestHistory(emptyHistory(), [{ id: 1, kind: "phase", text: "Main Phase 1" }], ctx());
    const next = ingestHistory(first, [{ id: 2, kind: "summon", seat: 0, card: info(1, "A"), text: "" }], ctx({ revision: 2 }));
    expect(next.items.some((item) => item.type === "tile" && item.kind === "heal")).toBe(false);
  });
});

describe("history entries: privacy", () => {
  it("never shows an opponent's Set card, even if the identity leaks", () => {
    const [entry] = entries([{ id: 1, kind: "set", seat: 1, card: info(99, "Secret Trap"), text: "Player 2 Sets a card" }]);
    expect(entry.thumbs[0]).toMatchObject({ code: null, card: null, name: null });
    expect(entry.title).toBe("Face-down card");
    expect(entry.sentence).toBe("Rival Set a card.");
    expect(JSON.stringify(entry)).not.toContain("Secret Trap");
    expect(JSON.stringify(entry)).not.toContain("99");
  });

  it("shows your own Set card, but a spectator never sees one", () => {
    const events: DuelEvent[] = [{ id: 1, kind: "set", seat: 0, card: info(42, "My Trap"), text: "" }];
    const [mine] = entries(events);
    expect(mine.thumbs[0]).toMatchObject({ code: 42, name: "My Trap" });
    const [watched] = entries(events, ctx(), { mySeat: null, who });
    expect(watched.thumbs[0]).toMatchObject({ code: null, name: null });
  });

  it("keeps a face-down summon as a card back", () => {
    const [entry] = entries([{ id: 1, kind: "summon", seat: 1, text: "Player 2 Special Summons a face-down monster" }]);
    expect(entry.thumbs[0].code).toBeNull();
    expect(entry.title).toBe("Face-down monster");
  });

  it("hides an opponent's draw and face-down moves, shows yours", () => {
    const events: DuelEvent[] = [
      { id: 1, kind: "move", seat: 1, reason: "draw", card: info(5, "Leak"), zone: zone(1, HAND), text: "" },
      { id: 2, kind: "move", seat: 1, reason: "banish", card: info(6, "Down"), faceDown: true, zone: zone(1, REMOVED), text: "" },
      { id: 3, kind: "move", seat: 0, reason: "draw", card: info(7, "Own"), zone: zone(0, HAND), text: "" },
    ];
    const list = entries(events).reverse();
    expect(list[0].thumbs[0].code).toBeNull();
    expect(list[0].sentence).toBe("Rival drew a card.");
    expect(list[1].thumbs[0].code).toBeNull();
    expect(list[2].thumbs[0].code).toBe(7);
    expect(JSON.stringify(list.slice(0, 2))).not.toMatch(/Leak|Down/);
  });

  it("hides an opponent's face-down position change", () => {
    const [entry] = entries([
      { id: 1, kind: "position", seat: 1, card: info(11, "Hidden"), zone: zone(1, MZONE), fromPosition: 1, toPosition: 8, text: "" },
    ]);
    expect(entry.thumbs[0].code).toBeNull();
    expect(entry.sentence).toBe("Rival changed a monster to face-down Defense Position.");
  });
});

describe("history entries: turn grouping", () => {
  const events: DuelEvent[] = [
    { id: 1, kind: "phase", text: "Main Phase 1" },
    { id: 2, kind: "summon", seat: 1, card: info(1, "A"), text: "" },
    { id: 3, kind: "phase", text: "Battle Phase" },
    { id: 4, kind: "attack", seat: 1, card: info(1, "A"), text: "", zone: zone(1, MZONE, 0) },
    { id: 5, kind: "phase", text: "Main Phase 1" },
    { id: 6, kind: "summon", seat: 0, card: info(2, "B"), text: "" },
  ];

  it("groups newest turn first, newest row first, with a turn and player label", () => {
    const view = buildHistoryView(ingestHistory(emptyHistory(), events, ctx({ turn: 4, turnSeat: 0 })).items, opts);
    expect(view.groups.map((group) => group.label)).toEqual(["Turn 4 · You", "Turn 3 · Rival"]);
    expect(view.groups[1].rows.map((row) => row.type)).toEqual(["entry", "phase", "entry"]);
    expect(view.groups[1].rows[1]).toMatchObject({ type: "phase", label: "Battle Phase", battle: true });
    expect(view.latestKey).toBe(6);
    expect(view.entryCount).toBe(3);
  });

  it("works out the player of a turn the window started inside", () => {
    // No Main Phase 1 separator for the older turn: its seat comes from the later one by parity.
    const mid: DuelEvent[] = [
      { id: 1, kind: "summon", seat: 1, card: info(1, "A"), text: "" },
      { id: 2, kind: "phase", text: "Main Phase 1" },
      { id: 3, kind: "summon", seat: 0, card: info(2, "B"), text: "" },
    ];
    const view = buildHistoryView(ingestHistory(emptyHistory(), mid, ctx({ turn: 4, turnSeat: 0 })).items, opts);
    expect(view.groups.map((group) => group.label)).toEqual(["Turn 4 · You", "Turn 3 · Rival"]);
  });

  it("returns an empty view for no items", () => {
    expect(buildHistoryView([], opts)).toEqual({ groups: [], latestKey: null, entryCount: 0 });
  });
});

describe("history entries: actor side", () => {
  it("colours by viewer seat, and treats seat 0 as you for a spectator", () => {
    expect(sideOf(1, 1)).toBe("you");
    expect(sideOf(0, 1)).toBe("opp");
    expect(sideOf(0, null)).toBe("you");
    expect(sideOf(1, null)).toBe("opp");
    expect(sideOf(null, 0)).toBe("opp");
  });

  it("builds one entry from a tile", () => {
    const state = ingestHistory(emptyHistory(), [{ id: 1, kind: "summon", seat: 1, card: info(3, "C"), text: "" }], ctx());
    const tile = state.items[0];
    if (tile.type !== "tile") throw new Error("expected tile");
    expect(entryFor(tile, opts)).toMatchObject({ side: "opp", actor: "Rival", turn: 3 });
  });
});

/** Every string a row draws or reads out. Used to prove no cryptic abbreviation survives. */
function visibleText(entry: HistoryEntry): string {
  return [
    entry.actor,
    entry.verb,
    entry.title,
    entry.sentence,
    ...entry.tags.map((tag) => tag.label),
    ...entry.lp.flatMap((change) => [change.text, change.unit, change.label, change.who, change.total ?? ""]),
    ...entry.thumbs.map((thumb) => thumb.label ?? ""),
  ].join(" | ");
}

describe("history entries: plain Yu-Gi-Oh! wording", () => {
  const battle: DuelEvent[] = [
    { id: 1, kind: "attack", seat: 0, card: info(1, "Blue-Eyes Chaos MAX Dragon"), text: "", zone: zone(0, MZONE, 0), target: zone(1, MZONE, 0) },
    { id: 2, kind: "damage", seat: 1, amount: 2400, cause: "battle", text: "" },
    { id: 3, kind: "destroy", seat: 1, zone: zone(1, MZONE, 0), card: info(2, "Defender"), cause: "battle", sourceCode: 1, text: "" },
  ];
  const battleCtx = ctx({
    lp: [8000, 5600],
    cards: [{ controller: 1, location: MZONE, sequence: 0, position: 1, code: 2, name: "Defender" }],
  });

  it("shows LP lost with a unit, whose LP it is and the total before and after", () => {
    const [entry] = entries(battle, battleCtx);
    expect(entry.lp).toEqual([
      {
        side: "opp",
        seat: 1,
        delta: -2400,
        cause: "battle",
        text: "−2,400",
        unit: "LP",
        label: "−2,400 LP",
        who: "Rival",
        total: "8,000 → 5,600",
      },
    ]);
  });

  it("leaves the total out when the LP before and after are not known", () => {
    const [entry] = entries(battle, ctx({ cards: battleCtx.cards }));
    expect(entry.lp[0]).toMatchObject({ label: "−2,400 LP", who: "Rival", total: null });
  });

  it("works several hits in one batch back from the current LP", () => {
    const list = entries(
      [
        { id: 1, kind: "damage", seat: 0, amount: 1000, cause: "effect", text: "" },
        { id: 2, kind: "damage", seat: 0, amount: 500, cause: "effect", text: "" },
      ],
      ctx({ lp: [6500, 8000] }),
    );
    // Newest first.
    expect(list.map((row) => row.lp[0].total)).toEqual(["7,000 → 6,500", "8,000 → 7,000"]);
  });

  it("names LP paid and LP gained with the same unit", () => {
    const first = ingestHistory(emptyHistory(), [{ id: 1, kind: "phase", text: "Main Phase 1" }], ctx({ lp: [8000, 8000] }));
    const next = ingestHistory(first, [{ id: 2, kind: "damage", seat: 0, amount: 1000, cause: "cost", text: "" }], ctx({ revision: 2, lp: [7000, 8000] }));
    const healed = ingestHistory(next, [], ctx({ revision: 3, lp: [7000, 9000] }));
    const rows = buildHistoryView(healed.items, opts).groups.flatMap((group) => group.rows).filter((row): row is HistoryEntry => row.type === "entry");
    const gain = rows[0];
    const paid = rows[1];
    expect(gain.verb).toBe("LP gained");
    expect(gain.lp[0]).toMatchObject({ text: "+1,000", label: "+1,000 LP", who: "Rival", total: "8,000 → 9,000" });
    expect(paid.verb).toBe("LP paid");
    expect(paid.lp[0]).toMatchObject({ label: "−1,000 LP", who: "You", total: "8,000 → 7,000" });
  });

  it("uses short complete action labels", () => {
    const list = entries([
      { id: 1, kind: "summon", seat: 0, card: info(1, "A"), summonKind: "normal", text: "" },
      { id: 2, kind: "activate", seat: 0, card: info(2, "B"), chainIndex: 1, text: "" },
      { id: 3, kind: "chain-end", text: "" },
      { id: 4, kind: "attack", seat: 0, card: info(1, "A"), text: "", zone: zone(0, MZONE, 0), target: zone(1, MZONE, 0) },
      { id: 5, kind: "phase", text: "End Phase" },
      { id: 6, kind: "attack", seat: 0, card: info(1, "A"), text: "Player 1 attacks directly", zone: zone(0, MZONE, 0) },
    ]).reverse();
    expect(list.map((entry) => entry.verb)).toEqual(["Normal Summon", "Activate", "Attack", "Direct attack"]);
  });

  it("shows a direct attack target as a named player plate, not an abbreviation", () => {
    const [entry] = entries([
      { id: 1, kind: "attack", seat: 0, card: info(7, "Raider"), text: "Player 1 attacks directly", zone: zone(0, MZONE, 2) },
      { id: 2, kind: "damage", seat: 1, amount: 2500, cause: "battle", text: "" },
    ]);
    expect(entry.verb).toBe("Direct attack");
    expect(entry.thumbs[1]).toMatchObject({ role: "portrait", label: "Rival", side: "opp" });
    expect(entry.sentence).toContain("directly");
  });

  it("keeps the player plate on LP-only rows", () => {
    const [entry] = entries([{ id: 1, kind: "damage", seat: 1, amount: 700, cause: "effect", text: "" }]);
    expect(entry.verb).toBe("Effect damage");
    expect(entry.thumbs[0]).toMatchObject({ role: "portrait", label: "Rival" });
  });

  it("never draws OPP or Opp anywhere in a row", () => {
    const rows = [
      ...entries(battle, battleCtx),
      ...entries([{ id: 1, kind: "attack", seat: 0, card: info(7, "Raider"), text: "attacks directly", zone: zone(0, MZONE, 2) }]),
      ...entries([{ id: 1, kind: "damage", seat: 1, amount: 700, cause: "effect", text: "" }]),
    ];
    for (const row of rows) expect(visibleText(row)).not.toMatch(/\bopp\b/i);
  });

  it("writes the opponent's name or Opponent in the turn header, never Opp", () => {
    const named: HistoryViewOptions = { mySeat: 0, who: (seat) => (seat === 0 ? "You" : "Opponent") };
    const view = buildHistoryView(
      ingestHistory(emptyHistory(), [{ id: 1, kind: "phase", text: "Main Phase 1" }, { id: 2, kind: "summon", seat: 1, card: info(1, "A"), text: "" }], ctx({ turn: 4, turnSeat: 1 })).items,
      named,
    );
    expect(view.groups[0].label).toBe("Turn 4 · Opponent");
  });
});

describe("history entries: historyWho", () => {
  const names = (seat: number) => ["Sulman", "Player 2", "Kaiba"][seat] ?? `Player ${seat + 1}`;

  it("says You for the viewer and the name for a named player", () => {
    expect(historyWho(0, 0, names, 2)).toBe("You");
    expect(historyWho(2, 0, names, 3)).toBe("Kaiba");
  });

  it("says Opponent when a two-player seat only has the placeholder name", () => {
    expect(historyWho(1, 0, names, 2)).toBe("Opponent");
  });

  it("keeps the placeholder with three or more seats, where Opponent would be unclear", () => {
    expect(historyWho(1, 0, names, 3)).toBe("Player 2");
  });

  it("handles a spectator and an unknown seat", () => {
    expect(historyWho(null, 0, names, 2)).toBe("Unknown");
    expect(historyWho(0, null, names, 2)).toBe("Sulman");
  });
});

describe("history entries: why a card was destroyed", () => {
  it("says destroyed by battle on the attack row", () => {
    const [entry] = entries([
      { id: 1, kind: "attack", seat: 0, card: info(1, "Attacker"), text: "", zone: zone(0, MZONE, 0), target: zone(1, MZONE, 0) },
      { id: 2, kind: "destroy", seat: 1, zone: zone(1, MZONE, 0), card: info(2, "Defender"), cause: "battle", sourceCode: 1, text: "" },
    ]);
    expect(entry.tags).toEqual([{ label: "Destroyed by battle", tone: "loss" }]);
    expect(entry.sentence).toContain("Defender was destroyed by battle.");
  });

  it("names the effect's card on a chain link", () => {
    const [entry] = entries([
      { id: 1, kind: "activate", seat: 0, card: info(77, "Raigeki"), chainIndex: 1, text: "" },
      { id: 2, kind: "chain-resolving", seat: 0, chainIndex: 1, text: "" },
      { id: 3, kind: "destroy", seat: 1, zone: zone(1, MZONE, 0), card: info(2, "Defender"), cause: "effect", sourceCode: 77, sourceKind: "spell", sourceSeat: 0, text: "" },
    ]);
    expect(entry.tags.map((tag) => tag.label)).toContain("Destroyed by Raigeki's effect");
    expect(entry.sentence).toContain("Defender was destroyed by Raigeki's effect.");
  });

  it("counts several cards destroyed by one effect", () => {
    const [entry] = entries([
      { id: 1, kind: "activate", seat: 0, card: info(77, "Raigeki"), chainIndex: 1, text: "" },
      { id: 2, kind: "chain-resolving", seat: 0, chainIndex: 1, text: "" },
      { id: 3, kind: "destroy", seat: 1, zone: zone(1, MZONE, 0), card: info(2, "A"), cause: "effect", sourceCode: 77, text: "" },
      { id: 4, kind: "destroy", seat: 1, zone: zone(1, MZONE, 1), card: info(3, "B"), cause: "effect", sourceCode: 77, text: "" },
    ]);
    expect(entry.tags.map((tag) => tag.label)).toContain("2 destroyed by Raigeki's effect");
  });

  it("falls back to card effect when the source card is not known", () => {
    const [entry] = entries([
      { id: 1, kind: "destroy", seat: 1, zone: zone(1, MZONE, 1), card: info(8, "Victim"), cause: "effect", sourceCode: 4242, text: "" },
    ]);
    expect(entry.verb).toBe("Destroyed");
    expect(entry.tags).toEqual([{ label: "By card effect", tone: "loss", plain: true }]);
    expect(entry.sentence).toBe("Victim was destroyed by card effect.");
  });

  it("finds a source card the log already showed, for a lone destroy", () => {
    const list = entries([
      { id: 1, kind: "activate", seat: 0, card: info(77, "Raigeki"), chainIndex: 1, text: "" },
      { id: 2, kind: "chain-end", text: "" },
      { id: 3, kind: "destroy", seat: 1, zone: zone(1, MZONE, 1), card: info(8, "Victim"), cause: "effect", sourceCode: 77, text: "" },
    ]);
    expect(list[0].tags).toEqual([{ label: "By Raigeki's effect", tone: "loss", plain: true }]);
  });

  it("words the other reasons and stays plain when there is none", () => {
    const list = entries([
      { id: 1, kind: "destroy", seat: 1, zone: zone(1, MZONE, 0), card: info(1, "A"), cause: "cost", text: "" },
      { id: 2, kind: "destroy", seat: 1, zone: zone(1, MZONE, 1), card: info(2, "B"), cause: "rule", text: "" },
      { id: 3, kind: "destroy", seat: 1, zone: zone(1, MZONE, 2), card: info(3, "C"), cause: "other", text: "" },
    ]).reverse();
    expect(list.map((entry) => entry.tags.map((tag) => tag.label))).toEqual([["As a cost"], ["By game rule"], []]);
  });
});

describe("history entries: where a card went and why", () => {
  it("words each destination in Yu-Gi-Oh! terms", () => {
    const list = entries([
      { id: 1, kind: "move", seat: 0, reason: "draw", card: info(1, "Mine"), zone: zone(0, HAND), text: "" },
      { id: 2, kind: "move", seat: 1, reason: "banish", card: info(2, "Gone"), zone: zone(1, REMOVED), text: "" },
      { id: 3, kind: "move", seat: 1, reason: "send", card: info(3, "Sent"), zone: zone(1, GRAVE), text: "" },
      { id: 4, kind: "move", seat: 1, reason: "discard", card: info(4, "Tossed"), zone: zone(1, GRAVE), text: "" },
      { id: 5, kind: "move", seat: 0, reason: "return", card: info(5, "Back"), zone: zone(0, HAND), text: "" },
    ]).reverse();
    expect(list.map((entry) => entry.verb)).toEqual(["Draw", "Banished", "Sent to Graveyard", "Discard", "Returned to hand"]);
  });

  it("names the card whose effect sent a card while a chain link resolves", () => {
    const list = entries([
      { id: 1, kind: "activate", seat: 0, card: info(50, "Foolish Burial"), chainIndex: 1, text: "" },
      { id: 2, kind: "chain-resolving", seat: 0, chainIndex: 1, text: "" },
      { id: 3, kind: "move", seat: 0, reason: "send", card: info(3, "Sent"), zone: zone(0, GRAVE), text: "" },
      { id: 4, kind: "move", seat: 0, reason: "banish", card: info(4, "Away"), zone: zone(0, REMOVED), text: "" },
    ]);
    const [banished, sent] = list;
    expect(sent.verb).toBe("Sent to Graveyard");
    expect(sent.tags).toEqual([{ label: "By Foolish Burial's effect", tone: "quiet", plain: true }]);
    expect(banished.tags).toEqual([{ label: "By Foolish Burial's effect", tone: "quiet", plain: true }]);
    expect(sent.sentence).toBe("You sent Sent to the Graveyard by Foolish Burial's effect.");
  });

  it("does not claim a cause for a move outside a resolving chain link", () => {
    const [entry] = entries([{ id: 1, kind: "move", seat: 1, reason: "send", card: info(3, "Sent"), zone: zone(1, GRAVE), text: "" }]);
    expect(entry.tags).toEqual([]);
  });

  it("calls the monsters sent for a Tribute Summon Tributed", () => {
    const list = entries([
      { id: 1, kind: "move", seat: 0, reason: "send", card: info(9, "Fodder"), zone: zone(0, GRAVE), from: zone(0, MZONE, 0), text: "" },
      { id: 2, kind: "move", seat: 0, reason: "summon", card: info(10, "Big"), zone: zone(0, MZONE, 1), text: "" },
      { id: 3, kind: "summon", seat: 0, card: info(10, "Big"), summonKind: "tribute", text: "" },
    ]);
    const [summon, tributed] = list;
    expect(summon.verb).toBe("Tribute Summon");
    expect(tributed.verb).toBe("Tributed");
    expect(tributed.sentence).toBe("You Tributed Fodder.");
  });

  it("calls cards sent for a Synchro or Fusion Summon Used as material", () => {
    const list = entries([
      { id: 1, kind: "move", seat: 0, reason: "send", card: info(21, "Tuner"), zone: zone(0, GRAVE), text: "" },
      { id: 2, kind: "move", seat: 0, reason: "send", card: info(22, "Non-tuner"), zone: zone(0, GRAVE), text: "" },
      { id: 3, kind: "move", seat: 0, reason: "summon", card: info(23, "Boss"), zone: zone(0, MZONE, 0), text: "" },
      { id: 4, kind: "summon", seat: 0, card: info(23, "Boss"), summonKind: "synchro", text: "" },
    ]);
    expect(list.map((entry) => entry.verb)).toEqual(["Synchro Summon", "Used as material", "Used as material"]);
    expect(list[1].sentence).toBe("You used Non-tuner as material.");
  });

  it("leaves an earlier send alone when other events sit between it and the summon", () => {
    const list = entries([
      { id: 1, kind: "move", seat: 0, reason: "send", card: info(9, "Early"), zone: zone(0, GRAVE), text: "" },
      { id: 2, kind: "chain-end", text: "" },
      { id: 3, kind: "chain-end", text: "" },
      { id: 4, kind: "move", seat: 0, reason: "summon", card: info(10, "Big"), zone: zone(0, MZONE, 1), text: "" },
      { id: 5, kind: "summon", seat: 0, card: info(10, "Big"), summonKind: "tribute", text: "" },
    ]);
    expect(list.map((entry) => entry.verb)).toEqual(["Tribute Summon", "Sent to Graveyard"]);
  });
});

describe("history entries: positions in Yu-Gi-Oh! words", () => {
  it("says Attack Position and Defense Position", () => {
    const list = entries([
      { id: 1, kind: "position", seat: 0, card: info(4, "Wall"), zone: zone(0, MZONE), fromPosition: 1, toPosition: 4, text: "" },
      { id: 2, kind: "position", seat: 0, card: info(4, "Wall"), zone: zone(0, MZONE), fromPosition: 4, toPosition: 1, text: "" },
    ]).reverse();
    expect(list.map((entry) => entry.verb)).toEqual(["To Defense Position", "To Attack Position"]);
    expect(list[0].sentence).toBe("You changed Wall to Defense Position.");
  });
});

describe("history entries: seats", () => {
  it.each([3, 4])("names the actual direct-attack defender at a %i-seat table", seatCount => {
    const targetSeat = seatCount - 1;
    const names = ["Viewer", "Incursion", "themankaran", "themankaran"];
    const list = entries([
      { id: 1, kind: "attack", seat: 1, targetSeat, text: "Player 2 attacks directly", zone: zone(1, MZONE) },
    ], ctx({ seatCount }), { mySeat: 0, seatCount, who: seat => seat == null ? "Unknown" : names[seat] });
    expect(list[0].thumbs.map(thumb => thumb.seat)).toEqual([1, targetSeat]);
    expect(list[0].sentence).toBe("Incursion attacked themankaran directly with a monster.");
  });

  it("carries the acting seat on the row and on each thumb", () => {
    const list = entries(
      [{ id: 1, kind: "attack", seat: 0, card: info(1, "Attacker"), text: "", zone: zone(0, MZONE, 0), target: zone(2, MZONE, 0) }],
      ctx({ seatCount: 3, cards: [{ controller: 2, location: MZONE, sequence: 0, position: 1, code: 2, name: "Defender" }] }),
    );
    expect(list[0].seat).toBe(0);
    expect(list[0].thumbs.map((thumb) => thumb.seat)).toEqual([0, 2]);
  });

  it("uses the damaged seat for an LP row", () => {
    const list = entries([{ id: 1, kind: "damage", seat: 2, amount: 500, cause: "effect", text: "" }], ctx({ seatCount: 3 }));
    expect(list[0].seat).toBe(2);
    expect(list[0].thumbs[0].seat).toBe(2);
  });
});

describe("history: turn-start phases", () => {
  it("keeps one header per turn: Draw and Standby Phase make no separator", () => {
    const events: DuelEvent[] = [
      { id: 1, kind: "phase", text: "Draw Phase" },
      { id: 2, kind: "phase", text: "Standby Phase" },
      { id: 3, kind: "phase", text: "Main Phase 1" },
      { id: 4, kind: "summon", seat: 0, card: info(1, "A"), text: "" },
    ];
    const state = ingestHistory(emptyHistory(), events, ctx({ turn: 1 }));
    const view = buildHistoryView(state.items, opts);
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].rows.map((row) => row.type)).toEqual(["entry"]);
  });
});

describe("history entries: chain link targets", () => {
  const veiler: DuelEvent[] = [
    { id: 1, kind: "activate", seat: 0, card: info(1, "Pot of Greed"), chainIndex: 1, text: "" },
    { id: 2, kind: "activate", seat: 1, card: info(2, "Effect Veiler"), chainIndex: 2, text: "" },
    { id: 3, kind: "target", seat: 1, chainIndex: 2, text: "Chain Link 2 targets Black Luster Soldier", targets: [zone(0, MZONE, 0)] },
  ];

  it("words the target of a link on its own entry, as a sentence and as a tag", () => {
    const list = entries(veiler);
    const link = list.find((entry) => entry.sentence.includes("Effect Veiler"))!;
    expect(link.sentence).toContain("Chain link 2 of 2. Targeting Black Luster Soldier.");
    expect(link.tags).toContainEqual({ label: "Targets Black Luster Soldier", tone: "chain", plain: true });
    expect(list.find((entry) => entry.sentence.includes("Pot of Greed"))!.tags.some((tag) => tag.label.startsWith("Targets"))).toBe(false);
  });

  it("keeps the wording the engine gave for a hidden target and ignores an event that clears the targets", () => {
    const hidden = entries([...veiler.slice(0, 2), { ...veiler[2]!, text: "Chain Link 2 targets a face-down card" }]);
    expect(hidden.find((entry) => entry.sentence.includes("Effect Veiler"))!.sentence).toContain("Targeting a face-down card.");
    const cleared = entries([...veiler, { id: 4, kind: "target", seat: 1, chainIndex: 2, text: "Chain Link 2 targets 0 cards", targets: [] }]);
    expect(cleared.find((entry) => entry.sentence.includes("Effect Veiler"))!.sentence).toContain("Targeting Black Luster Soldier.");
  });
});
