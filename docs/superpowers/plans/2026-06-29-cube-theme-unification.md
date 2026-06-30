# Cube / Theme Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two parallel saved-pool stores (`draft_templates` and `themes`/`theme_cards`) with a single `cubes` store used by the bot, the web cube library, and the Theme Draft mode — and add archetype search to the shared cube-draft pool builder.

**Architecture:** One `cubes` + `cube_cards` + `draft_player_cube` schema. One shared `createCubeService(db, catalog)` merges the themes service and the bot's draft-template service. The Theme Draft engine is retargeted table-for-table (behavior identical). The bot rewire swaps one dependency. The web collapses `/themes` + `/cubes` (My Cubes) into one `/cubes` library with one editor, and the shared cube-draft pool builder gains an archetype type-ahead.

**Tech Stack:** TypeScript, npm workspaces + Turborepo, better-sqlite3, Vitest, Next.js 16 App Router, discord.js.

**Spec:** `docs/superpowers/specs/2026-06-29-cube-theme-unification-design.md`

**Conventions for this plan:**
- Run a single shared/bot test file: `npx vitest run <path>`
- Run a single web test file: `npx vitest run <path> -c packages/web/vitest.config.ts`
- Typecheck one package: `npm run typecheck --workspace=packages/<pkg>`
- Build shared (needed by bot/web after shared changes): `npm run build --workspace=packages/shared`
- Commit after every green step. Keep `@yugidraft/shared` built so bot/web typecheck sees new exports.

**Naming rule (applies throughout):** storage noun = **cube**; the per-player mode stays **Theme Draft** / `mode: "theme"`. Config rename: `allowedThemeIds` → `allowedCubeIds` only. Mode-behavior fields (`themeSelection`, `uniqueThemes`, `themePackSize`, `extraDeckEnabled`, `extraDeckSize`, `burnUnpicked`, `themeAssignments`) keep their names.

---

## Phase 0 — Schema & migration

### Task 0.1: Rename tables in the schema

**Files:**
- Modify: `packages/shared/src/db/schema.ts`
- Test: `packages/shared/tests/db/schema.test.ts`

- [ ] **Step 1: Update the schema test to assert the new table names**

In `packages/shared/tests/db/schema.test.ts`, replace assertions for `themes`, `theme_cards`, `draft_player_theme` (around lines 34 and 148) with `cubes`, `cube_cards`, `draft_player_cube`. Add an assertion that `draft_templates` no longer exists. Example shape:

```ts
expect(tableNames).toContain("cubes");
expect(tableNames).toContain("cube_cards");
expect(tableNames).toContain("draft_player_cube");
expect(tableNames).not.toContain("themes");
expect(tableNames).not.toContain("theme_cards");
expect(tableNames).not.toContain("draft_player_theme");
expect(tableNames).not.toContain("draft_templates");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts`
Expected: FAIL (old names still created).

- [ ] **Step 3: Rewrite the table DDL**

In `packages/shared/src/db/schema.ts`:
- Replace the `themes` / `theme_cards` / `draft_player_theme` `create table` blocks with `cubes` / `cube_cards` / `draft_player_cube` per the spec's "Data model" SQL (add `config_json text not null default '{}'` and `updated_at … default current_timestamp` to `cubes`; `cube_cards` mirrors `theme_cards` with `cube_id`; `draft_player_cube` mirrors `draft_player_theme` with `cube_id`).
- Delete the `draft_templates` `create table` block.
- In `migrate()`, add idempotent drops of the legacy tables BEFORE the new `create table` calls run (data is wipeable):

```ts
db.exec(`
  drop table if exists draft_player_theme;
  drop table if exists theme_cards;
  drop table if exists themes;
  drop table if exists draft_templates;
`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Build shared + commit**

```bash
npm run build --workspace=packages/shared
git add packages/shared/src/db/schema.ts packages/shared/tests/db/schema.test.ts
git commit -m "feat(shared): rename theme/template tables to unified cubes schema"
```

---

## Phase 1 — Shared cube service + config rename + deal.ts

### Task 1.1: Rename `allowedThemeIds` → `allowedCubeIds` in DraftConfig

**Files:**
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Edit the type**

In `packages/shared/src/types/index.ts`, rename the field `allowedThemeIds?: number[]` to `allowedCubeIds?: number[]`. Leave all other fields unchanged.

- [ ] **Step 2: Find all references (they will be fixed in later tasks)**

Run: `grep -rn "allowedThemeIds" packages --include="*.ts" --include="*.tsx" | grep -v node_modules`
Note the list; each call site is updated in its owning task (engine in 2.x, web routes in 4.x, components in 5.x).

- [ ] **Step 3: Build shared + commit**

```bash
npm run build --workspace=packages/shared
git add packages/shared/src/types/index.ts
git commit -m "feat(shared): rename DraftConfig.allowedThemeIds to allowedCubeIds"
```

### Task 1.2: Rename `cube.ts` → `deal.ts`

**Files:**
- Rename: `packages/shared/src/services/cube.ts` → `packages/shared/src/services/deal.ts`
- Modify: importers of `analyzeCube` / `buildDeal` / `seededShuffle` and any barrel export.

- [ ] **Step 1: Move the file**

```bash
git mv packages/shared/src/services/cube.ts packages/shared/src/services/deal.ts
```

- [ ] **Step 2: Fix imports**

Run: `grep -rn "services/cube\b\|/cube\"\|/cube'" packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v cubes`
Update each import path from `.../services/cube` to `.../services/deal`. Check the shared services barrel (`packages/shared/src/services/index.ts`) and re-export from `deal`.

- [ ] **Step 3: Typecheck + build + commit**

Run: `npm run typecheck --workspace=packages/shared`
Expected: PASS.

```bash
npm run build --workspace=packages/shared
git add -A
git commit -m "refactor(shared): rename cube.ts to deal.ts (deal math, not storage)"
```

### Task 1.3: Create `createCubeService` (pool/library + template-compat + new methods)

**Files:**
- Create: `packages/shared/src/services/cubes.ts`
- Modify: `packages/shared/src/services/index.ts` (barrel export)
- Delete: `packages/shared/src/services/themes.ts` (after porting)
- Test: `packages/shared/tests/services/cubes.test.ts` (port from `themes.test.ts` if it exists; otherwise new)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/tests/services/cubes.test.ts`. Cover (use an in-memory/temp better-sqlite3 db + `migrate`, mirror the existing themes test setup):

```ts
// createBlank → row in cubes; findCube returns it
// createFromArchetype (mock catalog) → cubes row + cube_cards main/extra
// addCard / removeCard / setMaxCopies → cube_cards mutations
// importPasscodes → cube_cards upserts, routed main/extra by frame
// getCubePools → { main, extra } arrays
// analyzeCubePools → ok/errors for an insufficient main pool
// renameCube → updates name, rejects duplicate (guild_id,name)
// deleteCube → removes cubes + cube_cards rows
// save/findByName/list/delete (template-compat) → config_json round-trips
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/shared/tests/services/cubes.test.ts`
Expected: FAIL (`createCubeService` not defined).

- [ ] **Step 3: Implement `createCubeService`**

Port `packages/shared/src/services/themes.ts` verbatim into `packages/shared/src/services/cubes.ts`, applying the rename map: `themes`→`cubes`, `theme_cards`→`cube_cards`, `theme_id`→`cube_id`, `findTheme`→`findCube`, `listThemes`→`listCubes`, `getThemePools`→`getCubePools`, `createThemesService`→`createCubeService`. Then ADD:

```ts
// rename a cube (centralizes today's inline SQL from /api/themes/[id])
renameCube(cubeId: number, name: string): { ok: true } | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: "name is required" };
  const dupe = db.prepare(
    "select id from cubes where guild_id = (select guild_id from cubes where id = ?) and name = ? and id != ?",
  ).get(cubeId, trimmed, cubeId) as { id: number } | undefined;
  if (dupe) return { error: `A cube named "${trimmed}" already exists` };
  const res = db.prepare("update cubes set name = ?, updated_at = ? where id = ?")
    .run(trimmed, new Date().toISOString(), cubeId);
  return res.changes === 0 ? { error: "Cube not found" } : { ok: true };
},

// delete a cube + its cards
deleteCube(cubeId: number): void {
  db.prepare("delete from cube_cards where cube_id = ?").run(cubeId);
  db.prepare("delete from cubes where id = ?").run(cubeId);
},

// template-compat (ported from bot draft-templates service)
save(guildId: string, name: string, config: DraftConfig, createdByUserId: string) {
  const res = db.prepare(`
    insert into cubes (guild_id, name, config_json, created_by_user_id)
    values (?, ?, ?, ?)
    on conflict(guild_id, name) do update set
      config_json = excluded.config_json,
      created_by_user_id = excluded.created_by_user_id,
      updated_at = current_timestamp
  `).run(guildId, name.trim(), JSON.stringify(config), createdByUserId);
  return this.findById(Number(res.lastInsertRowid));
},
findByName(guildId: string, name: string) { /* select * from cubes where guild_id=? and name=? */ },
list(guildId: string) { /* select * from cubes where guild_id=? order by name asc, parse config_json */ },
delete(guildId: string, name: string) { db.prepare("delete from cube_cards where cube_id in (select id from cubes where guild_id=? and name=?)").run(guildId, name); db.prepare("delete from cubes where guild_id=? and name=?").run(guildId, name); },
```

`analyzeCubePools(cubeId, config)`: port the main/extra sufficiency math currently inside `drafts.ts` `preflightThemes` into a pure method that reads `cube_cards` and returns `{ ok, errors, warnings }`. (Task 2.3 makes `preflightThemes` call this.)

Update the barrel `packages/shared/src/services/index.ts`: export `createCubeService` from `./cubes`, remove the `createThemesService` export, delete `packages/shared/src/services/themes.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/shared/tests/services/cubes.test.ts`
Expected: PASS. Delete the old `packages/shared/tests/services/themes.test.ts` if present.

- [ ] **Step 5: Build shared + commit**

```bash
npm run build --workspace=packages/shared
git add -A
git commit -m "feat(shared): createCubeService merges themes + template ops + rename/delete/analyze"
```

---

## Phase 2 — Drafts engine retarget

### Task 2.1: Retarget Theme Draft engine functions to cube tables

**Files:**
- Modify: `packages/shared/src/services/drafts.ts`
- Test: `packages/shared/tests/services/drafts.test.ts` (the theme-draft cases)

- [ ] **Step 1: Update the theme-draft tests' table/field names**

In the theme-draft test cases in `packages/shared/tests/services/drafts.test.ts`, rename `draft_player_theme`→`draft_player_cube`, `theme_cards`→`cube_cards`, `theme_id`→`cube_id`, `themes`→`cubes`, `allowedThemeIds`→`allowedCubeIds`. Behavior assertions stay identical.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts`
Expected: FAIL (engine still reads old tables).

- [ ] **Step 3: Retarget the engine**

In `packages/shared/src/services/drafts.ts`, in `openThemeRound`, `assignThemes`, `preflightThemes`, `startThemeDraft`, `pickThemeCard`: replace SQL/identifiers `draft_player_theme`→`draft_player_cube`, `theme_cards`→`cube_cards`, `theme_id`→`cube_id`, `themes`→`cubes`; read `config.allowedCubeIds`. Keep `mode: "theme"` and all `theme*` config-behavior field reads. (Function names may stay `openThemeRound` etc. — they describe the mode, not the store — or rename to `openCubeRound`; if renamed, update callers in this file only.)

- [ ] **Step 4: Make `preflightThemes` delegate to `analyzeCubePools`**

Replace the inline main-pool sufficiency math in `preflightThemes` with a call to `createCubeService(db, catalog).analyzeCubePools(cubeId, config)` per assigned cube, aggregating errors. (Same result; one source of truth.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/shared/tests/services/drafts.test.ts`
Expected: PASS.

- [ ] **Step 6: Build shared + commit**

```bash
npm run build --workspace=packages/shared
git add packages/shared/src/services/drafts.ts packages/shared/tests/services/drafts.test.ts
git commit -m "feat(shared): retarget theme-draft engine to cube tables; preflight uses analyzeCubePools"
```

### Task 2.2: Apply-cube helper for shared drafts

**Files:**
- Modify: `packages/shared/src/services/drafts.ts` (or `cubes.ts`)
- Test: `packages/shared/tests/services/cubes.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test: given a cube with `config.setNames`, `config.customCardIds`, and `cube_cards`, `applyCubeToConfig(cube)` returns a config whose `customCardIds` = `customCardIds ∪ flatten(cube_cards main ∪ extra)` and preserves `setNames`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/shared/tests/services/cubes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `applyCubeToConfig` on the cube service**

```ts
applyCubeToConfig(cubeId: number, base: DraftConfig = {}): DraftConfig {
  const cube = this.findById(cubeId);
  const cfg: DraftConfig = JSON.parse(cube.config_json ?? "{}");
  const cardIds = this.getCubePools(cubeId);
  const flat = [...cardIds.main, ...cardIds.extra].map((c) => c.catalogCardId);
  const customCardIds = Array.from(new Set([...(cfg.customCardIds ?? []), ...flat]));
  return { ...base, ...cfg, customCardIds, setNames: cfg.setNames ?? base.setNames };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/shared/tests/services/cubes.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
npm run build --workspace=packages/shared
git add -A
git commit -m "feat(shared): applyCubeToConfig flattens a cube into a shared-draft config"
```

---

## Phase 3 — Bot rewire

### Task 3.1: Point the bot at the cube service

**Files:**
- Delete: `packages/bot/src/services/draft-templates.ts`
- Modify: `packages/bot/src/index.ts` (wire `deps.cubes`), `packages/bot/src/commands/handlers.ts`, `packages/bot/src/interactions/modals.ts`, `packages/bot/src/interactions/autocomplete.ts`
- Test: `packages/bot/tests/**` template tests (retarget)

- [ ] **Step 1: Retarget the bot template tests**

Find them: `grep -rln "templates\|draft_templates\|DraftTemplate" packages/bot/tests`. Update setup to use `createCubeService(db, catalog)` and the `cubes` table; assertions on `save`/`list`/`findByName`/`delete` stay (signatures preserved).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run <those test files>`
Expected: FAIL.

- [ ] **Step 3: Rewire**

- Delete `packages/bot/src/services/draft-templates.ts`.
- In `packages/bot/src/index.ts`: replace `createDraftTemplateService(db)` with `createCubeService(db, catalog)` (a catalog instance already exists for set sync — reuse it). Name the dep `deps.cubes` (or keep `deps.templates` pointing at the cube service to minimize call-site churn — pick one and be consistent).
- In `handlers.ts` / `modals.ts` / `autocomplete.ts`: update the import and the `deps.templates.*` references to the chosen dep name. Call sites (`save`/`list`/`findByName`/`delete`) are otherwise unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run <those test files>`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck --workspace=packages/bot`
Expected: PASS.

```bash
git add -A
git commit -m "feat(bot): replace draft-template service with shared cube service"
```

---

## Phase 4 — Web API

### Task 4.1: `/api/cubes` library routes (replace `/api/themes` + `/api/draft-templates`)

**Files:**
- Create: `packages/web/app/api/cubes/route.ts`, `packages/web/app/api/cubes/[id]/route.ts`, `packages/web/app/api/cubes/[id]/cards/route.ts`
- Delete: `packages/web/app/api/themes/route.ts`, `.../themes/[id]/route.ts`, `.../themes/[id]/cards/route.ts`, `packages/web/app/api/draft-templates/route.ts`, `.../draft-templates/[id]/route.ts`
- Modify: `packages/web/src/lib/theme-detail.ts` → `cube-detail.ts` (rename), any `theme-pools.ts` helper → `cube-pools.ts`
- Test: `packages/web/tests/cubes-route.test.ts` (port from theme route tests)

- [ ] **Step 1: Port the failing route tests**

Create `packages/web/tests/cubes-route.test.ts` from the existing theme/draft-template route tests, hitting `/api/cubes` and `/api/cubes/[id]` (GET list, POST create blank/archetype, PUT rename, DELETE). Use the cube service.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/web/tests/cubes-route.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL (routes not created).

- [ ] **Step 3: Implement the cube routes**

Port `app/api/themes/route.ts`, `app/api/themes/[id]/route.ts`, `app/api/themes/[id]/cards/route.ts` to the `app/api/cubes/...` paths, swapping `createThemesService`→`createCubeService`, `theme*` identifiers→`cube*`, and using `renameCube`/`deleteCube` from the service (replace the inline SQL). Fold the `/api/draft-templates` POST/PUT/GET/DELETE behavior into `/api/cubes` (the My Cubes save/update/delete now hit the cube library). Rename helper files `theme-detail.ts`→`cube-detail.ts`, `theme-pools.ts`→`cube-pools.ts` and update imports. Delete the old `themes` and `draft-templates` route files.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/cubes-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): /api/cubes library routes replace /api/themes and /api/draft-templates"
```

### Task 4.2: Draft-scoped cube routes + create/delete/helpers

**Files:**
- Create: `packages/web/app/api/drafts/[slug]/cubes/route.ts` (from `.../themes/route.ts`), `packages/web/app/api/drafts/[slug]/claim-cube/route.ts` (from `claim-theme`)
- Delete: `.../themes/route.ts`, `.../claim-theme/route.ts`
- Modify: `packages/web/app/api/drafts/route.ts` (create branch), `packages/web/app/api/drafts/[slug]/route.ts` (DELETE clears `draft_player_cube`), `packages/web/app/api/drafts/[slug]/helpers.ts` (`allowedThemes`→`allowedCubes`, reads cube tables)
- Test: `packages/web/tests/drafts-delete-route.test.ts` (the theme case → cube), plus a draft-cubes attach/detach test

- [ ] **Step 1: Update the delete-route theme test → cube**

In `packages/web/tests/drafts-delete-route.test.ts`, rename the theme case to use `cubes` / `draft_player_cube` (insert a `cubes` row, a `draft_player_cube` row, assert the cube survives deletion while `draft_player_cube` is cleared).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/tests/drafts-delete-route.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Move `.../themes/route.ts` → `.../cubes/route.ts` and `claim-theme` → `claim-cube`; swap identifiers, `persistAllowedThemeIds`→`persistAllowedCubeIds` writing `config.allowedCubeIds`, `draft_player_theme`→`draft_player_cube`, service swap.
- `app/api/drafts/[slug]/route.ts` DELETE: change `delete from draft_player_theme` → `delete from draft_player_cube`.
- `app/api/drafts/route.ts` create branch: `allowedThemeIds`→`allowedCubeIds`; when a cube is chosen for a shared draft, call `applyCubeToConfig`.
- `helpers.ts` `buildDraftResponse`: `allowedThemes`→`allowedCubes`, read `cubes`/`cube_cards`/`draft_player_cube`; keep `phase`/`themeProgress` keys (UI contract) unless also renaming UI in Phase 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/drafts-delete-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck --workspace=packages/web`
Expected: PASS (web components still reference old names until Phase 5 — if typecheck fails only on components, proceed; they're fixed next phase. If it blocks, do 4.2 and Phase 5 in one branch and typecheck at the end of Phase 5.)

```bash
git add -A
git commit -m "feat(web): draft-scoped cube routes + create/delete/helpers retargeted"
```

---

## Phase 5 — Web UI

### Task 5.1: Merge nav + library list

**Files:**
- Modify: `packages/web/src/lib/nav-items.ts` (one "Cubes" entry)
- Create: `packages/web/src/components/cubes/cubes-library-list.tsx` (merge `themes-list.tsx` + `my-cubes-list.tsx`)
- Modify: `packages/web/app/(app)/cubes/page.tsx` (render the merged list), add `packages/web/app/(app)/themes/page.tsx` → redirect to `/cubes`
- Delete: `packages/web/src/components/themes/themes-list.tsx`, `packages/web/src/components/cubes/my-cubes-list.tsx`

- [ ] **Step 1: Implement the merged list**

Build `cubes-library-list.tsx` from `themes-list.tsx` (it already has "Add cube" → create blank → editor; archetype badge; main/extra counts; delete) reading `/api/cubes`. Drop `my-cubes-list.tsx` (its draft_templates view is superseded).

- [ ] **Step 2: Nav + pages**

`nav-items.ts`: remove the "Themes" entry; keep one "Cubes" entry (Boxes icon). `app/(app)/cubes/page.tsx`: render `CubesLibraryList`. `app/(app)/themes/page.tsx`: `redirect("/cubes")`.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck --workspace=packages/web`

```bash
git add -A
git commit -m "feat(web): one Cubes library list + nav; /themes redirects to /cubes"
```

### Task 5.2: One cube editor

**Files:**
- Create: `packages/web/src/components/cubes/cube-editor.tsx` (from `themes/theme-editor.tsx`, the rich one)
- Modify: `packages/web/app/(app)/cubes/[id]/page.tsx` to render it
- Delete: old `themes/theme-editor.tsx`, the legacy `cubes/cube-editor.tsx` + `cubes/card-pool-editor.tsx`
- Test: `packages/web/tests/cube-editor.test.tsx` (port from `theme-editor.test.tsx`)

- [ ] **Step 1: Port the editor test**

Rename `theme-editor.test.tsx` → `cube-editor.test.tsx`, point at `/api/cubes/[id]`, component `CubeEditor`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/tests/cube-editor.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Copy `theme-editor.tsx` → `cubes/cube-editor.tsx`, retarget API paths to `/api/cubes/[id]` and `/api/cubes/[id]/cards`, rename `ThemeEditor`→`CubeEditor`, `from=/draft/...` back-link logic preserved. Wire `app/(app)/cubes/[id]/page.tsx` to render `CubeEditor`. Delete the legacy cube editor + card-pool-editor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/cube-editor.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): single cube editor replaces theme + legacy cube editors"
```

### Task 5.3: Retarget Theme Draft mode components

**Files:**
- Rename/Modify: `themes/theme-draft-builder.tsx` → `cubes/cube-draft-builder.tsx`, `themes/theme-lobby-panel.tsx` → `cubes/cube-lobby-panel.tsx`
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`, `packages/web/src/components/draft/draft-manage-view.tsx` (any theme references)

- [ ] **Step 1: Port components**

Move the two components, swap API calls to `/api/drafts/[slug]/cubes` and `/api/drafts/[slug]/claim-cube`, props `allowedThemes`→`allowedCubes`, `themeId`→`cubeId`. Keep all UI behavior (phase indicator, claim/preview/preflight, edit/detach/delete). Update `draft/[slug]/page.tsx` imports and the `isThemeDraft` branch to render the renamed components (the `mode === "theme"` check stays).

- [ ] **Step 2: Typecheck + the draft page/manage-view tests**

Run: `npm run typecheck --workspace=packages/web`
Run: `npx vitest run packages/web/tests/pages/draft-detail-page.test.tsx packages/web/tests/components/draft-manage-view.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (update any theme-named assertions to cube).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): retarget Theme Draft builder + lobby to cube routes"
```

### Task 5.4: Archetype search in the shared cube-draft pool builder

**Files:**
- Modify: `packages/web/src/components/draft/create-draft-form.tsx` (and/or the pool builder it uses)
- Modify: `packages/web/src/components/settings/card-pool-manager.tsx` → `/api/cubes`
- Test: `packages/web/tests/create-draft-archetype-search.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

New test: rendering the cube-draft create form shows a "Search archetype" input; typing ≥2 chars queries `/api/archetypes`; clicking a suggestion calls the resolve/seed path and adds those cards to the pool (`customCardIds`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/tests/create-draft-archetype-search.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extract the archetype type-ahead from the cube editor into a small reusable piece (e.g. `components/cubes/archetype-search.tsx`) and drop it into the shared cube-draft pool builder. On select, resolve the archetype to card ids (reuse the same seed/resolve call the editor uses) and union them into the form's `customCardIds`. Point `card-pool-manager.tsx` save/load at `/api/cubes`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/create-draft-archetype-search.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): archetype search in shared cube-draft pool builder"
```

### Task 5.5: Sweep remaining references

**Files:** repo-wide

- [ ] **Step 1: Find stragglers**

Run: `grep -rn "createThemesService\|/api/themes\|/api/draft-templates\|draft_player_theme\|theme_cards\|allowedThemeIds\|MyCubesList\|theme-editor\|themes-list" packages --include="*.ts" --include="*.tsx" | grep -v node_modules`
Expected: empty (or only intentional `mode: "theme"` / `themeSelection` / user-facing "Theme Draft" strings).

- [ ] **Step 2: Fix any remaining, typecheck all**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: sweep residual theme/draft-template references"
```

---

## Phase 6 — Full verification

### Task 6.1: Green build + manual smoke

- [ ] **Step 1: Full typecheck + tests**

Run: `npm run typecheck`
Run: `npm test`
Expected: PASS (per-package; some web suite flakiness under parallel WSL2 is pre-existing — confirm failing files pass in isolation).

- [ ] **Step 2: Reset test data**

Run: `npm run reset:test-data`
Expected: clean reseed against the new schema, no errors.

- [ ] **Step 3: Manual smoke (web running)**

Verify: (a) build a cube from an archetype in `/cubes/[id]`; (b) create a shared cube draft, seed its pool via the new archetype search, start it; (c) create a Theme Draft using cubes, claim/preflight/start, confirm main→extra phases; (d) confirm the Discord bot `/draft template save`/`list`/`delete` still works.

- [ ] **Step 4: Final commit / open PR**

```bash
git add -A && git commit -m "test: verify cube/theme unification end-to-end" || true
```

---

## Notes for the executor

- Build `@yugidraft/shared` after each shared change so bot/web typecheck sees new exports.
- Keep `mode: "theme"`, `themeSelection`, `uniqueThemes`, `themePackSize`, and user-facing "Theme Draft" strings — only the *storage noun* and `allowedThemeIds` are renamed.
- The web UI contract keys `phase` / `themeProgress` in `buildDraftResponse` may stay theme-named to limit churn; rename only if you also update the store/consumers in the same task.
- This is a large branch; commit per green step. Consider opening as its own PR (the Theme Draft PR #41 is separate).
