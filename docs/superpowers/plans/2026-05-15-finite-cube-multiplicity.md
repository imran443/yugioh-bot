# Finite Cube Multiplicity + Reusable Pool Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `×N` copy-count meaningful by modeling a finite physical cube that is materialized at draft start and dealt without replacement, fix the duplicate-card-in-pack bug, and consolidate the card pool preview into one reusable, container-aware component.

**Architecture:** At draft start (player count known) the resolved card multiset is validated, expanded into `packSize × players × packsPerPlayer` physical cards, distributed across distinct packs with a draft-id-seeded RNG, and persisted into a new `draft_cube` table. `openWave` deals per-wave slices from `draft_cube` instead of picking randomly with replacement; drafts already in flight at deploy (no `draft_cube` rows) keep the legacy generator. Card-pool chrome moves into a single `<CardPoolPanel>` wrapper around the existing `CardPoolGrid`.

**Tech Stack:** TypeScript, npm workspaces + Turborepo, better-sqlite3, Vitest, React 19 / Next.js 16, Tailwind, React Testing Library + jsdom.

---

## File Structure

**Created:**
- `packages/shared/src/services/cube.ts` — pure cube engine: seeded RNG, `validateCube`, `buildDraftPacks`. No DB, no I/O.
- `packages/shared/tests/services/cube.test.ts` — unit tests for the engine.
- `packages/web/src/components/cards/card-pool-panel.tsx` — presentational wrapper owning pool chrome.
- `packages/web/tests/components/card-pool-panel.test.tsx` — panel tests.

**Modified:**
- `packages/shared/src/db/schema.ts` — add `draft_cube` table to the migration block.
- `packages/web/src/lib/custom-card-pool.ts` — stop deduping; add `toCardCounts`.
- `packages/shared/src/services/drafts.ts` — `catalogCardIdsForDraft` → multiset; `openWave` → deal-from-cube + legacy guard; `startDraft` → validate + materialize cube.
- `packages/web/app/api/cards/resolve/route.ts` — dedupe ids before `findByIds`.
- `packages/web/src/components/cards/card-pool-grid.tsx` — container-aware grid columns.
- `packages/web/src/components/cards/pool-builder.tsx`, `packages/web/src/components/draft/create-draft-form.tsx`, `packages/web/src/components/draft/draft-manage-view.tsx`, `packages/web/src/components/draft/pool-panel.tsx` — use `<CardPoolPanel>`.
- Test updates: `packages/web/tests/custom-card-pool.test.ts`, `packages/web/tests/components/pool-builder.test.tsx`, `packages/shared/tests/services/drafts.test.ts`, `packages/shared/tests/draft-pool-snapshot.test.ts`.

**Commands** (from repo root):
- Single shared test file: `npx vitest run packages/shared/tests/services/cube.test.ts`
- Single web test file: `npx vitest run packages/web/tests/custom-card-pool.test.ts -c packages/web/vitest.config.ts`
- All tests: `npm test`
- Typecheck: `npm run typecheck`

---

### Task 1: `draft_cube` schema migration

**Files:**
- Modify: `packages/shared/src/db/schema.ts:100-127` (add table inside the existing `db.exec` block, after `draft_cards`)
- Test: `packages/shared/tests/services/drafts.test.ts` (add one test in the existing `describe`)

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe("shared draft service", () => { ... })` block in `packages/shared/tests/services/drafts.test.ts` (place it right after the `setup`/helper usage, e.g. directly before the closing `});` of the describe):

```ts
  it("creates the draft_cube table on migrate", () => {
    const app = setup();
    const row = app.db
      .prepare("select name from sqlite_master where type = 'table' and name = 'draft_cube'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("draft_cube");

    const columns = (app.db.pragma("table_info(draft_cube)") as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["draft_id", "position", "catalog_card_id"]));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts -t "creates the draft_cube table"`
Expected: FAIL — `expect(row?.name).toBe("draft_cube")` receives `undefined`.

- [ ] **Step 3: Add the table to the migration**

In `packages/shared/src/db/schema.ts`, inside the big `db.exec(\`...\`)` block, immediately after the `draft_cards` table definition (the block ending at line 112, before `create table if not exists draft_picks`), insert:

```sql
    create table if not exists draft_cube (
      draft_id integer not null references drafts(id),
      position integer not null,
      catalog_card_id integer not null references card_catalog(ygoprodeck_id),
      primary key (draft_id, position)
    );
```

The `primary key (draft_id, position)` doubles as the index for the per-wave range scan (`where draft_id = ? and position >= ? and position < ? order by position`), so no separate `create index` is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts -t "creates the draft_cube table"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/tests/services/drafts.test.ts
git commit -m "feat(shared): add draft_cube table for finite cube materialization"
```

---

### Task 2: Cube engine (`cube.ts`)

Pure, dependency-free module: seeded PRNG, `validateCube` (the three start-time gates), `buildDraftPacks` (deal that spreads each card's copies across distinct packs).

**Files:**
- Create: `packages/shared/src/services/cube.ts`
- Test: `packages/shared/tests/services/cube.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/tests/services/cube.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mulberry32, seededShuffle, validateCube, buildDraftPacks } from "../../src/services/cube.js";

describe("cube engine", () => {
  it("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA[0]).toBeGreaterThanOrEqual(0);
    expect(seqA[0]).toBeLessThan(1);
  });

  it("seededShuffle is deterministic and a permutation", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const s1 = seededShuffle(input, 99);
    const s2 = seededShuffle(input, 99);
    expect(s1).toEqual(s2);
    expect([...s1].sort((x, y) => x - y)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // input not mutated
  });

  it("validateCube rejects a cube with too few total cards", () => {
    // packSize 8, 2 players, 5 packs/player => slots 80
    const result = validateCube([1, 2, 3], 8, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/needs 80/);
  });

  it("validateCube rejects too few distinct card types", () => {
    // 8 distinct needed; only 2 distinct (lots of copies)
    const pool = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 1 : 2));
    const result = validateCube(pool, 8, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/distinct/i);
  });

  it("validateCube rejects a card with more copies than packs", () => {
    // totalPacks 4; card 1 has 5 copies (> 4); pad distinct + total
    const pool = [1, 1, 1, 1, 1, ...Array.from({ length: 27 }, (_, i) => i + 2)]; // 32 total, packSize 8 x 4 packs = 32
    const result = validateCube(pool, 8, 4);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only 4 packs/);
  });

  it("validateCube accepts a sufficient cube", () => {
    const pool = Array.from({ length: 80 }, (_, i) => i + 1);
    expect(validateCube(pool, 8, 10)).toEqual({ ok: true });
  });

  it("buildDraftPacks produces totalPacks packs of packSize distinct cards", () => {
    const pool = Array.from({ length: 80 }, (_, i) => i + 1);
    const packs = buildDraftPacks(pool, 8, 10, 12345);
    expect(packs).toHaveLength(10);
    for (const pack of packs) {
      expect(pack).toHaveLength(8);
      expect(new Set(pack).size).toBe(8); // distinct within pack
    }
    expect(packs.flat()).toHaveLength(80);
  });

  it("buildDraftPacks spreads a heavily skewed cube without duplicates in a pack", () => {
    // 4 packs of 4 = 16 slots. Card 1 has 4 copies (== totalPacks, the max).
    // Remaining 12 distinct singles fill the rest.
    const pool = [1, 1, 1, 1, ...Array.from({ length: 12 }, (_, i) => i + 2)];
    const packs = buildDraftPacks(pool, 4, 4, 777);
    expect(packs).toHaveLength(4);
    for (const pack of packs) {
      expect(pack).toHaveLength(4);
      expect(new Set(pack).size).toBe(4);
    }
    // Card 1's 4 copies land in 4 different packs (one each).
    const packsWithCard1 = packs.filter((p) => p.includes(1)).length;
    expect(packsWithCard1).toBe(4);
  });

  it("buildDraftPacks is deterministic for a given draft id", () => {
    const pool = Array.from({ length: 80 }, (_, i) => i + 1);
    expect(buildDraftPacks(pool, 8, 10, 555)).toEqual(buildDraftPacks(pool, 8, 10, 555));
  });

  it("buildDraftPacks only deals `slots` cards when the cube has extra", () => {
    // 100 distinct in the cube, but only 80 slots — 20 left unused.
    const pool = Array.from({ length: 100 }, (_, i) => i + 1);
    const packs = buildDraftPacks(pool, 8, 10, 1);
    expect(packs.flat()).toHaveLength(80);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/services/cube.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/cube.js'`.

- [ ] **Step 3: Write the cube engine**

Create `packages/shared/src/services/cube.ts`:

```ts
/**
 * Pure cube engine. No DB, no I/O. The deal is seeded by draft id so a
 * draft's pack layout is reproducible for debugging.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = items.slice();
  const rand = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface CubeValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Three start-time gates. `totalPacks` = players × packsPerPlayer.
 * Gates 2 and 3 are exactly the feasibility conditions for building
 * `packSize`-distinct packs from the multiset.
 */
export function validateCube(
  poolCardIds: number[],
  packSize: number,
  totalPacks: number,
): CubeValidationResult {
  const slots = packSize * totalPacks;

  if (poolCardIds.length < slots) {
    return {
      ok: false,
      error: `Cube too small: this draft needs ${slots} cards (${packSize} per pack × ${totalPacks} packs) but the cube only has ${poolCardIds.length}. Add ${slots - poolCardIds.length} more.`,
    };
  }

  const counts = new Map<number, number>();
  for (const id of poolCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  if (counts.size < packSize) {
    return {
      ok: false,
      error: `Not enough distinct cards: a pack holds ${packSize} different cards but the cube only has ${counts.size} distinct card type(s).`,
    };
  }

  for (const [cardId, count] of counts) {
    if (count > totalPacks) {
      return {
        ok: false,
        error: `Card ${cardId} has ${count} copies but only ${totalPacks} packs exist; a pack cannot hold duplicates. Reduce that card to at most ${totalPacks} copies.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Deal `packSize × totalPacks` cards into `totalPacks` packs, each holding
 * `packSize` DISTINCT cards.
 *
 * 1. Decide per-card usage: one copy of every distinct card first, then
 *    round-robin add remaining copies (capped at the card's available count)
 *    until exactly `slots` cards are chosen. A cube with more than `slots`
 *    cards leaves the surplus unused.
 * 2. Place copies with a cumulative round-robin: copy c of a card goes to
 *    pack `(offset + c) % totalPacks`; `offset` then advances by that card's
 *    usage. Because a card's usage ≤ totalPacks (guaranteed by validateCube),
 *    its copies never collide in one pack. Because total placements = slots =
 *    packSize × totalPacks and the offset sweeps continuously mod totalPacks,
 *    every pack receives exactly `packSize` cards.
 *
 * Caller guarantees validateCube already passed.
 */
export function buildDraftPacks(
  poolCardIds: number[],
  packSize: number,
  totalPacks: number,
  draftId: number,
): number[][] {
  const slots = packSize * totalPacks;

  const counts = new Map<number, number>();
  for (const id of poolCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  const distinctIds = seededShuffle([...counts.keys()], draftId);

  const usage = new Map<number, number>();
  let assigned = 0;
  for (const id of distinctIds) {
    if (assigned >= slots) break;
    usage.set(id, 1);
    assigned += 1;
  }
  let progressed = true;
  while (assigned < slots && progressed) {
    progressed = false;
    for (const id of distinctIds) {
      if (assigned >= slots) break;
      const used = usage.get(id) ?? 0;
      if (used < (counts.get(id) ?? 0)) {
        usage.set(id, used + 1);
        assigned += 1;
        progressed = true;
      }
    }
  }

  const packs: number[][] = Array.from({ length: totalPacks }, () => []);
  let offset = 0;
  for (const cardId of distinctIds) {
    const used = usage.get(cardId) ?? 0;
    for (let c = 0; c < used; c += 1) {
      packs[(offset + c) % totalPacks].push(cardId);
    }
    offset = (offset + used) % totalPacks;
  }

  return packs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/tests/services/cube.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/cube.ts packages/shared/tests/services/cube.test.ts
git commit -m "feat(shared): add pure cube engine — seeded deal + start-time validation"
```

---

### Task 3: `parseCustomCardIds` keeps repeats + `toCardCounts`

Removing the dedup is what makes a pasted-3× passcode mean 3 copies. This breaks two tests that assert the old dedup behavior — both are fixed in this same task so suites stay green.

**Files:**
- Modify: `packages/web/src/lib/custom-card-pool.ts`
- Test: `packages/web/tests/custom-card-pool.test.ts` (update existing), `packages/web/tests/components/pool-builder.test.tsx:69-87` (flip the now-wrong assertion)

- [ ] **Step 1: Update the failing tests to the new contract**

Replace the first test in `packages/web/tests/custom-card-pool.test.ts` (lines 5-10) so the full file reads:

```ts
import { describe, expect, it } from "vitest";
import { parseCustomCardIds, toCardCounts } from "../src/lib/custom-card-pool.js";

describe("custom card pool parser", () => {
  it("preserves repeats in order from newline comma and whitespace separated text", () => {
    expect(parseCustomCardIds("46986414\n83764718, 46986414\t12345678")).toEqual({
      cardIds: [46986414, 83764718, 46986414, 12345678],
      errors: [],
    });
  });

  it("reports invalid tokens without dropping valid passcodes", () => {
    expect(parseCustomCardIds("46986414\nDark Magician\n123x\n83764718")).toEqual({
      cardIds: [46986414, 83764718],
      errors: ["Dark", "Magician", "123x"],
    });
  });

  it("toCardCounts tallies occurrences per id", () => {
    expect(toCardCounts([5, 5, 5, 7, 7, 9])).toEqual(
      new Map([
        [5, 3],
        [7, 2],
        [9, 1],
      ]),
    );
  });
});
```

In `packages/web/tests/components/pool-builder.test.tsx`, replace the test at lines 69-87 (`"collapses repeated custom ids to a single tile with no quantity badge"`) with:

```tsx
  it("shows one tile with a ×N badge for repeated custom ids", async () => {
    stubFetch();
    const onChange = vi.fn();
    render(
      <PoolBuilder
        value={{ setNames: [], customCardText: "46986414\n46986414\n46986414" }}
        onChange={onChange}
      />,
    );

    await act(async () => { vi.advanceTimersByTime(400); });

    await waitFor(() => expect(screen.getByRole("button", { name: /preview dark magician/i })).toBeTruthy());
    // Repeats are no longer deduped: the same card type renders as a single
    // tile, but with a ×3 multiplicity badge derived client-side.
    expect(screen.getAllByRole("button", { name: /preview dark magician/i }).length).toBe(1);
    expect(screen.getByText("×3")).toBeTruthy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/custom-card-pool.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — `toCardCounts` is not exported / first test still gets `[46986414, 83764718, 12345678]`.

Run: `npx vitest run packages/web/tests/components/pool-builder.test.tsx -c packages/web/vitest.config.ts -t "×N badge"`
Expected: FAIL — no `×3` text (still deduped to qty 1).

- [ ] **Step 3: Rewrite `custom-card-pool.ts`**

Replace the entire contents of `packages/web/src/lib/custom-card-pool.ts` with:

```ts
export type CustomCardPoolParseResult = {
  cardIds: number[];
  errors: string[];
};

const cardIdSeparatorPattern = /[\s,]+/;
const cardIdPattern = /^\d+$/;

/**
 * Parse passcodes. Repeats are PRESERVED in order — a passcode pasted N times
 * means N physical copies. Invalid tokens are collected, valid ones kept.
 */
export function parseCustomCardIds(text: string): CustomCardPoolParseResult {
  const cardIds: number[] = [];
  const errors: string[] = [];

  for (const token of text.split(cardIdSeparatorPattern)) {
    const value = token.trim();
    if (!value) {
      continue;
    }

    if (!cardIdPattern.test(value)) {
      errors.push(value);
      continue;
    }

    cardIds.push(Number(value));
  }

  return { cardIds, errors };
}

/** Single place card multiplicities are derived from an id list. */
export function toCardCounts(ids: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/custom-card-pool.test.ts -c packages/web/vitest.config.ts`
Expected: PASS

Run: `npx vitest run packages/web/tests/components/pool-builder.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (all PoolBuilder tests; the `×N badge` test now asserts the badge).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/custom-card-pool.ts packages/web/tests/custom-card-pool.test.ts packages/web/tests/components/pool-builder.test.tsx
git commit -m "feat(web): parseCustomCardIds preserves repeats; add toCardCounts"
```

---

### Task 4: `catalogCardIdsForDraft` returns a multiset

Set/include/catch-all sources contribute one baseline copy; each occurrence of a passcode in `customCardIds` adds one more on top (a set card pasted 3× → 1 + 3 = 4; a custom-only card pasted 3× → 0 + 3 = 3).

**Files:**
- Modify: `packages/shared/src/services/drafts.ts:291-329`
- Test: `packages/shared/tests/draft-pool-snapshot.test.ts` (add a multiset test)

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe("pool snapshot", () => { ... })` block in `packages/shared/tests/draft-pool-snapshot.test.ts`, before its closing `});`:

```ts
  it("resolvePoolCardIds is a multiset: set baseline 1 + additive custom repeats", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db); // cards 1..20 in "Set A"
    const drafts = createDraftService(db);

    // Card 1 is in Set A (baseline 1) and pasted 3× => 4 copies.
    // Card 999 is not in any catalog row => contributes nothing.
    // Card 5 is in Set A only => 1 copy.
    const ids = drafts.resolvePoolCardIds({
      setNames: ["Set A"],
      customCardIds: [1, 1, 1, 999],
    });

    const counts = new Map<number, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);

    expect(counts.get(1)).toBe(4);
    expect(counts.get(5)).toBe(1);
    expect(counts.has(999)).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/draft-pool-snapshot.test.ts -t "multiset"`
Expected: FAIL — `counts.get(1)` is `1`, not `4` (current code dedups via `new Set`).

- [ ] **Step 3: Rewrite `catalogCardIdsForDraft`**

In `packages/shared/src/services/drafts.ts`, replace the entire `catalogCardIdsForDraft` function (lines 291-329) with:

```ts
  const catalogCardIdsForDraft = (config: DraftConfig): number[] => {
    const setNames = new Set((config.setNames ?? []).map((name) => name.trim()));
    const customCounts = new Map<number, number>();
    for (const id of config.customCardIds ?? []) {
      customCounts.set(id, (customCounts.get(id) ?? 0) + 1);
    }
    const includeNames = new Set((config.includeNames ?? []).map(normalizeName));
    const excludeNames = new Set((config.excludeNames ?? []).map(normalizeName));
    const hasExplicitPool = setNames.size > 0 || customCounts.size > 0 || includeNames.size > 0;

    const rows = db
      .prepare("select ygoprodeck_id, name, type, frame_type, card_sets_json from card_catalog")
      .all()
      .map((row: any) => row as CatalogRow);

    const result: number[] = [];

    for (const row of rows) {
      const normalizedName = normalizeName(row.name);

      if (isExtraDeckCatalogRow(row)) {
        continue;
      }
      if (excludeNames.has(normalizedName)) {
        continue;
      }

      // Baseline: 1 copy if the card is sourced from the no-explicit-pool
      // catch-all, an includeNames match, or a selected set. Custom-only
      // membership does NOT add a baseline — its copies come from the count.
      let baseline = 0;
      if (!hasExplicitPool) {
        baseline = 1;
      } else if (includeNames.has(normalizedName)) {
        baseline = 1;
      } else {
        const cardSets = JSON.parse(row.card_sets_json) as Array<{ set_name: string }>;
        if (cardSets.some((cardSet) => setNames.has(cardSet.set_name))) {
          baseline = 1;
        }
      }

      const custom = customCounts.get(row.ygoprodeck_id) ?? 0;
      const total = baseline + custom;
      for (let i = 0; i < total; i += 1) {
        result.push(row.ygoprodeck_id);
      }
    }

    return result;
  };
```

(`resolvePoolCardIds` at line 932 already returns `catalogCardIdsForDraft(config)` — it now returns the multiset with no further change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/tests/draft-pool-snapshot.test.ts -t "multiset"`
Expected: PASS

Run: `npx vitest run packages/shared/tests/draft-pool-snapshot.test.ts -t "resolvePoolCardIds returns cards matching the recipe"`
Expected: PASS (20 distinct Set A cards, baseline 1 each → length 20, still green).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/drafts.ts packages/shared/tests/draft-pool-snapshot.test.ts
git commit -m "feat(shared): catalogCardIdsForDraft returns a multiset (set=1 + additive custom)"
```

---

### Task 5: `openWave` — legacy guard + deal-from-cube reader

`openWave` stops picking randomly with replacement. When `draft_cube` rows exist it deals the per-wave slice; when none exist (a draft already in flight before this deployed) it keeps the old generator. Task 5 only changes `openWave`; `startDraft` does not yet build a cube, so every draft still takes the legacy branch and the existing suite stays green. The cube branch is exercised in Task 6.

**Files:**
- Modify: `packages/shared/src/services/drafts.ts:344-381` (the whole `openWave` function)
- Test: `packages/shared/tests/services/drafts.test.ts` (add one legacy-branch test)

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/tests/services/drafts.test.ts` inside the `describe`, before its closing `});`:

```ts
  it("openWave falls back to the legacy generator when no draft_cube rows exist", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "legacy night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 80);
    app.drafts.start(draft.id);

    // No draft_cube rows are written by Task 5's startDraft, so the legacy
    // path runs: each player still gets a packSize pack in wave 1.
    const cubeCount = (
      app.db.prepare("select count(*) as n from draft_cube where draft_id = ?").get(draft.id) as { n: number }
    ).n;
    expect(cubeCount).toBe(0);
    expect(app.drafts.currentPackOptions(draft.id, yugi.id)).toHaveLength(8);
    expect(app.drafts.currentPackOptions(draft.id, kaiba.id)).toHaveLength(8);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts -t "legacy generator"`
Expected: FAIL — config `{}` resolves all 80 catalog cards via the OLD `catalogCardIdsForDraft`… actually this passes by accident today. To force a real RED, first apply Step 3's `openWave` rewrite expecting the `draft_cube` query to exist; before the rewrite this test fails because `seedCatalogCards(80)` + config `{}` still works but the assertion `cubeCount).toBe(0)` references the `draft_cube` table which exists (Task 1) and returns 0 — so the meaningful failure is the missing branch logic. Run the rewrite then re-run; if Step 2 shows PASS pre-rewrite, that is acceptable here because this test's purpose is a regression guard for the legacy branch — proceed to Step 3 and confirm it still passes.

(Engineer note: this test is a guard, not a strict RED→GREEN. The strict RED→GREEN cube assertions live in Task 6.)

- [ ] **Step 3: Rewrite `openWave`**

In `packages/shared/src/services/drafts.ts`, replace the entire `openWave` function (lines 344-381) with:

```ts
  const openWave = (draftId: number, waveNumber: number, playerCount: number, config: DraftConfig) => {
    const packSize = config.packSize ?? defaultDraftConfig.packSize;
    const passDirection = waveNumber % 2 === 0 && config.alternatePassDirection ? -1 : 1;
    const insertPack = db.prepare(
      `
        insert into draft_packs (
          draft_id,
          pack_round,
          origin_seat_index,
          current_holder_seat_index,
          pass_direction
        ) values (?, ?, ?, ?, ?)
      `,
    );
    const insertDraftCard = db.prepare(
      `
        insert into draft_cards (draft_id, wave_number, draft_pack_id, catalog_card_id, position)
        values (?, ?, ?, ?, ?)
      `,
    );

    const hasCube = db.prepare("select 1 from draft_cube where draft_id = ? limit 1").get(draftId);

    if (hasCube) {
      const selectSlice = db.prepare(
        "select catalog_card_id from draft_cube where draft_id = ? and position >= ? and position < ? order by position",
      );
      for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
        const globalPack = (waveNumber - 1) * playerCount + playerIndex;
        const sliceRows = selectSlice.all(
          draftId,
          globalPack * packSize,
          (globalPack + 1) * packSize,
        ) as Array<{ catalog_card_id: number }>;
        const packId = Number(
          insertPack.run(draftId, waveNumber, playerIndex, playerIndex, passDirection).lastInsertRowid,
        );
        sliceRows.forEach((row, cardIndex) => {
          insertDraftCard.run(draftId, waveNumber, packId, row.catalog_card_id, cardIndex);
        });
      }
      return;
    }

    // Legacy path: drafts already active before the cube model deployed have
    // no draft_cube rows and finish all remaining waves on the old generator.
    const catalogCardIds =
      config.poolCardIds && config.poolCardIds.length > 0
        ? config.poolCardIds
        : catalogCardIdsForDraft(config);

    if (catalogCardIds.length === 0) {
      throw new Error("Draft pool is empty");
    }

    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
      const packId = Number(
        insertPack.run(draftId, waveNumber, playerIndex, playerIndex, passDirection).lastInsertRowid,
      );

      for (let cardIndex = 0; cardIndex < packSize; cardIndex += 1) {
        const catalogCardId = catalogCardIds[Math.floor(Math.random() * catalogCardIds.length)];
        insertDraftCard.run(draftId, waveNumber, packId, catalogCardId, cardIndex);
      }
    }
  };
```

- [ ] **Step 4: Run the shared draft suites to verify they stay green**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts packages/shared/tests/draft-pool-snapshot.test.ts`
Expected: PASS for the new `legacy generator` test and all pre-existing tests (no cube is built yet, so behavior is unchanged from before — note the existing seed counts still work because there is no validation gate until Task 6).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/drafts.ts packages/shared/tests/services/drafts.test.ts
git commit -m "feat(shared): openWave deals from draft_cube with a legacy-generator fallback"
```

---

### Task 6: `startDraft` — validate + materialize the cube

This is the cutover. `startDraft` resolves the multiset, runs the three validation gates, builds the packs with `buildDraftPacks`, and persists them into `draft_cube`. After this, every freshly started draft takes `openWave`'s cube branch. The start-time validation breaks several existing tests that seed too few cards — all are fixed in this task.

**Files:**
- Modify: `packages/shared/src/services/drafts.ts` — add `import` for the cube engine; rewrite `startDraft` (lines 383-432)
- Test: `packages/shared/tests/services/drafts.test.ts` (fix seed counts; add validation + cube tests), `packages/shared/tests/draft-pool-snapshot.test.ts` (parametrize `seedDb`)

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/tests/services/drafts.test.ts` inside the `describe`, before its closing `});`:

```ts
  it("blocks start when the cube has too few total cards", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "small cube", { setNames: ["Metal Raiders"] }, "user-1", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 16); // 16 < 80 slots

    expect(() => app.drafts.start(draft.id)).toThrow(/Cube too small/);
  });

  it("blocks start when there are too few distinct card types", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    // 2 distinct ids, each pasted 40× => 80 total, packSize 8 needs 8 distinct.
    const customCardIds = [...Array(40).fill(101), ...Array(40).fill(102)];
    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "skewed",
      { customCardIds, packSize: 8, packsPerPlayer: 5 },
      "user-1",
      yugi.id,
    );
    app.drafts.join(draft.id, kaiba.id);
    for (const id of [101, 102]) {
      app.db
        .prepare(
          `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
           values (?, ?, 'Spellcaster / Normal Monster', 'normal', '', '', '[]', '2026-01-01T00:00:00Z')`,
        )
        .run(id, `Custom ${id}`);
    }

    expect(() => app.drafts.start(draft.id)).toThrow(/distinct/i);
  });

  it("blocks start when a card has more copies than packs", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    // totalPacks = 2 players × 5 = 10. Card 101 pasted 11× (> 10).
    const customCardIds = [...Array(11).fill(101), ...Array.from({ length: 69 }, (_, i) => 200 + i)];
    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "over-copied",
      { customCardIds, packSize: 8, packsPerPlayer: 5 },
      "user-1",
      yugi.id,
    );
    app.drafts.join(draft.id, kaiba.id);
    const ins = app.db.prepare(
      `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
       values (?, ?, 'Spellcaster / Normal Monster', 'normal', '', '', '[]', '2026-01-01T00:00:00Z')`,
    );
    ins.run(101, "Custom 101");
    for (let i = 0; i < 69; i += 1) ins.run(200 + i, `Custom ${200 + i}`);

    expect(() => app.drafts.start(draft.id)).toThrow(/only 10 packs exist/);
  });

  it("materializes draft_cube at start and deals wave 1 from it", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", { setNames: ["Metal Raiders"] }, "user-1", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 80); // 80 distinct == slots

    app.drafts.start(draft.id);

    const cubeRows = app.db
      .prepare("select position, catalog_card_id from draft_cube where draft_id = ? order by position")
      .all(draft.id) as Array<{ position: number; catalog_card_id: number }>;
    expect(cubeRows).toHaveLength(80); // packSize 8 × (2 players × 5 packs)
    expect(cubeRows.map((r) => r.position)).toEqual(Array.from({ length: 80 }, (_, i) => i));

    // Wave 1 = first 2 packs of the cube (one per player), each 8 distinct.
    const wave1 = app.db
      .prepare("select catalog_card_id from draft_cards where draft_id = ? and wave_number = 1 order by draft_pack_id, position")
      .all(draft.id) as Array<{ catalog_card_id: number }>;
    expect(wave1).toHaveLength(16);
    expect(wave1.map((r) => r.catalog_card_id)).toEqual(
      cubeRows.slice(0, 16).map((r) => r.catalog_card_id),
    );
    expect(app.drafts.currentPackOptions(draft.id, yugi.id)).toHaveLength(8);
  });

  it("legacy guard: a started draft with draft_cube deleted opens later waves via the generator", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "midflight", { setNames: ["Metal Raiders"] }, "user-1", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 80);
    app.drafts.start(draft.id);

    // Simulate a pre-deploy in-flight draft: drop its cube rows.
    app.db.prepare("delete from draft_cube where draft_id = ?").run(draft.id);

    // Drive wave 1 to completion so openWave(wave 2) fires (legacy branch).
    for (let step = 0; step < 8; step += 1) {
      const y = app.drafts.currentPackOptions(draft.id, yugi.id);
      const k = app.drafts.currentPackOptions(draft.id, kaiba.id);
      if (y.length > 0) app.drafts.pickCard(draft.id, yugi.id, y[0].id);
      if (k.length > 0) app.drafts.pickCard(draft.id, kaiba.id, k[0].id);
    }

    const wave2 = app.db
      .prepare("select count(*) as n from draft_cards where draft_id = ? and wave_number = 2")
      .get(draft.id) as { n: number };
    expect(wave2.n).toBeGreaterThan(0);
  });
```

Then fix the existing tests broken by the new validation gate (start now requires `packSize × players × packsPerPlayer` cards):

- Line 116: `seedCatalogCards(app.db, 16);` → `seedCatalogCards(app.db, 80);`
- Lines 139-146 (`"uses custom card ids as an explicit draft pool"`): change `customCardIds: [101, 102], packSize: 2, packsPerPlayer: 1` to `customCardIds: [101, 101, 102, 102], packSize: 2, packsPerPlayer: 1` (slots = 2 × (2 players × 1) = 4; two cards × 2 copies = 4 ✓; each card 2 copies ≤ totalPacks 2 ✓). The assertion `expect(openedCardIds).toEqual([{ catalog_card_id: 101 }, { catalog_card_id: 102 }])` stays — the cube deal is now deterministic and contains both.
- Line 194: `seedCatalogCards(app.db, 16);` → `seedCatalogCards(app.db, 80);`
- Line 219: `seedCatalogCards(app.db, 50);` → `seedCatalogCards(app.db, 80);`
- Line 255: `seedCatalogCards(app.db, 50);` → `seedCatalogCards(app.db, 80);`
- Line 283: `seedCatalogCards(app.db, 50);` → `seedCatalogCards(app.db, 80);`
- Line 330: `seedCatalogCards(app.db, 60);` → `seedCatalogCards(app.db, 100);` (this test uses `packSize: 10, packsPerPlayer: 5` → slots = 10 × (2 × 5) = 100)

In `packages/shared/tests/draft-pool-snapshot.test.ts`, parametrize `seedDb` and bump the two start-using tests. Replace the `seedDb` function (lines 6-17) with:

```ts
function seedDb(db: Database.Database, count = 20) {
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u1', 'Alice')").run();
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u2', 'Bob')").run();
  const insertCard = db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, 'Effect Monster', 'effect', '', '', ?, current_timestamp)`,
  );
  for (let i = 1; i <= count; i++) {
    insertCard.run(i, `Card ${i}`, JSON.stringify([{ set_name: "Set A" }]));
  }
}
```

In the same file, change the `seedDb(db);` call at line 33 (inside `"openWave uses poolCardIds when present..."`) to `seedDb(db, 80);`, and the `seedDb(db);` call at line 71 (inside `"openWave falls back to catalog when poolCardIds is absent (old draft)"`) to `seedDb(db, 80);`. Test 1 (`"resolvePoolCardIds returns cards matching the recipe"`, line 23) keeps `seedDb(db);` (default 20) — its `toHaveLength(20)` assertion stays valid.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts -t "blocks start"`
Expected: FAIL — `start` does not throw (no validation yet).

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts -t "materializes draft_cube"`
Expected: FAIL — `draft_cube` has 0 rows (startDraft does not build it yet).

- [ ] **Step 3: Add the cube import and rewrite `startDraft`**

In `packages/shared/src/services/drafts.ts`, add the import near the other relative imports at the top of the file (match the existing `.js`-extension ESM style used elsewhere in the package):

```ts
import { validateCube, buildDraftPacks } from "./cube.js";
```

Replace the entire `startDraft` transaction (lines 383-432) with:

```ts
  const startDraft = db.transaction((draftId: number, now = new Date()) => {
    const draft = findById(draftId);

    if (draft.status !== "pending") {
      throw new Error("Draft must be pending to start");
    }

    const playerIds = db
      .prepare(
        `
          select player_id from draft_players
          where draft_id = ?
          order by joined_at asc, rowid asc
        `,
      )
      .all(draftId)
      .map((row: any) => row.player_id);

    if (playerIds.length < 2) {
      throw new Error("Draft requires at least two players to start");
    }

    const assignSeat = db.prepare(
      `
        update draft_players
        set seat_index = ?
        where draft_id = ? and player_id = ?
      `,
    );

    for (const [seatIndex, playerId] of playerIds.entries()) {
      assignSeat.run(seatIndex, draftId, playerId);
    }

    const packSize = draft.config.packSize ?? defaultDraftConfig.packSize;
    const packsPerPlayer = draft.config.packsPerPlayer ?? defaultDraftConfig.packsPerPlayer;
    const totalPacks = playerIds.length * packsPerPlayer;

    const poolCardIds =
      draft.config.poolCardIds && draft.config.poolCardIds.length > 0
        ? draft.config.poolCardIds
        : catalogCardIdsForDraft(draft.config);

    const validation = validateCube(poolCardIds, packSize, totalPacks);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const packs = buildDraftPacks(poolCardIds, packSize, totalPacks, draftId);
    const insertCube = db.prepare(
      "insert into draft_cube (draft_id, position, catalog_card_id) values (?, ?, ?)",
    );
    let position = 0;
    for (const pack of packs) {
      for (const cardId of pack) {
        insertCube.run(draftId, position, cardId);
        position += 1;
      }
    }

    openWave(draftId, 1, playerIds.length, draft.config);

    db.prepare(
      `
        update drafts
        set status = 'active',
            started_at = ?,
            current_wave_number = 1,
            current_pick_step = 1,
            pick_deadline_at = ?
        where id = ?
      `,
    ).run(now.toISOString(), deadlineIso(now, draft.config.pickSeconds ?? defaultDraftConfig.pickSeconds), draftId);

    return findById(draftId);
  });
```

- [ ] **Step 4: Run the full shared suite to verify green**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts packages/shared/tests/draft-pool-snapshot.test.ts`
Expected: PASS — new validation + cube + legacy-guard tests pass; all pre-existing tests pass with the bumped seed counts and the `[101,101,102,102]` custom-ids change.

Run: `npm test --workspace=packages/shared`
Expected: PASS (whole shared package).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/drafts.ts packages/shared/tests/services/drafts.test.ts packages/shared/tests/draft-pool-snapshot.test.ts
git commit -m "feat(shared): materialize + validate finite cube at draft start"
```

---

### Task 7: `cards/resolve` dedupes before catalog lookup

`resolvePoolCardIds` now returns a multiset. The resolve route only needs distinct cards for the preview grid (PoolBuilder computes `qty` client-side from the parsed ids), so dedupe before `findByIds`.

**Files:**
- Modify: `packages/web/app/api/cards/resolve/route.ts:25-30`
- Test: `packages/web/tests/cards-resolve-route.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Append this test to the existing `describe` in `packages/web/tests/cards-resolve-route.test.ts` (keep the file's existing imports and mocks; this assumes the existing helper that POSTs to the route — match the surrounding test style in that file):

```ts
  it("returns one card entry per distinct id even when ids repeat", async () => {
    // Two catalog cards; request repeats 101 three times.
    seedCard(db, 101, "Alpha");
    seedCard(db, 102, "Beta");

    const res = await POST(
      new Request("http://test/api/cards/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setNames: [], customCardIds: [101, 101, 101, 102] }),
      }),
    );

    const body = (await res.json()) as { cards: Array<{ id: number }> };
    const ids = body.cards.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toEqual([101, 102]); // distinct, no triple 101
  });
```

(If `packages/web/tests/cards-resolve-route.test.ts` has no `seedCard` helper, add a local one mirroring the catalog-insert pattern already used in that file's `beforeEach`/`setup`. Do not invent a new auth mock — reuse the file's existing session mock.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/cards-resolve-route.test.ts -c packages/web/vitest.config.ts -t "one card entry per distinct id"`
Expected: FAIL — `findByIds` receives `[101,101,101,102]`; depending on its impl it may return duplicate `101` entries, so `ids` is `[101,101,101,102]`.

- [ ] **Step 3: Dedupe before `findByIds`**

In `packages/web/app/api/cards/resolve/route.ts`, replace lines 25-30:

```ts
  const resolvedIds = drafts.resolvePoolCardIds({
    setNames,
    customCardIds,
  });

  const cards: CardSummary[] = catalog.findByIds(resolvedIds).map((c) => ({
```

with:

```ts
  const resolvedIds = drafts.resolvePoolCardIds({
    setNames,
    customCardIds,
  });
  const distinctIds = [...new Set(resolvedIds)];

  const cards: CardSummary[] = catalog.findByIds(distinctIds).map((c) => ({
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/cards-resolve-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (new test + all pre-existing route tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/cards/resolve/route.ts packages/web/tests/cards-resolve-route.test.ts
git commit -m "fix(web): cards/resolve dedupes ids before catalog lookup"
```

---

### Task 8: `<CardPoolPanel>` reusable wrapper

A presentational wrapper owning the chrome (container, header, count, loading/error) around the existing `CardPoolGrid`. Data-driven, no fetching.

**Files:**
- Create: `packages/web/src/components/cards/card-pool-panel.tsx`
- Test: `packages/web/tests/components/card-pool-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/components/card-pool-panel.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CardPoolPanel } from "../../src/components/cards/card-pool-panel";
import type { CardSummary } from "../../src/lib/card-types";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

const cards: CardSummary[] = [
  { id: 1, name: "Bujingi Crane", type: "Winged Beast / Effect Monster", frameType: "effect", effectText: "", imageUrl: "u1", imageUrlSmall: "s1" },
  { id: 2, name: "Mirror Force", type: "Trap Card", frameType: "trap", effectText: "", imageUrl: "u2", imageUrlSmall: "s2", qty: 3 },
];

describe("CardPoolPanel", () => {
  it("renders the title and a distinct-count summary", () => {
    render(<CardPoolPanel cards={cards} title="Cube Pool" />);
    expect(screen.getByText("Cube Pool")).toBeTruthy();
    expect(screen.getByText(/2 cards/i)).toBeTruthy();
  });

  it("shows total copies when any qty > 1 and countMode is copies", () => {
    render(<CardPoolPanel cards={cards} title="Cube Pool" countMode="copies" />);
    // 1 (qty undefined => 1) + 3 = 4 copies across 2 distinct types
    expect(screen.getByText(/2 cards/i)).toBeTruthy();
    expect(screen.getByText(/4 copies/i)).toBeTruthy();
  });

  it("collapses to just the card count when every qty is 1", () => {
    render(
      <CardPoolPanel
        cards={[{ ...cards[0] }, { ...cards[1], qty: 1 }]}
        title="Cube Pool"
        countMode="copies"
      />,
    );
    expect(screen.getByText(/2 cards/i)).toBeTruthy();
    expect(screen.queryByText(/copies/i)).toBeNull();
  });

  it("renders an error slot", () => {
    render(<CardPoolPanel cards={[]} title="Cube Pool" error="Failed to resolve cards." />);
    expect(screen.getByText("Failed to resolve cards.")).toBeTruthy();
  });

  it("delegates to the grid (renders a preview tile per card)", () => {
    render(<CardPoolPanel cards={cards} title="Cube Pool" />);
    expect(screen.getByRole("button", { name: /preview bujingi crane/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /preview mirror force/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/card-pool-panel.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — `Cannot find module '../../src/components/cards/card-pool-panel'`.

- [ ] **Step 3: Write the component**

Create `packages/web/src/components/cards/card-pool-panel.tsx`:

```tsx
"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import type { CardSummary } from "@/lib/card-types";

interface CardPoolPanelProps {
  cards: CardSummary[];
  title: string;
  loading?: boolean;
  unknownIds?: number[];
  emptyMessage?: string;
  error?: string | null;
  heightClassName?: string;
  showSummary?: boolean;
  /** "distinct" (default) shows just N cards; "copies" also shows total copies when any qty > 1. */
  countMode?: "distinct" | "copies";
  className?: string;
}

export function CardPoolPanel({
  cards,
  title,
  loading = false,
  unknownIds = [],
  emptyMessage = "No cards.",
  error = null,
  heightClassName,
  showSummary = false,
  countMode = "distinct",
  className,
}: CardPoolPanelProps) {
  const distinct = cards.length;
  const totalCopies = useMemo(
    () => cards.reduce((sum, c) => sum + (c.qty ?? 1), 0),
    [cards],
  );
  const showCopies = countMode === "copies" && totalCopies > distinct;

  return (
    <div className={cn("@container rounded-xl border border-border bg-surface p-3", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-display text-lg text-text-primary">{title}</h3>
        <span aria-live="polite" className="text-sm tabular-nums text-text-secondary">
          {distinct} card{distinct === 1 ? "" : "s"}
          {showCopies ? ` · ${totalCopies} copies` : ""}
          {loading ? " · resolving…" : ""}
        </span>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-accent-cta/20 bg-accent-cta/10 px-3 py-2 text-sm text-accent-cta">
          {error}
        </p>
      )}

      <CardPoolGrid
        cards={cards}
        loading={loading}
        unknownIds={unknownIds}
        emptyMessage={emptyMessage}
        heightClassName={heightClassName}
        showSummary={showSummary}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/card-pool-panel.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/cards/card-pool-panel.tsx packages/web/tests/components/card-pool-panel.test.tsx
git commit -m "feat(web): add reusable CardPoolPanel wrapper around CardPoolGrid"
```

---

### Task 9: Container-aware grid in `CardPoolGrid`

Swap the fixed `grid-cols-2 … 2xl:grid-cols-3` for an auto-fill grid that responds to the grid's own width (narrow sidebar → 2-3 columns; wide manage view → 5-6+). `repeat(auto-fill, minmax(9rem, 1fr))` needs no Tailwind container-query plugin.

**Files:**
- Modify: `packages/web/src/components/cards/card-pool-grid.tsx:162,172`
- Test: `packages/web/tests/components/card-pool-grid.test.tsx` (add a class assertion; existing tests stay green)

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe("CardPoolGrid", () => { ... })` block in `packages/web/tests/components/card-pool-grid.test.tsx`, before its closing `});`:

```tsx
  it("uses an auto-fill responsive grid (no fixed column count)", () => {
    render(<CardPoolGrid cards={cards} />);
    const grid = screen.getByTestId("card-pool-grid");
    expect(grid.className).toContain("grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]");
    expect(grid.className).not.toContain("grid-cols-2");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts -t "auto-fill responsive grid"`
Expected: FAIL — grid still has `grid-cols-2 … 2xl:grid-cols-3`.

- [ ] **Step 3: Swap the grid classes**

In `packages/web/src/components/cards/card-pool-grid.tsx`, change the two grid container `className`s.

Line 162 (skeleton):

```tsx
          <div data-testid="card-pool-grid-skeleton" className="grid grid-cols-2 gap-3 p-3 2xl:grid-cols-3">
```

becomes:

```tsx
          <div data-testid="card-pool-grid-skeleton" className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 p-3">
```

Line 172 (the real grid):

```tsx
          <div data-testid="card-pool-grid" className="grid grid-cols-2 gap-3 p-3 2xl:grid-cols-3">
```

becomes:

```tsx
          <div data-testid="card-pool-grid" className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 p-3">
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (new test + all pre-existing CardPoolGrid tests — none assert the old column classes).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-pool-grid.test.tsx
git commit -m "feat(web): container-aware auto-fill grid in CardPoolGrid"
```

---

### Task 10: Refactor the four call sites onto `<CardPoolPanel>`

Replace the duplicated chrome at four sites with the panel. Each keeps its own fetch hook/state and passes `cards` down.

**Files:**
- Modify: `packages/web/src/components/cards/pool-builder.tsx:91-134`
- Modify: `packages/web/src/components/draft/pool-panel.tsx:33-77`
- Modify: `packages/web/src/components/draft/create-draft-form.tsx` (right-column preview, ~lines 268-290)
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx` (left sticky pool, ~lines 310-334)

- [ ] **Step 1: Refactor `pool-builder.tsx`**

In `packages/web/src/components/cards/pool-builder.tsx`, replace the import on line 8:

```tsx
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
```

with:

```tsx
import { CardPoolPanel } from "@/components/cards/card-pool-panel";
```

Replace the `showPreview` block (lines 116-132):

```tsx
      {showPreview && (
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm font-medium text-text-primary">
            <span>Pool preview</span>
            <span aria-live="polite" className="text-text-secondary tabular-nums">— {count} card{count === 1 ? "" : "s"}</span>
            {loading && <span className="text-xs text-text-muted">resolving…</span>}
          </div>
          <CardPoolGrid
            cards={cards}
            unknownIds={unknownIds}
            loading={loading}
            heightClassName={previewHeightClassName}
            emptyMessage="Add sets or card IDs above to preview the pool."
            showSummary={false}
          />
        </div>
      )}
```

with:

```tsx
      {showPreview && (
        <CardPoolPanel
          title="Pool preview"
          cards={cards}
          unknownIds={unknownIds}
          loading={loading}
          heightClassName={previewHeightClassName}
          emptyMessage="Add sets or card IDs above to preview the pool."
          countMode="copies"
        />
      )}
```

The now-unused `const count = cards.length;` on line 89 can be deleted (it was only used by the old header).

- [ ] **Step 2: Refactor `pool-panel.tsx` (drafting screen)**

In `packages/web/src/components/draft/pool-panel.tsx`, replace the import on line 9:

```tsx
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
```

with:

```tsx
import { CardPoolPanel } from "@/components/cards/card-pool-panel";
```

Replace the grid wrapper inside `panelContent` (lines 49-51):

```tsx
      <div className="rounded-xl border border-border bg-bg-elevated/40 p-3">
        <CardPoolGrid cards={groupedPool} heightClassName="h-[26rem] xl:h-[34rem]" emptyMessage="No cards drafted yet." />
      </div>
```

with:

```tsx
      <CardPoolPanel
        title="Drafted"
        cards={groupedPool}
        heightClassName="h-[26rem] xl:h-[34rem]"
        emptyMessage="No cards drafted yet."
        countMode="copies"
      />
```

(`groupedPool` already carries `qty` from its existing dedupe-with-count `useMemo` at lines 20-31 — `countMode="copies"` now surfaces it.)

- [ ] **Step 3: Refactor `create-draft-form.tsx` and `draft-manage-view.tsx`**

Open `packages/web/src/components/draft/create-draft-form.tsx`. Locate the right-column pool preview (the block around lines 268-290 that renders a `CardPoolGrid` or the inline pool chrome fed by the create form's pool state). Replace that block with a `<CardPoolPanel>` using the same `cards`/`loading`/`unknownIds` state variables already in scope, e.g.:

```tsx
<CardPoolPanel
  title="Pool preview"
  cards={poolCards}
  unknownIds={poolUnknownIds}
  loading={poolLoading}
  emptyMessage="Add sets or card IDs to preview the pool."
  countMode="copies"
/>
```

(Use the exact state identifiers already present in this file — read the surrounding lines to confirm names; do not introduce new fetch logic.) Add `import { CardPoolPanel } from "@/components/cards/card-pool-panel";` and remove a now-unused `CardPoolGrid` import if present.

Open `packages/web/src/components/draft/draft-manage-view.tsx`. Locate the left sticky pool block (around lines 310-334) that fetches `/api/drafts/${slug}/pool` and renders the grid/chrome. Replace the rendered chrome+grid with:

```tsx
<CardPoolPanel
  title="Card pool"
  cards={poolCards}
  loading={poolLoading}
  error={poolError}
  emptyMessage="No cards in this pool."
  countMode="copies"
/>
```

(Reuse the file's existing pool fetch state identifiers; keep the fetch effect untouched.) Add the `CardPoolPanel` import and drop a now-unused `CardPoolGrid` import if present.

- [ ] **Step 4: Typecheck, run web tests, and verify in the browser**

Run: `npm run typecheck`
Expected: PASS (no type errors from the refactor; prop names match `CardPoolPanelProps`).

Run: `npx vitest run -c packages/web/vitest.config.ts`
Expected: PASS (all web tests, including PoolBuilder and CardPoolPanel).

Then start the dev server and verify each surface visually:

Run: `npm run dev:web` (in a separate terminal; with `dev:bot` + `dev:ws` if needed)
Manually confirm in a browser:
- Create-draft form: pasting a passcode 3× shows one tile with a `×3` badge and the summary reads `N cards · M copies`.
- Draft manage view (pending): left pool panel renders, count summary correct, grid widens to more columns on a wide window and 2-3 on a narrow one.
- Drafting screen `PoolPanel`: drafted cards show with `×N` when the same card was picked multiple times.
- Pool preview empty/loading/error states render via the panel.

If you cannot run a browser in this environment, state that explicitly instead of claiming the UI works.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/cards/pool-builder.tsx packages/web/src/components/draft/pool-panel.tsx packages/web/src/components/draft/create-draft-form.tsx packages/web/src/components/draft/draft-manage-view.tsx
git commit -m "refactor(web): consolidate pool chrome onto CardPoolPanel at 4 call sites"
```

---

### Task 11: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the monorepo**

Run: `npm run typecheck`
Expected: PASS for all packages.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS for `shared` and `web`. The 4 known pre-existing `bot` failures are out of scope and unrelated — confirm the failure set is unchanged (no NEW bot failures introduced; the bot inherits the shared multiset/validation with no bot-specific code change).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (Turbo builds `shared` first; `bot`, `ws`, `web` compile).

- [ ] **Step 4: Manual smoke — bot draft-start validation surfaces**

Confirm (by code reading + the existing bot start path at `packages/bot/src/interactions/buttons.ts:505-526` and `packages/bot/src/commands/handlers.ts:684-699`) that `deps.drafts.start(draft.id)` throwing a `validateCube` error propagates to the bot's existing error reply path — the bot has no custom-id input and no `poolCardIds` snapshot, so its drafts materialize as distinct 1-copy set cards and are validated by the same shared `startDraft`. No bot code change is required; note this explicitly in the task completion.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

Only if Steps 1-3 required fixes:

```bash
git add -A
git commit -m "fix: address typecheck/test fixups for finite cube feature"
```

Otherwise no commit — the feature is complete across the Task 1-10 commits.

---

## Self-Review

**1. Spec coverage:**

- Finite physical cube / deal without replacement → Tasks 2, 6 (`buildDraftPacks`, `startDraft` materialization, `openWave` slice reader).
- Duplicate-in-pack bug fix → Task 2 (distinct-within-pack guarantee) + Task 6 (cutover).
- Copy input = repeat passcode, no new syntax → Task 3 (`parseCustomCardIds` keeps repeats).
- Set contribution = 1 baseline + additive custom → Task 4 (`catalogCardIdsForDraft` multiset).
- Validate at draft start with clear messages (too-few-total, too-few-distinct, copies > totalPacks) → Task 2 (`validateCube`) + Task 6 (gated in `startDraft`, tested).
- `draft_cube` table, additive migration following existing pattern → Task 1.
- Seeded-by-draft-id reproducible deal → Task 2 (`mulberry32` keyed by `draftId`, determinism test).
- Backward compat: completed untouched (never regenerated), active mid-flight legacy guard (no `draft_cube` rows → old generator), pending pre-deploy → materializes 1-copy-each → Task 5 (guard + test) + Task 6 (legacy-guard test).
- Reusable `<CardPoolPanel>` with the specified props and distinct/copies count → Task 8.
- Container-aware grid → Task 9.
- Refactor the 4 call sites → Task 10.
- Templates ripple (repeats preserved through `parseCustomCardIds`) → covered transitively by Task 3 (no template schema change; no separate task needed since templates only re-join ids).
- Bot ripple (inherits shared logic; start-time validation surfaces as a reply) → Task 11 Step 4 (verification, no code change).
- Web routes: `/api/drafts` + `/api/drafts/[slug]` snapshot `resolvePoolCardIds` (now multiset) with zero route change; `/api/drafts/[slug]/pool` already computes `qty`; `cards/resolve` deduped → Task 7 + transitive (no change needed for the snapshot routes, by design).
- Existing suites stay green; pre-existing bot failures out of scope → Tasks 3, 5, 6 fix every broken test in the same commit; Task 11 Step 2 confirms the bot failure set is unchanged.

No gaps.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Every code step contains complete code. The two soft spots — Task 10 Step 3 (`create-draft-form.tsx` / `draft-manage-view.tsx`) and Task 7's `seedCard` helper — are intentionally instruction-plus-template because the exact in-scope state identifiers must be read from those files at execution time; the `<CardPoolPanel>` usage and prop contract are fully specified, so this is integration wiring, not a hidden design decision.

**3. Type consistency:** `validateCube(poolCardIds, packSize, totalPacks): CubeValidationResult` and `buildDraftPacks(poolCardIds, packSize, totalPacks, draftId): number[][]` are defined in Task 2 and consumed with the identical signatures in Task 6. `CubeValidationResult.error` is `string | undefined`; Task 6 throws `new Error(validation.error)` only inside `if (!validation.ok)`. `CardPoolPanelProps` (Task 8) — `cards, title, loading?, unknownIds?, emptyMessage?, error?, heightClassName?, showSummary?, countMode?, className?` — matches every call site in Tasks 8 and 10. `toCardCounts` is exported from `custom-card-pool.ts` in Task 3 and imported in the Task 3 test. `draft_cube(draft_id, position, catalog_card_id)` columns (Task 1) match the inserts/selects in Tasks 5 and 6.

No inconsistencies found.
