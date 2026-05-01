# Draft Functionality Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Discord-native Yugioh draft functionality with join buttons, synchronized 8-card pick steps, YGOPRODeck set/card data, card image grids, and `.ydk` deck export.

**Architecture:** Add draft-specific SQLite tables and services beside the existing tournament system. Keep draft state independent from tournaments for v1, use injected services for YGOPRODeck and Discord notifications, and wire Discord commands/buttons/modals only after the draft engine is tested.

**Tech Stack:** TypeScript, Node 22 native `fetch`, Discord.js, better-sqlite3, Vitest, Docker Compose, YGOPRODeck API v7, `sharp` for PNG grid rendering.

---

## Ground Rules

- Use TDD for each task: write or update tests first, run failing tests, implement the smallest passing change, rerun tests.
- Do not call YGOPRODeck from unit tests. Inject fake `fetch` implementations and fake card data.
- Do not hotlink card images in Discord. Download once, cache under `data/card-images`, then render local images into a grid.
- Prefer YGOPRODeck `image_url_small` for cached draft images. Full images are unnecessary for Discord picker grids and waste VM disk.
- Keep generated picker grids temporary. Do not store every grid PNG permanently.
- Keep `/draft` separate from `/event` for v1.
- Commit after each task or small cohesive group if tests pass.

## Preparation

**Files:**
- Read: `docs/plans/2026-04-30-draft-functionality-design.md`
- Read: `src/services/tournaments.ts`
- Read: `src/commands/handlers.ts`
- Read: `src/interactions/buttons.ts`
- Read: `src/interactions/modals.ts`
- Read: `src/interactions/select-menus.ts`
- Read: `src/index.ts`

**Step 1: Start from a clean worktree**

Run: `git status --short --branch`

Expected: no uncommitted changes, or only unrelated user changes that will not be touched.

**Step 2: Create an implementation branch or worktree**

Run in the chosen workspace: `git switch -c feat/draft-functionality`

Expected: branch switches successfully.

---

### Task 1: Add Draft Schema

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `tests/db/schema.test.ts`

**Step 1: Write the failing schema test**

Update `tests/db/schema.test.ts` so `creates all bot tables` expects the new tables:

```ts
expect(tables).toEqual([
  "card_catalog",
  "draft_cards",
  "draft_picks",
  "draft_players",
  "drafts",
  "matches",
  "players",
  "tournament_matches",
  "tournament_participants",
  "tournaments",
]);
```

Add a duplicate-current-draft-name test:

```ts
it("enforces unique current draft names per guild", () => {
  const db = new Database(":memory:");

  migrate(db);

  db.prepare(
    `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json)
     values ('guild-1', 'channel-1', 'retro', 'completed', 'user-1', '{}')`,
  ).run();
  db.prepare(
    `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json)
     values ('guild-1', 'channel-1', 'retro', 'pending', 'user-1', '{}')`,
  ).run();

  expect(() =>
    db.prepare(
      `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json)
       values ('guild-1', 'channel-1', 'retro', 'active', 'user-2', '{}')`,
    ).run(),
  ).toThrow(/UNIQUE constraint failed/);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/db/schema.test.ts`

Expected: FAIL because draft tables do not exist.

**Step 3: Add schema tables and indexes**

In `src/db/schema.ts`, add tables inside the main `db.exec` block:

```sql
create table if not exists card_catalog (
  ygoprodeck_id integer primary key,
  name text not null,
  type text not null,
  frame_type text not null,
  image_url text not null,
  image_url_small text,
  card_sets_json text not null default '[]',
  cached_at text not null default current_timestamp
);

create table if not exists drafts (
  id integer primary key autoincrement,
  guild_id text not null,
  channel_id text not null,
  name text not null,
  status text not null,
  created_by_user_id text not null,
  config_json text not null default '{}',
  current_wave_number integer not null default 0,
  current_pick_step integer not null default 0,
  created_at text not null default current_timestamp,
  started_at text,
  ended_at text
);

create table if not exists draft_players (
  draft_id integer not null references drafts(id),
  player_id integer not null references players(id),
  pick_count integer not null default 0,
  finished_at text,
  joined_at text not null default current_timestamp,
  primary key (draft_id, player_id)
);

create table if not exists draft_cards (
  id integer primary key autoincrement,
  draft_id integer not null references drafts(id),
  wave_number integer not null,
  catalog_card_id integer not null references card_catalog(ygoprodeck_id),
  picked_by_player_id integer references players(id),
  picked_at text,
  created_at text not null default current_timestamp
);

create table if not exists draft_picks (
  id integer primary key autoincrement,
  draft_id integer not null references drafts(id),
  player_id integer not null references players(id),
  draft_card_id integer not null references draft_cards(id),
  wave_number integer not null,
  pick_step integer not null,
  picked_at text not null default current_timestamp,
  unique (draft_id, player_id, wave_number, pick_step),
  unique (draft_card_id)
);
```

Add indexes after the tournament unique index:

```sql
create unique index if not exists drafts_current_name_unique
on drafts (guild_id, name)
where status in ('pending', 'active');

create index if not exists draft_cards_unpicked_idx
on draft_cards (draft_id, wave_number, picked_by_player_id);
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/db/schema.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat: add draft database schema"
```

---

### Task 2: Add Card Catalog Service

**Files:**
- Create: `src/services/card-catalog.ts`
- Create: `tests/services/card-catalog.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json` if present after install

**Step 1: Write failing catalog tests**

Create `tests/services/card-catalog.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";

const mainDeckCard = {
  id: 46986414,
  name: "Dark Magician",
  type: "Normal Monster",
  frameType: "normal",
  card_sets: [{ set_name: "Legend of Blue Eyes White Dragon" }],
  card_images: [{ image_url: "https://images.ygoprodeck.com/images/cards/46986414.jpg", image_url_small: "small.jpg" }],
};

const extraDeckCard = {
  id: 6983839,
  name: "Tornado Dragon",
  type: "XYZ Monster",
  frameType: "xyz",
  card_sets: [{ set_name: "Maximum Crisis" }],
  card_images: [{ image_url: "https://images.ygoprodeck.com/images/cards/6983839.jpg" }],
};

function setup(fetchImpl = vi.fn()) {
  const db = new Database(":memory:");
  migrate(db);
  return createCardCatalogService(db, { fetch: fetchImpl as any });
}

describe("card catalog service", () => {
  it("fetches set cards and excludes extra deck cards", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [mainDeckCard, extraDeckCard] }) });
    const catalog = setup(fetchImpl);

    const cards = await catalog.syncDraftPool({ setNames: ["Maximum Crisis"], includeNames: [], excludeNames: [] });

    expect(cards.map((card) => card.name)).toEqual(["Dark Magician"]);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("cardset=Maximum%20Crisis"), expect.anything());
  });

  it("adds exact included card names and removes excluded names", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [mainDeckCard] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ ...mainDeckCard, id: 89631139, name: "Blue-Eyes White Dragon" }] }) });
    const catalog = setup(fetchImpl);

    const cards = await catalog.syncDraftPool({
      setNames: ["LOB"],
      includeNames: ["Blue-Eyes White Dragon"],
      excludeNames: ["Dark Magician"],
    });

    expect(cards.map((card) => card.name)).toEqual(["Blue-Eyes White Dragon"]);
  });
});
```

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/services/card-catalog.test.ts`

Expected: FAIL because `card-catalog.ts` does not exist.

**Step 3: Implement minimal catalog service**

Create `src/services/card-catalog.ts` with these exported types and factory:

```ts
import type Database from "better-sqlite3";

export type CatalogCard = {
  id: number;
  name: string;
  type: string;
  frameType: string;
  imageUrl: string;
  imageUrlSmall: string | null;
  setNames: string[];
};

export type DraftPoolInput = {
  setNames: string[];
  includeNames: string[];
  excludeNames: string[];
};

const extraDeckTypes = new Set([
  "Fusion Monster",
  "Link Monster",
  "Pendulum Effect Fusion Monster",
  "Synchro Monster",
  "Synchro Pendulum Effect Monster",
  "Synchro Tuner Monster",
  "XYZ Monster",
  "XYZ Pendulum Effect Monster",
]);

type FetchLike = typeof fetch;

export function createCardCatalogService(db: Database.Database, deps: { fetch?: FetchLike } = {}) {
  const fetchImpl = deps.fetch ?? fetch;

  const upsert = (card: CatalogCard) => {
    db.prepare(
      `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
       values (?, ?, ?, ?, ?, ?, ?, current_timestamp)
       on conflict(ygoprodeck_id) do update set
         name = excluded.name,
         type = excluded.type,
         frame_type = excluded.frame_type,
         image_url = excluded.image_url,
         image_url_small = excluded.image_url_small,
         card_sets_json = excluded.card_sets_json,
         cached_at = current_timestamp`,
    ).run(card.id, card.name, card.type, card.frameType, card.imageUrl, card.imageUrlSmall, JSON.stringify(card.setNames));
  };

  const fetchJson = async (url: string) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`YGOPRODeck request failed: HTTP ${response.status}`);
    return response.json() as Promise<{ data?: any[]; error?: string }>;
  };

  const normalize = (raw: any): CatalogCard | undefined => {
    if (!raw?.id || !raw?.name || !raw?.type || !raw?.frameType || extraDeckTypes.has(raw.type)) return undefined;
    const firstImage = raw.card_images?.[0];
    if (!firstImage?.image_url) return undefined;
    return {
      id: Number(raw.id),
      name: raw.name,
      type: raw.type,
      frameType: raw.frameType,
      imageUrl: firstImage.image_url,
      imageUrlSmall: firstImage.image_url_small ?? null,
      setNames: (raw.card_sets ?? []).map((set: any) => set.set_name).filter(Boolean),
    };
  };

  return {
    async syncDraftPool(input: DraftPoolInput): Promise<CatalogCard[]> {
      const byId = new Map<number, CatalogCard>();
      for (const setName of input.setNames) {
        const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=${encodeURIComponent(setName)}`;
        const json = await fetchJson(url);
        if (json.error) throw new Error(json.error);
        for (const raw of json.data ?? []) {
          const card = normalize(raw);
          if (card) byId.set(card.id, card);
        }
      }
      if (input.includeNames.length > 0) {
        const names = input.includeNames.join("|");
        const json = await fetchJson(`https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(names)}`);
        for (const raw of json.data ?? []) {
          const card = normalize(raw);
          if (card) byId.set(card.id, card);
        }
      }
      const excluded = new Set(input.excludeNames.map((name) => name.toLowerCase()));
      const cards = [...byId.values()].filter((card) => !excluded.has(card.name.toLowerCase()));
      for (const card of cards) upsert(card);
      return cards.sort((a, b) => a.name.localeCompare(b.name));
    },

    findByIds(ids: number[]): CatalogCard[] {
      if (ids.length === 0) return [];
      return db.prepare(`select * from card_catalog where ygoprodeck_id in (${ids.map(() => "?").join(",")})`).all(...ids).map((row: any) => ({
        id: row.ygoprodeck_id,
        name: row.name,
        type: row.type,
        frameType: row.frame_type,
        imageUrl: row.image_url,
        imageUrlSmall: row.image_url_small,
        setNames: JSON.parse(row.card_sets_json),
      }));
    },
  };
}

export type CardCatalogService = ReturnType<typeof createCardCatalogService>;
```

**Step 4: Run tests**

Run: `npm test -- tests/services/card-catalog.test.ts`

Expected: PASS.

**Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/services/card-catalog.ts tests/services/card-catalog.test.ts
git commit -m "feat: add ygoprodeck card catalog service"
```

---

### Task 3: Add Draft Service Creation And Joining

**Files:**
- Create: `src/services/drafts.ts`
- Create: `tests/services/drafts.test.ts`

**Step 1: Write failing draft lifecycle tests**

Create `tests/services/drafts.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createDraftService } from "../../src/services/drafts.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, players: createPlayerRepository(db), drafts: createDraftService(db) };
}

describe("draft service", () => {
  it("creates a pending draft and auto-joins the creator", () => {
    const app = setup();
    const creator = app.players.upsert("guild-1", "user-1", "Yugi");

    const draft = app.drafts.create({
      guildId: "guild-1",
      channelId: "channel-1",
      name: "Retro Cube",
      createdByUserId: "user-1",
      creatorPlayerId: creator.id,
      setNames: ["Metal Raiders"],
      includeNames: [],
      excludeNames: [],
    });

    expect(draft.status).toBe("pending");
    expect(app.drafts.players(draft.id).map((player) => player.playerId)).toEqual([creator.id]);
  });

  it("joins a pending draft once", () => {
    const app = setup();
    const creator = app.players.upsert("guild-1", "user-1", "Yugi");
    const joey = app.players.upsert("guild-1", "user-2", "Joey");
    const draft = app.drafts.create({ guildId: "guild-1", channelId: "channel-1", name: "Retro", createdByUserId: "user-1", creatorPlayerId: creator.id, setNames: ["MRD"], includeNames: [], excludeNames: [] });

    app.drafts.join(draft.id, joey.id);
    app.drafts.join(draft.id, joey.id);

    expect(app.drafts.players(draft.id).map((player) => player.playerId)).toEqual([creator.id, joey.id]);
  });

  it("rejects duplicate active or pending draft names", () => {
    const app = setup();
    const creator = app.players.upsert("guild-1", "user-1", "Yugi");
    app.drafts.create({ guildId: "guild-1", channelId: "channel-1", name: "Retro", createdByUserId: "user-1", creatorPlayerId: creator.id, setNames: ["MRD"], includeNames: [], excludeNames: [] });

    expect(() =>
      app.drafts.create({ guildId: "guild-1", channelId: "channel-1", name: "Retro", createdByUserId: "user-1", creatorPlayerId: creator.id, setNames: ["LOB"], includeNames: [], excludeNames: [] }),
    ).toThrow("An active or pending draft already uses that name");
  });
});
```

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: FAIL because `drafts.ts` does not exist.

**Step 3: Implement create/join/list**

Create `src/services/drafts.ts` with `Draft`, `DraftStatus`, `DraftPlayer`, `createDraftService(db)`, and methods:

- `create(input)` inserts into `drafts`, stores config JSON, and inserts creator into `draft_players` in a transaction.
- `findById(draftId)` returns a draft or throws.
- `findByName(guildId, name)` returns active/pending first.
- `listByStatus(guildId, statuses)` mirrors tournament service behavior.
- `join(draftId, playerId)` only allows pending drafts and uses `insert or ignore`.
- `players(draftId)` returns joined players in join order.

Use the tournament service style for row mapping and errors.

**Step 4: Run tests**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: add draft lifecycle service"
```

---

### Task 4: Add Draft Start And Wave Creation

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Add failing tests for start and first wave**

In `tests/services/drafts.test.ts`, add helper catalog rows:

```ts
function insertCards(db: Database.Database, count: number) {
  for (let index = 1; index <= count; index += 1) {
    db.prepare(
      `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json)
       values (?, ?, 'Effect Monster', 'effect', ?, ?, '[]')`,
    ).run(1000 + index, `Card ${index}`, `card-${index}.jpg`, `small-${index}.jpg`);
  }
}
```

Add tests:

```ts
it("starts a draft and opens one 8-card wave per player", () => {
  const app = setup();
  insertCards(app.db, 20);
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const joey = app.players.upsert("guild-1", "user-2", "Joey");
  const draft = app.drafts.create({ guildId: "guild-1", channelId: "channel-1", name: "Retro", createdByUserId: "user-1", creatorPlayerId: yugi.id, setNames: ["MRD"], includeNames: [], excludeNames: [] });
  app.drafts.join(draft.id, joey.id);

  app.drafts.start(draft.id);

  expect(app.drafts.findById(draft.id).status).toBe("active");
  expect(app.drafts.currentWaveCards(draft.id)).toHaveLength(16);
});

it("requires at least two players to start", () => {
  const app = setup();
  insertCards(app.db, 20);
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const draft = app.drafts.create({ guildId: "guild-1", channelId: "channel-1", name: "Retro", createdByUserId: "user-1", creatorPlayerId: yugi.id, setNames: ["MRD"], includeNames: [], excludeNames: [] });

  expect(() => app.drafts.start(draft.id)).toThrow("Draft needs at least two players");
});
```

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: FAIL because start/wave methods do not exist.

**Step 3: Implement start and wave creation**

In `src/services/drafts.ts`, add:

- `start(draftId)` validates pending status, validates at least 2 players, opens wave 1, sets active, `started_at`, `current_wave_number = 1`, `current_pick_step = 1`.
- `currentWaveCards(draftId)` returns unpicked and picked cards for the current wave with catalog metadata.
- Internal `openWave(draftId, waveNumber)` inserts `playerCount * 8` `draft_cards` by randomly selecting from `card_catalog` rows.

For v1, sample card instances with replacement from the eligible catalog rows. This allows official-set-style duplicate pulls and avoids requiring massive unique cube lists.

**Step 4: Run tests**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: start drafts with opening waves"
```

---

### Task 5: Add Pick Options And Synchronized Pick Steps

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Add failing pick tests**

Add tests:

```ts
it("offers eight options from the current wave and records one pick per step", () => {
  const app = setup();
  insertCards(app.db, 20);
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const joey = app.players.upsert("guild-1", "user-2", "Joey");
  const draft = app.drafts.create({ guildId: "guild-1", channelId: "channel-1", name: "Retro", createdByUserId: "user-1", creatorPlayerId: yugi.id, setNames: ["MRD"], includeNames: [], excludeNames: [] });
  app.drafts.join(draft.id, joey.id);
  app.drafts.start(draft.id);

  const options = app.drafts.pickOptions(draft.id, yugi.id);
  expect(options).toHaveLength(8);

  app.drafts.pickCard(draft.id, yugi.id, options[0].draftCardId);

  expect(app.drafts.pickOptions(draft.id, yugi.id)).toEqual([]);
  expect(() => app.drafts.pickCard(draft.id, yugi.id, options[1].draftCardId)).toThrow("You already picked for this step");
});

it("advances to the next pick step only after every active player picks", () => {
  const app = setup();
  insertCards(app.db, 20);
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const joey = app.players.upsert("guild-1", "user-2", "Joey");
  const draft = app.drafts.create({ guildId: "guild-1", channelId: "channel-1", name: "Retro", createdByUserId: "user-1", creatorPlayerId: yugi.id, setNames: ["MRD"], includeNames: [], excludeNames: [] });
  app.drafts.join(draft.id, joey.id);
  app.drafts.start(draft.id);

  app.drafts.pickCard(draft.id, yugi.id, app.drafts.pickOptions(draft.id, yugi.id)[0].draftCardId);
  expect(app.drafts.findById(draft.id).currentPickStep).toBe(1);

  app.drafts.pickCard(draft.id, joey.id, app.drafts.pickOptions(draft.id, joey.id)[0].draftCardId);
  expect(app.drafts.findById(draft.id).currentPickStep).toBe(2);
});
```

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: FAIL because pick methods do not exist.

**Step 3: Implement pick options and recording**

In `src/services/drafts.ts`, add:

- `pickOptions(draftId, playerId)` returns up to 8 unpicked current-wave cards if the player has not picked for the current step.
- `pickCard(draftId, playerId, draftCardId)` runs in a transaction.
- Validate draft active, player joined, player has not picked current step, card is in current wave, card is unpicked.
- Insert into `draft_picks` and update `draft_cards.picked_by_player_id`.
- Increment `draft_players.pick_count`.
- If all unfinished players picked this step, advance `current_pick_step` by 1.

**Step 4: Run tests**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: add synchronized draft picks"
```

---

### Task 6: Add Wave Advancement And Completion

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Add failing advancement tests**

Add tests for emptying a wave and completing at 40 picks:

```ts
it("opens the next wave after the current wave is fully picked", () => {
  const app = setup();
  insertCards(app.db, 30);
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const joey = app.players.upsert("guild-1", "user-2", "Joey");
  const draft = app.drafts.create({ guildId: "guild-1", channelId: "channel-1", name: "Retro", createdByUserId: "user-1", creatorPlayerId: yugi.id, setNames: ["MRD"], includeNames: [], excludeNames: [] });
  app.drafts.join(draft.id, joey.id);
  app.drafts.start(draft.id);

  for (let step = 1; step <= 8; step += 1) {
    app.drafts.pickCard(draft.id, yugi.id, app.drafts.pickOptions(draft.id, yugi.id)[0].draftCardId);
    app.drafts.pickCard(draft.id, joey.id, app.drafts.pickOptions(draft.id, joey.id)[0].draftCardId);
  }

  expect(app.drafts.findById(draft.id).currentWaveNumber).toBe(2);
  expect(app.drafts.currentWaveCards(draft.id)).toHaveLength(16);
});
```

Add a completion test that loops 40 picks per player and expects `status` to become `completed`.

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: FAIL because wave advancement/completion is not implemented.

**Step 3: Implement advancement**

After all players pick a step:

- If no unpicked cards remain in current wave and any player has fewer than 40 picks, open `current_wave_number + 1` and reset `current_pick_step = 1`.
- If all players have 40 picks, set draft `status = 'completed'`, set `ended_at`, and mark players finished.
- Do not prompt or return options for players at 40 picks.

**Step 4: Run tests**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: advance draft waves to completion"
```

---

### Task 7: Add YDK Export

**Files:**
- Modify: `src/services/drafts.ts`
- Modify: `tests/services/drafts.test.ts`

**Step 1: Add failing YDK test**

Add a test that inserts 40 picked cards for one player or uses a helper to complete a small draft, then calls:

```ts
const ydk = app.drafts.exportYdk(draft.id, yugi.id);
expect(ydk).toContain("#created by Yugioh Discord Bot");
expect(ydk).toContain("#main");
expect(ydk).toContain("#extra");
expect(ydk).toContain("!side");
expect(ydk.split("\n").filter((line) => /^\d+$/.test(line))).toHaveLength(40);
```

Add another test that export before 40 picks throws `Deck is not complete yet`.

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: FAIL because `exportYdk` does not exist.

**Step 3: Implement export**

Add `exportYdk(draftId, playerId): string` to `DraftService`:

```ts
const ids = db.prepare(
  `select dc.catalog_card_id
   from draft_cards dc
   where dc.draft_id = ? and dc.picked_by_player_id = ?
   order by dc.picked_at asc, dc.id asc`,
).all(draftId, playerId).map((row: any) => row.catalog_card_id);

if (ids.length !== 40) throw new Error("Deck is not complete yet");

return ["#created by Yugioh Discord Bot", "#main", ...ids.map(String), "#extra", "!side", ""].join("\n");
```

**Step 4: Run tests**

Run: `npm test -- tests/services/drafts.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/drafts.ts tests/services/drafts.test.ts
git commit -m "feat: export drafted decks as ydk"
```

---

### Task 8: Add Draft Image Service

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` if generated
- Create: `src/services/draft-images.ts`
- Create: `tests/services/draft-images.test.ts`

**Step 1: Install image dependency**

Run: `npm install sharp`

Expected: `sharp` is added to dependencies and install completes.

**Step 2: Write failing image service test**

Create `tests/services/draft-images.test.ts` with a unit test that uses tiny generated buffers rather than network images:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createDraftImageService } from "../../src/services/draft-images.js";

describe("draft image service", () => {
  it("renders a numbered grid image", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "draft-images-"));
    try {
      const source = path.join(dir, "card.jpg");
      await sharp({ create: { width: 120, height: 176, channels: 3, background: "white" } }).jpeg().toFile(source);
      const images = createDraftImageService({ cacheDir: dir, fetch: async () => ({ ok: true, arrayBuffer: async () => (await readFile(source)).buffer }) as any });

      const output = await images.renderPickGrid([
        { id: 1, name: "Card 1", imageUrl: "https://example.com/1.jpg", imageUrlSmall: null },
        { id: 2, name: "Card 2", imageUrl: "https://example.com/2.jpg", imageUrlSmall: null },
      ]);

      expect(output.filename).toBe("draft-picks.png");
      expect(output.buffer.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

**Step 3: Run test to verify failure**

Run: `npm test -- tests/services/draft-images.test.ts`

Expected: FAIL because service does not exist.

**Step 4: Implement image service**

Create `src/services/draft-images.ts`:

- Export `createDraftImageService({ cacheDir, fetch })`.
- Use card ID filenames like `<cacheDir>/<id>.jpg`.
- Download `imageUrlSmall` when available and fall back to `imageUrl` only if no small image exists.
- Download missing images once.
- Use `sharp` to resize card images to a fixed width, compose a 4x2 grid, and overlay simple number labels.
- Return `{ filename: "draft-picks.png", buffer }`.
- Do not write generated grid PNGs to persistent storage; return buffers directly for Discord attachments.
- Throw normal errors and let callers fall back to text.

**Step 5: Run tests**

Run: `npm test -- tests/services/draft-images.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/services/draft-images.ts tests/services/draft-images.test.ts
git commit -m "feat: render draft pick card grids"
```

---

### Task 9: Add Draft Storage Cleanup

**Files:**
- Create: `src/services/draft-cleanup.ts`
- Create: `tests/services/draft-cleanup.test.ts`
- Modify: `README.md`
- Modify: `docs/deployment/gce-runbook.md`

**Step 1: Write failing cleanup tests**

Create `tests/services/draft-cleanup.test.ts`:

```ts
import Database from "better-sqlite3";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createDraftCleanupService } from "../../src/services/draft-cleanup.js";

describe("draft cleanup service", () => {
  it("reports draft storage usage", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const dir = await mkdtemp(path.join(tmpdir(), "draft-cleanup-"));
    try {
      await writeFile(path.join(dir, "1.jpg"), Buffer.alloc(10));
      const cleanup = createDraftCleanupService(db, { imageCacheDir: dir });

      await expect(cleanup.storageSummary()).resolves.toMatchObject({ imageCacheBytes: 10 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes cached images for cards no longer referenced by active or pending drafts", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const dir = await mkdtemp(path.join(tmpdir(), "draft-cleanup-"));
    try {
      await writeFile(path.join(dir, "1001.jpg"), Buffer.alloc(10));
      const cleanup = createDraftCleanupService(db, { imageCacheDir: dir });

      await cleanup.removeUnreferencedImages();

      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

**Step 2: Run test to verify failure**

Run: `npm test -- tests/services/draft-cleanup.test.ts`

Expected: FAIL because cleanup service does not exist.

**Step 3: Implement cleanup service**

Create `src/services/draft-cleanup.ts` with:

- `storageSummary()` returning image cache bytes, cached card count, draft count, and completed draft count.
- `removeUnreferencedImages()` deleting cached image files whose card IDs are not referenced by pending or active draft cards.
- Safe file handling: ignore missing directories and non-card filenames.

Use only file names matching `/^\d+\.jpg$/` for deletion.

**Step 4: Run tests**

Run: `npm test -- tests/services/draft-cleanup.test.ts`

Expected: PASS.

**Step 5: Document storage expectations**

Add to `README.md` and `docs/deployment/gce-runbook.md`:

- 30 GB is enough for v1 if the bot caches small card images.
- Expected cache sizes: metadata is small, small card images are usually under a few GB even for broad usage, Docker/build artifacts are the larger operational risk.
- Generated picker grids are sent as temporary buffers and should not accumulate on disk.
- Periodic maintenance commands:

```bash
docker system df
docker image prune -f
du -sh /opt/yugioh-discord-bot/data/*
```

**Step 6: Commit**

```bash
git add src/services/draft-cleanup.ts tests/services/draft-cleanup.test.ts README.md docs/deployment/gce-runbook.md
git commit -m "feat: add draft storage cleanup"
```

---

### Task 10: Add `/draft` Command Definitions

**Files:**
- Modify: `src/commands/definitions.ts`
- Modify: `tests/commands/definitions.test.ts`

**Step 1: Write failing command definition test**

Update `tests/commands/definitions.test.ts` to assert `draft` exists and includes subcommands:

```ts
const draft = commandDefinitions.find((command: any) => command.name === "draft") as any;
expect(draft).toBeDefined();
expect(JSON.stringify(draft)).toContain("dashboard");
expect(JSON.stringify(draft)).toContain("join");
expect(JSON.stringify(draft)).toContain("start");
expect(JSON.stringify(draft)).toContain("export");
```

**Step 2: Run test to verify failure**

Run: `npm test -- tests/commands/definitions.test.ts`

Expected: FAIL because `/draft` does not exist.

**Step 3: Add command definition**

In `src/commands/definitions.ts`, add a `SlashCommandBuilder` for `draft` with subcommands:

- `dashboard`: open private draft dashboard.
- `join name`: join by name, with autocomplete later if needed.
- `start name`: creator starts a pending draft.
- `export name`: export your completed deck.

Keep dashboard as the primary create flow because modals support longer set/card text.

**Step 4: Run tests**

Run: `npm test -- tests/commands/definitions.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/definitions.ts tests/commands/definitions.test.ts
git commit -m "feat: add draft slash commands"
```

---

### Task 11: Wire Draft Dependencies And Interaction Types

**Files:**
- Modify: `src/index.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/interactions/buttons.ts`
- Modify: `src/interactions/modals.ts`
- Modify: `src/interactions/select-menus.ts`
- Modify: affected tests setup helpers

**Step 1: Add failing type-oriented test setup changes**

Update test setup helpers to pass `drafts`, `cards`, and `draftImages` placeholders once handler types require them. Initial compile should fail until types are updated.

**Step 2: Run typecheck to verify failure**

Run: `npm run typecheck`

Expected: FAIL from missing draft dependencies.

**Step 3: Extend dependencies**

Add `createDraftService(db)`, `createCardCatalogService(db)`, and `createDraftImageService(...)` to `src/index.ts` deps.

Extend interaction-like types with `channelId` where needed:

- `CommandInteractionLike.channelId`
- `ButtonInteractionLike.channelId`
- `ModalInteractionLike.channelId`

In `src/index.ts`, map `interaction.channelId` into those objects.

Add a notifier dependency shape:

```ts
type DraftNotifier = {
  sendPickPrompt(input: { channelId: string; userId: string; draftId: number; draftName: string }): Promise<void>;
};
```

In `index.ts`, implement it with `client.channels.fetch(channelId)` and `channel.send(...)` for guild text channels.

**Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.ts src/commands/handlers.ts src/interactions/buttons.ts src/interactions/modals.ts src/interactions/select-menus.ts tests
git commit -m "refactor: wire draft dependencies"
```

---

### Task 12: Add Draft Dashboard And Create Modal

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `src/interactions/buttons.ts`
- Modify: `src/interactions/modals.ts`
- Modify: `tests/commands/handlers.test.ts`
- Modify: `tests/interactions/buttons.test.ts`
- Modify: `tests/interactions/modals.test.ts`

**Step 1: Write failing dashboard tests**

Add command test:

```ts
it("/draft dashboard replies privately with draft buttons", async () => {
  const app = setup();
  const { interaction, replies } = fakeInteraction({ commandName: "draft", subcommand: "dashboard", user: { id: "user-1", username: "Yugi" } });

  await handleCommand(interaction, app);

  expect(replies[0]).toMatchObject({ content: expect.stringContaining("Draft Dashboard"), ephemeral: true });
  expect(JSON.stringify(replies[0])).toContain("draft_create");
  expect(JSON.stringify(replies[0])).toContain("draft_open");
  expect(JSON.stringify(replies[0])).toContain("draft_export");
});
```

Add button test for `draft_create` showing a modal with fields `name`, `sets`, `includes`, `excludes`.

Add modal test for `draft_create_modal` creating a draft, auto-joining creator, and replying publicly with `Join Draft` button.

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/commands/handlers.test.ts tests/interactions/buttons.test.ts tests/interactions/modals.test.ts`

Expected: FAIL because dashboard/create handlers do not exist.

**Step 3: Implement dashboard and modal**

Add helpers:

- `draftDashboardReply()` in `src/commands/handlers.ts`.
- `draftSignupPostReply(draft)` in `src/commands/handlers.ts` or a new small formatter module if needed.
- Button `draft_create` opens modal.
- Modal `draft_create_modal` parses comma/newline-separated set/include/exclude values.
- Modal creates creator player, creates draft with `channelId`, and replies publicly with `Join Draft` button.

**Step 4: Run tests**

Run: `npm test -- tests/commands/handlers.test.ts tests/interactions/buttons.test.ts tests/interactions/modals.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/handlers.ts src/interactions/buttons.ts src/interactions/modals.ts tests/commands/handlers.test.ts tests/interactions/buttons.test.ts tests/interactions/modals.test.ts
git commit -m "feat: add draft dashboard creation flow"
```

---

### Task 13: Add Join, Start, And Pick Prompt Buttons

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `src/interactions/buttons.ts`
- Modify: `tests/commands/handlers.test.ts`
- Modify: `tests/interactions/buttons.test.ts`

**Step 1: Write failing interaction tests**

Add tests for:

- `join_draft:<id>` joins pending draft and replies ephemerally.
- `/draft join name:<name>` joins by name.
- `/draft start name:<name>` requires creator and starts draft.
- Start sends pick prompts via fake notifier for every joined player.
- Non-creator start rejects with `Only the draft creator can do that`.

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/commands/handlers.test.ts tests/interactions/buttons.test.ts`

Expected: FAIL.

**Step 3: Implement join/start**

In command and button handlers:

- Resolve draft by id/name.
- Upsert current player.
- Join pending drafts.
- Start pending drafts if creator.
- After `drafts.start`, call notifier for each player needing a pick.

Add `drafts.playersNeedingPick(draftId)` to `DraftService` if useful.

**Step 4: Run tests**

Run: `npm test -- tests/commands/handlers.test.ts tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/handlers.ts src/interactions/buttons.ts src/services/drafts.ts tests/commands/handlers.test.ts tests/interactions/buttons.test.ts tests/services/drafts.test.ts
git commit -m "feat: join and start drafts"
```

---

### Task 14: Add Pick Card UI And Recording

**Files:**
- Modify: `src/interactions/buttons.ts`
- Modify: `src/interactions/select-menus.ts`
- Modify: `src/index.ts`
- Modify: `tests/interactions/buttons.test.ts`
- Modify: `tests/interactions/select-menus.test.ts`

**Step 1: Write failing picker tests**

Add tests for:

- `draft_pick:<draftId>` replies ephemerally with 8 options and a grid attachment if image service succeeds.
- Fallback text list is used when image service throws.
- `draft_pick_card:<draftId>:<draftCardId>` records a pick.
- After the final player picks for a step, notifier sends next prompts.
- A player who already picked for the step gets an ephemeral status message.

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/interactions/buttons.test.ts tests/interactions/select-menus.test.ts`

Expected: FAIL.

**Step 3: Implement pick UI**

Discord has a five-button-per-row limit. Use a string select menu for 8 card choices rather than 8 buttons.

- Button `draft_pick:<draftId>` gets `drafts.pickOptions`.
- Render grid through `draftImages.renderPickGrid`.
- Reply with attachment plus select menu `draft_pick_card:<draftId>` with options `1. Card Name` through `8. Card Name`, values as `draftCardId`.
- Select menu handler records the pick and replies ephemerally with selected card name.
- If the pick completes a synchronized step, send next prompts through notifier.

Update interaction-like reply types to support Discord `files` if needed:

```ts
files?: InteractionReplyOptions["files"];
```

**Step 4: Run tests**

Run: `npm test -- tests/interactions/buttons.test.ts tests/interactions/select-menus.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/interactions/buttons.ts src/interactions/select-menus.ts src/index.ts tests/interactions/buttons.test.ts tests/interactions/select-menus.test.ts
git commit -m "feat: add draft card picking ui"
```

---

### Task 15: Add Deck Export Interaction

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `src/interactions/buttons.ts`
- Modify: `tests/commands/handlers.test.ts`
- Modify: `tests/interactions/buttons.test.ts`

**Step 1: Write failing export tests**

Add tests for:

- `/draft export name:<name>` returns a `.ydk` attachment when complete.
- `draft_export` dashboard path lists completed drafts or exports when only one exists.
- Incomplete decks return `Deck is not complete yet`.

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/commands/handlers.test.ts tests/interactions/buttons.test.ts`

Expected: FAIL.

**Step 3: Implement export replies**

Use Discord file attachments from buffers:

```ts
const ydk = deps.drafts.exportYdk(draft.id, player.id);
await interaction.reply({
  content: `Exported ${draft.name}.`,
  ephemeral: true,
  files: [{ attachment: Buffer.from(ydk, "utf8"), name: `${draft.name}.ydk` }],
});
```

Sanitize filename by replacing non-alphanumeric characters with `-`.

**Step 4: Run tests**

Run: `npm test -- tests/commands/handlers.test.ts tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/handlers.ts src/interactions/buttons.ts tests/commands/handlers.test.ts tests/interactions/buttons.test.ts
git commit -m "feat: export draft decks from discord"
```

---

### Task 16: Add Autocomplete And Help Text

**Files:**
- Modify: `src/interactions/autocomplete.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `tests/interactions/autocomplete.test.ts`
- Modify: `tests/commands/handlers.test.ts`
- Modify: `README.md`

**Step 1: Write failing tests**

Add autocomplete tests for `/draft join`, `/draft start`, and `/draft export` name options.

Update `/help` test to include draft commands.

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/interactions/autocomplete.test.ts tests/commands/handlers.test.ts`

Expected: FAIL.

**Step 3: Implement autocomplete and help docs**

- Pending drafts for join/start.
- Completed drafts for export.
- User-specific completed drafts for export if practical.
- Update README feature list and manual checklist with draft smoke tests.

**Step 4: Run tests**

Run: `npm test -- tests/interactions/autocomplete.test.ts tests/commands/handlers.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/interactions/autocomplete.ts src/commands/handlers.ts tests/interactions/autocomplete.test.ts tests/commands/handlers.test.ts README.md
git commit -m "feat: add draft autocomplete and docs"
```

---

### Task 17: End-To-End Verification

**Files:**
- No code changes expected unless verification finds bugs.

**Step 1: Run full test suite**

Run: `npm test`

Expected: PASS.

**Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

**Step 3: Run production build**

Run: `npm run build`

Expected: PASS.

**Step 4: Build Docker image**

Run: `docker compose build`

Expected: PASS.

**Step 5: Manual Discord smoke test**

In a test Discord server:

- Run `/draft dashboard`.
- Create a draft with one or two small YGOPRODeck sets.
- Confirm public `Join Draft` button appears.
- Join with a second account.
- Start the draft.
- Confirm both users are pinged in the creation channel.
- Click `Pick Cards` and confirm an 8-card grid appears privately.
- Pick one card with the select menu.
- Confirm next prompts appear only after both users pick.
- Continue or seed state in development to verify `.ydk` export.

**Step 6: Final commit if verification required fixes**

If fixes were needed:

```bash
git add <changed-files>
git commit -m "fix: stabilize draft workflow"
```

---

## Deployment Notes

- The bot deploy flow already runs slash command registration before startup through Docker Compose.
- After merging to `main`, GitHub Actions deploys to the GCE VM.
- YGOPRODeck metadata and images will be cached on the VM under the SQLite database and `data/card-images`.
- Ensure `data/card-images` lives under the existing persistent `./data` mount.
- With small card image caching and temporary grid buffers, 30 GB is enough for v1. Monitor Docker image layers and old build artifacts because they are more likely to consume disk than card metadata.
- Run storage cleanup periodically after deploys or when disk usage grows.

## Open Follow-Ups After V1

- Timed picks and auto-pick for inactive users.
- Finite uploaded cube lists with exact copy counts.
- Rarity-weighted pack simulation.
- Extra Deck side draft.
- Tournament creation from completed draft pods.
