# Pack Variety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop players being shown the same card twice within a single Wave by dealing a weighted Cube with at most one copy of any card per Wave, and validate feasibility at draft start.

**Architecture:** Two phases. Phase 0 is a behavior-preserving rename (`Pool`/`Cube`/`Deal`, Scheme 1) including backwards-compatible SQLite migrations. Phase 1 replaces `validateCube`→`analyzeCube` (distinct ≥ players×packSize) and `buildDraftPacks`→`buildDeal` (copies spread across distinct Waves, sized to exactly S = players×waves×packSize by weight-proportional trim/pad).

**Tech Stack:** TypeScript, npm workspaces + Turborepo, better-sqlite3, Vitest. Business logic in `@yugidraft/shared`.

**Spec:** [`docs/superpowers/specs/2026-05-24-pack-variety-design.md`](../specs/2026-05-24-pack-variety-design.md) · **Decision:** [ADR-0002](../../adr/0002-pack-variety-deal.md)

**Sizes used throughout:** `P` = players, `W` = waves (`packsPerPlayer`), `k` = packSize, `C = P×k` (cards per wave), `S = P×W×k` (total deal slots). A pack at flat index `i` belongs to wave `floor(i/P)`, seat `i%P` — this is how `openWave` slices, so `buildDeal` must emit packs wave-major then seat-major.

**Test commands:** shared package: `npx vitest run packages/shared/tests/services/cube.test.ts` (single file) or `npm test --workspace=packages/shared` (whole package). Type check: `npm run typecheck`.

---

## Phase 0 — Rename (no behavior change)

### Task 1: Rename `draft_cube` table → `draft_deal`

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (create-table block + `migrate`)
- Modify: `packages/shared/src/services/drafts.ts:387,391,483`
- Test: `packages/shared/tests/db/schema.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add to `packages/shared/tests/db/schema.test.ts`:

```ts
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";

it("migrates a legacy draft_cube table to draft_deal, preserving rows", () => {
  const db = new Database(":memory:");
  // minimal legacy shape
  db.exec(`
    create table draft_cube (draft_id integer not null, position integer not null,
      catalog_card_id integer not null, primary key (draft_id, position));
    insert into draft_cube (draft_id, position, catalog_card_id) values (1, 0, 1001), (1, 1, 1002);
  `);
  migrate(db);
  const rows = db.prepare("select position, catalog_card_id from draft_deal where draft_id = 1 order by position").all();
  expect(rows).toEqual([
    { position: 0, catalog_card_id: 1001 },
    { position: 1, catalog_card_id: 1002 },
  ]);
  const oldGone = db.prepare("select 1 from sqlite_master where type='table' and name='draft_cube'").get();
  expect(oldGone).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts -t "migrates a legacy draft_cube"`
Expected: FAIL — `draft_deal` does not exist.

- [ ] **Step 3: Rename the table in the create-table block**

In `packages/shared/src/db/schema.ts`, change the `create table if not exists draft_cube (...)` statement to `create table if not exists draft_deal (...)` (columns unchanged: `draft_id`, `position`, `catalog_card_id`, `primary key (draft_id, position)`).

- [ ] **Step 4: Add the data-copy migration inside `migrate(db)`**

Add near the other migration calls in `migrate(db)` (after the create-table block has run):

```ts
// Rename: draft_cube -> draft_deal (copy rows then drop; idempotent)
const hasLegacyCube = db
  .prepare("select 1 from sqlite_master where type='table' and name='draft_cube'")
  .get();
if (hasLegacyCube) {
  db.exec(`
    insert into draft_deal (draft_id, position, catalog_card_id)
      select draft_id, position, catalog_card_id from draft_cube;
    drop table draft_cube;
  `);
}
```

- [ ] **Step 5: Update `drafts.ts` references**

In `packages/shared/src/services/drafts.ts`:
- Line ~387: `select 1 from draft_cube where draft_id = ? limit 1` → `... from draft_deal ...`
- Line ~391: `select catalog_card_id from draft_cube where ...` → `... from draft_deal ...`
- Line ~483: `insert into draft_cube (draft_id, position, catalog_card_id) ...` → `insert into draft_deal (...)`
- Update the comment at ~411 (`no draft_cube rows`) → `no draft_deal rows`.

- [ ] **Step 6: Update other references**

Run `grep -rln "draft_cube" packages --include="*.ts"` and update remaining test references (`packages/bot/tests/db/shared-db.test.ts`, `packages/shared/tests/db/schema.test.ts`, `packages/shared/tests/services/drafts.test.ts`) to `draft_deal`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts` then `npm test --workspace=packages/shared`
Expected: PASS (including the new migration test).

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/src/services/drafts.ts packages/shared/tests packages/bot/tests
git commit -m "refactor(shared): rename draft_cube table to draft_deal"
```

---

### Task 2: Rename `draft_packs.pack_round` column → `wave_number`

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (create-table + unique + index + `migrate`)
- Modify: `packages/shared/src/services/drafts.ts:373,546,656,774`
- Test: `packages/shared/tests/db/schema.test.ts`

- [ ] **Step 1: Write the failing migration test**

```ts
it("renames legacy draft_packs.pack_round to wave_number, preserving rows", () => {
  const db = new Database(":memory:");
  db.exec(`
    create table draft_packs (id integer primary key autoincrement, draft_id integer not null,
      pack_round integer not null, origin_seat_index integer not null,
      current_holder_seat_index integer not null, pass_direction integer not null);
    insert into draft_packs (draft_id, pack_round, origin_seat_index, current_holder_seat_index, pass_direction)
      values (1, 2, 0, 0, 1);
  `);
  migrate(db);
  const row = db.prepare("select wave_number from draft_packs where draft_id = 1").get();
  expect(row).toEqual({ wave_number: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts -t "renames legacy draft_packs.pack_round"`
Expected: FAIL — no `wave_number` column.

- [ ] **Step 3: Update the create-table block**

In `schema.ts`, `create table if not exists draft_packs`: rename column `pack_round integer not null` → `wave_number integer not null`, and the constraint `unique (draft_id, pack_round, origin_seat_index)` → `unique (draft_id, wave_number, origin_seat_index)`. Also update the index `draft_packs_holder_idx on draft_packs (draft_id, pack_round, current_holder_seat_index)` → `(draft_id, wave_number, current_holder_seat_index)`.

- [ ] **Step 4: Add the column-rename migration inside `migrate(db)`**

```ts
// Rename: draft_packs.pack_round -> wave_number (idempotent)
const packCols = db.prepare("pragma table_info(draft_packs)").all() as Array<{ name: string }>;
const hasPackRound = packCols.some((c) => c.name === "pack_round");
const hasWaveNumber = packCols.some((c) => c.name === "wave_number");
if (hasPackRound && !hasWaveNumber) {
  db.exec("alter table draft_packs rename column pack_round to wave_number");
}
```

(SQLite ≥3.25 carries the unique constraint and the index over automatically on `rename column`; better-sqlite3 bundles a newer SQLite.)

- [ ] **Step 5: Update `drafts.ts` references**

In `packages/shared/src/services/drafts.ts`, replace `pack_round` with `wave_number` at the insert (~373) and the three `where ... pack_round = ?` reads (~546, ~656, ~774). The bound values are unchanged (they already pass the wave number).

- [ ] **Step 6: Update remaining references**

`grep -rln "pack_round" packages --include="*.ts"` and update test references (`packages/bot/tests/services/drafts.test.ts`, `packages/shared/tests/db/schema.test.ts`, `packages/shared/tests/services/drafts.test.ts`).

- [ ] **Step 7: Run tests**

Run: `npm test --workspace=packages/shared && npm test --workspace=packages/bot`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/src/services/drafts.ts packages/shared/tests packages/bot/tests
git commit -m "refactor(shared): rename draft_packs.pack_round to wave_number"
```

---

### Task 3: Rename `poolCardIds` → `cubeCardIds` (with read-both for persisted config)

**Files:**
- Modify: `packages/shared/src/types/index.ts:12`
- Modify: `packages/shared/src/services/drafts.ts` (~413-414, ~471-473, method `resolvePoolCardIds`→`resolveCubeCardIds` at ~1008)
- Modify: `packages/web/app/api/drafts/route.ts`, `packages/web/app/api/drafts/[slug]/route.ts`, `packages/web/app/api/drafts/[slug]/pool/route.ts`
- Test: `packages/shared/tests/services/drafts.test.ts`

- [ ] **Step 1: Write the failing read-both test**

Add to `packages/shared/tests/services/drafts.test.ts` (use the existing in-memory db + service helpers in that file):

```ts
it("resolveCubeCardIds reads a legacy poolCardIds config key", () => {
  const ids = service.resolveCubeCardIds({ poolCardIds: [1, 2, 3] } as any);
  expect(ids).toEqual([1, 2, 3]);
});

it("resolveCubeCardIds prefers cubeCardIds when present", () => {
  const ids = service.resolveCubeCardIds({ cubeCardIds: [7, 8], poolCardIds: [1] } as any);
  expect(ids).toEqual([7, 8]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts -t "resolveCubeCardIds"`
Expected: FAIL — `service.resolveCubeCardIds is not a function`.

- [ ] **Step 3: Update the type (read-both)**

In `packages/shared/src/types/index.ts`, in `DraftConfig`:

```ts
  cubeCardIds?: number[];
  /** @deprecated legacy key, still read for drafts created before the rename */
  poolCardIds?: number[];
```

- [ ] **Step 4: Rename the service method and add the fallback**

In `packages/shared/src/services/drafts.ts`, rename the public method (~1008):

```ts
    resolveCubeCardIds(config: DraftConfig): number[] {
      return config.cubeCardIds && config.cubeCardIds.length > 0
        ? config.cubeCardIds
        : config.poolCardIds && config.poolCardIds.length > 0
          ? config.poolCardIds
          : catalogCardIdsForDraft(config);
    },
```

Update the two internal uses (~413-414 in `openWave`, ~471-473 in `startDraft`) to call the same precedence: `config.cubeCardIds ?? config.poolCardIds` before falling back to `catalogCardIdsForDraft(config)`. Rename the local `poolCardIds` variable in `startDraft` to `cubeCardIds`.

- [ ] **Step 5: Update web routes (write new key, read both)**

- `packages/web/app/api/drafts/route.ts`: `const cubeCardIds = drafts.resolveCubeCardIds(config);` and write `const configWithPool = { ...config, cubeCardIds };` (rename the property written into the persisted config).
- `packages/web/app/api/drafts/[slug]/route.ts`: same rename for `resolveCubeCardIds`, the length guard, and `(mergedConfig as any).cubeCardIds = cubeCardIds;`. The check at ~243 becomes `if (!draftModel.config.cubeCardIds?.length && !draftModel.config.poolCardIds?.length)`.
- `packages/web/app/api/drafts/[slug]/pool/route.ts`: `const ids = config.cubeCardIds?.length ? config.cubeCardIds : config.poolCardIds?.length ? config.poolCardIds : drafts.resolveCubeCardIds(config);`

- [ ] **Step 6: Update remaining references**

`grep -rln "poolCardIds\|resolvePoolCardIds" packages --include="*.ts"` — update remaining web tests (`drafts-pool-route.test.ts`, `drafts-put-route.test.ts`) and shared tests (`draft-pool-snapshot.test.ts`, `draft-tournament-helper.test.ts`). Keep at least one test that passes a legacy `poolCardIds` key to prove the fallback. Ignore `packages/shared/dist/**` (build output).

- [ ] **Step 7: Run tests + typecheck**

Run: `npm run typecheck && npm test --workspace=packages/shared && npm test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared packages/web
git commit -m "refactor: rename poolCardIds to cubeCardIds (read-both for legacy configs)"
```

---

## Phase 1 — Deal algorithm + validation

### Task 4: Replace `validateCube` with `analyzeCube`

**Files:**
- Modify: `packages/shared/src/services/cube.ts:22-61`
- Modify: `packages/shared/src/services/drafts.ts:4,476-479`
- Test: `packages/shared/tests/services/cube.test.ts`

- [ ] **Step 1: Replace the validation tests**

In `packages/shared/tests/services/cube.test.ts`, replace the four `validateCube` tests (lines ~24-50) with:

```ts
import { analyzeCube } from "../../src/services/cube.js";

it("analyzeCube errors when distinct < players × packSize", () => {
  // 3 players × 8 packSize => need 24 distinct; provide 10
  const cube = Array.from({ length: 10 }, (_, i) => i + 1);
  const r = analyzeCube(cube, 3, 5, 8);
  expect(r.ok).toBe(false);
  expect(r.errors.join(" ")).toMatch(/at least 24 distinct/);
});

it("analyzeCube accepts when distinct == players × packSize (boundary)", () => {
  const cube = Array.from({ length: 24 }, (_, i) => i + 1);
  const r = analyzeCube(cube, 3, 5, 8);
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
});

it("analyzeCube warns (not errors) when a card has more copies than waves", () => {
  // 2 players × 4 packSize => 8 distinct needed; card 1 has 6 copies, waves = 3
  const cube = [1, 1, 1, 1, 1, 1, ...Array.from({ length: 7 }, (_, i) => i + 2)];
  const r = analyzeCube(cube, 2, 3, 4);
  expect(r.ok).toBe(true);
  expect(r.warnings.join(" ")).toMatch(/card 1/i);
  expect(r.warnings.join(" ")).toMatch(/capped at 3/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/tests/services/cube.test.ts -t "analyzeCube"`
Expected: FAIL — `analyzeCube` not exported.

- [ ] **Step 3: Implement `analyzeCube` (replace `validateCube` + `CubeValidationResult`)**

In `packages/shared/src/services/cube.ts`, replace lines 22-61 with:

```ts
export interface CubeAnalysis {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function analyzeCube(
  cubeCardIds: number[],
  players: number,
  waves: number,
  packSize: number,
): CubeAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cardsPerWave = players * packSize;

  const counts = new Map<number, number>();
  for (const id of cubeCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const distinct = counts.size;

  if (distinct < cardsPerWave) {
    const maxPackSize = Math.floor(distinct / players);
    errors.push(
      `Cube needs at least ${cardsPerWave} distinct cards for ${players} players × ${packSize} per pack, but has ${distinct}. ` +
        `Add ${cardsPerWave - distinct} more distinct cards, or reduce pack size to ${maxPackSize}.`,
    );
  }

  for (const [cardId, count] of counts) {
    if (count > waves) {
      warnings.push(
        `Card ${cardId} has ${count} copies but a draft has only ${waves} waves; it will be capped at ${waves} (one copy per wave).`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
```

- [ ] **Step 4: Update `startDraft` to call `analyzeCube`**

In `packages/shared/src/services/drafts.ts`:
- Line 4 import: `import { analyzeCube, buildDeal } from "./cube.js";` (the `buildDeal` half lands in Task 5; for this task import `analyzeCube` and keep `buildDraftPacks` until Task 5).
- Replace lines ~476-479:

```ts
    const players = playerIds.length;
    const waves = packsPerPlayer;
    const analysis = analyzeCube(cubeCardIds, players, waves, packSize);
    if (!analysis.ok) {
      throw new Error(analysis.errors.join(" "));
    }
```

(`cubeCardIds` is the local renamed in Task 3. `totalPacks` stays defined for the existing `buildDraftPacks` call until Task 5.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/shared/tests/services/cube.test.ts && npm test --workspace=packages/shared`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/cube.ts packages/shared/src/services/drafts.ts packages/shared/tests/services/cube.test.ts
git commit -m "feat(shared): analyzeCube validates distinct >= players x packSize"
```

---

### Task 5: Replace `buildDraftPacks` with `buildDeal` (one copy per wave)

**Files:**
- Modify: `packages/shared/src/services/cube.ts:63-108`
- Modify: `packages/shared/src/services/drafts.ts:4,481`
- Test: `packages/shared/tests/services/cube.test.ts`

- [ ] **Step 1: Replace the buildDraftPacks tests with buildDeal tests**

In `packages/shared/tests/services/cube.test.ts`, replace the `buildDraftPacks` tests (lines ~52-88) with these. Note the helper that asserts the core invariant:

```ts
import { buildDeal } from "../../src/services/cube.js";

// pack at flat index i is in wave floor(i / players)
function wavesOf(packs: number[][], players: number): number[][] {
  const waves: number[][] = [];
  packs.forEach((pack, i) => {
    const w = Math.floor(i / players);
    (waves[w] ??= []).push(...pack);
  });
  return waves;
}

it("buildDeal: every pack has packSize distinct cards, total = S", () => {
  const cube = Array.from({ length: 80 }, (_, i) => i + 1);
  const packs = buildDeal(cube, { players: 2, waves: 5, packSize: 8, draftId: 12345 });
  expect(packs).toHaveLength(10); // P*W
  for (const pack of packs) {
    expect(pack).toHaveLength(8);
    expect(new Set(pack).size).toBe(8);
  }
  expect(packs.flat()).toHaveLength(80); // S = 2*5*8
});

it("buildDeal: no card appears more than once within a wave", () => {
  const cube = Array.from({ length: 80 }, (_, i) => i + 1);
  const packs = buildDeal(cube, { players: 2, waves: 5, packSize: 8, draftId: 999 });
  for (const wave of wavesOf(packs, 2)) {
    expect(new Set(wave).size).toBe(wave.length);
  }
});

it("buildDeal: draft-34 regression — 7×4×13 has zero within-wave duplicates", () => {
  const cube = Array.from({ length: 239 }, (_, i) => i + 1); // 239 distinct, 1 copy each
  const packs = buildDeal(cube, { players: 7, waves: 4, packSize: 13, draftId: 34 });
  expect(packs).toHaveLength(28);
  expect(packs.flat()).toHaveLength(364); // S
  for (const wave of wavesOf(packs, 7)) {
    expect(wave).toHaveLength(91); // C = 7*13
    expect(new Set(wave).size).toBe(91); // all distinct in the wave
  }
});

it("buildDeal: a card's copies land in distinct waves, capped at waves", () => {
  // card 1 authored 10x but only 3 waves => at most 3 copies, in 3 distinct waves
  const cube = [...Array(10).fill(1), ...Array.from({ length: 30 }, (_, i) => i + 2)];
  const packs = buildDeal(cube, { players: 2, waves: 3, packSize: 4, draftId: 5 });
  const waves = wavesOf(packs, 2);
  const wavesWithCard1 = waves.filter((w) => w.includes(1)).length;
  const copiesOfCard1 = packs.flat().filter((c) => c === 1).length;
  expect(copiesOfCard1).toBeLessThanOrEqual(3);
  expect(copiesOfCard1).toBe(wavesWithCard1); // one per wave it appears in
});

it("buildDeal: pads a too-small cube by reusing cards across waves", () => {
  // 24 distinct, S = 2*3*4 = 24 ... make it smaller: 12 distinct, S = 24 => must pad
  const cube = Array.from({ length: 12 }, (_, i) => i + 1);
  const packs = buildDeal(cube, { players: 2, waves: 3, packSize: 4, draftId: 7 });
  expect(packs.flat()).toHaveLength(24);
  for (const wave of wavesOf(packs, 2)) {
    expect(new Set(wave).size).toBe(8); // C = 8, still all distinct in-wave
  }
});

it("buildDeal: weight-proportional — heavier authored card gets >= copies", () => {
  // card 1 authored 3x, others 1x; cube larger than S so trimming happens
  const cube = [1, 1, 1, ...Array.from({ length: 40 }, (_, i) => i + 2)];
  const packs = buildDeal(cube, { players: 2, waves: 3, packSize: 4, draftId: 11 });
  const flat = packs.flat();
  const c1 = flat.filter((c) => c === 1).length;
  // a singleton that survived, for comparison
  const survivor = [...new Set(flat)].find((id) => id !== 1)!;
  const cs = flat.filter((c) => c === survivor).length;
  expect(c1).toBeGreaterThanOrEqual(cs);
});

it("buildDeal is deterministic for a given draftId", () => {
  const cube = Array.from({ length: 80 }, (_, i) => i + 1);
  expect(buildDeal(cube, { players: 2, waves: 5, packSize: 8, draftId: 555 }))
    .toEqual(buildDeal(cube, { players: 2, waves: 5, packSize: 8, draftId: 555 }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/tests/services/cube.test.ts -t "buildDeal"`
Expected: FAIL — `buildDeal` not exported.

- [ ] **Step 3: Implement `buildDeal` (replace `buildDraftPacks`)**

In `packages/shared/src/services/cube.ts`, replace `buildDraftPacks` (lines 63-108) with:

```ts
export function buildDeal(
  cubeCardIds: number[],
  opts: { players: number; waves: number; packSize: number; draftId: number },
): number[][] {
  const { players, waves, packSize, draftId } = opts;
  const totalPacks = players * waves;
  const cardsPerWave = players * packSize; // C
  const slots = totalPacks * packSize; // S

  // 1. authored counts
  const counts = new Map<number, number>();
  for (const id of cubeCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  // deterministic order
  const distinctIds = seededShuffle([...counts.keys()], draftId);

  // 2. budgets: start at min(count, waves), then trim/pad to exactly `slots`
  const budget = new Map<number, number>();
  let total = 0;
  for (const id of distinctIds) {
    const b = Math.min(counts.get(id) ?? 0, waves);
    budget.set(id, b);
    total += b;
  }
  // trim: drop copies from the least-weighted cards first (singletons fall to zero)
  while (total > slots) {
    let pick: number | undefined;
    let pickB = Infinity;
    for (const id of distinctIds) {
      const b = budget.get(id) ?? 0;
      if (b > 0 && b < pickB) {
        pickB = b;
        pick = id;
      }
    }
    if (pick === undefined) break;
    budget.set(pick, pickB - 1);
    total -= 1;
  }
  // pad: round-robin +1 to cards with headroom (spreads invented copies)
  while (total < slots) {
    let addedThisPass = false;
    for (const id of distinctIds) {
      if (total >= slots) break;
      const b = budget.get(id) ?? 0;
      if (b < waves) {
        budget.set(id, b + 1);
        total += 1;
        addedThisPass = true;
      }
    }
    if (!addedThisPass) break; // unreachable when analyzeCube passed
  }

  // 3. assign each card's copies to distinct waves; balance wave fill (cap C each)
  const waveCards: number[][] = Array.from({ length: waves }, () => []);
  const waveRemaining = new Array<number>(waves).fill(cardsPerWave);
  // most-constrained-first: highest budget placed first
  const assignOrder = [...distinctIds].sort(
    (a, b) => (budget.get(b) ?? 0) - (budget.get(a) ?? 0),
  );
  for (const id of assignOrder) {
    const b = budget.get(id) ?? 0;
    if (b === 0) continue;
    // pick the b waves with the most remaining capacity
    const targets = Array.from({ length: waves }, (_, w) => w)
      .filter((w) => waveRemaining[w] > 0)
      .sort((x, y) => waveRemaining[y] - waveRemaining[x])
      .slice(0, b);
    for (const w of targets) {
      waveCards[w].push(id);
      waveRemaining[w] -= 1;
    }
  }

  // 4. within each wave, round-robin its C distinct cards into P packs of packSize
  const packs: number[][] = Array.from({ length: totalPacks }, () => []);
  for (let w = 0; w < waves; w += 1) {
    const shuffled = seededShuffle(waveCards[w], draftId + w + 1);
    shuffled.forEach((id, i) => {
      const seat = i % players;
      packs[w * players + seat].push(id);
    });
  }

  return packs;
}
```

- [ ] **Step 4: Wire `startDraft` to `buildDeal`**

In `packages/shared/src/services/drafts.ts`:
- Line 4: ensure import is `import { analyzeCube, buildDeal } from "./cube.js";` (remove `buildDraftPacks`).
- Replace the `buildDraftPacks(...)` call (~481):

```ts
    const packs = buildDeal(cubeCardIds, { players, waves, packSize, draftId });
```

(`players`/`waves` were introduced in Task 4. The downstream flatten-into-`draft_deal` loop is unchanged — it iterates `packs` in index order, which is already wave-major/seat-major.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run typecheck && npm test --workspace=packages/shared`
Expected: PASS (all `buildDeal` tests, including the draft-34 regression).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/cube.ts packages/shared/src/services/drafts.ts packages/shared/tests/services/cube.test.ts
git commit -m "feat(shared): buildDeal deals one copy per wave, sized to S"
```

---

### Task 6: Surface validation at draft create/edit (advisory)

**Files:**
- Modify: `packages/web/app/api/drafts/route.ts`, `packages/web/app/api/drafts/[slug]/route.ts`
- Test: `packages/web/tests/drafts-route.test.ts`

- [ ] **Step 1: Write the failing route test**

Add to `packages/web/tests/drafts-route.test.ts` (follow the file's existing request-mocking pattern):

```ts
it("create returns analyzeCube warnings when a card exceeds the wave count", async () => {
  // build a config whose cube has a card with copies > packsPerPlayer
  // (reuse the helper that posts to the create route in this file)
  const res = await postCreateDraft({
    packSize: 4,
    packsPerPlayer: 3,
    customCardIds: [1, 1, 1, 1, 1, ...range(2, 20)], // card 1 has 5 copies > 3 waves
  });
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.warnings.join(" ")).toMatch(/card 1/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/web/tests/drafts-route.test.ts -t "analyzeCube warnings" -c packages/web/vitest.config.ts`
Expected: FAIL — no `warnings` in the response.

- [ ] **Step 3: Call `analyzeCube` in the create route**

In `packages/web/app/api/drafts/route.ts`, after resolving `cubeCardIds` and before/with persisting, compute an advisory using the current participant count (or the configured expected count if no players yet — default to 2, the start minimum). Import `analyzeCube` from `@yugidraft/shared/services`:

```ts
import { analyzeCube } from "@yugidraft/shared/services";
// ...
const players = Math.max(2, currentParticipantCount); // best-effort at create time
const analysis = analyzeCube(cubeCardIds, players, config.packsPerPlayer ?? 5, config.packSize ?? 8);
if (!analysis.ok) {
  return NextResponse.json({ error: analysis.errors.join(" ") }, { status: 400 });
}
// include analysis.warnings in the success payload
return NextResponse.json({ /* existing fields */, warnings: analysis.warnings });
```

Apply the same advisory (errors block, warnings surface) in `packages/web/app/api/drafts/[slug]/route.ts` on edit.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): surface analyzeCube errors/warnings at draft create/edit"
```

---

### Task 7: End-to-end regression — a started draft has zero within-wave duplicates

**Files:**
- Test: `packages/shared/tests/services/drafts.test.ts`

- [ ] **Step 1: Write the integration test**

Add to `packages/shared/tests/services/drafts.test.ts` (reuse the file's existing db + service setup and player-join helpers):

```ts
it("a started draft deals no card twice within a wave (reads draft_deal)", () => {
  // create a draft with 4 players, packSize 4, packsPerPlayer 3, a 60-distinct cube
  const draftId = createDraftWithPlayers({ players: 4, packSize: 4, packsPerPlayer: 3,
    cubeCardIds: range(1, 60) });
  service.startDraft(draftId);

  const rows = db
    .prepare("select position, catalog_card_id from draft_deal where draft_id = ? order by position")
    .all(draftId) as Array<{ position: number; catalog_card_id: number }>;
  expect(rows).toHaveLength(48); // S = 4*3*4

  const players = 4, packSize = 4;
  const cardsPerWave = players * packSize; // 16
  for (let w = 0; w * cardsPerWave < rows.length; w += 1) {
    const wave = rows.slice(w * cardsPerWave, (w + 1) * cardsPerWave).map((r) => r.catalog_card_id);
    expect(new Set(wave).size).toBe(wave.length); // all distinct in the wave
  }
});
```

(If `createDraftWithPlayers`/`range` helpers don't already exist in the file, inline the existing create+join calls used by the other tests in this file — do not invent a new abstraction.)

- [ ] **Step 2: Run to verify it passes (algorithm already implemented)**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts -t "no card twice within a wave"`
Expected: PASS (this is a guard against regressions in wiring, not new behavior).

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS across packages.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/tests/services/drafts.test.ts
git commit -m "test(shared): integration guard for zero within-wave duplicates"
```

---

## Self-Review

**Spec coverage:**
- Terminology renames (Pool/Cube/Deal, `draft_deal`, `wave_number`, `cubeCardIds` read-both) → Tasks 1-3. ✓
- Invariant (one copy per wave) → Task 5 (`buildDeal`) + Task 7 (integration). ✓
- Validation change (distinct ≥ players×packSize; warn on copies>waves) → Task 4. ✓
- Creation-time advisory → Task 6. ✓
- Weight-proportional trim + padding → Task 5 (trim/pad blocks + tests). ✓
- Determinism (seeded by draftId) → Task 5 determinism test. ✓
- Migrations backwards-compatible → Tasks 1-2 (idempotent, guarded, with migration tests). ✓
- Legacy random path for pre-cube drafts untouched → not modified (openWave's `hasCube`/`draft_deal` guard unchanged beyond table name). ✓

**Placeholder scan:** Task 6 and Task 7 reference existing test helpers (`postCreateDraft`, `createDraftWithPlayers`, `range`) with an explicit instruction to inline the existing pattern if absent — no invented abstractions. All code steps contain full code.

**Type consistency:** `analyzeCube(cubeCardIds, players, waves, packSize) → CubeAnalysis {ok, errors[], warnings[]}` used identically in cube.ts, drafts.ts, and web routes. `buildDeal(cubeCardIds, {players, waves, packSize, draftId})` used identically in cube.ts and drafts.ts. `resolveCubeCardIds` named consistently across service + web routes.

**Out of scope (deferred):** the post-implementation draft-engine guide (separate task), and the eight unrelated issues tracked separately.
