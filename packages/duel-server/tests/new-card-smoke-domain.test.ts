import { activate, defineScenario, expectBoard, select, yes } from "./support/dsl.js";
import { runScenario } from "./support/session.js";
import { itWithCores, needs } from "./support/cores.js";

const requirements = [needs.domain(), needs.domainScript(), needs.cards()];
const deck = ["Mystical Elf", "Aqua Madoor", "Baby Dragon", "Battle Ox"];

itWithCores("Domain: Dark City at Midnight summons from the Deck after destruction", requirements, async () => {
  await runScenario(defineScenario({
    id: "domain-dark-city-destroyed-deck-summon",
    title: "Dark City's uncovered destruction trigger works with a free Monster Zone",
    source: "Pinned c4663194.lua: s.sptg/s.spop; new-card-smoke delta review",
    tags: ["domain", "new-card-smoke", "runner-gap"],
    setup: { mode: "domain", deckSize: 6,
      p0: { deckMaster: "Mystical Elf", field: { card: 4663194, pos: "up" }, hand: ["Mystical Space Typhoon"],
        deck: ["Destiny HERO - Diamond Dude", "Destiny HERO - Doom Lord", ...deck] },
      p1: { deckMaster: "Celtic Guardian", deck } },
    steps: [activate("Mystical Space Typhoon"), yes(), select("Destiny HERO - Diamond Dude"),
      expectBoard({ p0: { monsters: { include: ["Destiny HERO - Diamond Dude"], count: 1 },
        grave: { include: [4663194, "Mystical Space Typhoon"] }, deckCount: 5, deckMaster: { inZone: true } } })],
  }));
});

itWithCores("Domain: Bingo Card resolves both the full-column effect and opponent five-card branch", requirements, async () => {
  await runScenario(defineScenario({
    id: "domain-bingo-full-column",
    title: "Bingo destroys an occupied outer column and both players draw",
    source: "Pinned c99505609.lua: s.columnfilter/s.desop; new-card-smoke delta review",
    tags: ["domain", "new-card-smoke", "runner-gap"],
    setup: { mode: "domain", deckSize: 4,
      p0: { deckMaster: "Mystical Elf", monsters: ["Mystical Elf"],
        spells: [{ card: "Mirror Force", pos: "set" }, { card: 99505609, pos: "set" }], deck },
      p1: { deckMaster: "Celtic Guardian", monsters: [null, null, null, null, "Alexandrite Dragon"],
        spells: [null, null, null, null, { card: "Mirror Force", pos: "set" }], deck } },
    steps: [activate(99505609), select({ card: "Mystical Elf", owner: "p0", from: "mzone" }),
      expectBoard({ p0: { monsters: [], grave: { include: [99505609, "Mystical Elf", "Mirror Force"] }, deckCount: 3 },
        p1: { monsters: [], grave: { include: ["Alexandrite Dragon", "Mirror Force"] }, deckCount: 3 } })],
  }));
  const monsters = ["Mystical Elf", "Alexandrite Dragon", "Aqua Madoor", "Baby Dragon", "Battle Ox"];
  await runScenario(defineScenario({
    id: "domain-bingo-opponent-five-card-branch",
    title: "Bingo's GY branch destroys five opponent monsters and makes that opponent draw two",
    source: "Pinned c99505609.lua: s.efftg/s.effop; new-card-smoke delta review",
    tags: ["domain", "new-card-smoke", "runner-gap"],
    setup: { mode: "domain", deckSize: 4,
      p0: { deckMaster: "Mystical Elf", grave: [99505609], deck },
      p1: { deckMaster: "Celtic Guardian", monsters, deck } },
    steps: [activate({ card: 99505609, from: "grave" }),
      expectBoard({ p0: { banished: [99505609], deckCount: 4 },
        p1: { monsters: [], grave: monsters, deckCount: 2, hand: { count: 2 } } })],
  }));
});
