import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../helpers/fixtures";
import { handCard, ownZone, pickLegalZone, useCard } from "../helpers/board";
import { enterDuelRoom } from "../helpers/duel";
import { collectTableErrors, readTable, startTablePreset } from "../helpers/table";
import { declineToAction, rulesPanel, rulesZone } from "../helpers/table-rules";
import type { Page } from "@playwright/test";

// GitHub issue 321: negated monsters carry a visible mark, and the target of an auto-picked Effect Veiler is named.
// Preset negation-veiler-ffa4 (seat 1 is a scripted bot): needs DUEL_SCENARIOS=1 on the stack, which every e2e stack sets.
//   E2E_SLOT=7 E2E_WORKERS=1 DUEL_SCENARIOS=1 E2E_PRESET=negation-veiler-ffa4 npm run e2e --workspace=packages/e2e -- tests/negation-indicator.spec.ts
// NEGATION_SHOTS=<dir> also writes the screenshots used in the design review.

const BLS = "Black Luster Soldier - Soldier of Light and Darkness";
const shotsDir = process.env.NEGATION_SHOTS;

const mark = (page: Page, sequence: number) => rulesZone(page, 0, sequence).locator("[data-negation-mark]");
const zoneNegated = (page: Page, sequence: number) => rulesZone(page, 0, sequence).and(page.locator("[data-negated='true']"));

/** The board plays its chain effects a few seconds after the engine answers; a screenshot waits for them to leave. */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('[data-chain-callout], [data-chain-panel], [data-testid="chain-tower"]')).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await settle(page);
  mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

test.describe("negated monsters (FFA4)", () => {
  test.setTimeout(180_000);

  test("Destined Rivals marks Souls and Toy Soldier; Effect Veiler's auto-picked target is named, then marked", async ({ player }) => {
    const { page } = await player("p1");
    const errors = collectTableErrors(page);
    const slug = await startTablePreset(page, "negation-veiler-ffa4");

    // Start: three face-up monsters, none negated.
    for (const sequence of [0, 1, 2]) {
      await expect(rulesZone(page, 0, sequence)).toHaveAttribute("data-occupied", "true");
      await expect(zoneNegated(page, sequence)).toHaveCount(0);
      await expect(mark(page, sequence)).toHaveCount(0);
    }
    await expect(rulesZone(page, 0, 0).getByRole("button", { name: /^Your monster zone 1$/ })).toBeVisible();
    await shot(page, "plaza-before");

    // First Pot of Greed: seat 1 chains Destined Rivals. Souls and Toy Soldier are negated, Black Luster Soldier is immune.
    await useCard(page, handCard(page, "Pot of Greed"), "Activate");
    await pickLegalZone(page, "st");
    await declineToAction(page, slug);
    await expect(zoneNegated(page, 1)).toHaveCount(1);
    await expect(zoneNegated(page, 2)).toHaveCount(1);
    await expect(mark(page, 1)).toHaveAttribute("aria-label", "Effects negated");
    await expect(mark(page, 2)).toHaveAttribute("aria-label", "Effects negated");
    await expect(rulesZone(page, 0, 1).getByRole("button", { name: /^Your monster zone 2\. .*Effects negated/ })).toBeVisible();
    await expect(zoneNegated(page, 0)).toHaveCount(0);
    await expect(mark(page, 0)).toHaveCount(0);
    const afterRivals = (await readTable(page, slug)).engine!;
    expect(afterRivals.seats[0]!.monsters.filter(Boolean).map((card) => [card!.name, card!.negated ?? false])).toEqual([[BLS, false], ["Magicians' Souls", true], ["Toy Soldier", true]]);
    await shot(page, "plaza-after-rivals");

    // Second Pot of Greed: seat 1 chains Effect Veiler. Nobody else holds a response, so the host resolves the chain in
    // one batch and the chain target ring (it follows the live chain) has no time to show. The log line is the cue.
    await useCard(page, handCard(page, "Pot of Greed"), "Activate");
    await pickLegalZone(page, "st");
    await expect(zoneNegated(page, 0)).toHaveCount(1);
    await expect(mark(page, 0)).toHaveAttribute("aria-label", "Effects negated");
    await expect(rulesZone(page, 0, 0).getByRole("button", { name: /^Your monster zone 1\. .*Effects negated/ })).toBeVisible();
    const end = (await readTable(page, slug)).engine!;
    const logText = end.log.map((entry) => entry.text);
    expect(logText).toContain(`Chain Link 2: Effect Veiler targets ${BLS}`);
    // The "Only legal target" line is private to the activating seat (a bot here), so seat 0 never reads it.
    expect(logText.join("\n")).not.toContain("Only legal target");
    expect(end.seats[0]!.monsters.filter(Boolean).map((card) => card!.negated ?? false)).toEqual([true, true, true]);
    expect(end.seats[0]!.monsters.filter(Boolean)[0]!.attack).toBe(3000);
    await shot(page, "plaza-after-veiler");
    // Hovering the card shows its peek, which says so, too.
    await rulesZone(page, 0, 0).locator("button").first().hover();
    await expect(page.getByTestId("inspector-negated").first()).toHaveText(/Effects negated/);
    await shot(page, "inspector");

    await page.getByRole("navigation", { name: "Table panels" }).getByRole("button", { name: /^Log/ }).click();
    // The Log panel names the target twice: on the link's History entry and in the match sheet line.
    const panel = page.getByRole("dialog", { name: "Log panel" });
    await expect(panel.getByText(`Targets ${BLS}`, { exact: true })).toBeVisible();
    await expect(panel.getByText(`Chain Link 2: Effect Veiler targets ${BLS}`)).toBeAttached();
    await shot(page, "log-veiler-target");

    // A spectator sees every seat as a compact board (?stage=legacy keeps those boards); the mark must read at that size too.
    await page.mouse.move(5, 5);
    const watcher = await player("p2");
    await watcher.page.goto(`/duels/${encodeURIComponent(slug)}?window=1&stage=legacy`);
    await enterDuelRoom(watcher.page);
    const compact = watcher.page.locator("[data-zones][data-negated='true']");
    await expect(compact).toHaveCount(3);
    await expect(watcher.page.locator("[data-negation-mark]")).toHaveCount(3);
    await expect(watcher.page.locator("[data-negation-mark]").first()).toHaveAttribute("aria-label", "Effects negated");
    await shot(watcher.page, "compact-ffa4-spectator");
    // Phone width: no horizontal page scroll, and the mark is still drawn.
    for (const view of [watcher.page, page]) {
      await view.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => view.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    }
    await expect(watcher.page.locator("[data-negation-mark]")).toHaveCount(3);
    await watcher.page.getByTestId("seat-board-0").getByRole("button").first().click();
    await expect(watcher.page.locator("[data-negation-mark]").first()).toBeVisible();
    await expect.poll(() => watcher.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot(watcher.page, "compact-ffa4-spectator-390");
    await shot(page, "plaza-390");

    expect(errors).toEqual([]);
  });

  test("1v1: Effect Veiler's only legal target shows as negated on the field, and the log names it", async ({ player }) => {
    const { page } = await player("p1");
    const errors = collectTableErrors(page);
    const started = await page.request.post("/api/duels/preset", { data: { presetId: "negation-veiler-1v1" }, timeout: 60_000 });
    expect(started.ok(), await started.text()).toBe(true);
    const { slug } = (await started.json()) as { slug: string };
    await page.goto(`/duels/${slug}?window=1`);
    await enterDuelRoom(page);

    const toy = ownZone(page, "mz", 0);
    await expect(toy).toHaveAttribute("data-occupied", "true");
    await expect(toy).not.toHaveAttribute("data-negated", "true");
    await expect(page.locator("[data-negation-mark]")).toHaveCount(0);
    await shot(page, "field-1v1-before");

    await useCard(page, handCard(page, "Pot of Greed"), "Activate");
    await pickLegalZone(page, "st");
    await expect(toy).toHaveAttribute("data-negated", "true");
    await expect(page.locator("[data-negation-mark]")).toHaveCount(1);
    await expect(page.locator("[data-negation-mark]")).toHaveAttribute("aria-label", "Effects negated");
    const engine = (await (await page.request.get(`/api/duels/${encodeURIComponent(slug)}`)).json()).engine as { log: Array<{ text: string }> };
    expect(engine.log.map((entry) => entry.text)).toContain("Chain Link 2: Effect Veiler targets Toy Soldier");
    await shot(page, "field-1v1");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await expect(page.locator("[data-negation-mark]")).toHaveCount(1);
    await shot(page, "field-1v1-390");
    expect(errors).toEqual([]);
  });
});
