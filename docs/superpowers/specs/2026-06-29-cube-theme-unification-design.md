# Cube / Theme Unification — Design

**Date:** 2026-06-29
**Status:** Approved (design)
**Supersedes / extends:** `docs/superpowers/specs/2026-06-25-theme-draft-design.md` and its plan `docs/superpowers/plans/2026-06-28-theme-draft-mode.md`. The Theme Draft *mode* built there is preserved in full; this work only unifies the saved-pool storage it sits on top of.

## Motivation

The app has two conceptually identical "saved card pool" stores that grew independently:

- **`draft_templates`** — the bot's "draft template" feature (a saved `DraftConfig`: pool sources + pack settings), invoked from Discord. The web surfaces the same rows as **"My Cubes"**, showing only the pool part (`setNames` + `customCardIds`).
- **`themes` / `theme_cards`** — per-player Theme Draft pools (explicit cards split `main`/`extra` with per-card `max_copies`).

A user building a reusable card pool can do it in two unrelated places with two editors. The deal *mechanic* (shared pool vs per-player themed) is genuinely different and stays; the *saved pool* is the same thing and should be one store.

**Decision (chosen by the user — "Option 2, total merge"):** Replace **both** `draft_templates` and `themes` with a single `cubes` store, and rewire the bot to read it. Discord draft templates, web "My Cubes", and Theme Draft pools all become one **cube**. Existing data is throwaway test data, so there is no row migration.

## Naming

- The **storage noun** is **"cube"** everywhere — tables, services, API routes, and the single library tab.
- The **per-player draft mode keeps its identity**: user-facing **"Theme Draft"** and `DraftConfig.mode === "theme"` are unchanged (the user asked to keep the draft-mode chooser as-is).
- Mental model: *a Theme Draft restricts each player to a cube.*
- Config field `allowedThemeIds` → **`allowedCubeIds`**. Mode-behavior fields keep their names (`themeSelection`, `uniqueThemes`, `themePackSize`, `extraDeckEnabled`, `extraDeckSize`, `burnUnpicked`, `themeAssignments`).

## Data model

Drop `themes`, `theme_cards`, `draft_player_theme`, **and** `draft_templates`. Keep `archetypes`. Add three tables:

```sql
create table if not exists cubes (            -- = old draft_templates + themes, unified
  id integer primary key autoincrement,
  guild_id text not null,
  name text not null,
  archetype text,                              -- provenance when seeded from an archetype (display)
  banlist text,
  config_json text not null default '{}',      -- pack/mode defaults + setNames/customCardIds (bot templates & set draws)
  created_by_user_id text not null,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (guild_id, name)
);

create table if not exists cube_cards (        -- = old theme_cards
  cube_id integer not null references cubes(id) on delete cascade,
  catalog_card_id integer not null references card_catalog(ygoprodeck_id),
  pool text not null,                          -- 'main' | 'extra'
  max_copies integer not null default 3,
  source text,
  primary key (cube_id, catalog_card_id)
);

create table if not exists draft_player_cube ( -- = old draft_player_theme
  draft_id integer not null references drafts(id),
  player_id integer not null references players(id),
  cube_id integer not null references cubes(id),
  primary key (draft_id, player_id)
);
```

### Two pool representations per cube (deliberate)

A cube row can carry its pool two ways; this is the bridge that lets one row serve all three jobs:

- **`config_json`** (`setNames` / `customCardIds` + pack/mode settings) — what **bot templates** and **set-based booster draws** already use. The bot keeps working with near-zero change.
- **`cube_cards`** (explicit cards, `main`/`extra`, `max_copies`) — what **Theme Drafts** and the **rich editor** use.

**Canonical resolution:**
- *Shared cube draft pool* = `resolve(config.setNames)` ∪ `config.customCardIds` ∪ `flatten(cube_cards main ∪ extra)`.
- *Theme draft pool* = `cube_cards` only — `main` phase, then optional `extra` phase.

A cube with only `config_json` and no `cube_cards` (a set/passcode bot template) is valid; if such a cube were attached to a Theme Draft, the existing main-pool preflight rejects it gracefully.

## Services & pool resolution

**One shared service** `packages/shared/src/services/cubes.ts` → `createCubeService(db, catalog)`, merging today's `createThemesService` (`packages/shared/src/services/themes.ts`) and the bot's `createDraftTemplateService` (`packages/bot/src/services/draft-templates.ts`):

- *Pool/library ops — renamed 1:1 from the themes service:* `createBlank`, `createFromArchetype`, `findCube` (was `findTheme`), `listCubes` (was `listThemes`), `getCubePools` (was `getThemePools`), `addCard`, `removeCard`, `setMaxCopies`, `importPasscodes`, `seedArchetypeInto`.
- *Pool/library ops — NEW methods (not present on the themes service today):* `renameCube` and `deleteCube` centralize what is currently inline SQL in `packages/web/app/api/themes/[id]/route.ts` (`update themes set name…` / `delete from themes…`); `analyzeCubePools` centralizes the main/extra sufficiency check that today lives in the engine's `preflightThemes`. The web routes and engine then call these instead of duplicating SQL. Budget these as new code, not renames.
- *Template-compatible ops* (from the bot service, **identical signatures**): `save(guildId, name, config, userId)`, `findByName(guildId, name)`, `list(guildId)`, `delete(guildId, name)` — so bot call sites swap only the wiring, not their logic.

**Deal algorithm untouched.** `packages/shared/src/services/cube.ts` (`analyzeCube` / `buildDeal` / `seededShuffle`) is deal *math*, not storage. Rename the file to `deal.ts` purely to avoid `cube.ts` vs `cubes.ts` confusion (mechanical import update across `drafts.ts` and any web importers).

**Engine changes are minimal:**
- *Shared draft* — resolution stays config-driven. "Use this cube" copies the cube's pool into the draft config at apply-time: `config.setNames = cube.setNames`, `config.customCardIds = cube.customCardIds ∪ flatten(cube_cards)`. Existing `catalogCardIdsForDraft` → `resolveCubeCardIds` → `buildDeal` → `draft_deal` is unchanged.
- *Theme draft* — `openThemeRound`, `assignThemes`, `preflightThemes`, `startThemeDraft`, `pickThemeCard` are a pure theme→cube rename: read `cube_cards` for the `cube_id` from `draft_player_cube`. Logic identical.

## Bot rewire (deliberately tiny)

- Delete `packages/bot/src/services/draft-templates.ts`; wire `deps.cubes = createCubeService(db, catalog)`. Note: the merged service takes a `catalog` arg the old `createDraftTemplateService(db)` did not — confirm a card-catalog instance is available at the bot wire site (it is; the bot already runs set sync via the catalog service) and pass it in.
- `packages/bot/src/commands/handlers.ts`, `interactions/modals.ts`, `interactions/autocomplete.ts` keep their `save`/`list`/`findByName`/`delete` call sites (signatures preserved); only the dependency name changes.
- No new Discord theme-draft path is added — Theme Draft remains web-only, as today.

## Web — API & UI

### API (collapse to one cube surface)
- `/api/themes` + `/api/draft-templates` → **`/api/cubes`** (GET list, POST create/save).
- `/api/themes/[id]` + `/api/draft-templates/[id]` → **`/api/cubes/[id]`** (GET / PUT / DELETE).
- `/api/themes/[id]/cards` → **`/api/cubes/[id]/cards`**.
- `/api/drafts/[slug]/themes` → **`/api/drafts/[slug]/cubes`**; `/api/drafts/[slug]/claim-theme` → **`/api/drafts/[slug]/claim-cube`**.
- `/api/archetypes` unchanged (now used in more places).

### One library, one editor
- **Nav:** "Themes" + "Cubes" merge into a single **Cubes** entry.
- **`/cubes` list** = merge of `themes-list` + `my-cubes-list`: every cube with main/extra counts + archetype badge, the "Add cube" button, delete. Old `/themes` redirects to `/cubes`.
- **`/cubes/[id]` editor** = today's rich theme editor (archetype seed, passcode import, single-card add, main/extra panels, max-copies, editable title, delete). It absorbs `card-pool-editor` / `cube-editor`. Single place to build any cube.

### Theme Draft mode — preserved, retargeted
- Chooser `/drafts/new` (theme vs cube) stays. `theme-draft-builder` → `cube-draft-builder`, `theme-lobby-panel` → `cube-lobby-panel`, all reading `/api/.../cubes`. Live phase indicator, pack fade, draft-type badges, editable titles — behavior unchanged.

### Shared cube draft gains archetype search
*(Explicit user request, bundled into this work — a small new capability beyond the pure store merge, justified because cubes can now hold archetype-seeded cards and the seed primitive already exists.)*
- The cube-draft pool builder (`create-draft-form` + `card-pool-editor`) gets an **"Add a whole archetype"** type-ahead reusing `/api/archetypes` + the seed primitive, resolving that archetype's cards into the shared pool. A shared cube draft can be built from **archetypes + sets + passcodes**.
- "Save pool as cube" → `/api/cubes`; "load saved cube" → `/api/cubes`.
- Settings `card-pool-manager` → points at `/api/cubes`.

## Migration

`migrate(db)` drops `draft_player_theme`, `theme_cards`, `themes`, `draft_templates` and creates `cubes` / `cube_cards` / `draft_player_cube`. No row migration (data is wipeable). `npm run reset:test-data` reseeds. `allowedThemeIds` → `allowedCubeIds` with no back-compat shim.

## Testing (TDD)

- **Shared service:** merged cube-service tests — pool ops (`createBlank`/`createFromArchetype`/`addCard`/`removeCard`/`setMaxCopies`/`importPasscodes`/`getCubePools`/`analyzeCubePools`) plus template-compat (`save`/`list`/`findByName`/`delete`).
- **Engine:** existing theme-draft round tests retargeted to `cube_cards` / `draft_player_cube` (behavior identical).
- **Web routes:** `/api/cubes` CRUD, `/api/drafts/[slug]/cubes` attach/detach, `claim-cube`, delete-route clears `draft_player_cube`, create-route theme + cube branches.
- **Bot:** template `save`/`list`/`findByName`/`delete` retargeted to the cube service.
- **Components:** cube editor (was `theme-editor.test`), archetype search in the shared cube-draft pool builder.
- **Schema:** `packages/shared/tests/db/schema.test.ts` hard-asserts the old table names (`themes`, `theme_cards`, `draft_player_theme`) and will fail on the rename — update it to assert `cubes` / `cube_cards` / `draft_player_cube`.
- Rename existing tests rather than duplicate.

**Verification:** `npm run typecheck` + `npm test` per package, `npm run reset:test-data`, then smoke: seed a cube from an archetype → run a shared cube draft seeded from an archetype → run a Theme Draft on cubes → confirm bot `/draft template` save/load still works.

## Out of scope

- No new Discord theme-draft creation flow.
- No change to the booster draft deal algorithm.
- No change to tournaments, matches, gamification.
- "Live set" semantics: saving a set-based pool into `cube_cards` resolves to a snapshot; set-based booster drafts continue to pick sets at draft-create time (config `setNames`), not via a saved cube.
