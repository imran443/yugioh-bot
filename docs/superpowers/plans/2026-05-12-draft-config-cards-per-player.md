# Draft config: cards-per-player + adjustable pack size — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "cards drafted per player" an explicit, adjustable draft setting (default 40, range 40–60) and let organizers pick the pack size directly (default 15), instead of deriving pack size from a hardcoded 40-card total.

**Architecture:** Add `cardsPerPlayer` to `DraftConfig` and replace the hardcoded `40` per-player pick cap in the draft engine with that config value. Rework the shared `DraftConfigFields` form component (used by the Create form and the pending-draft Manage view) to expose "Rounds — cards drafted per player", "Size of each pack", and "Pick duration (seconds)" inputs, dropping the alternate-pass/randomize checkboxes (web-created drafts always randomize seats). Pack size is derived into `packsPerPlayer = max(1, ceil(cardsPerPlayer / packSize))` so the supply always covers the target; leftover cards in the final pack are simply left unpicked.

**Tech Stack:** TypeScript, better-sqlite3 (`packages/shared`), Next.js + React + Vitest/Testing Library (`packages/web`). Test commands: `npx vitest run packages/shared/tests/services/drafts.test.ts` and `npx vitest run packages/web/tests/components/create-draft-form.test.tsx -c packages/web/vitest.config.ts`.

---

### Task 1: Add `cardsPerPlayer` to the draft config and engine

**Files:**
- Modify: `packages/shared/src/types/index.ts:1-12`
- Modify: `packages/shared/src/services/drafts.ts:83-101` (default config + normalize), `:446`, `:503-507`, `:679`
- Test: `packages/shared/tests/services/drafts.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing top-level `describe(...)` block in `packages/shared/tests/services/drafts.test.ts` (after the "exports a completed deck in YGOPro YDK format" test). It uses the existing `setup`, `insertPlayer`, `seedCatalogCards` helpers already imported in that file.

```ts
  it("respects a custom cardsPerPlayer cap above the default 40", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    // 5 packs of 10 => 50 cards available per player, target 50
    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "big draft",
      { packSize: 10, packsPerPlayer: 5, cardsPerPlayer: 50 },
      "user-1",
      yugi.id,
    );

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 60);
    app.drafts.start(draft.id);

    for (let i = 0; i < 60; i++) {
      const yugiOptions = app.drafts.currentPackOptions(draft.id, yugi.id);
      const kaibaOptions = app.drafts.currentPackOptions(draft.id, kaiba.id);
      if (yugiOptions.length > 0) app.drafts.pickCard(draft.id, yugi.id, yugiOptions[0].id);
      if (kaibaOptions.length > 0) app.drafts.pickCard(draft.id, kaiba.id, kaibaOptions[0].id);
    }

    const yugiRow = app.db
      .prepare("select pick_count, finished_at from draft_players where draft_id = ? and player_id = ?")
      .get(draft.id, yugi.id) as { pick_count: number; finished_at: string | null };
    expect(yugiRow.pick_count).toBe(50);
    expect(yugiRow.finished_at).not.toBeNull();

    const draftRow = app.db.prepare("select status from drafts where id = ?").get(draft.id) as { status: string };
    expect(draftRow.status).toBe("completed");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts -t "custom cardsPerPlayer"`
Expected: FAIL — `pick_count` is `40`, not `50` (engine still uses the hardcoded cap).

- [ ] **Step 3: Add `cardsPerPlayer` to the `DraftConfig` type**

In `packages/shared/src/types/index.ts`, add the field to the `DraftConfig` interface (right after `packsPerPlayer?: number;`):

```ts
export interface DraftConfig {
  setNames?: string[];
  customCardIds?: number[];
  includeNames?: string[];
  excludeNames?: string[];
  packSize?: number;
  packsPerPlayer?: number;
  cardsPerPlayer?: number;
  pickSeconds?: number;
  alternatePassDirection?: boolean;
  randomizeSeats?: boolean;
  poolCardIds?: number[];
}
```

- [ ] **Step 4: Add the default and normalize it**

In `packages/shared/src/services/drafts.ts`, update `defaultDraftConfig` and `normalizeDraftConfig` (currently around lines 83-101):

```ts
const defaultDraftConfig = {
  packSize: 8,
  packsPerPlayer: 5,
  cardsPerPlayer: 40,
  pickSeconds: 45,
  alternatePassDirection: true,
  randomizeSeats: false,
} satisfies Required<Pick<DraftConfig, "packSize" | "packsPerPlayer" | "cardsPerPlayer" | "pickSeconds" | "alternatePassDirection" | "randomizeSeats">>;

function normalizeDraftConfig(config: DraftConfig): DraftConfig {
  return {
    ...config,
    packSize: config.packSize ?? defaultDraftConfig.packSize,
    packsPerPlayer: config.packsPerPlayer ?? defaultDraftConfig.packsPerPlayer,
    cardsPerPlayer: config.cardsPerPlayer ?? defaultDraftConfig.cardsPerPlayer,
    pickSeconds: config.pickSeconds ?? defaultDraftConfig.pickSeconds,
    alternatePassDirection: config.alternatePassDirection ?? defaultDraftConfig.alternatePassDirection,
    randomizeSeats: config.randomizeSeats ?? defaultDraftConfig.randomizeSeats,
  };
}
```

- [ ] **Step 5: Replace the hardcoded `40` cap in `pickCard`**

In `packages/shared/src/services/drafts.ts`, inside `pickCard` (the `draft` object is already available from `findById(draftId)` near the top of the transaction):

Replace line ~446:

```ts
    if (playerRow.finished_at !== null || playerRow.pick_count >= 40) {
      throw new Error("Player has already finished drafting");
    }
```

with:

```ts
    const cardsPerPlayer = draft.config.cardsPerPlayer ?? defaultDraftConfig.cardsPerPlayer;
    if (playerRow.finished_at !== null || playerRow.pick_count >= cardsPerPlayer) {
      throw new Error("Player has already finished drafting");
    }
```

Replace the `update draft_players` statement (lines ~503-507):

```ts
    db.prepare(
      `
        update draft_players
        set pick_count = pick_count + 1,
            finished_at = case when pick_count + 1 >= 40 then ? else finished_at end
        where draft_id = ? and player_id = ?
      `,
    ).run(now.toISOString(), draftId, playerId);
```

with:

```ts
    db.prepare(
      `
        update draft_players
        set pick_count = pick_count + 1,
            finished_at = case when pick_count + 1 >= ? then ? else finished_at end
        where draft_id = ? and player_id = ?
      `,
    ).run(cardsPerPlayer, now.toISOString(), draftId, playerId);
```

- [ ] **Step 6: Replace the hardcoded `40` cap in `currentPackOptionsInternal`**

In `packages/shared/src/services/drafts.ts`, in `currentPackOptionsInternal` (line ~679) — `draft` is available from `findById(draftId)` a few lines above:

Replace:

```ts
    if (playerRow.finished_at !== null || playerRow.pick_count >= 40) {
      return [];
    }
```

with:

```ts
    if (playerRow.finished_at !== null || playerRow.pick_count >= (draft.config.cardsPerPlayer ?? defaultDraftConfig.cardsPerPlayer)) {
      return [];
    }
```

- [ ] **Step 7: Run the shared test suite**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts`
Expected: PASS — including the new test and all existing tests (the "exports a completed deck" test still stops at 40 because it omits `cardsPerPlayer`, which now defaults to 40).

- [ ] **Step 8: Typecheck the shared package**

Run: `npm run typecheck --workspace=packages/shared`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/types/index.ts packages/shared/src/services/drafts.ts packages/shared/tests/services/drafts.test.ts
git commit -m "feat(shared): make per-player draft card count configurable via cardsPerPlayer"
```

---

### Task 2: Rework `DraftConfigFields` (value type, helpers, component)

**Files:**
- Modify: `packages/web/src/components/draft/draft-config-fields.tsx` (entire file — `DraftConfigFieldsValue`, `configFromFields`, `fieldsFromConfig`, `validateFields`, `DraftConfigFields`)
- Modify: `packages/web/tests/components/create-draft-form.test.tsx` (label queries + new assertions; this is the test driver for this task)

- [ ] **Step 1: Update the test to drive the new shape**

In `packages/web/tests/components/create-draft-form.test.tsx`:

(a) In the test `"loads a saved pool's sets and custom IDs without touching the numeric options"`, replace the numeric-option assertions block:

```ts
    // Numeric options should remain at their defaults, NOT overwritten by the pool
    expect(screen.getByLabelText(/packs per player/i)).toHaveValue(5);
    expect(screen.getByLabelText(/pick timer/i)).toHaveValue(45);
    expect(screen.getByLabelText(/alternate pass direction/i)).toBeChecked();
    expect(screen.getByLabelText(/randomize seats/i)).not.toBeChecked();
```

with:

```ts
    // Numeric options should remain at their defaults, NOT overwritten by the pool
    expect(screen.getByLabelText(/cards drafted per player/i)).toHaveValue(40);
    expect(screen.getByLabelText(/size of each pack/i)).toHaveValue(15);
    expect(screen.getByLabelText(/pick duration/i)).toHaveValue(45);
    expect(screen.queryByLabelText(/alternate pass/i)).toBeNull();
    expect(screen.queryByLabelText(/randomize seats/i)).toBeNull();
```

(b) Add a new test at the end of the `describe("CreateDraftForm", ...)` block:

```ts
  it("submits cardsPerPlayer, packSize, derived packsPerPlayer, and randomized seats", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/discord/channels") return Response.json({ channels: [] });
      if (String(input) === "/api/draft-templates" && !init) return Response.json({ templates: [] });
      if (String(input) === "/api/drafts" && init?.method === "POST") {
        return Response.json({ webSlug: "cube" }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CreateDraftForm />);

    fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Cube" } });
    fireEvent.change(screen.getByLabelText(/custom card ids/i), { target: { value: "46986414" } });
    fireEvent.change(screen.getByLabelText(/cards drafted per player/i), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText(/size of each pack/i), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: /create draft/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/draft/cube"));

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/drafts" && init?.method === "POST",
    );
    const body = JSON.parse(String(postCall?.[1]?.body));
    expect(body.config).toMatchObject({
      cardsPerPlayer: 40,
      packSize: 15,
      packsPerPlayer: 3,
      randomizeSeats: true,
      alternatePassDirection: true,
    });
  });

  it("rejects a pack size larger than cards per player", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/discord/channels") return Response.json({ channels: [] });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CreateDraftForm />);

    fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Cube" } });
    fireEvent.change(screen.getByLabelText(/custom card ids/i), { target: { value: "46986414" } });
    fireEvent.change(screen.getByLabelText(/size of each pack/i), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: /create draft/i }));

    expect(await screen.findByText(/pack size cannot exceed/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/web/tests/components/create-draft-form.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — labels like `/cards drafted per player/i` don't exist yet; the new assertions fail.

- [ ] **Step 3: Rewrite `draft-config-fields.tsx`**

Replace the entire contents of `packages/web/src/components/draft/draft-config-fields.tsx` with:

```tsx
"use client";

import * as React from "react";
import type { DraftConfig } from "@yugidraft/shared/types";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { PoolBuilder } from "@/components/cards/pool-builder";
import type { CardSummary } from "@/lib/card-types";

export const CARDS_PER_PLAYER_MIN = 40;
export const CARDS_PER_PLAYER_MAX = 60;
export const PACK_SIZE_MIN = 5;
export const PICK_SECONDS_MIN = 5;
export const PICK_SECONDS_MAX = 300;

export type DraftConfigFieldsValue = {
  setNames: string[];
  customCardText: string;
  cardsPerPlayerText: string;
  packSizeText: string;
  pickSecondsText: string;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function parseCardsPerPlayer(text: string): number {
  return clamp(parseInt(text) || CARDS_PER_PLAYER_MIN, CARDS_PER_PLAYER_MIN, CARDS_PER_PLAYER_MAX);
}

function parsePackSize(text: string, cardsPerPlayer: number): number {
  return clamp(parseInt(text) || 15, PACK_SIZE_MIN, cardsPerPlayer);
}

function parsePickSeconds(text: string): number {
  return clamp(parseInt(text) || 45, PICK_SECONDS_MIN, PICK_SECONDS_MAX);
}

function derivePacksPerPlayer(cardsPerPlayer: number, packSize: number): number {
  return Math.max(1, Math.ceil(cardsPerPlayer / packSize));
}

export function configFromFields(fields: DraftConfigFieldsValue): DraftConfig {
  const cardsPerPlayer = parseCardsPerPlayer(fields.cardsPerPlayerText);
  const packSize = parsePackSize(fields.packSizeText, cardsPerPlayer);
  const pickSeconds = parsePickSeconds(fields.pickSecondsText);
  const { cardIds: customCardIds } = parseCustomCardIds(fields.customCardText);
  return {
    setNames: fields.setNames,
    customCardIds,
    includeNames: [],
    excludeNames: [],
    cardsPerPlayer,
    packSize,
    packsPerPlayer: derivePacksPerPlayer(cardsPerPlayer, packSize),
    pickSeconds,
    alternatePassDirection: true,
    randomizeSeats: true,
  };
}

export function fieldsFromConfig(config: DraftConfig, customCardIds?: number[]): DraftConfigFieldsValue {
  const ids = customCardIds ?? config.customCardIds ?? [];
  return {
    setNames: config.setNames ?? [],
    customCardText: ids.join("\n"),
    cardsPerPlayerText: String(config.cardsPerPlayer ?? CARDS_PER_PLAYER_MIN),
    packSizeText: String(config.packSize ?? 15),
    pickSecondsText: String(config.pickSeconds ?? 45),
  };
}

export function validateFields(fields: DraftConfigFieldsValue): string | null {
  const { cardIds, errors } = parseCustomCardIds(fields.customCardText);
  if (fields.setNames.length === 0 && cardIds.length === 0) {
    return "Select at least one set or paste custom card IDs";
  }
  if (errors.length > 0) {
    return `Remove invalid card IDs: ${errors.slice(0, 3).join(", ")}`;
  }
  const cards = parseInt(fields.cardsPerPlayerText);
  if (!cards || cards < CARDS_PER_PLAYER_MIN || cards > CARDS_PER_PLAYER_MAX) {
    return `Cards per player must be between ${CARDS_PER_PLAYER_MIN} and ${CARDS_PER_PLAYER_MAX}`;
  }
  const packSize = parseInt(fields.packSizeText);
  if (!packSize || packSize < PACK_SIZE_MIN) {
    return `Pack size must be at least ${PACK_SIZE_MIN}`;
  }
  if (packSize > cards) {
    return "Pack size cannot exceed the number of cards per player";
  }
  const secs = parseInt(fields.pickSecondsText);
  if (!secs || secs < PICK_SECONDS_MIN || secs > PICK_SECONDS_MAX) {
    return `Pick duration must be between ${PICK_SECONDS_MIN} and ${PICK_SECONDS_MAX} seconds`;
  }
  return null;
}

interface DraftConfigFieldsProps {
  value: DraftConfigFieldsValue;
  onChange: (value: DraftConfigFieldsValue) => void;
  poolBuilderShowPreview?: boolean;
  onPool?: (cards: CardSummary[], unknownIds: number[], loading: boolean) => void;
}

export function DraftConfigFields({ value, onChange, poolBuilderShowPreview, onPool }: DraftConfigFieldsProps) {
  const cardsPerPlayer = parseCardsPerPlayer(value.cardsPerPlayerText);
  const packSizeRaw = parseInt(value.packSizeText) || 15;
  const packSize = Math.max(PACK_SIZE_MIN, packSizeRaw);
  const packsPerPlayer = derivePacksPerPlayer(cardsPerPlayer, Math.min(packSize, cardsPerPlayer));

  return (
    <div className="space-y-4">
      <PoolBuilder
        value={{ setNames: value.setNames, customCardText: value.customCardText }}
        onChange={(pb) => onChange({ ...value, setNames: pb.setNames, customCardText: pb.customCardText })}
        showPreview={poolBuilderShowPreview}
        onPool={onPool}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="cards-per-player" className="mb-1 block text-sm font-medium text-text-primary">
            Rounds &mdash; cards drafted per player
          </label>
          <input
            id="cards-per-player"
            type="number"
            value={value.cardsPerPlayerText}
            onChange={(e) => onChange({ ...value, cardsPerPlayerText: e.target.value })}
            min={CARDS_PER_PLAYER_MIN}
            max={CARDS_PER_PLAYER_MAX}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="pack-size" className="mb-1 block text-sm font-medium text-text-primary">
            Size of each pack
          </label>
          <input
            id="pack-size"
            type="number"
            value={value.packSizeText}
            onChange={(e) => onChange({ ...value, packSizeText: e.target.value })}
            min={PACK_SIZE_MIN}
            max={cardsPerPlayer}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="pick-seconds" className="mb-1 block text-sm font-medium text-text-primary">
            Pick duration (seconds)
          </label>
          <input
            id="pick-seconds"
            type="number"
            value={value.pickSecondsText}
            onChange={(e) => onChange({ ...value, pickSecondsText: e.target.value })}
            min={PICK_SECONDS_MIN}
            max={PICK_SECONDS_MAX}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
      </div>
      <p className="text-xs text-text-secondary">
        Each player drafts {cardsPerPlayer} card{cardsPerPlayer !== 1 ? "s" : ""} across {packsPerPlayer} pack
        {packsPerPlayer !== 1 ? "s" : ""} of {Math.min(packSize, cardsPerPlayer)} &mdash; extra cards in the last pack are left out.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run the create-draft-form tests**

Run: `npx vitest run packages/web/tests/components/create-draft-form.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — `create-draft-form.tsx` still initializes `fields` with the old keys (`packsPerPlayerText`, `alternatePass`, `randomizeSeats`), so it won't typecheck/render. Fixed in Task 3. (If you are running tasks strictly in order, it's fine to see this fail here; move to Task 3.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/draft/draft-config-fields.tsx packages/web/tests/components/create-draft-form.test.tsx
git commit -m "feat(web): rework DraftConfigFields with cards-per-player and pack-size inputs"
```

---

### Task 3: Update `CreateDraftForm` initial state

**Files:**
- Modify: `packages/web/src/components/draft/create-draft-form.tsx:30-37` (the `fields` initial state)

- [ ] **Step 1: Replace the initial `fields` state**

In `packages/web/src/components/draft/create-draft-form.tsx`, change:

```tsx
  const [fields, setFields] = React.useState<DraftConfigFieldsValue>({
    setNames: [],
    customCardText: "",
    packsPerPlayerText: "5",
    pickSecondsText: "45",
    alternatePass: true,
    randomizeSeats: false,
  });
```

to:

```tsx
  const [fields, setFields] = React.useState<DraftConfigFieldsValue>({
    setNames: [],
    customCardText: "",
    cardsPerPlayerText: "40",
    packSizeText: "15",
    pickSecondsText: "45",
  });
```

(No other changes — `applyTemplate` only spreads `setNames`/`customCardText`, `handleSaveTemplate` and `handleSubmit` use `validateFields`/`configFromFields`/`parseCustomCardIds` which are unchanged in signature.)

- [ ] **Step 2: Run the create-draft-form tests**

Run: `npx vitest run packages/web/tests/components/create-draft-form.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS — all tests including the new `cardsPerPlayer`/`packSize` submit test and the pack-size-too-large validation test.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/draft/create-draft-form.tsx
git commit -m "feat(web): CreateDraftForm uses cards-per-player + pack-size defaults"
```

---

### Task 4: Update the Manage view read-only config summary

**Files:**
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx:442-452` (the "Packs/Player" summary tile)
- Test: `packages/web/tests/components/draft-manage-view.test.tsx`

- [ ] **Step 1: Add a failing assertion to the manage-view test**

In `packages/web/tests/components/draft-manage-view.test.tsx`, in `baseDraft.config`, add `cardsPerPlayer: 45,` next to `packSize`/`packsPerPlayer`. Then add this test inside the existing `describe(...)` block:

```ts
  it("shows the configured cards-per-player in the read-only summary", () => {
    render(<DraftManageView {...baseProps} />);
    expect(screen.getByText("Cards/Player")).toBeInTheDocument();
    expect(screen.getByText("45")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/web/tests/components/draft-manage-view.test.tsx -c packages/web/vitest.config.ts -t "cards-per-player in the read-only summary"`
Expected: FAIL — the tile currently reads "Packs/Player".

- [ ] **Step 3: Update the summary tile**

In `packages/web/src/components/draft/draft-manage-view.tsx`, change the first tile in the `sm:grid-cols-3` read-only grid from:

```tsx
                <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
                  <span className="block text-xs text-text-muted">
                    <Package className="mr-1 inline h-3.5 w-3.5" />
                    Packs/Player
                  </span>
                  <span className="mt-1 block text-lg font-semibold text-text-primary">
                    {draft.config.packsPerPlayer ?? "—"}
                  </span>
                </div>
```

to:

```tsx
                <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
                  <span className="block text-xs text-text-muted">
                    <Package className="mr-1 inline h-3.5 w-3.5" />
                    Cards/Player
                  </span>
                  <span className="mt-1 block text-lg font-semibold text-text-primary">
                    {draft.config.cardsPerPlayer ?? 40}
                  </span>
                </div>
```

(Leave the "Cards/Pack" and "Pick Timer" tiles unchanged.)

- [ ] **Step 4: Run the manage-view tests**

Run: `npx vitest run packages/web/tests/components/draft-manage-view.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/draft/draft-manage-view.tsx packages/web/tests/components/draft-manage-view.test.tsx
git commit -m "feat(web): show cards-per-player in draft manage summary"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all packages pass. If any other test referenced the old `DraftConfigFields` labels (`/packs per player/i`, `/pick timer/i`) or the removed checkboxes, update those queries to the new labels (`/cards drafted per player/i`, `/size of each pack/i`, `/pick duration/i`) and re-run. Search first: `grep -rn "packs per player\|Pick Timer\|alternate pass\|randomize seats" packages/web/tests` (case-insensitive: add `-i`).

- [ ] **Step 2: Typecheck everything**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit any follow-up test fixes**

```bash
git add -A
git commit -m "test(web): update draft config field expectations for cards-per-player"
```

(Skip this commit if Step 1 needed no changes.)

---

## Notes for the implementer

- The draft engine still ends a draft when `currentPackRound >= packsPerPlayer` (unchanged). Because the form derives `packsPerPlayer = ceil(cardsPerPlayer / packSize)`, the available supply (`packsPerPlayer × packSize` cards per player) always meets or exceeds `cardsPerPlayer`; any surplus in the final pack is left unpicked, which the existing "all players finished → completed" path handles cleanly.
- The Discord bot's start-draft flow is intentionally untouched. Its `defaultDraftConfig` now carries `cardsPerPlayer: 40`, so bot-created drafts behave exactly as before.
- `alternatePassDirection` and `randomizeSeats` no longer have any UI. Web-created drafts hardcode both to `true` in `configFromFields`; bot-created drafts keep the engine defaults.
