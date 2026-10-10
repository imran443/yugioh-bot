import { expect, it } from "vitest";
import { smokeExpectedEffects } from "../scripts/lib/new-card-smoke-effects.js";
import { summarizeCard } from "../scripts/lib/new-card-smoke-pool.js";

const result = (expected: Array<{ id: string; label: string; parent?: string }>) => ({
  id: "normal/1v1/hand", seed: 1, steps: 3, offered: [], activated: expected.map(e => e.id), replayed: true, expected,
});

it("does not let unprinted helper choices cover missing printed branches of another effect", () => {
  const description = "Choose a printed effect;\n● Draw 1 card.\n● Destroy 1 card.\nYou can add a card to your hand or Set it.";
  const test = result([{ id: "printed", label: "Choose a printed effect" }, { id: "helper", label: "Add or Set" },
    { id: "hand", label: "Add it", parent: "helper" }, { id: "set", label: "Set it", parent: "helper" }]);
  expect(smokeExpectedEffects([test], description).size).toBe(6);
  const card = summarizeCard({ code: 42, type: 33, description }, [test]);
  expect(card.status).toBe("WARN");
  expect(card.reason).toContain("4 of 6");
});

it("compares separate printed groups with their own parent effects", () => {
  const description = "First selection;\n● A.\n● B.\nSecond selection;\n● C.\n● D.";
  const test = result([{ id: "first", label: "First selection" }, { id: "second", label: "Second selection" },
    { id: "a", label: "A", parent: "first" }, { id: "c", label: "C", parent: "second" },
    { id: "d", label: "D", parent: "second" }, { id: "extra", label: "Unprinted", parent: "second" }]);
  expect(smokeExpectedEffects([test], description).size).toBe(7);
  expect(summarizeCard({ code: 42, type: 33, description }, [test]).reason).toContain("6 of 7");
});

it("keeps the total and warns when a printed group cannot be matched reliably", () => {
  const description = "Choose an effect;\n● Draw 1 card.\n● Destroy 1 card.";
  const test = result([{ id: "first", label: "First effect" }, { id: "second", label: "Second effect" },
    { id: "a", label: "A", parent: "second" }, { id: "b", label: "B", parent: "second" }]);
  expect(smokeExpectedEffects([test], description).size).toBe(4);
  const card = summarizeCard({ code: 42, type: 33, description }, [test]);
  expect(card.status).toBe("WARN");
  expect(card.reason).toContain("reliably");
});

it("accepts complete per-effect coverage despite punctuation and activation restrictions", () => {
  const description = 'Activate 1 of these effects (but only once per turn);\r\n● A.\r\n● B.\r\nOther effect: Add a card.';
  const test = result([{ id: "selection", label: "Activate 1 of these effects;" }, { id: "other", label: "Add a card" },
    { id: "a", label: "A", parent: "selection" }, { id: "b", label: "B", parent: "selection" }]);
  expect(summarizeCard({ code: 42, type: 33, description }, [test]).status).toBe("PASS");
});

it("does not assign a printed group to one of several effects with the same label", () => {
  const description = "Choose an effect;\n● A.\n● B.";
  const test = result([{ id: "first", label: "Choose an effect" }, { id: "second", label: "Choose an effect" },
    { id: "a", label: "A", parent: "second" }, { id: "b", label: "B", parent: "second" }]);
  expect(smokeExpectedEffects([test], description).size).toBe(4);
  expect(summarizeCard({ code: 42, type: 33, description }, [test]).status).toBe("WARN");
});
