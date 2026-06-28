# Theme Draft Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second draft mode (`mode: "theme"`) where each player drafts privately from their own archetype/theme-restricted pool (main deck + optional Extra Deck), reusing the existing draft lifecycle, pick UI, bots, and timer.

**Architecture:** A "theme" is the same shape as a cube — a curated card list — but persisted in normalized `themes`/`theme_cards` tables split into `main`/`extra` pools with per-card `max_copies`, and seeded from YGOPRODeck archetypes. The draft engine branches on `config.mode === "theme"`: instead of one shared `buildDeal` distribution, each round it deals every player a private pack of `themePackSize` choices from their assigned theme (`openThemeRound`), they each pick 1 simultaneously, and the global round counter (`current_wave_number`) advances `1..totalRounds` where `totalRounds = cardsPerPlayer + (extraDeckEnabled ? extraDeckSize : 0)`. Phase (main vs extra) is *derived* from the round number, never stored. The existing booster path is untouched.

**Tech Stack:** TypeScript, npm workspaces + Turborepo, better-sqlite3, vitest, Next.js 16 App Router, Socket.IO. YGOPRODeck API v7 (`db.ygoprodeck.com/api/v7`) is the only data source in v1.

**Spec:** `docs/superpowers/specs/2026-06-25-theme-draft-design.md` (read it first).

---

## Conventions for every task

- **TDD.** Write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Run a single shared test:** `npx vitest run packages/shared/tests/<file>.test.ts`
- **Run a single web test:** `npx vitest run packages/web/tests/<file>.test.ts -c packages/web/vitest.config.ts`
- **Typecheck before committing a phase:** `npm run typecheck`
- **Commit messages:** conventional commits (`feat(shared): ...`, `feat(web): ...`, `test: ...`). Do NOT push or open PRs unless the human asks.
- **Shared test DB idiom:** `const db = new Database(":memory:"); migrate(db);` then construct the service factory. See `packages/shared/tests/services/drafts.test.ts` and `card-catalog.test.ts`.
- **Catalog HTTP is mocked by passing a custom `fetch` to the service factory** (NOT `vi.mock`). See `card-catalog.test.ts` `setup()`.
- **Web route test idiom:** temp-file SQLite via `mkdtempSync`, set `process.env.DATABASE_PATH`, `vi.mock("@/lib/auth", ...)`, dynamic `await import("../app/api/.../route")`, call `POST(request)` directly. See `packages/web/tests/drafts-create-route.test.ts`.

---

## File Structure

**Create:**
- `packages/shared/src/services/themes.ts` — theme authoring + validation service (`createThemesService(db)`).
- `packages/shared/tests/services/themes.test.ts`
- `packages/shared/tests/services/card-catalog-archetype.test.ts`
- `packages/shared/tests/services/drafts-theme.test.ts`
- `packages/web/app/api/themes/route.ts` — `GET` list, `POST` create.
- `packages/web/app/api/themes/[id]/route.ts` — `GET` pools, `PUT` rename, `DELETE`.
- `packages/web/app/api/themes/[id]/cards/route.ts` — `POST` mutate cards (add/remove/setMaxCopies/import/seedArchetype).
- `packages/web/app/api/archetypes/route.ts` — `GET` archetype list.
- `packages/web/src/components/themes/theme-editor.tsx` — author UI (reuses cube-editor primitives).
- `packages/web/src/lib/theme-pools.ts` — small shared client helper for routing a card id to main/extra.
- `packages/web/app/(app)/themes/page.tsx` + `packages/web/app/(app)/themes/[id]/page.tsx` — theme list + editor pages.
- `packages/web/app/(app)/drafts/new/cube/page.tsx` — the existing cube `CreateDraftForm`, moved here.
- `packages/web/app/(app)/drafts/new/theme/page.tsx` — the new theme create form page.
- `packages/web/src/components/draft/create-theme-draft-form.tsx` — the theme create form (sibling to `create-draft-form.tsx`).
- `packages/web/tests/themes-*.test.ts`, `packages/web/tests/drafts-theme-pick-route.test.ts`

**Modify:**
- `packages/web/app/(app)/drafts/new/page.tsx` — becomes the **draft-type chooser** (Cube vs Theme) instead of rendering the cube form directly.
- `packages/shared/src/types/index.ts` — extend `DraftConfig`; add `ThemeCard`, `ThemePools`, `ThemeAnalysis`, `Theme` types.
- `packages/shared/src/db/schema.ts` — new tables + `card_catalog.archetype` column.
- `packages/shared/src/services/card-catalog.ts` — `archetype` field, `syncByArchetype`, `syncStaples`, `syncGenericExtra`, `listArchetypes`.
- `packages/shared/src/services/drafts.ts` — `defaultDraftConfig`/`normalizeDraftConfig`, theme branch in `start`, new `openThemeRound`, theme branch in `pickCard`, `totalRounds`-aware finish gate & `currentPackOptions`.
- `packages/shared/src/ws/events.ts` — `phase` field on resync/status payloads.
- `packages/web/app/api/drafts/[slug]/route.ts` + `helpers.ts` — theme create config passthrough, theme assignment at start, preflight warnings, `phase` in response.
- `packages/web/app/(app)/drafts/new/page.tsx` → draft-type chooser (cube form moves to `drafts/new/cube/page.tsx`).
- `packages/web/app/(app)/draft/[slug]/page.tsx` — phase indicator + Extra section.

---

# Phase 1 — Catalog & Themes

Produces working theme authoring + validation, fully unit-tested, with no draft-engine changes. After Phase 1 an admin can build/seed/import/validate themes via the API and editor.

## Task 1.1: `card_catalog.archetype` column

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (the `addColumnIfMissing` block, ~lines 228-258)
- Test: `packages/shared/tests/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `schema.test.ts`:

```ts
it("adds an archetype column to card_catalog", () => {
  const db = new Database(":memory:");
  migrate(db);
  const cols = (db.pragma("table_info(card_catalog)") as Array<{ name: string }>).map((c) => c.name);
  expect(cols).toContain("archetype");
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts`
Expected: FAIL (`archetype` not in columns).

- [ ] **Step 3: Implement**

In `schema.ts`, alongside the other `addColumnIfMissing(db, ...)` calls:

```ts
addColumnIfMissing(db, "card_catalog", "archetype", "text");
```

- [ ] **Step 4: Run it, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/tests/db/schema.test.ts
git commit -m "feat(shared): add archetype column to card_catalog"
```

## Task 1.2: `themes`, `theme_cards`, `draft_player_theme`, `archetypes` tables

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (the `db.exec(...)` create-table block; add new `create table if not exists` statements)
- Test: `packages/shared/tests/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("creates theme tables", () => {
  const db = new Database(":memory:");
  migrate(db);
  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
  expect(tables).toEqual(expect.arrayContaining(["themes", "theme_cards", "draft_player_theme", "archetypes"]));
});

it("enforces the theme_cards primary key and pool", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("insert into themes (guild_id, name, created_by_user_id, created_at, updated_at) values ('g','Blue-Eyes','u','t','t')").run();
  db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (1,'a','t','normal','i','i','[]','t')").run();
  db.prepare("insert into theme_cards (theme_id, catalog_card_id, pool, max_copies) values (1,1,'main',3)").run();
  expect(() =>
    db.prepare("insert into theme_cards (theme_id, catalog_card_id, pool, max_copies) values (1,1,'main',3)").run(),
  ).toThrow();
});
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement**

Add inside the `db.exec(\`...\`)` block in `migrate` (place after the existing `card_catalog` table so the FK target exists):

```sql
create table if not exists themes (
  id integer primary key autoincrement,
  guild_id text not null,
  name text not null,
  archetype text,
  banlist text,
  created_by_user_id text not null,
  created_at text not null,
  updated_at text not null,
  unique (guild_id, name)
);

create table if not exists theme_cards (
  theme_id integer not null references themes(id) on delete cascade,
  catalog_card_id integer not null references card_catalog(ygoprodeck_id),
  pool text not null,
  max_copies integer not null default 3,
  source text,
  primary key (theme_id, catalog_card_id)
);

create table if not exists draft_player_theme (
  draft_id integer not null references drafts(id),
  player_id integer not null references players(id),
  theme_id integer not null references themes(id),
  primary key (draft_id, player_id)
);

create table if not exists archetypes (
  name text primary key,
  synced_at text not null
);
```

Note: `source` column lets the editor flag auto-added generic-extra cards (spec). `unique (guild_id, name)` mirrors `draft_templates`.

- [ ] **Step 4: Run it, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/tests/db/schema.test.ts
git commit -m "feat(shared): add themes/theme_cards/draft_player_theme schema"
```

## Task 1.3: Persist & return `archetype` in card-catalog

**Files:**
- Modify: `packages/shared/src/services/card-catalog.ts` (`YgoprodeckCard` type ~lines 14-29; `upsertCard` insert+mapping ~lines 102-133; the row→Card mapper used by `findByIds`)
- Modify: `packages/shared/src/types/index.ts` (`Card` interface — add `archetype?: string`)
- Test: `packages/shared/tests/services/card-catalog-archetype.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Mirror the `setup()` helper from `card-catalog.test.ts` (custom `fetch`). New file:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";

function setup(cardsByArchetype: Record<string, any[]> = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const catalog = createCardCatalogService(db, {
    fetch: async (input) => {
      const url = new URL(String(input));
      const archetype = url.searchParams.get("archetype");
      const data = archetype ? cardsByArchetype[archetype] ?? [] : [];
      return { ok: true, async json() { return { data }; } } as Response;
    },
  });
  return { db, catalog };
}

const blueEyes = {
  id: 89631139, name: "Blue-Eyes White Dragon", type: "Normal Monster", frameType: "normal",
  archetype: "Blue-Eyes",
  card_images: [{ image_url: "i", image_url_small: "i" }],
};

it("stores and returns the archetype on a synced card", async () => {
  const { db, catalog } = setup({ "Blue-Eyes": [blueEyes] });
  await catalog.syncByArchetype("Blue-Eyes");
  const [card] = catalog.findByIds([89631139]);
  expect(card.archetype).toBe("Blue-Eyes");
});
```

- [ ] **Step 2: Run it, expect FAIL** (`syncByArchetype` undefined — that's fine, this task only adds the column plumbing; you'll implement `syncByArchetype` in 1.4. To isolate 1.3, instead insert via `syncCardByName` or a direct upsert path. Simplest: write a focused 1.3 test that calls a tiny new exported mapping. **Recommended:** fold 1.3 into 1.4 — implement the type/column/mapping changes as the first steps of 1.4 so the test in 1.4 covers them.)

> **Decision:** Merge Task 1.3 into Task 1.4. Do the `Card.archetype` type add, `YgoprodeckCard.archetype` add, `upsertCard` column add, and row-mapper add as the implementation of 1.4. Skip a standalone 1.3 commit.

## Task 1.4: `syncByArchetype` (keeps Extra cards, splits main/extra) + archetype persistence

**Files:**
- Modify: `packages/shared/src/types/index.ts` — `Card.archetype?: string`.
- Modify: `packages/shared/src/services/card-catalog.ts` —
  - `YgoprodeckCard` += `archetype?: string`.
  - `fetchCards` signature: widen `searchParam` union to include `"archetype" | "staple" | "type"`.
  - `upsertCard`: add `archetype` column to the insert column list, the `values (...)` placeholders, and the `on conflict ... do update set` clause; pass `card.archetype ?? null` in the run args (mind argument order).
  - Row→Card mapper (the function `findByIds` maps with): add `archetype: row.archetype ?? undefined`.
  - New method `syncByArchetype(archetype: string, opts?: { banlist?: string }): Promise<{ main: CardCatalogCard[]; extra: CardCatalogCard[] }>`.
- Test: `packages/shared/tests/services/card-catalog-archetype.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
const blueEyes = { id: 89631139, name: "Blue-Eyes White Dragon", type: "Normal Monster", frameType: "normal", archetype: "Blue-Eyes", card_images: [{ image_url: "i", image_url_small: "i" }] };
const blueEyesTwin = { id: 23995346, name: "Blue-Eyes Twin Burst Dragon", type: "Fusion Monster", frameType: "fusion", archetype: "Blue-Eyes", card_images: [{ image_url: "i", image_url_small: "i" }] };

it("splits archetype cards into main and extra, keeping extra-deck cards", async () => {
  const { catalog } = setup({ "Blue-Eyes": [blueEyes, blueEyesTwin] });
  const result = await catalog.syncByArchetype("Blue-Eyes");
  expect(result.main.map((c) => c.ygoprodeckId)).toEqual([89631139]);
  expect(result.extra.map((c) => c.ygoprodeckId)).toEqual([23995346]);
});

it("stores the archetype on cached cards", async () => {
  const { catalog } = setup({ "Blue-Eyes": [blueEyes] });
  await catalog.syncByArchetype("Blue-Eyes");
  expect(catalog.findByIds([89631139])[0].archetype).toBe("Blue-Eyes");
});

it("passes banlist to the API when provided", async () => {
  const calls: string[] = [];
  const db = new Database(":memory:"); migrate(db);
  const catalog = createCardCatalogService(db, { fetch: async (i) => { calls.push(String(i)); return { ok: true, async json() { return { data: [blueEyes] }; } } as Response; } });
  await catalog.syncByArchetype("Blue-Eyes", { banlist: "tcg" });
  expect(calls[0]).toContain("archetype=Blue-Eyes");
  expect(calls[0]).toContain("banlist=tcg");
});
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement**

`syncByArchetype` body (reuse the existing `isExtraDeckCard`, `upsertCard`, and the cached-card reader). Build the URL with `archetype` and optional `banlist`:

```ts
async syncByArchetype(archetype, opts = {}) {
  const url = new URL(YGOPRODECK_API_URL);
  url.searchParams.set("archetype", archetype);
  if (opts.banlist) url.searchParams.set("banlist", opts.banlist);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`YGOPRODeck request failed for archetype=${archetype}`);
  const payload = (await response.json()) as { data?: YgoprodeckCard[] };
  const cards = payload.data ?? [];
  for (const card of cards) upsertOne(card); // factor the upsert+map from syncDraftPool
  const ids = cards.map((c) => c.id);
  const cached = findByIds(ids); // the in-scope findByIds closure inside the service factory (no `this`)
  const extraIds = new Set(cards.filter(isExtraDeckCard).map((c) => c.id));
  return {
    main: cached.filter((c) => !extraIds.has(c.ygoprodeckId)),
    extra: cached.filter((c) => extraIds.has(c.ygoprodeckId)),
  };
}
```

> **Note for implementer:** `upsertCard` currently runs positional params inside `syncDraftPool`. Factor a small `upsertOne(card: YgoprodeckCard)` helper (maps fields → runs `upsertCard`, now including `archetype`) and reuse it from `syncDraftPool` and the new sync methods to stay DRY.

- [ ] **Step 4: Run it, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/index.ts packages/shared/src/services/card-catalog.ts packages/shared/tests/services/card-catalog-archetype.test.ts
git commit -m "feat(shared): syncByArchetype with archetype persistence and main/extra split"
```

## Task 1.5: `syncStaples` + `syncGenericExtra`

**Files:**
- Modify: `packages/shared/src/services/card-catalog.ts`
- Test: `packages/shared/tests/services/card-catalog-archetype.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it("syncStaples pulls staple cards (main pool only)", async () => {
  const pot = { id: 55144522, name: "Pot of Greed", type: "Spell Card", frameType: "spell", card_images: [{ image_url: "i", image_url_small: "i" }] };
  const db = new Database(":memory:"); migrate(db);
  const catalog = createCardCatalogService(db, { fetch: async (i) => { const u = new URL(String(i)); return { ok: true, async json() { return { data: u.searchParams.get("staple") ? [pot] : [] }; } } as Response; } });
  const staples = await catalog.syncStaples();
  expect(staples.map((c) => c.ygoprodeckId)).toContain(55144522);
});

it("syncGenericExtra returns extra-deck cards, XYZ first by default", async () => {
  const xyz = { id: 84013237, name: "Number 39: Utopia", type: "XYZ Monster", frameType: "xyz", card_images: [{ image_url: "i", image_url_small: "i" }] };
  const db = new Database(":memory:"); migrate(db);
  const catalog = createCardCatalogService(db, { fetch: async (i) => { const u = new URL(String(i)); return { ok: true, async json() { return { data: u.searchParams.get("type") === "XYZ Monster" ? [xyz] : [] }; } } as Response; } });
  const generic = await catalog.syncGenericExtra();
  expect(generic.map((c) => c.ygoprodeckId)).toContain(84013237);
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

- `syncStaples(opts?: { banlist?: string })`: URL with `staple=yes` (+ optional `banlist`); upsert; return cached cards filtered to non-extra (`!isExtraDeckCard`).
- `syncGenericExtra(opts?: { banlist?: string; types?: ("xyz"|"synchro"|"link")[] })`: default `types = ["xyz","synchro","link"]`. For each type fetch `type=XYZ Monster` / `Synchro Monster` / `Link Monster` (+ optional `banlist`), upsert, accumulate cached extra cards in type order (XYZ first). De-dupe by id. (v1 does not attempt to detect archetype-locked materials — return all of the requested types; trimming is the admin's job in the editor. Document this as a known simplification.)

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(shared): syncStaples and syncGenericExtra catalog methods"
```

## Task 1.6: `listArchetypes` (archetypes.php + cache)

**Files:**
- Modify: `packages/shared/src/services/card-catalog.ts` — add `ARCHETYPES_API_URL = "https://db.ygoprodeck.com/api/v7/archetypes.php"`, method `listArchetypes(query?: string): Promise<string[]>`.
- Test: `packages/shared/tests/services/card-catalog-archetype.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("lists archetypes from the API and caches them", async () => {
  let calls = 0;
  const db = new Database(":memory:"); migrate(db);
  const catalog = createCardCatalogService(db, { fetch: async (i) => { calls++; const u = String(i); if (u.includes("archetypes.php")) return { ok: true, async json() { return [{ archetype_name: "Blue-Eyes" }, { archetype_name: "Dark Magician" }]; } } as Response; return { ok: true, async json() { return { data: [] }; } } as Response; } });
  expect(await catalog.listArchetypes()).toEqual(["Blue-Eyes", "Dark Magician"]);
  const filtered = await catalog.listArchetypes("blue");
  expect(filtered).toEqual(["Blue-Eyes"]);
  expect(calls).toBe(1); // second call served from cache
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** — `archetypes.php` returns a JSON array of `{ archetype_name }`. On first call (or empty cache) fetch, upsert names into `archetypes` (name PK + `synced_at`), then read names from the table. `query` filters case-insensitively (`name like '%'||?||'%'`).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(shared): listArchetypes backed by archetypes.php cache"`

## Task 1.7: Theme types + `createThemesService` skeleton (createBlank/listThemes/getThemePools/addCard/removeCard/setMaxCopies)

**Files:**
- Modify: `packages/shared/src/types/index.ts` — add:

```ts
export type ThemePool = "main" | "extra";
export interface ThemeCard { catalogCardId: number; pool: ThemePool; maxCopies: number; source?: string; }
export interface ThemePools { main: ThemeCard[]; extra: ThemeCard[]; }
export interface Theme { id: number; guildId: string; name: string; archetype: string | null; banlist: string | null; createdByUserId: string; }
export interface ThemeAnalysis { ok: boolean; errors: string[]; warnings: string[]; }
```

- Create: `packages/shared/src/services/themes.ts`
- Test: `packages/shared/tests/services/themes.test.ts`

The service factory takes `(db, deps)` where `deps` carries the catalog service so it can auto-sync missing cards: `createThemesService(db, catalog: CardCatalogService)`.

- [ ] **Step 1: Failing tests**

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createThemesService } from "../../src/services/themes.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";

function setup() {
  const db = new Database(":memory:"); migrate(db);
  const catalog = createCardCatalogService(db, { fetch: async () => ({ ok: true, async json() { return { data: [] }; } }) as Response });
  const themes = createThemesService(db, catalog);
  // seed a couple of catalog cards directly
  const ins = db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?,?,?,?,?)");
  ins.run(1, "Main A", "Normal Monster", "normal", "i", "i", "[]", "t");
  ins.run(2, "Xyz B", "XYZ Monster", "xyz", "i", "i", "[]", "t");
  return { db, themes };
}

it("creates a blank theme and adds/removes cards", () => {
  const { themes } = setup();
  const theme = themes.createBlank("g", "Stun", "u");
  themes.addCard(theme.id, 1, "main");
  themes.addCard(theme.id, 2, "extra", 1);
  let pools = themes.getThemePools(theme.id);
  expect(pools.main.map((c) => c.catalogCardId)).toEqual([1]);
  expect(pools.extra).toEqual([{ catalogCardId: 2, pool: "extra", maxCopies: 1, source: undefined }]);
  themes.removeCard(theme.id, 1);
  pools = themes.getThemePools(theme.id);
  expect(pools.main).toEqual([]);
});

it("setMaxCopies updates a card's copies", () => {
  const { themes } = setup();
  const theme = themes.createBlank("g", "Stun", "u");
  themes.addCard(theme.id, 1, "main");
  themes.setMaxCopies(theme.id, 1, 2);
  expect(themes.getThemePools(theme.id).main[0].maxCopies).toBe(2);
});

it("lists themes for a guild", () => {
  const { themes } = setup();
  themes.createBlank("g", "Stun", "u");
  themes.createBlank("g", "Blue-Eyes", "u");
  expect(themes.listThemes("g").map((t) => t.name).sort()).toEqual(["Blue-Eyes", "Stun"]);
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** `createThemesService(db, catalog)` with `createBlank`, `addCard` (insert into `theme_cards`, `on conflict (theme_id, catalog_card_id) do update set pool=excluded.pool, max_copies=excluded.max_copies`), `removeCard`, `setMaxCopies`, `getThemePools` (select rows, group by pool, order by `rowid`), `listThemes`. `createBlank` writes a `themes` row with `archetype = null`, `created_at`/`updated_at` = `new Date().toISOString()`. Bump `updated_at` on every mutation.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(shared): themes service core (blank/add/remove/setMaxCopies/list/pools)"`

## Task 1.8: `createFromArchetype` with Extra top-up

**Files:**
- Modify: `packages/shared/src/services/themes.ts`
- Test: `packages/shared/tests/services/themes.test.ts`

`createFromArchetype(guildId, archetype, createdByUserId, opts?: { banlist?: string; includeStaples?: boolean; topUpExtraWithGenerics?: boolean; extraTarget?: number })` (default `topUpExtraWithGenerics: true`).

- [ ] **Step 1: Failing test** (drive the catalog with a mocked fetch returning archetype main+extra and generic XYZ)

```ts
it("seeds a theme from an archetype and tops up thin extra with generics", async () => {
  const db = new Database(":memory:"); migrate(db);
  const archMain = { id: 10, name: "BEWD", type: "Normal Monster", frameType: "normal", archetype: "Blue-Eyes", card_images: [{ image_url: "i", image_url_small: "i" }] };
  const archExtra = { id: 11, name: "BE Twin", type: "Fusion Monster", frameType: "fusion", archetype: "Blue-Eyes", card_images: [{ image_url: "i", image_url_small: "i" }] };
  const genXyz = { id: 12, name: "Utopia", type: "XYZ Monster", frameType: "xyz", card_images: [{ image_url: "i", image_url_small: "i" }] };
  const catalog = createCardCatalogService(db, { fetch: async (i) => { const u = new URL(String(i)); const a = u.searchParams.get("archetype"); const ty = u.searchParams.get("type"); const data = a === "Blue-Eyes" ? [archMain, archExtra] : ty === "XYZ Monster" ? [genXyz] : []; return { ok: true, async json() { return { data }; } } as Response; } });
  const themes = createThemesService(db, catalog);
  const theme = await themes.createFromArchetype("g", "Blue-Eyes", "u", { extraTarget: 2, topUpExtraWithGenerics: true });
  const pools = themes.getThemePools(theme.id);
  expect(pools.main.map((c) => c.catalogCardId)).toContain(10);
  expect(pools.extra.map((c) => c.catalogCardId)).toEqual(expect.arrayContaining([11, 12]));
  expect(pools.extra.find((c) => c.catalogCardId === 12)?.source).toBe("generic-extra");
  expect(theme.archetype).toBe("Blue-Eyes");
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** — `createFromArchetype` is `async`. Call `catalog.syncByArchetype(archetype, { banlist })` → `{ main, extra }`. Create theme row (`archetype` set, `banlist` stored). Insert main cards (pool `main`), extra cards (pool `extra`). If `includeStaples`, `catalog.syncStaples({ banlist })` → add to main. If `topUpExtraWithGenerics` and `extra.length < extraTarget`, `catalog.syncGenericExtra({ banlist })`, add cards not already present until reaching `extraTarget`, tagged `source = "generic-extra"`. Return the `Theme`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(shared): createFromArchetype with generic extra top-up"`

## Task 1.9: `importPasscodes` + `seedArchetypeInto`

**Files:**
- Modify: `packages/shared/src/services/themes.ts`
- Test: `packages/shared/tests/services/themes.test.ts`

`importPasscodes(themeId, codes: number[], opts?: { pool?: ThemePool }): Promise<{ added: number; unknown: number[] }>` — for each id: ensure it exists in `card_catalog` (if missing, `catalog.syncCardById` — add this thin method to catalog if absent, or reuse `fetchCards("id", ...)`); route to `extra` if `isExtraDeckCard`-equivalent (use the catalog card's frame type) unless `opts.pool` forces one; `addCard`. Repeats collapse via the PK (importing 3 copies of one id ⇒ 1 row; multiplicity is `max_copies`, not row count — so importing the same id N times sets `max_copies = min(N, 3)` capped). Unknown ids that fail to sync are returned in `unknown`.

`seedArchetypeInto(themeId, archetype, opts?)` — additive `syncByArchetype` then `addCard` for each, skipping ids already present.

- [ ] **Step 1: Failing tests**

```ts
it("imports passcodes, routing extra-deck cards to the extra pool", async () => {
  const db = new Database(":memory:"); migrate(db);
  const ins = db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?,?,?,?,?)");
  ins.run(1, "Main A", "Normal Monster", "normal", "i", "i", "[]", "t");
  ins.run(2, "Xyz B", "XYZ Monster", "xyz", "i", "i", "[]", "t");
  const catalog = createCardCatalogService(db, { fetch: async () => ({ ok: true, async json() { return { data: [] }; } }) as Response });
  const themes = createThemesService(db, catalog);
  const theme = themes.createBlank("g", "Custom", "u");
  const res = await themes.importPasscodes(theme.id, [1, 2]);
  expect(res.added).toBe(2);
  const pools = themes.getThemePools(theme.id);
  expect(pools.main.map((c) => c.catalogCardId)).toEqual([1]);
  expect(pools.extra.map((c) => c.catalogCardId)).toEqual([2]);
});

it("collapses repeated passcodes into max_copies (capped at 3)", async () => {
  const db = new Database(":memory:"); migrate(db);
  db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (1,'Main A','Normal Monster','normal','i','i','[]','t')").run();
  const catalog = createCardCatalogService(db, { fetch: async () => ({ ok: true, async json() { return { data: [] }; } }) as Response });
  const themes = createThemesService(db, catalog);
  const theme = themes.createBlank("g", "Custom", "u");
  await themes.importPasscodes(theme.id, [1, 1, 1, 1]);
  expect(themes.getThemePools(theme.id).main[0].maxCopies).toBe(3);
});
```

- [ ] **Step 2-4: Run FAIL → implement → PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(shared): theme importPasscodes and seedArchetypeInto"`

## Task 1.10: `analyzeTheme` validation

**Files:**
- Modify: `packages/shared/src/services/themes.ts`
- Test: `packages/shared/tests/services/themes.test.ts`

`analyzeTheme(themeId, config: { themePackSize: number; cardsPerPlayer: number; extraDeckSize: number; burnUnpicked: boolean; extraDeckEnabled: boolean }): ThemeAnalysis`.

Required pool sizes (counting `max_copies` as the pool size of each pool):
- `burnUnpicked` → main needs `cardsPerPlayer * themePackSize`; extra needs `extraDeckSize * themePackSize`.
- `!burnUnpicked` → main needs `cardsPerPlayer + (themePackSize - 1)`; extra needs `extraDeckSize + (themePackSize - 1)`.

Severity: main short ⇒ **error**; extra short ⇒ **warning** (only when `extraDeckEnabled`); extra checks skipped entirely when `!extraDeckEnabled`.

- [ ] **Step 1: Failing tests** (build a theme with N main copies, assert error/ok across burn + extra toggles)

```ts
function poolSize(themes, id, pool) { return themes.getThemePools(id)[pool].reduce((s, c) => s + c.maxCopies, 0); }

it("flags a main-short theme as an error (burn off)", () => {
  const { themes } = setup(); // helper that seeds catalog + a themes service
  const t = themes.createBlank("g", "Tiny", "u");
  themes.addCard(t.id, 1, "main", 3); // 3 main copies
  const a = themes.analyzeTheme(t.id, { themePackSize: 3, cardsPerPlayer: 40, extraDeckSize: 15, burnUnpicked: false, extraDeckEnabled: false });
  expect(a.ok).toBe(false);
  expect(a.errors[0]).toMatch(/main/i);
});

it("passes a main-sufficient theme and skips extra when extra disabled", () => {
  const { themes, db } = setup();
  const t = themes.createBlank("g", "Big", "u");
  // seed 42 distinct main catalog cards
  const ins = db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?,?,?,?,?)");
  for (let i = 100; i < 142; i++) { ins.run(i, `C${i}`, "Normal Monster", "normal", "i", "i", "[]", "t"); themes.addCard(t.id, i, "main", 1); }
  const a = themes.analyzeTheme(t.id, { themePackSize: 3, cardsPerPlayer: 40, extraDeckSize: 15, burnUnpicked: false, extraDeckEnabled: false });
  expect(a.ok).toBe(true);
});

it("warns (not errors) on a thin extra pool when extra enabled", () => {
  const { themes, db } = setup();
  const t = themes.createBlank("g", "Big", "u");
  const ins = db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?,?,?,?,?)");
  for (let i = 100; i < 142; i++) { ins.run(i, `C${i}`, "Normal Monster", "normal", "i", "i", "[]", "t"); themes.addCard(t.id, i, "main", 1); }
  const a = themes.analyzeTheme(t.id, { themePackSize: 3, cardsPerPlayer: 40, extraDeckSize: 15, burnUnpicked: false, extraDeckEnabled: true });
  expect(a.ok).toBe(true);          // warnings don't fail ok
  expect(a.warnings.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2-4: FAIL → implement → PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(shared): analyzeTheme pool validation"`

## Task 1.11: Theme HTTP routes (web)

**Files:**
- Create: `packages/web/app/api/themes/route.ts`, `packages/web/app/api/themes/[id]/route.ts`, `packages/web/app/api/themes/[id]/cards/route.ts`, `packages/web/app/api/archetypes/route.ts`
- Test: `packages/web/tests/themes-routes.test.ts`

Each route follows the existing pattern: `auth()` for session/guild, `getDb()` (`@/lib/...`), build the catalog + themes services, return JSON. Mirror `app/api/draft-templates/route.ts` for shape and error handling.

Endpoints:
- `GET /api/themes` → `{ themes: Theme[] }` (with `main`/`extra` counts).
- `POST /api/themes` body `{ kind: "blank", name } | { kind: "archetype", name?, archetype, banlist?, includeStaples?, extraTarget? }` → `{ theme }` 201.
- `GET /api/themes/[id]` → `{ theme, pools: ThemePools, cards: CardSummary[] }` (resolve catalog details for the grid).
- `PUT /api/themes/[id]` body `{ name }` → rename.
- `DELETE /api/themes/[id]`.
- `POST /api/themes/[id]/cards` body one of `{ op: "add", catalogCardId, pool, maxCopies? } | { op: "remove", catalogCardId } | { op: "setMaxCopies", catalogCardId, maxCopies } | { op: "import", codes: number[], pool? } | { op: "seedArchetype", archetype, banlist? }` → updated `{ pools, cards }`.
- `GET /api/archetypes?query=` → `{ archetypes: string[] }`.

- [ ] **Step 1: Failing test** (one representative — create blank theme then import passcodes via the route)

```ts
// temp-file db + auth mock per packages/web/tests/drafts-create-route.test.ts
it("creates a blank theme then imports passcodes routed to main/extra", async () => {
  // ...setup temp db, seed two card_catalog rows (one normal id=1, one xyz id=2)...
  const { POST: createTheme } = await import("../app/api/themes/route");
  const created = await createTheme(new Request("http://x/api/themes", { method: "POST", body: JSON.stringify({ kind: "blank", name: "Custom" }) }) as any);
  const { theme } = await created.json();
  const { POST: mutate } = await import("../app/api/themes/[id]/cards/route");
  const res = await mutate(new Request("http://x", { method: "POST", body: JSON.stringify({ op: "import", codes: [1, 2] }) }) as any, { params: Promise.resolve({ id: String(theme.id) }) });
  const body = await res.json();
  expect(body.pools.main.map((c: any) => c.catalogCardId)).toEqual([1]);
  expect(body.pools.extra.map((c: any) => c.catalogCardId)).toEqual([2]);
});
```

- [ ] **Step 2-4: FAIL → implement all four route files → PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(web): theme + archetype API routes"`

## Task 1.12: Theme editor UI (reuses cube-editor primitives)

**Files:**
- Create: `packages/web/src/components/themes/theme-editor.tsx`, `packages/web/app/(app)/themes/page.tsx`, `packages/web/app/(app)/themes/[id]/page.tsx`, `packages/web/src/lib/theme-pools.ts`
- (Optional refactor) Extract import/upload/fuzzy-add logic from `card-pool-editor.tsx` into a reusable hook so both editors share it.
- Test: `packages/web/tests/theme-editor.test.tsx` (jsdom; `// @vitest-environment jsdom`; use `installVirtualizerJsdomEnv` if the grid virtualizes)

The editor reuses: `parseCustomCardIds` (`@/lib/custom-card-pool`), `CardPoolGrid`, `CardHoverPopup`, `getCached`/`putCards` (`@/lib/cards-cache`), the `/api/cards/resolve` fuzzy flow. Theme-specific additions: two grids (main/extra), each card has a `max_copies` stepper, a "Seed/Bulk-add archetype" control (`POST .../cards { op:"seedArchetype" }`), and import routing to main/extra (server decides via `op:"import"`). Save = the per-op POSTs (no single bulk PUT needed — mutations persist immediately, mirroring how the cube editor saves a whole pool but here we persist incrementally; if you prefer a single save, batch ops and POST on save).

- [ ] **Step 1: Failing component test** — render editor in `create`-equivalent mode with a stubbed fetch; type a passcode list into the import textarea, submit, assert the main/extra grids show the expected cards (mock `/api/themes/[id]/cards` to echo pools). Keep it focused on the import → grid wiring.

- [ ] **Step 2-4: FAIL → implement → PASS**

- [ ] **Step 5: Typecheck + Commit**

```bash
npm run typecheck
git commit -am "feat(web): theme editor reusing cube-editor primitives"
```

## Task 1.13: Phase 1 wrap — full suite + typecheck

- [ ] Run `npm test --workspace=packages/shared` and `npm test --workspace=packages/web` — all green.
- [ ] Run `npm run typecheck` — clean.
- [ ] Commit any lint fixups. Phase 1 delivers working, tested theme authoring.

---

# Phase 2 — Engine

Adds the `theme` draft mode to the engine. After Phase 2 a theme draft can be created, started, drafted (via the service layer) to completion, validated by integration tests with simulated picks. Booster mode stays byte-for-byte unchanged.

## Task 2.1: `DraftConfig` additions + normalize/defaults

**Files:**
- Modify: `packages/shared/src/types/index.ts` (`DraftConfig`)
- Modify: `packages/shared/src/services/drafts.ts` (`defaultDraftConfig` ~lines 84-91, `normalizeDraftConfig` ~lines 93-103)
- Test: `packages/shared/tests/services/drafts.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("normalizes theme-mode defaults", () => {
  const app = setup();
  const yugi = insertPlayer(app.db, "g", "u", "Yugi");
  const draft = app.drafts.create("g", "c", "theme night", { mode: "theme", allowedThemeIds: [1, 2] }, "u", yugi.id);
  expect(draft.config.themePackSize).toBe(3);
  expect(draft.config.extraDeckEnabled).toBe(true);
  expect(draft.config.extraDeckSize).toBe(15);
  expect(draft.config.burnUnpicked).toBe(false);
  expect(draft.config.themeSelection).toBe("player_pick");
  expect(draft.config.uniqueThemes).toBe(true);
});

it("leaves booster config untouched (no theme keys leak in)", () => {
  const app = setup();
  const yugi = insertPlayer(app.db, "g", "u", "Yugi");
  const draft = app.drafts.create("g", "c", "cube night", { setNames: ["X"] }, "u", yugi.id);
  expect(draft.config.themePackSize).toBeUndefined();
  expect(draft.config.mode).toBeUndefined();
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

`DraftConfig` additions (verbatim from spec):

```ts
  mode?: "booster" | "theme";
  allowedThemeIds?: number[];
  themeSelection?: "host_assigned" | "random" | "player_pick";
  themeAssignments?: Record<string, number>;
  uniqueThemes?: boolean;
  themePackSize?: number;
  extraDeckEnabled?: boolean;
  extraDeckSize?: number;
  burnUnpicked?: boolean;
```

In `normalizeDraftConfig`, only apply theme defaults when `config.mode === "theme"` (so booster output is unchanged — the second test guards this):

```ts
function normalizeDraftConfig(config: DraftConfig): DraftConfig {
  const base = {
    ...config,
    packSize: config.packSize ?? defaultDraftConfig.packSize,
    packsPerPlayer: config.packsPerPlayer ?? defaultDraftConfig.packsPerPlayer,
    cardsPerPlayer: config.cardsPerPlayer ?? defaultDraftConfig.cardsPerPlayer,
    pickSeconds: config.pickSeconds ?? defaultDraftConfig.pickSeconds,
    alternatePassDirection: config.alternatePassDirection ?? defaultDraftConfig.alternatePassDirection,
    randomizeSeats: config.randomizeSeats ?? defaultDraftConfig.randomizeSeats,
  };
  if (config.mode !== "theme") return base;
  return {
    ...base,
    mode: "theme",
    themePackSize: config.themePackSize ?? 3,
    extraDeckEnabled: config.extraDeckEnabled ?? true,
    extraDeckSize: config.extraDeckSize ?? 15,
    burnUnpicked: config.burnUnpicked ?? false,
    themeSelection: config.themeSelection ?? "player_pick",
    uniqueThemes: config.uniqueThemes ?? true,
  };
}
```

Add a module-level helper used by later tasks:

```ts
export function totalThemeRounds(config: DraftConfig): number {
  const main = config.cardsPerPlayer ?? defaultDraftConfig.cardsPerPlayer;
  const extra = config.extraDeckEnabled ?? true ? (config.extraDeckSize ?? 15) : 0;
  return main + extra;
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(shared): DraftConfig theme fields + normalization"`

## Task 2.2: `openThemeRound` (per-player pack dealing)

**Files:**
- Modify: `packages/shared/src/services/drafts.ts` — add internal `openThemeRound(draftId, roundNumber)` (sibling to `openWave`). **Add `seededShuffle` to the existing `cube.ts` import** — the file currently imports only `{ analyzeCube, buildDeal }`; `seededShuffle` is exported there (verified) but not yet imported here.
- Test: `packages/shared/tests/services/drafts-theme.test.ts` (new)

Design (verbatim intent):
- Derived phase: `phase = roundNumber <= cardsPerPlayer ? "main" : "extra"`.
- For each active (joined, non-cancelled) player with seat `s` and assigned theme `T` (from `draft_player_theme`):
  - Build the **available multiset**: for each `theme_cards` row in pool `phase`, push `catalog_card_id` `max_copies` times.
  - Subtract consumed copies:
    - If `burnUnpicked`: subtract every `catalog_card_id` that appeared in **any prior pack** of this player (via `draft_cards.draft_pack_id ∈ player's packs`), one instance per occurrence.
    - Else: subtract only `catalog_card_id`s this player **picked** (via `draft_picks → draft_cards`), one per pick.
  - `seededShuffle(available, seed)` with `seed = hashSeed(draftId, playerId, roundNumber)`.
  - Take first `themePackSize` (or fewer if pool is thin — graceful). **If zero cards remain, create NO pack for this player this round** and set the player's `draft_players.finished_at` (if not already set) so they are excluded from the round-advance gate (Task 2.5) and `currentPackOptions` returns `[]` for them. They simply end with a shorter deck — this is the thin-Extra warning path.
  - Insert one `draft_packs` row (`origin_seat_index = current_holder_seat_index = s`, `pass_direction = 1`, `wave_number = roundNumber`), then up-to-`themePackSize` `draft_cards` (`wave_number = roundNumber`, `draft_pack_id`, `catalog_card_id`, `position = index`).

`hashSeed`: `((draftId * 73856093) ^ (playerId * 19349663) ^ (roundNumber * 83492791)) >>> 0`.

> **Why marking finished matters (round-advance correctness):** the Task 2.5 advance gate is "all players who were *dealt a pack this round* have picked." A pool-exhausted player gets no pack and can never record a pick — if the gate counted them as merely "not yet picked," the round (and the whole draft) would deadlock. Excluding no-pack players from the gate (the plan counts *packs dealt*, not *all active players*) avoids this; setting `finished_at` is the tidy belt-and-suspenders that also short-circuits `currentPackOptions`. `expireCurrentPickStep` already tolerates this (a no-options player is skipped), so the bot/timeout path is safe by construction.

- [ ] **Step 1: Failing test** — seed a draft directly: insert 2 players, assign each a theme with ≥ `themePackSize` main cards, set `current_wave_number=1`, call `openThemeRound(draftId, 1)`, assert each player's `currentPackOptions` returns exactly `themePackSize` cards drawn from *their* theme only, and that two runs with the same seed produce identical packs.

```ts
it("deals each player a private themePackSize pack from their own theme", () => {
  const { db, drafts } = setupThemeDraft({ themePackSize: 3, themes: { a: [1,2,3,4,5], b: [6,7,8,9,10] } });
  // setupThemeDraft starts the draft (Task 2.4) OR call the exported openThemeRound test seam
  const p1Options = drafts.currentPackOptions(draftId, player1Id).map((c) => c.catalogCardId);
  expect(p1Options).toHaveLength(3);
  expect(p1Options.every((id) => [1,2,3,4,5].includes(id))).toBe(true);
});
```

> **Test seam:** export `openThemeRound` (or expose it on the service for tests), so this task is testable before `start` is wired. Keep it internal+exported-for-test, or test it through `start` in Task 2.4 and make this task's test minimal.

- [ ] **Step 2-4: FAIL → implement → PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(shared): openThemeRound per-player pack dealing"`

## Task 2.3: `totalRounds`-aware finish gate & `currentPackOptions`

**Files:**
- Modify: `packages/shared/src/services/drafts.ts` — three spots that hardcode `cardsPerPlayer`:
  1. `pickCard` finish gate (~lines 529-532).
  2. `pickCard` `draft_players` `finished_at` update (the `pick_count + 1 >= ?` bind, ~lines 588-595).
  3. `currentPackOptionsInternal` early return (~lines 765-767).

  In theme mode use `totalThemeRounds(draft.config)` instead of `cardsPerPlayer`. Compute `const perPlayerTotal = draft.config.mode === "theme" ? totalThemeRounds(draft.config) : (draft.config.cardsPerPlayer ?? defaultDraftConfig.cardsPerPlayer);` and use it in those comparisons.
- Test: covered by Task 2.5 integration (Extra picks must not be rejected). Add a focused unit test if convenient.

> **Which of the three is load-bearing:** once Task 2.5 adds the early `if (draft.config.mode === "theme") return pickThemeCard(...)` at the top of `pickCard`, spots **#1** (finish gate) and **#2** (`finished_at` bind) are unreachable in theme mode (the booster body never runs) — making them theme-aware is *defensive only* and harmless for booster (`perPlayerTotal` collapses to `cardsPerPlayer` when `mode !== "theme"`). Spot **#3** (`currentPackOptionsInternal` early return) is on the shared path and is **mandatory**: without it, once a theme player's `pick_count` reaches 40 the options query returns `[]` for the entire Extra phase, so no human or bot can pick an Extra card and the draft stalls. Do #3 for certain; do #1/#2 as defensive consistency.

- [ ] **Step 1-5:** This is a refactor enabling later tasks; verify via Task 2.5's full-draft integration test (an Extra-phase pick that would be rejected under the old `>= 40` gate). Commit with Task 2.4 or standalone: `git commit -am "feat(shared): theme-aware per-player total in finish gate and options"`

## Task 2.4: Theme branch in `start` + assignment

**Files:**
- Modify: `packages/shared/src/services/drafts.ts` — `startDraft` transaction (~lines 435-513): branch `if (draft.config.mode === "theme") return startThemeDraft(draftId, now);`. Add `startThemeDraft`.
- Test: `packages/shared/tests/services/drafts-theme.test.ts`

`startThemeDraft`:
- Load player ids (same query as booster). Require ≥ 2 (reuse the existing check).
- Assign seats (reuse the `assignSeat` loop).
- **Resolve theme assignments** by `themeSelection`:
  - `host_assigned`: read `config.themeAssignments` (playerId→themeId); throw if any player unmapped. Write `draft_player_theme` rows.
  - `player_pick`: read existing `draft_player_theme` rows (written during lobby); for any unassigned player assign via distinct-spread random over `allowedThemeIds` (covers bots). 
  - `random`: distinct-spread random over `allowedThemeIds` for all players.
  - Distinct-spread: `seededShuffle(allowedThemeIds, draftId)` then assign round-robin; if `uniqueThemes` and `allowedThemeIds.length < playerCount` → throw (hard error).
- **Preflight:** for each assigned theme, `themes.analyzeTheme(themeId, config)`; if any `errors`, throw `new Error(errors.join(" "))` (mirrors booster `analyzeCube` gate). (Warnings are surfaced by the web layer pre-start — see Task 3.4; engine only blocks on errors.)
- Do **not** populate `draft_deal` (so `openWave`'s cube branch never fires for theme drafts).
- `openThemeRound(draftId, 1)`.
- Update `drafts` row: `status='active', started_at, current_wave_number=1, current_pick_step=1, pick_deadline_at`.

> **Dependency:** `startThemeDraft` needs the themes service. Construct it inside `createDraftService` (the factory already has `db`; build `const themes = createThemesService(db, createCardCatalogService(db))` lazily, or accept it as an optional dep). Prefer constructing lazily inside the theme branch to avoid changing the booster constructor signature.

- [ ] **Step 1: Failing test**

```ts
it("starts a theme draft, assigns distinct themes, and opens round 1", () => {
  const { db, drafts, themeA, themeB, p1, p2, draftId } = makeThemeDraft({ themeSelection: "random", allowedThemeIds: [themeA, themeB] });
  const started = drafts.start(draftId);
  expect(started.status).toBe("active");
  expect(started.currentPackRound).toBe(1);
  const assigned = db.prepare("select player_id, theme_id from draft_player_theme where draft_id=?").all(draftId);
  expect(new Set(assigned.map((r: any) => r.theme_id)).size).toBe(2); // distinct
  expect(drafts.currentPackOptions(draftId, p1)).toHaveLength(3);
});

it("blocks start when uniqueThemes and not enough themes for players", () => {
  const { drafts, draftId } = makeThemeDraft({ themeSelection: "random", allowedThemeIds: [themeA], players: 2, uniqueThemes: true });
  expect(() => drafts.start(draftId)).toThrow();
});
```

- [ ] **Step 2-4: FAIL → implement → PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(shared): start theme drafts with assignment + preflight"`

## Task 2.5: Theme branch in `pickCard` (round advancement + completion)

**Files:**
- Modify: `packages/shared/src/services/drafts.ts` — at the top of the `pickCard` transaction, after `findById`+asserts, `if (draft.config.mode === "theme") return pickThemeCard(draftId, playerId, draftCardId, pickMethod, now);`. Add `pickThemeCard`.
- Test: `packages/shared/tests/services/drafts-theme.test.ts`

`pickThemeCard` (does NOT run booster pass-the-pack logic):
- Validate: player not finished (`pick_count >= totalThemeRounds`), hasn't already picked this round (`hasPickedCurrentStep(draftId, playerId, currentPackRound, 1)`), the card is in the player's current pack (`draft_cards.draft_pack_id` = the player's pack for `current_wave_number`/seat), unpicked.
- Mark `draft_cards.picked_by_player_id`, insert `draft_picks` (`wave_number = current_wave_number`, `pick_step = 1`, `pick_method`), increment `draft_players.pick_count`, set `finished_at` when `pick_count+1 >= totalThemeRounds`.
- **Round advance (gate on packs dealt, NOT all active players):** let `dealt` = players who have a `draft_packs` row for `(draft_id, current_wave_number)`, and `picked` = players who have a `draft_picks` row for `(draft_id, current_wave_number)`. Advance when **every player in `dealt` is also in `picked`** (i.e. no pack dealt this round is still unpicked). Players who got no pack this round (pool exhausted; marked `finished_at` in `openThemeRound`) are *not* in `dealt`, so they never block advancement.
  - If `current_wave_number >= totalThemeRounds` → `update drafts set status='completed', ended_at=?`.
  - Else → `openThemeRound(draftId, current_wave_number + 1)` and `update drafts set current_wave_number = current_wave_number + 1, current_pick_step = 1, pick_deadline_at = ?`.
  - **Edge case (must LOOP, not single-step):** if a round opens where *no* player gets a pack (every assigned theme's current-phase pool is exhausted — only reachable in the Extra phase after warnings), there is nothing to pick, so nothing will ever call `pickThemeCard` to re-trigger advancement. Have `openThemeRound` **return the number of packs dealt**, and after opening a round (in both `startThemeDraft` and the advance branch of `pickThemeCard`) run an **advance-on-empty loop**: while the just-opened round dealt 0 packs, `if (current_wave_number >= totalThemeRounds) complete; else openThemeRound(++current_wave_number)`. This guarantees termination even if every Extra round 41..55 opens empty (all themes thin-Extra). Cover with the second thin-Extra test below.
- (Burn requires no extra writes — unpicked cards stay `picked_by_player_id IS NULL` and `openThemeRound` excludes prior-pack cards when `burnUnpicked`.)

- [ ] **Step 1: Failing integration tests**

```ts
it("runs a full main-only theme draft to completion with simulated picks (2 players)", () => {
  const { drafts, draftId, p1, p2 } = makeThemeDraft({ extraDeckEnabled: false, cardsPerPlayer: 40, themePackSize: 3, allowedThemeIds: [themeA, themeB] /* each themed pool large enough */ });
  drafts.start(draftId);
  for (let round = 1; round <= 40; round++) {
    for (const pid of [p1, p2]) {
      const opt = drafts.currentPackOptions(draftId, pid)[0];
      drafts.pickCard(draftId, pid, opt.id, "manual");
    }
  }
  expect(drafts.findById(draftId).status).toBe("completed");
  expect(drafts.pool(draftId, p1)).toHaveLength(40);
});

it("runs a main + extra theme draft (does not reject extra picks)", () => {
  const { drafts, draftId, p1, p2 } = makeThemeDraft({ extraDeckEnabled: true, cardsPerPlayer: 40, extraDeckSize: 15, themePackSize: 3, allowedThemeIds: [themeA, themeB] });
  drafts.start(draftId);
  for (let round = 1; round <= 55; round++) for (const pid of [p1, p2]) { const o = drafts.currentPackOptions(draftId, pid)[0]; drafts.pickCard(draftId, pid, o.id, "manual"); }
  expect(drafts.findById(draftId).status).toBe("completed");
  expect(drafts.pool(draftId, p1)).toHaveLength(55);
});

it("respects themePackSize != 3", () => {
  const { drafts, draftId, p1 } = makeThemeDraft({ themePackSize: 5, extraDeckEnabled: false, allowedThemeIds: [themeA, themeB] });
  drafts.start(draftId);
  expect(drafts.currentPackOptions(draftId, p1)).toHaveLength(5);
});

it("returns unpicked cards to the pool when burnUnpicked is false", () => {
  // small theme pool (e.g. 41 main copies); with burn off a 40-card draft must still complete
  const { drafts, draftId, p1, p2 } = makeThemeDraft({ burnUnpicked: false, cardsPerPlayer: 40, extraDeckEnabled: false, themePackSize: 3, smallPools: true });
  drafts.start(draftId);
  for (let r = 1; r <= 40; r++) for (const pid of [p1, p2]) { const o = drafts.currentPackOptions(draftId, pid)[0]; drafts.pickCard(draftId, pid, o.id, "manual"); }
  expect(drafts.findById(draftId).status).toBe("completed");
});

it("completes a draft even when a player's Extra pool runs dry mid-phase (thin-Extra warning path)", () => {
  // p1 has a full extra pool; p2's extra pool has only 2 cards (fewer than extraDeckSize=15).
  // With burn off, p2 exhausts its extra pool after ~2 extra rounds, gets no pack, is marked finished,
  // and must NOT block the remaining extra rounds for p1 nor block completion.
  const { drafts, draftId, p1, p2 } = makeThemeDraft({
    extraDeckEnabled: true, cardsPerPlayer: 40, extraDeckSize: 15, themePackSize: 3, burnUnpicked: false,
    allowedThemeIds: [themeFullExtra, themeThinExtra],
    themeSelection: "host_assigned", assign: { p1: themeFullExtra, p2: themeThinExtra },
  });
  drafts.start(draftId);
  // drive every round; pick the first available option for whoever still has a pack
  for (let r = 1; r <= 55 && drafts.findById(draftId).status === "active"; r++) {
    for (const pid of [p1, p2]) {
      const opts = drafts.currentPackOptions(draftId, pid);
      if (opts.length > 0) drafts.pickCard(draftId, pid, opts[0].id, "manual");
    }
  }
  expect(drafts.findById(draftId).status).toBe("completed");
  expect(drafts.pool(draftId, p1)).toHaveLength(55);              // full main + extra
  expect(drafts.pool(draftId, p2).length).toBeLessThan(55);        // ended short on extra, no error
  expect(drafts.pool(draftId, p2).length).toBeGreaterThanOrEqual(42); // 40 main + the 2 extra it had
});

it("completes when ALL themes are thin-Extra so several extra rounds open with zero packs (advance-on-empty loop)", () => {
  // Both players' extra pools are tiny (e.g. 1 card each). After ~1 extra round every theme's extra
  // pool is exhausted, so rounds open with 0 packs dealt. The advance-on-empty loop must still drive
  // current_wave_number to totalRounds and complete — not hang.
  const { drafts, draftId, p1, p2 } = makeThemeDraft({
    extraDeckEnabled: true, cardsPerPlayer: 40, extraDeckSize: 15, themePackSize: 3, burnUnpicked: false,
    allowedThemeIds: [themeThinExtra, themeThinExtra2],
    themeSelection: "host_assigned", assign: { p1: themeThinExtra, p2: themeThinExtra2 },
  });
  drafts.start(draftId);
  for (let r = 1; r <= 55 && drafts.findById(draftId).status === "active"; r++) {
    for (const pid of [p1, p2]) {
      const opts = drafts.currentPackOptions(draftId, pid);
      if (opts.length > 0) drafts.pickCard(draftId, pid, opts[0].id, "manual");
    }
  }
  expect(drafts.findById(draftId).status).toBe("completed"); // did not deadlock on empty extra rounds
});
```

- [ ] **Step 2-4: FAIL → implement → PASS** (this is the core engine task; expect iteration)

- [ ] **Step 5: Commit** `git commit -am "feat(shared): theme pickCard with round advancement and completion"`

## Task 2.6: Bot auto-pick parity (expire path)

**Files:**
- Test only: `packages/shared/tests/services/drafts-theme.test.ts` — verify `expireCurrentPickStep` auto-picks for all pending theme players (no code change expected, since it calls `currentPackOptions` + `pickCard`, both now theme-aware).

- [ ] **Step 1: Failing/regression test**

```ts
it("expireCurrentPickStep auto-picks pending players in theme mode", () => {
  const { drafts, draftId } = makeThemeDraft({ pickSeconds: 1, allowedThemeIds: [themeA, themeB] });
  drafts.start(draftId);
  const past = new Date(Date.now() + 5000);
  const { autoPickedPlayerIds } = drafts.expireCurrentPickStep(draftId, past);
  expect(autoPickedPlayerIds.length).toBe(2);
  expect(drafts.findById(draftId).currentPackRound).toBe(2); // advanced after all auto-picked
});
```

- [ ] **Step 2-4:** If green immediately, great (confirms reuse). If not, fix the theme path. 

- [ ] **Step 5: Commit** `git commit -am "test(shared): theme bot auto-pick via expireCurrentPickStep"`

## Task 2.7: Phase 2 wrap

- [ ] `npm test --workspace=packages/shared` green; `npm run typecheck` clean.
- [ ] **Verify booster regression:** the entire existing `drafts.test.ts` still passes unchanged.
- [ ] Commit fixups.

---

# Phase 3 — UI & Assignment

Wires theme mode through the web: draft-type chooser (Cube vs Theme), theme create form, lobby theme selection (3 modes) + preview, start preflight (block on error, warn-to-reroll on thin extra), phase indicator, decklist with Extra section. After Phase 3 a host can run a full theme draft end-to-end in the browser, including the solo bot run.

## Task 3.1a: Draft-type chooser (+ move cube form to its own route)

The **+ New Draft** button on the Drafts page currently links to `/drafts/new`, which renders the cube `CreateDraftForm` directly (`packages/web/app/(app)/drafts/new/page.tsx` → `<CreateDraftForm />`). Insert a chooser step so the user first picks **Cube Draft** or **Theme Draft**, then lands on the matching create flow. The cube experience must stay byte-for-byte the same — only its route moves.

**Files:**
- Create: `packages/web/app/(app)/drafts/new/cube/page.tsx` — moves the current `<CreateDraftForm />` page body here verbatim (heading "Create New Draft" + `<CreateDraftForm />`).
- Modify: `packages/web/app/(app)/drafts/new/page.tsx` — replace the cube form with a **chooser**: two cards/links, "Cube Draft" → `/drafts/new/cube`, "Theme Draft" → `/drafts/new/theme`, each with a one-line description. Match the existing dark-mode card styling (see the draft cards in `packages/web/app/(app)/drafts/page.tsx`). The Drafts-page **+ New Draft** link target (`/drafts/new`) is unchanged — it now lands on the chooser.
- Test: `packages/web/tests/drafts-new-chooser.test.tsx` (jsdom) — render the chooser, assert it shows both options and that the links point at `/drafts/new/cube` and `/drafts/new/theme`.

- [ ] **Step 1: Failing component test**

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import NewDraftPage from "../app/(app)/drafts/new/page";

it("offers a cube and a theme draft option", () => {
  render(<NewDraftPage />);
  expect(screen.getByRole("link", { name: /cube draft/i })).toHaveAttribute("href", "/drafts/new/cube");
  expect(screen.getByRole("link", { name: /theme draft/i })).toHaveAttribute("href", "/drafts/new/theme");
});
```

- [ ] **Step 2: Run, expect FAIL** (chooser not built; current page renders the form)

- [ ] **Step 3: Implement** — move the form into `drafts/new/cube/page.tsx`; make `drafts/new/page.tsx` the chooser with two `next/link` cards. (`/drafts/new/theme` is built in Task 3.1b; the link can exist before the page does.)

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(web): draft-type chooser at /drafts/new; cube form -> /drafts/new/cube"`

## Task 3.1b: Theme create form + route + config passthrough

**Files:**
- Create: `packages/web/app/(app)/drafts/new/theme/page.tsx` — renders the new theme form.
- Create: `packages/web/src/components/draft/create-theme-draft-form.tsx` — the theme create form (sibling to `create-draft-form.tsx`; reuse its name/channel fields and POST plumbing).
- Modify: `packages/web/app/api/drafts/route.ts` (POST create) — accept & passthrough theme config (it already stores `config` JSON; ensure theme keys survive `normalizeDraftConfig` — Task 2.1 already guarantees this since `mode:"theme"` triggers the theme defaults branch).
- Test: `packages/web/tests/drafts-create-theme-route.test.ts`

The theme form shows: theme multi-select (`allowedThemeIds`, fed by `GET /api/themes`), `themePackSize`, main-deck size (`cardsPerPlayer`), Extra toggle (`extraDeckEnabled`) + `extraDeckSize` (shown when on), `burnUnpicked`, `themeSelection`, `uniqueThemes`, `pickSeconds`. It builds a theme `DraftConfig` (with `mode: "theme"`) and POSTs to `/api/drafts`, then redirects to the new draft's lobby like the cube form does.

- [ ] **Step 1: Failing route test** — POST `/api/drafts` with a theme config; assert `config_json` round-trips `mode:"theme"`, `allowedThemeIds`, `themePackSize`.

```ts
it("creates a theme draft and persists theme config", async () => {
  // temp db + auth mock; seed two themes rows
  const { POST } = await import("../app/api/drafts/route");
  const res = await POST(new Request("http://x/api/drafts", { method: "POST", body: JSON.stringify({ name: "Theme Night", config: { mode: "theme", allowedThemeIds: [1, 2], themePackSize: 4, extraDeckEnabled: false } }) }) as any);
  expect(res.status).toBe(201);
  // verify config_json round-trips mode:"theme" + allowedThemeIds + themePackSize (defaults applied)
});
```

- [ ] **Step 2-4: FAIL → implement theme form + theme page + route passthrough → PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(web): theme create form at /drafts/new/theme + config passthrough"`

## Task 3.2: Lobby theme selection + claim endpoint

**Files:**
- Create: `packages/web/app/api/drafts/[slug]/claim-theme/route.ts` — `POST { themeId }` writes `draft_player_theme` for the current player (only `player_pick`, only while pending, enforce uniqueness when `uniqueThemes`).
- Modify: the lobby UI (the pending-draft view in `packages/web/app/(app)/draft/[slug]/page.tsx` or its lobby component) — render the 3 selection modes; for `player_pick` show claim buttons (greying claimed themes when `uniqueThemes`); for `host_assigned` show host assignment controls writing `config.themeAssignments` via the draft `PUT`; for `random` hide until start.
- Test: `packages/web/tests/drafts-claim-theme-route.test.ts`

- [ ] **Step 1: Failing test** — claim a theme, assert row written; second player claiming the same theme under `uniqueThemes` gets rejected.

- [ ] **Step 2-4: FAIL → implement → PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(web): lobby theme claim endpoint + selection UI"`

## Task 3.3: Theme preview in lobby

**Files:**
- Modify: `GET /api/drafts/[slug]` helper (`helpers.ts`) — when `mode === "theme"`, include `allowedThemes: [{ id, name, archetype, mainCount, extraCount, sampleCardImages }]` (hide for `random` until active).
- Modify: lobby UI to render preview chips.
- Test: `packages/web/tests/drafts-theme-preview.test.ts`

- [ ] **Step 1-5:** failing test asserts the GET response includes `allowedThemes` with counts + sample images for a theme draft; implement; commit `git commit -am "feat(web): lobby theme preview"`.

## Task 3.4: Start preflight (block on error, warn-to-reroll)

**Files:**
- Create: `packages/web/app/api/drafts/[slug]/preflight/route.ts` — `GET` returns `{ errors: string[]; warnings: string[] }` by resolving assigned/assignable themes and running `themes.analyzeTheme` per theme under the draft config.
- Modify: POST start route (`drafts/[slug]/route.ts`) — relies on `drafts.start` throwing on hard errors (already implemented Task 2.4); surface the thrown message as a 400. The warn-to-reroll UI calls `GET preflight` before showing the Start button.
- Modify: lobby UI — show preflight warnings with "Re-roll / Edit theme / Turn Extra off / Proceed anyway".
- Test: `packages/web/tests/drafts-preflight-route.test.ts`

- [ ] **Step 1: Failing test** — a draft whose assigned theme is main-short returns an `errors` entry; a thin-extra theme returns a `warnings` entry but no error.

- [ ] **Step 2-4: FAIL → implement → PASS**

- [ ] **Step 5: Commit** `git commit -am "feat(web): theme start preflight endpoint + warnings UI"`

## Task 3.5: Draft screen phase indicator + Extra decklist section

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx` + `helpers.ts` — add derived `phase` ("main"|"extra") and progress (`Main 12/40`, `Extra 3/15`) to the GET response and render an indicator; the existing `<CardGrid>` shows the `themePackSize` options unchanged. On complete, the pool/decklist view splits Main vs Extra (Extra section hidden when `extraDeckEnabled` was false).
- Test: `packages/web/tests/drafts-theme-phase.test.ts` (response shape) + a light component test if practical.

- [ ] **Step 1-5:** failing test asserts the GET response exposes `phase` and main/extra progress for an active theme draft; implement; commit `git commit -am "feat(web): theme phase indicator + extra decklist section"`.

## Task 3.6: Bot solo-run verification (manual + scripted)

**Files:**
- Test: `packages/web/tests/drafts-theme-pick-route.test.ts` — assert the pick route auto-picks `bot_player_dev_*` players in a theme draft (the route already targets `fake_%`/`bot_%`; confirm it advances theme rounds).
- Manual: create a theme draft in the running web app, add bots via `join-bot`, click through, confirm completion + decklists.

- [ ] **Step 1: Failing/route test**

```ts
it("auto-picks theme bots after a human pick", async () => {
  // seed an active 2-player theme draft (1 human, 1 bot_player_dev_), then POST /pick for the human
  // assert the bot also got a pick recorded for the round
});
```

- [ ] **Step 2-4: FAIL → fix if needed → PASS**

- [ ] **Step 5: Commit** `git commit -am "test(web): theme bot auto-pick via pick route"`

## Task 3.7: Phase 3 wrap

- [ ] `npm test` (all packages) green; `npm run typecheck` clean.
- [ ] Manual bot solo run to completion in the running Docker stack.

---

# Phase 4 — Polish

## Task 4.1: WebSocket `phase` field

**Files:**
- Modify: `packages/shared/src/ws/events.ts` — add `phase?: "main" | "extra"` to `DraftResyncBroadcast` and `DraftStatusBroadcast`.
- Modify: emit sites (`packages/bot/src/lib/notify-ws.ts`, web pick/start routes) to set `phase` for theme drafts; client store (`draft-store.ts`) reads it for the indicator.
- Test: `packages/shared/tests/ws-events*.test.ts` if present, else a type-level/usage test.

- [ ] **Step 1-5:** add field, thread it through, commit `git commit -am "feat: add phase field to draft ws events"`.

## Task 4.2: Validation surfacing + tournament hand-off check

**Files:**
- Modify: host UI to show `analyzeTheme` warnings when curating `allowedThemeIds` (balance warning when a theme is much smaller/larger than peers).
- Test: confirm tournament hand-off works on a completed theme draft (it consumes picks generically). Note `createTournamentFromDraft` is a **method of `createDraftTournamentService(db)`** in `packages/shared/src/services/draft-tournament.ts` (not a standalone export) — construct that service first, then add an integration test asserting a tournament is created from a completed theme draft.

- [ ] **Step 1-5:** test + implement + commit `git commit -am "feat(web): theme validation surfacing + tournament hand-off test"`.

## Task 4.3: Final wrap

- [ ] `npm test` all green, `npm run typecheck` + `npm run build` clean.
- [ ] Update `CLAUDE.md` "Draft flow" / "Card catalog" sections to mention theme mode and the new tables/services.
- [ ] Use **superpowers:requesting-code-review** before merging.

---

## Risks & decisions captured

- **Engine reuse over rewrite:** theme mode adds `openThemeRound` + `pickThemeCard` and three `totalRounds`-aware tweaks; the booster `pickCard`/`openWave`/`buildDeal`/`draft_deal` paths are untouched. The biggest correctness risk is round-advancement (booster advances when *all wave cards* are picked; theme must advance when *all players* have picked, since `themePackSize-1` cards stay unpicked each round). Task 2.5 tests this directly.
- **Burn needs no schema:** "consumed" is derived — picked cards (burn off) or all prior-pack cards (burn on) — so no `burned` column.
- **Generic-extra detection is coarse in v1:** `syncGenericExtra` returns whole XYZ/Synchro/Link types without material-lock analysis; the admin trims in the editor. Documented, not silently assumed.
- **Theme editor is a sibling, not a fork:** it reuses cube-editor primitives (`parseCustomCardIds`, `CardPoolGrid`, `CardHoverPopup`, cards-cache, `/api/cards/resolve`) rather than overloading `CardPoolEditor` with a theme mode, to avoid regressing the cube flow. Extract shared logic into a hook if duplication is meaningful.
- **Preflight split:** the engine (`drafts.start`) blocks on hard errors; the web `preflight` endpoint surfaces warnings for the re-roll UX. Keeps the engine simple and testable.
