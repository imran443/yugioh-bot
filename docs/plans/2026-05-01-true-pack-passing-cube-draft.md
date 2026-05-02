# True Pack-Passing Cube Draft Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the shared-pool draft with a Discord-native true pack-passing cube draft using `5 x 8 = 40`, public timers, random auto-pick, image-and-text pickers, and private image-and-text pool browsing.

**Architecture:** Keep the existing draft service boundary, but change the draft engine from wave-based shared choices to pack-based state. Reuse `draft_cards` as card instances, add `draft_packs` for holder/rotation state, and move picking from select menus to numbered button interactions. Add a small timer service that edits the public draft status message and expires pick steps from persisted deadlines.

**Tech Stack:** TypeScript, Discord.js v14, better-sqlite3, Vitest, Node timers, `sharp`, YGOPRODeck cached card images.

---

## Design References

- Read first: `docs/plans/2026-05-01-true-pack-passing-cube-draft-design.md`
- Existing draft engine: `src/services/drafts.ts`
- Existing draft schema: `src/db/schema.ts`
- Existing button handlers: `src/interactions/buttons.ts`
- Existing select menu handlers: `src/interactions/select-menus.ts`
- Existing command handlers: `src/commands/handlers.ts`
- Existing image service: `src/services/draft-images.ts`
- Existing startup wiring: `src/index.ts`

## Ground Rules

- Use TDD. Write or update tests first, confirm failure, then implement the smallest passing change.
- Do not use DMs for draft pick prompts.
- Keep all public coordination in the draft channel.
- Keep all pick and pool card details ephemeral.
- Acknowledge Discord interactions within 3 seconds. Defer ephemeral replies before image generation.
- Default draft format is `packSize: 8`, `packsPerPlayer: 5`, `pickSeconds: 45`.
- Auto-pick chooses randomly from the pending player's current pack.
- Do not preserve active legacy wave-based drafts. Completed exports should keep working where practical.

---

## Task 1: Add Pack-Passing Schema

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `tests/db/schema.test.ts`

**Step 1: Write the failing schema test**

Update `tests/db/schema.test.ts` so the table list includes `draft_packs`.

Add a test that verifies the pack-passing columns exist:

```ts
it("creates true pack-passing draft columns", () => {
  const db = new Database(":memory:");
  migrate(db);

  const draftColumns = db.pragma("table_info(drafts)") as Array<{ name: string }>;
  const playerColumns = db.pragma("table_info(draft_players)") as Array<{ name: string }>;
  const cardColumns = db.pragma("table_info(draft_cards)") as Array<{ name: string }>;
  const pickColumns = db.pragma("table_info(draft_picks)") as Array<{ name: string }>;

  expect(draftColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
    "pick_deadline_at",
    "status_message_id",
  ]));
  expect(playerColumns.map((column) => column.name)).toContain("seat_index");
  expect(cardColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
    "draft_pack_id",
    "position",
  ]));
  expect(pickColumns.map((column) => column.name)).toContain("pick_method");
});
```

Add a test that verifies `draft_packs` columns:

```ts
it("creates draft packs for pack-passing state", () => {
  const db = new Database(":memory:");
  migrate(db);

  const columns = db.pragma("table_info(draft_packs)") as Array<{ name: string }>;

  expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
    "id",
    "draft_id",
    "pack_round",
    "origin_seat_index",
    "current_holder_seat_index",
    "pass_direction",
    "created_at",
  ]));
});
```

**Step 2: Run the schema test to verify failure**

Run: `npm test -- tests/db/schema.test.ts`

Expected: FAIL because `draft_packs` and new columns do not exist.

**Step 3: Add schema changes**

In `src/db/schema.ts`, add `draft_packs` to the main `db.exec` block:

```sql
create table if not exists draft_packs (
  id integer primary key autoincrement,
  draft_id integer not null references drafts(id),
  pack_round integer not null,
  origin_seat_index integer not null,
  current_holder_seat_index integer not null,
  pass_direction integer not null,
  created_at text not null default current_timestamp,
  unique (draft_id, pack_round, origin_seat_index)
);
```

Add columns for fresh databases directly to the relevant `create table` statements:

```sql
-- drafts
pick_deadline_at text,
status_message_id text,

-- draft_players
seat_index integer,

-- draft_cards
draft_pack_id integer references draft_packs(id),
position integer,

-- draft_picks
pick_method text not null default 'manual',
```

Add migration helpers after the initial `db.exec` so existing SQLite databases receive the columns:

```ts
function hasColumn(db: Database.Database, table: string, column: string) {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((info) => info.name === column);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string) {
  if (!hasColumn(db, table, column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}
```

Then call:

```ts
addColumnIfMissing(db, "drafts", "pick_deadline_at", "text");
addColumnIfMissing(db, "drafts", "status_message_id", "text");
addColumnIfMissing(db, "draft_players", "seat_index", "integer");
addColumnIfMissing(db, "draft_cards", "draft_pack_id", "integer references draft_packs(id)");
addColumnIfMissing(db, "draft_cards", "position", "integer");
addColumnIfMissing(db, "draft_picks", "pick_method", "text not null default 'manual'");
```

Add indexes:

```sql
create index if not exists draft_packs_holder_idx
on draft_packs (draft_id, pack_round, current_holder_seat_index);

create index if not exists draft_cards_pack_idx
on draft_cards (draft_pack_id, picked_by_player_id, position);
```

**Step 4: Run the schema test to verify pass**

Run: `npm test -- tests/db/schema.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat: add pack passing draft schema"
```

---

## Task 2: Extend Draft Types And Defaults

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Write the failing default config test**

In `tests/services/drafts.test.ts`, update the create-draft test so `draft.config` includes defaults after creation:

```ts
expect(draft.config).toEqual({
  setNames: ["Battle Pack 3"],
  includeNames: ["Dark Magician"],
  excludeNames: ["Pot of Greed"],
  packSize: 8,
  packsPerPlayer: 5,
  pickSeconds: 45,
  alternatePassDirection: true,
  randomizeSeats: false,
});
```

Update the expected draft shape to include:

```ts
currentPackRound: 0,
currentPickStep: 0,
pickDeadlineAt: null,
statusMessageId: null,
```

**Step 2: Run the draft service test to verify failure**

Run: `npm test -- tests/services/drafts.test.ts -t "creates a pending draft"`

Expected: FAIL because these defaults and fields do not exist.

**Step 3: Implement config defaults and mapped fields**

In `src/services/drafts.ts`, extend `DraftConfig`:

```ts
export type DraftConfig = {
  setNames?: string[];
  includeNames?: string[];
  excludeNames?: string[];
  packSize?: number;
  packsPerPlayer?: number;
  pickSeconds?: number;
  alternatePassDirection?: boolean;
  randomizeSeats?: boolean;
};
```

Add a normalized config type and defaults:

```ts
const defaultDraftConfig = {
  packSize: 8,
  packsPerPlayer: 5,
  pickSeconds: 45,
  alternatePassDirection: true,
  randomizeSeats: false,
};

function normalizeDraftConfig(config: DraftConfig): DraftConfig {
  return {
    ...config,
    packSize: config.packSize ?? defaultDraftConfig.packSize,
    packsPerPlayer: config.packsPerPlayer ?? defaultDraftConfig.packsPerPlayer,
    pickSeconds: config.pickSeconds ?? defaultDraftConfig.pickSeconds,
    alternatePassDirection: config.alternatePassDirection ?? defaultDraftConfig.alternatePassDirection,
    randomizeSeats: config.randomizeSeats ?? defaultDraftConfig.randomizeSeats,
  };
}
```

Change `createDraft` to store `JSON.stringify(normalizeDraftConfig(config))`.

Change `mapDraft` to expose `currentPackRound` from `current_wave_number`:

```ts
currentPackRound: row.current_wave_number,
currentPickStep: row.current_pick_step,
pickDeadlineAt: row.pick_deadline_at,
statusMessageId: row.status_message_id,
```

Remove or migrate public uses of `currentWaveNumber` in service tests as tasks progress.

**Step 4: Run the focused test to verify pass**

Run: `npm test -- tests/services/drafts.test.ts -t "creates a pending draft"`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: add draft pack defaults"
```

---

## Task 3: Start Drafts With Seats And Packs

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Replace the wave start test with a pack start test**

Replace the existing `starts a pending draft, opens the first 8-card wave...` test with:

```ts
it("starts a draft by seating players and opening one 8-card pack per player", () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);
  app.drafts.join(draft.id, kaiba.id);
  seedCatalogCards(app.db, 16);

  const started = app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));

  expect(started).toEqual(expect.objectContaining({
    status: "active",
    currentPackRound: 1,
    currentPickStep: 1,
    pickDeadlineAt: "2026-05-01T00:00:45.000Z",
  }));
  expect(app.drafts.players(draft.id)).toEqual([
    { playerId: yugi.id, displayName: "Yugi", seatIndex: 0 },
    { playerId: kaiba.id, displayName: "Kaiba", seatIndex: 1 },
  ]);
  expect(app.drafts.currentPackOptions(draft.id, yugi.id)).toHaveLength(8);
  expect(app.drafts.currentPackOptions(draft.id, kaiba.id)).toHaveLength(8);
});
```

**Step 2: Run the focused test to verify failure**

Run: `npm test -- tests/services/drafts.test.ts -t "opening one 8-card pack"`

Expected: FAIL because `start` does not accept a date and `currentPackOptions` does not exist.

**Step 3: Implement seating and first packs**

In `src/services/drafts.ts`:

- Add `seatIndex` to `DraftPlayer`.
- Add `currentPackOptions(draftId, playerId): DraftCard[]`.
- Change `start(draftId, now = new Date())` to accept a clock date.
- Assign `seat_index` ordered by `joined_at asc, rowid asc`.
- Insert one `draft_packs` row per player for pack round 1.
- Insert `packSize` `draft_cards` rows for each pack with `draft_pack_id`, `wave_number = 1`, and stable `position`.
- Update `drafts.current_wave_number = 1`, `current_pick_step = 1`, and `pick_deadline_at`.

Use a helper:

```ts
function deadlineIso(now: Date, seconds: number) {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
```

Keep the current random card source behavior for now. Drawing with replacement is acceptable until a later cube-list import feature.

**Step 4: Run the focused test to verify pass**

Run: `npm test -- tests/services/drafts.test.ts -t "opening one 8-card pack"`

Expected: PASS.

**Step 5: Run all draft service tests**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: Some old wave tests may fail. Update old tests to new pack terminology only after the new behavior is covered.

**Step 6: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: start drafts with packs"
```

---

## Task 4: Manual Picks And Pack Rotation

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Write a failing pack rotation test**

Add:

```ts
it("passes packs after every active player picks", () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const joey = app.players.upsert("guild-1", "user-3", "Joey");
  const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);
  app.drafts.join(draft.id, kaiba.id);
  app.drafts.join(draft.id, joey.id);
  seedCatalogCards(app.db, 120);
  app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));

  const yugiFirstPack = app.drafts.currentPackOptions(draft.id, yugi.id).map((card) => card.id);
  const kaibaFirstPack = app.drafts.currentPackOptions(draft.id, kaiba.id).map((card) => card.id);
  const joeyFirstPack = app.drafts.currentPackOptions(draft.id, joey.id).map((card) => card.id);

  app.drafts.pickCard(draft.id, yugi.id, yugiFirstPack[0], "manual", new Date("2026-05-01T00:00:05.000Z"));
  expect(app.drafts.findById(draft.id).currentPickStep).toBe(1);

  app.drafts.pickCard(draft.id, kaiba.id, kaibaFirstPack[0], "manual", new Date("2026-05-01T00:00:06.000Z"));
  app.drafts.pickCard(draft.id, joey.id, joeyFirstPack[0], "manual", new Date("2026-05-01T00:00:07.000Z"));

  const advanced = app.drafts.findById(draft.id);
  expect(advanced.currentPickStep).toBe(2);
  expect(advanced.pickDeadlineAt).toBe("2026-05-01T00:00:52.000Z");
  expect(app.drafts.currentPackOptions(draft.id, yugi.id).map((card) => card.id)).not.toEqual(yugiFirstPack.slice(1));
});
```

**Step 2: Run the focused test to verify failure**

Run: `npm test -- tests/services/drafts.test.ts -t "passes packs"`

Expected: FAIL because packs do not rotate.

**Step 3: Implement manual pick validation and rotation**

Change `pickCard` signature:

```ts
pickCard(
  draftId: number,
  playerId: number,
  draftCardId: number,
  pickMethod: "manual" | "auto" = "manual",
  now = new Date(),
): DraftPick
```

Validation must check:

- Draft is active.
- Player is joined.
- Player has not picked in `currentPackRound/currentPickStep`.
- Selected card belongs to the pack currently held by the player's seat.
- Selected card is unpicked.

After every active player has picked:

- If current packs still contain unpicked cards, rotate `draft_packs.current_holder_seat_index` by `pass_direction` and increment `current_pick_step`.
- If current packs are empty and more pack rounds remain, open the next pack round and set `current_pick_step = 1`.
- If no pack rounds remain, complete the draft.
- Always set a new `pick_deadline_at` when advancing to a new step.

**Step 4: Run the focused test to verify pass**

Run: `npm test -- tests/services/drafts.test.ts -t "passes packs"`

Expected: PASS.

**Step 5: Add alternating pass direction test**

Add a test that sets `packsPerPlayer: 2`, finishes the first 8 picks, opens pack round 2, and verifies the new packs have `pass_direction = -1` when `alternatePassDirection` is true.

Run: `npm test -- tests/services/drafts.test.ts -t "alternates pass direction"`

Expected: PASS after implementation.

**Step 6: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: rotate draft packs after picks"
```

---

## Task 5: Random Auto-Pick On Timeout

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Write a failing timeout test**

Add:

```ts
it("randomly auto-picks for pending players when the deadline expires", () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);
  app.drafts.join(draft.id, kaiba.id);
  seedCatalogCards(app.db, 80);
  app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));

  const yugiOptions = app.drafts.currentPackOptions(draft.id, yugi.id);
  app.drafts.pickCard(draft.id, yugi.id, yugiOptions[0].id, "manual", new Date("2026-05-01T00:00:10.000Z"));

  const result = app.drafts.expireCurrentPickStep(draft.id, new Date("2026-05-01T00:00:45.000Z"));

  expect(result.autoPickedPlayerIds).toEqual([kaiba.id]);
  expect(app.drafts.findById(draft.id).currentPickStep).toBe(2);
  const autoPickRow = app.db.prepare("select pick_method from draft_picks where player_id = ?").get(kaiba.id) as { pick_method: string };
  expect(autoPickRow.pick_method).toBe("auto");
});
```

**Step 2: Run the focused test to verify failure**

Run: `npm test -- tests/services/drafts.test.ts -t "auto-picks"`

Expected: FAIL because `expireCurrentPickStep` does not exist.

**Step 3: Implement timeout auto-pick**

Add:

```ts
expireCurrentPickStep(draftId: number, now = new Date()): { autoPickedPlayerIds: number[] }
```

Behavior:

- If draft is not active, return no auto-picks.
- If `pick_deadline_at` is null or greater than `now`, return no auto-picks.
- For every active player without a pick this step, choose a random card from `currentPackOptions`.
- Call the same internal `pickCard` transaction with `pickMethod = "auto"`.
- Avoid double-picking if a manual pick already landed.

**Step 4: Run timeout tests**

Run: `npm test -- tests/services/drafts.test.ts -t "auto-picks"`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: auto pick expired draft packs"
```

---

## Task 6: Pool View Data And YDK Export

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Write a failing pool test**

Add:

```ts
it("returns a player's drafted pool with catalog ids in pick order", () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);
  app.drafts.join(draft.id, kaiba.id);
  seedCatalogCards(app.db, 80);
  app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));

  const firstPick = app.drafts.currentPackOptions(draft.id, yugi.id)[0];
  app.drafts.pickCard(draft.id, yugi.id, firstPick.id, "manual", new Date("2026-05-01T00:00:05.000Z"));

  expect(app.drafts.pool(draft.id, yugi.id)).toEqual([
    expect.objectContaining({ draftCardId: firstPick.id, catalogCardId: firstPick.catalogCardId }),
  ]);
});
```

**Step 2: Run the focused test to verify failure**

Run: `npm test -- tests/services/drafts.test.ts -t "drafted pool"`

Expected: FAIL because `pool` does not exist.

**Step 3: Implement pool query**

Add `pool(draftId, playerId)` to `DraftService`.

Return rows ordered by `draft_picks.id asc` with:

```ts
type DraftPoolCard = {
  draftCardId: number;
  catalogCardId: number;
  pickMethod: "manual" | "auto";
  packRound: number;
  pickStep: number;
};
```

Update `exportYdk` to use this pool query instead of direct legacy assumptions.

**Step 4: Run pool and export tests**

Run: `npm test -- tests/services/drafts.test.ts -t "pool|Export|export"`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: expose drafted player pools"
```

---

## Task 7: Generate Readable Individual Card Images

**Files:**
- Modify: `src/services/draft-images.ts`
- Modify: `tests/services/draft-images.test.ts`

**Step 1: Write failing image attachment tests**

Add tests for a new method:

```ts
const images = await service.renderCardImages([
  { ygoprodeckId: 1, imageUrl: "https://img/full/1", imageUrlSmall: "https://img/small/1", label: "1" },
]);

expect(images).toEqual([
  { filename: "draft-card-1.png", buffer: expect.any(Buffer) },
]);
```

Also add a test that cache filenames do not collide with the old thumbnail grid cache:

```ts
expect(fetchCalls).toEqual(["https://img/full/1"]);
```

**Step 2: Run image service tests to verify failure**

Run: `npm test -- tests/services/draft-images.test.ts`

Expected: FAIL because `renderCardImages` does not exist.

**Step 3: Implement `renderCardImages`**

In `src/services/draft-images.ts`:

- Keep `renderNumberedGrid` temporarily for old tests until interactions are migrated.
- Add `renderCardImages(cards)`.
- Use readable dimensions, for example `CARD_FULL_WIDTH = 240` and proportional height `350`.
- Fetch `imageUrl` first for full-size picker images.
- Cache as `${ygoprodeckId}-full.png`.
- Add a small number overlay using the same label shown in Discord.

Return:

```ts
Array<{ filename: string; buffer: Buffer }>
```

**Step 4: Run image service tests**

Run: `npm test -- tests/services/draft-images.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/draft-images.ts tests/services/draft-images.test.ts
git commit -m "feat: render individual draft card images"
```

---

## Task 8: Move Draft Picking To Numbered Buttons

**Files:**
- Modify: `src/interactions/buttons.ts`
- Modify: `src/interactions/select-menus.ts`
- Modify: `tests/interactions/buttons.test.ts`
- Modify: `tests/interactions/select-menus.test.ts`

**Step 1: Write failing pick UI test**

In `tests/interactions/buttons.test.ts`, replace the grid image pick test with a separate image and buttons test:

```ts
it("opens an ephemeral image-and-text picker with numbered pick buttons", async () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
  const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
  app.drafts.join(draft.id, kaiba.id);
  seedDraftCatalog(app, 80);
  app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));

  const { interaction, replies } = fakeButton({ customId: `draft_pick:${draft.id}` });

  await handleButton(interaction, {
    ...app,
    draftImages: {
      async renderCardImages(cards) {
        return cards.map((card, index) => ({ filename: `draft-card-${index + 1}.png`, buffer: Buffer.from(String(card.ygoprodeckId)) }));
      },
    },
  });

  expect(replies[0].ephemeral).toBe(true);
  expect(replies[0].content).toContain("Pick a card from your current pack");
  expect(replies[0].files).toHaveLength(8);
  expect(JSON.stringify(replies[0].components)).toContain("Pick 1");
  expect(JSON.stringify(replies[0].components)).toContain("View My Pool");
});
```

**Step 2: Run the focused test to verify failure**

Run: `npm test -- tests/interactions/buttons.test.ts -t "image-and-text picker"`

Expected: FAIL because the handler still renders the grid and select menu.

**Step 3: Implement picker button UI**

In `src/interactions/buttons.ts`:

- Keep `draft_pick:${draftId}` to open the picker.
- Use `deps.drafts.currentPackOptions(draftId, player.id)`.
- Load catalog cards.
- Call `deps.draftImages.renderCardImages`.
- Build content with numbered card names.
- Add numbered buttons with custom IDs `draft_pick_card:${draftId}:${draftCardId}`.
- Add `View My Pool` button with custom ID `draft_pool:${draftId}:0`.

Remove new DM-specific assumptions. The picker button must work from the guild channel public message.

**Step 4: Add failing numbered pick button test**

Add:

```ts
it("records a draft pick from a numbered pick button", async () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
  const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
  app.drafts.join(draft.id, kaiba.id);
  seedDraftCatalog(app, 80);
  app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));
  const option = app.drafts.currentPackOptions(draft.id, yugi.id)[0];
  const { interaction, replies } = fakeButton({ customId: `draft_pick_card:${draft.id}:${option.id}` });

  await handleButton(interaction, app);

  expect(replies[0].content).toContain("You picked");
  expect(replies[0].ephemeral).toBe(true);
  expect(app.drafts.pool(draft.id, yugi.id)).toHaveLength(1);
});
```

**Step 5: Implement numbered pick button handling**

Add a `draft_pick_card:(\d+):(\d+)` branch in `handleButton` before the generic export branch.

After picking:

- Reply ephemerally with picked card name and pool summary.
- Do not DM anyone.
- Let the public status updater refresh the shared message in later tasks.

**Step 6: Retire select-menu draft picking tests**

In `tests/interactions/select-menus.test.ts`, remove or rewrite draft pick select-menu tests because draft picking is now button-based.

Keep non-draft select menu tests.

**Step 7: Run interaction tests**

Run: `npm test -- tests/interactions/buttons.test.ts tests/interactions/select-menus.test.ts`

Expected: PASS.

**Step 8: Commit**

```bash
git add src/interactions/buttons.ts src/interactions/select-menus.ts tests/interactions/buttons.test.ts tests/interactions/select-menus.test.ts
git commit -m "feat: pick draft cards with numbered buttons"
```

---

## Task 9: Add Private Image-And-Text Pool View

**Files:**
- Modify: `src/interactions/buttons.ts`
- Modify: `tests/interactions/buttons.test.ts`

**Step 1: Write failing pool button test**

Add:

```ts
it("shows a private paged image-and-text pool view", async () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
  const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
  app.drafts.join(draft.id, kaiba.id);
  seedDraftCatalog(app, 80);
  app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));
  const option = app.drafts.currentPackOptions(draft.id, yugi.id)[0];
  app.drafts.pickCard(draft.id, yugi.id, option.id, "manual", new Date("2026-05-01T00:00:05.000Z"));
  const { interaction, replies } = fakeButton({ customId: `draft_pool:${draft.id}:0` });

  await handleButton(interaction, {
    ...app,
    draftImages: {
      async renderCardImages(cards) {
        return cards.map((card, index) => ({ filename: `pool-card-${index + 1}.png`, buffer: Buffer.from(String(card.ygoprodeckId)) }));
      },
    },
  });

  expect(replies[0].ephemeral).toBe(true);
  expect(replies[0].content).toContain("Your pool: 1 card");
  expect(replies[0].files).toHaveLength(1);
});
```

**Step 2: Run focused pool view test to verify failure**

Run: `npm test -- tests/interactions/buttons.test.ts -t "pool view"`

Expected: FAIL because `draft_pool` is not handled.

**Step 3: Implement `draft_pool` button handling**

In `src/interactions/buttons.ts`:

- Parse `draft_pool:${draftId}:${page}`.
- Validate player is in the draft.
- Query `deps.drafts.pool`.
- Page cards, for example 8 per page.
- Load catalog cards.
- Call `renderCardImages` for page cards.
- Reply ephemerally with text labels, counts, images, and `Previous`/`Next` buttons when needed.

**Step 4: Run button tests**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/interactions/buttons.ts tests/interactions/buttons.test.ts
git commit -m "feat: show private draft pool images"
```

---

## Task 10: Public Draft Status Message And No DM Prompts

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `src/index.ts`
- Modify: `tests/commands/handlers.test.ts`

**Step 1: Write failing start command test**

In `tests/commands/handlers.test.ts`, add or update the draft start test so it expects one public status reply with buttons, not one prompt per player.

Expected content should include:

```text
Cube Draft: cube night
Pack 1 / 5
Pick 1 / 8
Picked: 0 / 2
```

Expected components should contain:

```text
Pick Card
View My Pool
```

**Step 2: Run focused command test to verify failure**

Run: `npm test -- tests/commands/handlers.test.ts -t "draft start"`

Expected: FAIL because start still sends per-player notifier prompts.

**Step 3: Implement draft status reply formatter**

Create a helper in `src/commands/handlers.ts` or a new formatter file `src/formatters/drafts.ts`:

```ts
export function draftStatusMessage(input: DraftStatusView) {
  return {
    content: [
      `Cube Draft: ${input.name}`,
      `Pack ${input.currentPackRound} / ${input.packsPerPlayer}`,
      `Pick ${input.currentPickStep} / ${input.packSize}`,
      `Time left: ${input.timeLeft} (ends <t:${input.deadlineUnix}:R>)`,
      "",
      `Picked: ${input.pickedCount} / ${input.playerCount}`,
      `Waiting on: ${input.waitingMentions.length ? input.waitingMentions.join(", ") : "No one"}`,
      "",
      "Click Pick Card to choose from your current pack.",
    ].join("\n"),
    components: [draftStatusButtons(input.draftId)],
  };
}
```

The service should expose enough state for this view, such as `drafts.statusView(draftId, now)`.

**Step 4: Change draft start command**

In `handleDraft` start:

- Start the draft with `deps.drafts.start(draft.id)`.
- Reply with the public draft status message.
- Store the created status message ID if the interaction abstraction supports it later.
- Do not call `deps.notifier.sendPickPrompt` for each player.

**Step 5: Remove DirectMessages intent and DM notifier path**

In `src/index.ts`:

- Remove `GatewayIntentBits.DirectMessages`.
- Remove DM-first `user.send` pick prompts.
- Replace notifier usage with public status message updater in later timer tasks.

**Step 6: Run command tests**

Run: `npm test -- tests/commands/handlers.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/commands/handlers.ts src/index.ts tests/commands/handlers.test.ts
git commit -m "feat: show public draft status"
```

---

## Task 11: Draft Timer Service And Startup Recovery

**Files:**
- Create: `src/services/draft-timers.ts`
- Create: `tests/services/draft-timers.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing timer service test**

Create `tests/services/draft-timers.test.ts` with a fake scheduler and fake message updater.

Test behavior:

```ts
it("expires overdue active drafts and updates the public status message", async () => {
  const app = setupWithActiveDraftPastDeadline();
  const updates: number[] = [];
  const timers = createDraftTimerService({
    drafts: app.drafts,
    updateDraftStatusMessage: async (draftId) => updates.push(draftId),
    now: () => new Date("2026-05-01T00:01:00.000Z"),
  });

  await timers.tick();

  expect(app.drafts.findById(app.draft.id).currentPickStep).toBe(2);
  expect(updates).toEqual([app.draft.id]);
});
```

**Step 2: Run timer tests to verify failure**

Run: `npm test -- tests/services/draft-timers.test.ts`

Expected: FAIL because the timer service does not exist.

**Step 3: Implement timer service**

Implement:

```ts
export function createDraftTimerService(input: {
  drafts: DraftService;
  updateDraftStatusMessage: (draftId: number) => Promise<void>;
  now?: () => Date;
}) {
  return {
    async tick() {
      for (const draft of input.drafts.listByStatus("*", ["active"])) {
        const before = input.drafts.findById(draft.id);
        input.drafts.expireCurrentPickStep(draft.id, input.now?.() ?? new Date());
        const after = input.drafts.findById(draft.id);
        if (after.currentPickStep !== before.currentPickStep || after.currentPackRound !== before.currentPackRound || after.status !== before.status) {
          await input.updateDraftStatusMessage(draft.id);
        }
      }
    },
  };
}
```

If `listByStatus` currently requires a guild ID, add `listActive(): Draft[]` to `DraftService` instead of using `"*"`.

**Step 4: Wire timer service in `src/index.ts`**

- On `client.once("ready")`, call one recovery `tick()`.
- Start `setInterval` for regular ticks, such as every 1000ms or 5000ms.
- Use the timer service to update public status messages.
- Keep message edits rate-limited by only editing when formatted content changed or when countdown bucket changed.

**Step 5: Run timer tests**

Run: `npm test -- tests/services/draft-timers.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/services/draft-timers.ts tests/services/draft-timers.test.ts src/index.ts
git commit -m "feat: expire timed draft picks"
```

---

## Task 12: Full Verification And Cleanup

**Files:**
- Modify as needed: `src/services/drafts.ts`
- Modify as needed: `src/interactions/buttons.ts`
- Modify as needed: `src/commands/handlers.ts`
- Modify as needed: tests touched above

**Step 1: Search for legacy wave and DM behavior**

Run: `rg "currentWave|wave|sendPickPrompt|DirectMessages|draft_pick_card:" src tests`

Expected: Only intentional compatibility references remain. No DM draft prompt path should remain.

**Step 2: Run focused draft tests**

Run: `npm test -- tests/services/drafts.test.ts tests/services/draft-images.test.ts tests/services/draft-timers.test.ts tests/interactions/buttons.test.ts tests/interactions/select-menus.test.ts tests/commands/handlers.test.ts`

Expected: PASS.

**Step 3: Run full test suite**

Run: `npm test`

Expected: PASS.

**Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

**Step 5: Run build**

Run: `npm run build`

Expected: PASS.

**Step 6: Update docs if implementation differs**

Read: `docs/plans/2026-05-01-true-pack-passing-cube-draft-design.md`

If implementation made a necessary tradeoff, update the design doc before final commit.

**Step 7: Final commit**

```bash
git add src tests docs/plans/2026-05-01-true-pack-passing-cube-draft-design.md docs/plans/2026-05-01-true-pack-passing-cube-draft.md
git commit -m "feat: implement true pack passing drafts"
```

---

## Task 13: Verify Cancellation And Retention Behavior

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `src/interactions/buttons.ts`
- Modify: `tests/services/drafts.test.ts`
- Modify: `tests/interactions/buttons.test.ts`

**Step 1: Write a failing cancel retention test**

In `tests/services/drafts.test.ts`, add:

```ts
it("soft-cancels active drafts without deleting pack or pick history", () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);
  app.drafts.join(draft.id, kaiba.id);
  seedCatalogCards(app.db, 80);
  app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));
  const option = app.drafts.currentPackOptions(draft.id, yugi.id)[0];
  app.drafts.pickCard(draft.id, yugi.id, option.id, "manual", new Date("2026-05-01T00:00:05.000Z"));

  const cancelled = app.drafts.cancel(draft.id);

  expect(cancelled.status).toBe("cancelled");
  expect(app.db.prepare("select count(*) as count from draft_packs where draft_id = ?").get(draft.id)).toEqual({ count: 2 });
  expect(app.db.prepare("select count(*) as count from draft_cards where draft_id = ?").get(draft.id)).toEqual({ count: 16 });
  expect(app.db.prepare("select count(*) as count from draft_picks where draft_id = ?").get(draft.id)).toEqual({ count: 1 });
});
```

**Step 2: Run focused cancel test**

Run: `npm test -- tests/services/drafts.test.ts -t "soft-cancels"`

Expected: PASS if `cancel` still soft-cancels. Fix only if needed.

**Step 3: Ensure timers ignore cancelled drafts**

Add or update timer tests so cancelled drafts are not expired or edited.

Run: `npm test -- tests/services/draft-timers.test.ts -t "cancelled"`

Expected: PASS.

**Step 4: Disable cancelled draft buttons**

Update public cancelled status rendering so the message clearly says cancelled and disables or removes `Pick Card` / `View My Pool` controls.

Run: `npm test -- tests/interactions/buttons.test.ts tests/commands/handlers.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts src/interactions/buttons.ts tests/services/drafts.test.ts tests/interactions/buttons.test.ts tests/services/draft-timers.test.ts tests/commands/handlers.test.ts
git commit -m "test: lock draft cancellation retention"
```

---

## Manual Discord Test Checklist

After deploy, test in a Discord server:

- `/draft create name:cube night` creates public signup.
- Multiple players join.
- `/draft start name:cube night` posts one public status message.
- Public message shows `Pack 1 / 5`, `Pick 1 / 8`, timer, picked count, and waiting list.
- Player clicks `Pick Card` and receives ephemeral image-and-text pack view.
- Player picks with `Pick 1` through `Pick 8` button.
- Player clicks `View My Pool` and sees private image-and-text pool view.
- After all players pick, public status advances to the next pick.
- If a player does not pick before timeout, bot randomly auto-picks and advances.
- No draft DMs are sent.
- After 5 packs of 8, each player can `/draft export` a 40-card `.ydk`.
