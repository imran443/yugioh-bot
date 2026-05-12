# Card Pool Viewer & Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline scrollable card-pool viewer (with search/filter/sort + card preview) to the pending-draft screen, a live pool preview to the create form, and a "Card Pools" management section to Settings — all sharing one resolve API, one `<CardPoolGrid>` component, and one `<PoolBuilder>` component.

**Architecture:** A `POST /api/cards/resolve` endpoint turns `{ setNames, customCardIds }` into card details from the local `card_catalog` (no network); a `GET /api/drafts/[slug]/pool` endpoint resolves a draft's frozen `poolCardIds`. A shared `<CardPoolGrid>` carries the grid/search/filter/sort/preview UI (the existing `PoolPanel` is refactored to wrap it). A shared `<PoolBuilder>` (sets picker + custom-IDs textarea + live preview) is embedded by `DraftConfigFields` (create + edit) and the Settings pool editor. Saved pools (`draft_templates`) become pool-only (`{ setNames, customCardIds }`); new `PUT`/`DELETE` routes enable rename/delete.

**Tech Stack:** Next.js 16 App Router, TypeScript (strict), React, Zustand, `next/image`, `better-sqlite3` via `@yugidraft/shared/db`, Vitest + Testing Library (`@vitest-environment jsdom`).

**Conventions in this repo (read once before starting):**
- Web route files export `runtime = "nodejs"`, use `auth()` from `@/lib/auth`, `getDb()` from `@/lib/db`, `env` from `@/lib/env` (`env.discordGuildId`).
- Web route tests: `vi.resetModules()` in `beforeEach`, `vi.mock("@/lib/auth", () => ({ auth }))`, set `process.env.DATABASE_PATH` to a temp sqlite file + `process.env.DISCORD_GUILD_ID`, `migrate(db)` from `@yugidraft/shared/db`, then `await import("../app/api/.../route")`. See `packages/web/tests/draft-tournament-route.test.ts` for the exact pattern.
- Component tests start with `// @vitest-environment jsdom`, use `@testing-library/react`, stub `fetch` with `vi.stubGlobal`.
- Run a single web test file: `npx vitest run packages/web/tests/<file>`. Run all web tests: `npm test --workspace=packages/web`. Typecheck: `npm run typecheck`.
- `card_catalog` columns: `ygoprodeck_id` (pk), `name`, `type`, `frame_type`, `effect_text`, `atk`, `def`, `attribute`, `level`, `image_url`, `image_url_small`, `card_sets_json`, `cached_at`.
- `createCardCatalogService(db).findByIds(ids: number[])` returns `CardCatalogCard[]` shaped `{ ygoprodeckId, name, type, frameType, effectText, atk?, def?, attribute?, level?, imageUrl, imageUrlSmall, cardSets, cachedAt }`, in the same order as `ids`, skipping ids not in the catalog.
- `createDraftService(db).resolvePoolCardIds(config: DraftConfig): number[]` returns the deduped union of (cards belonging to `config.setNames`) ∪ (`config.customCardIds` present in the catalog), excluding extra-deck cards.
- `parseCustomCardIds(text: string)` from `@/lib/custom-card-pool` returns `{ cardIds: number[]; errors: string[] }`.
- Do NOT run `git push` or open PRs. Commit locally only.

---

## File Structure

**New files:**
- `packages/web/src/lib/card-types.ts` — `CardSummary` type + the monster/spell/trap classification helpers (moved out of `pool-panel.tsx`).
- `packages/web/src/lib/cards-cache.ts` — in-memory `Map<number, CardSummary>` with `getCached` / `putCards` helpers.
- `packages/web/app/api/cards/resolve/route.ts` — `POST` resolve endpoint.
- `packages/web/app/api/drafts/[slug]/pool/route.ts` — `GET` draft pool endpoint.
- `packages/web/app/api/draft-templates/[id]/route.ts` — `PUT` (edit/rename) + `DELETE`.
- `packages/web/src/components/cards/card-pool-grid.tsx` — shared presentational grid (search/filter/sort/grid/preview).
- `packages/web/src/components/cards/pool-builder.tsx` — sets picker + custom-IDs textarea + debounced live `<CardPoolGrid>` preview.
- `packages/web/src/components/settings/card-pool-manager.tsx` — list/create/edit/rename/delete pools.
- Tests: `packages/web/tests/cards-cache.test.ts`, `packages/web/tests/cards-resolve-route.test.ts`, `packages/web/tests/drafts-pool-route.test.ts`, `packages/web/tests/draft-templates-id-route.test.ts`, `packages/web/tests/components/card-pool-grid.test.tsx`, `packages/web/tests/components/pool-builder.test.tsx`, `packages/web/tests/components/card-pool-manager.test.tsx`. (Plus edits to existing `packages/web/tests/components/create-draft-form.test.tsx`, `packages/web/tests/components/draft-manage-view.test.tsx` if present, `packages/web/tests/draft-templates-route.test.ts` if present.)

**Modified files:**
- `packages/web/src/components/draft/pool-panel.tsx` — refactor to wrap `<CardPoolGrid>`.
- `packages/web/src/components/draft/card-hover-popup.tsx` — add a tap/dismiss path for no-hover devices.
- `packages/web/src/components/draft/draft-config-fields.tsx` — replace inline Sets picker + custom-IDs textarea with `<PoolBuilder>`.
- `packages/web/src/components/draft/create-draft-form.tsx` — "Save Pool" sends pool-only payload; loading a saved pool only fills sets + custom IDs.
- `packages/web/src/components/draft/draft-manage-view.tsx` — add read-only "Card Pool" section; accept `slug` prop.
- `packages/web/app/(app)/draft/[slug]/page.tsx` — pass `slug` to `DraftManageView`.
- `packages/web/app/api/draft-templates/route.ts` — `GET` includes `setNames`/`customCardIds`; `POST` persists pool-only.
- `packages/web/app/(app)/settings/page.tsx` — render `<CardPoolManager>`; widen container.

---

## Task 1: `CardSummary` type + classification helpers

**Files:**
- Create: `packages/web/src/lib/card-types.ts`
- Test: `packages/web/tests/card-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/tests/card-types.test.ts
import { describe, expect, it } from "vitest";
import {
  isMonster,
  isSpell,
  isTrap,
  isEffectMonster,
  isNormalMonster,
  getTypeLabel,
  type CardSummary,
} from "../src/lib/card-types";

const monster: CardSummary = {
  id: 1, name: "Bujingi Crane", type: "Winged Beast / Effect Monster",
  frameType: "effect", effectText: "...", imageUrl: "u", imageUrlSmall: "s",
};
const trap: CardSummary = {
  id: 2, name: "Mirror Force", type: "Trap Card", frameType: "trap",
  effectText: "...", imageUrl: "u", imageUrlSmall: "s",
};

describe("card-types", () => {
  it("classifies monsters, spells, traps", () => {
    expect(isMonster(monster.type)).toBe(true);
    expect(isTrap(trap.type)).toBe(true);
    expect(isSpell("Spell Card")).toBe(true);
    expect(isSpell(trap.type)).toBe(false);
  });
  it("classifies effect vs normal monsters", () => {
    expect(isEffectMonster(monster)).toBe(true);
    expect(isNormalMonster({ ...monster, type: "Dragon / Normal Monster", frameType: "normal" })).toBe(true);
  });
  it("labels card types", () => {
    expect(getTypeLabel(monster.type)).toBe("Monster");
    expect(getTypeLabel(trap.type)).toBe("Trap");
    expect(getTypeLabel("Spell Card")).toBe("Spell");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/card-types.test.ts`
Expected: FAIL — cannot find module `../src/lib/card-types`.

- [ ] **Step 3: Create `card-types.ts`**

Move the helpers currently in `packages/web/src/components/draft/pool-panel.tsx` (lines ~40–64) into this new file, generalized to `CardSummary`:

```ts
// packages/web/src/lib/card-types.ts
export interface CardSummary {
  id: number;
  name: string;
  type: string;
  frameType: string;
  attribute?: string;
  level?: number;
  effectText: string;
  atk?: number;
  def?: number;
  imageUrl: string;
  imageUrlSmall: string;
}

export function isMonster(type: string): boolean {
  return type.trim().toLowerCase().includes("monster");
}
export function isSpell(type: string): boolean {
  return type.trim().toLowerCase().includes("spell card");
}
export function isTrap(type: string): boolean {
  return type.trim().toLowerCase().includes("trap card");
}
export function isEffectMonster(card: Pick<CardSummary, "type" | "frameType">): boolean {
  const frameType = card.frameType.trim().toLowerCase();
  return isMonster(card.type) && (frameType === "effect" || card.type.toLowerCase().includes("effect monster"));
}
export function isNormalMonster(card: Pick<CardSummary, "type" | "frameType">): boolean {
  const frameType = card.frameType.trim().toLowerCase();
  return isMonster(card.type) && (frameType === "normal" || card.type.toLowerCase().includes("normal monster"));
}
export function getTypeBadgeClass(type: string): string {
  return isMonster(type)
    ? "bg-accent-primary/10 text-accent-primary"
    : isSpell(type)
      ? "bg-accent-gold/10 text-accent-gold"
      : "bg-accent-cta/10 text-accent-cta";
}
export function getTypeLabel(type: string): string {
  return isMonster(type) ? "Monster" : isSpell(type) ? "Spell" : isTrap(type) ? "Trap" : "Other";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/card-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/card-types.ts packages/web/tests/card-types.test.ts
git commit -m "feat(web): add CardSummary type and card classification helpers"
```

---

## Task 2: Client-side resolve cache

**Files:**
- Create: `packages/web/src/lib/cards-cache.ts`
- Test: `packages/web/tests/cards-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/tests/cards-cache.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { getCached, putCards, clearCardsCache } from "../src/lib/cards-cache";
import type { CardSummary } from "../src/lib/card-types";

const a: CardSummary = { id: 1, name: "A", type: "Effect Monster", frameType: "effect", effectText: "", imageUrl: "", imageUrlSmall: "" };
const b: CardSummary = { id: 2, name: "B", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "", imageUrlSmall: "" };

describe("cards-cache", () => {
  beforeEach(() => clearCardsCache());

  it("returns all ids as missing when empty", () => {
    expect(getCached([1, 2])).toEqual({ hits: [], missing: [1, 2] });
  });

  it("returns hits for cached ids and missing for the rest", () => {
    putCards([a]);
    expect(getCached([1, 2])).toEqual({ hits: [a], missing: [2] });
  });

  it("reports no missing once everything is cached", () => {
    putCards([a, b]);
    expect(getCached([1, 2])).toEqual({ hits: [a, b], missing: [] });
  });

  it("dedupes requested ids", () => {
    putCards([a]);
    expect(getCached([1, 1, 2])).toEqual({ hits: [a], missing: [2] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/cards-cache.test.ts`
Expected: FAIL — cannot find module `../src/lib/cards-cache`.

- [ ] **Step 3: Create `cards-cache.ts`**

```ts
// packages/web/src/lib/cards-cache.ts
import type { CardSummary } from "./card-types";

const cache = new Map<number, CardSummary>();

export function getCached(ids: number[]): { hits: CardSummary[]; missing: number[] } {
  const seen = new Set<number>();
  const hits: CardSummary[] = [];
  const missing: number[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = cache.get(id);
    if (card) hits.push(card);
    else missing.push(id);
  }
  return { hits, missing };
}

export function putCards(cards: CardSummary[]): void {
  for (const card of cards) cache.set(card.id, card);
}

export function clearCardsCache(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/cards-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/cards-cache.ts packages/web/tests/cards-cache.test.ts
git commit -m "feat(web): add client-side card resolve cache"
```

---

## Task 3: `POST /api/cards/resolve`

**Files:**
- Create: `packages/web/app/api/cards/resolve/route.ts`
- Test: `packages/web/tests/cards-resolve-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/tests/cards-resolve-route.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function setupDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-cards-resolve-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  // two catalog cards: one in "Metal Raiders", one not in any set
  db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, effect_text, atk, def, attribute, level, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(46986414, "Dark Magician", "Spellcaster / Normal Monster", "normal", "The ultimate wizard.", 2500, 2100, "DARK", 7, "u1", "s1", JSON.stringify([{ set_name: "Metal Raiders" }]), new Date().toISOString());
  db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, effect_text, atk, def, attribute, level, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(83764718, "Monster Reborn", "Spell Card", "spell", "Target 1 monster...", null, null, null, null, "u2", "s2", JSON.stringify([]), new Date().toISOString());
  db.close();
}

describe("POST /api/cards/resolve", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u", name: "Yugi" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  it("401 when unauthenticated", async () => {
    await setupDb();
    auth.mockResolvedValue(null);
    const { POST } = await import("../app/api/cards/resolve/route");
    const res = await POST(new Request("http://localhost/api/cards/resolve", { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(401);
  });

  it("resolves set names and custom ids, dedupes, returns unknownIds", async () => {
    await setupDb();
    const { POST } = await import("../app/api/cards/resolve/route");
    const res = await POST(new Request("http://localhost/api/cards/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setNames: ["Metal Raiders"], customCardIds: [83764718, 46986414, 99999999] }),
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.cards.map((c: { id: number }) => c.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([46986414, 83764718]);
    expect(json.unknownIds).toEqual([99999999]);
    const dm = json.cards.find((c: { id: number }) => c.id === 46986414);
    expect(dm).toMatchObject({ name: "Dark Magician", type: "Spellcaster / Normal Monster", frameType: "normal", imageUrl: "u1", imageUrlSmall: "s1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/cards-resolve-route.test.ts`
Expected: FAIL — cannot find module `../app/api/cards/resolve/route`.

- [ ] **Step 3: Create the route**

```ts
// packages/web/app/api/cards/resolve/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createDraftService, createCardCatalogService } from "@yugidraft/shared/services";
import type { CardSummary } from "@/lib/card-types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { setNames?: string[]; customCardIds?: number[] };
  const setNames = Array.isArray(body.setNames) ? body.setNames.filter((s): s is string => typeof s === "string") : [];
  const customCardIds = Array.isArray(body.customCardIds)
    ? body.customCardIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
    : [];

  const db = getDb();
  const drafts = createDraftService(db);
  const catalog = createCardCatalogService(db);

  const resolvedIds = drafts.resolvePoolCardIds({
    setNames,
    customCardIds,
    includeNames: [],
    excludeNames: [],
  });

  const cards: CardSummary[] = catalog.findByIds(resolvedIds).map((c) => ({
    id: c.ygoprodeckId,
    name: c.name,
    type: c.type,
    frameType: c.frameType,
    attribute: c.attribute,
    level: c.level,
    effectText: c.effectText,
    atk: c.atk,
    def: c.def,
    imageUrl: c.imageUrl,
    imageUrlSmall: c.imageUrlSmall,
  }));

  const present = new Set(cards.map((c) => c.id));
  const unknownIds = customCardIds.filter((id) => !present.has(id));

  return NextResponse.json({ cards, unknownIds });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/cards-resolve-route.test.ts`
Expected: PASS. (If `createDraftService`/`createCardCatalogService` are not re-exported from `@yugidraft/shared/services`, import them from their module paths instead — check `packages/shared/src/services/index.ts`; both should already be exported there.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/cards/resolve/route.ts packages/web/tests/cards-resolve-route.test.ts
git commit -m "feat(web): add POST /api/cards/resolve endpoint"
```

---

## Task 4: `GET /api/drafts/[slug]/pool`

**Files:**
- Create: `packages/web/app/api/drafts/[slug]/pool/route.ts`
- Test: `packages/web/tests/drafts-pool-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/tests/drafts-pool-route.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function setup(configJson: string) {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-drafts-pool-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, effect_text, atk, def, attribute, level, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(46986414, "Dark Magician", "Spellcaster / Normal Monster", "normal", "x", 2500, 2100, "DARK", 7, "u1", "s1", JSON.stringify([{ set_name: "Metal Raiders" }]), new Date().toISOString());
  db.prepare(
    `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug)
     values ('guild-1', 'ch1', 'D', 'pending', 'u', ?, 'slug-1')`,
  ).run(configJson);
  db.close();
}

describe("GET /api/drafts/[slug]/pool", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u", name: "Yugi" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  function req() { return new Request("http://localhost/api/drafts/slug-1/pool"); }
  function params() { return { params: Promise.resolve({ slug: "slug-1" }) }; }

  it("401 unauthenticated", async () => {
    await setup(JSON.stringify({ poolCardIds: [46986414] }));
    auth.mockResolvedValue(null);
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    expect((await GET(req(), params())).status).toBe(401);
  });

  it("404 for unknown slug", async () => {
    await setup(JSON.stringify({ poolCardIds: [46986414] }));
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    const res = await GET(new Request("http://localhost/api/drafts/nope/pool"), { params: Promise.resolve({ slug: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("returns cards from poolCardIds", async () => {
    await setup(JSON.stringify({ poolCardIds: [46986414] }));
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cards.map((c: { id: number }) => c.id)).toEqual([46986414]);
    expect(json.cards[0]).toMatchObject({ name: "Dark Magician", imageUrl: "u1" });
  });

  it("falls back to resolvePoolCardIds when poolCardIds absent", async () => {
    await setup(JSON.stringify({ setNames: ["Metal Raiders"] }));
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    const json = await (await GET(req(), params())).json();
    expect(json.cards.map((c: { id: number }) => c.id)).toEqual([46986414]);
  });

  it("returns empty array for an unresolvable pool", async () => {
    await setup(JSON.stringify({ setNames: ["Nonexistent Set"] }));
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    const json = await (await GET(req(), params())).json();
    expect(json.cards).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/drafts-pool-route.test.ts`
Expected: FAIL — cannot find module `../app/api/drafts/[slug]/pool/route`.

- [ ] **Step 3: Create the route**

```ts
// packages/web/app/api/drafts/[slug]/pool/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createDraftService, createCardCatalogService } from "@yugidraft/shared/services";
import type { DraftConfig } from "@yugidraft/shared/types";
import type { CardSummary } from "@/lib/card-types";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const db = getDb();
  const row = db
    .prepare("select config_json from drafts where web_slug = ? and guild_id = ?")
    .get(slug, env.discordGuildId) as { config_json: string } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }

  const config = JSON.parse(row.config_json) as DraftConfig;
  const drafts = createDraftService(db);
  const catalog = createCardCatalogService(db);

  const ids = config.poolCardIds && config.poolCardIds.length > 0
    ? config.poolCardIds
    : drafts.resolvePoolCardIds(config);

  const cards: CardSummary[] = catalog.findByIds(ids).map((c) => ({
    id: c.ygoprodeckId,
    name: c.name,
    type: c.type,
    frameType: c.frameType,
    attribute: c.attribute,
    level: c.level,
    effectText: c.effectText,
    atk: c.atk,
    def: c.def,
    imageUrl: c.imageUrl,
    imageUrlSmall: c.imageUrlSmall,
  }));

  return NextResponse.json({ cards });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/drafts-pool-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "packages/web/app/api/drafts/[slug]/pool/route.ts" packages/web/tests/drafts-pool-route.test.ts
git commit -m "feat(web): add GET /api/drafts/[slug]/pool endpoint"
```

---

## Task 5: `<CardPoolGrid>` shared component

**Files:**
- Create: `packages/web/src/components/cards/card-pool-grid.tsx`
- Test: `packages/web/tests/components/card-pool-grid.test.tsx`

This component is the search/filter/sort/grid/preview UI, generalized from `PoolPanel`'s inner block. It does NOT use the draft store. Keep it under ~200 lines.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/tests/components/card-pool-grid.test.tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardPoolGrid } from "../../src/components/cards/card-pool-grid";
import type { CardSummary } from "../../src/lib/card-types";

const cards: CardSummary[] = [
  { id: 1, name: "Bujingi Crane", type: "Winged Beast / Effect Monster", frameType: "effect", effectText: "...", imageUrl: "u1", imageUrlSmall: "s1" },
  { id: 2, name: "Mirror Force", type: "Trap Card", frameType: "trap", effectText: "...", imageUrl: "u2", imageUrlSmall: "s2" },
  { id: 3, name: "Monster Reborn", type: "Spell Card", frameType: "spell", effectText: "...", imageUrl: "u3", imageUrlSmall: "s3" },
];

describe("CardPoolGrid", () => {
  it("renders a tile per card with an accessible preview label", () => {
    render(<CardPoolGrid cards={cards} />);
    expect(screen.getByRole("button", { name: /preview bujingi crane/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /preview mirror force/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /preview monster reborn/i })).toBeTruthy();
  });

  it("narrows by search", () => {
    render(<CardPoolGrid cards={cards} />);
    fireEvent.change(screen.getByLabelText(/search cards/i), { target: { value: "mirror" } });
    expect(screen.queryByRole("button", { name: /preview bujingi crane/i })).toBeNull();
    expect(screen.getByRole("button", { name: /preview mirror force/i })).toBeTruthy();
  });

  it("narrows by type filter", () => {
    render(<CardPoolGrid cards={cards} />);
    fireEvent.click(screen.getByRole("button", { name: /^traps$/i }));
    expect(screen.getByRole("button", { name: /preview mirror force/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preview monster reborn/i })).toBeNull();
  });

  it("shows the empty message when there are no cards", () => {
    render(<CardPoolGrid cards={[]} emptyMessage="Nothing here yet." />);
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
  });

  it("shows a skeleton while loading with no cards", () => {
    render(<CardPoolGrid cards={[]} loading />);
    expect(screen.getByTestId("card-pool-grid-skeleton")).toBeTruthy();
  });

  it("shows an updating overlay while loading with cards present", () => {
    render(<CardPoolGrid cards={cards} loading />);
    expect(screen.getByText(/updating/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /preview bujingi crane/i })).toBeTruthy();
  });

  it("renders unknownIds as placeholder tiles", () => {
    render(<CardPoolGrid cards={cards} unknownIds={[99999999]} />);
    const placeholder = screen.getByText(/99999999/);
    expect(placeholder).toBeTruthy();
    expect(within(placeholder.closest("[data-testid='card-pool-grid-unknown']") as HTMLElement).getByText(/not in catalog/i)).toBeTruthy();
  });

  it("opens the preview popup on focus", () => {
    render(<CardPoolGrid cards={cards} />);
    fireEvent.focus(screen.getByRole("button", { name: /preview mirror force/i }));
    // CardHoverPopup renders the card name as a heading
    expect(screen.getAllByText("Mirror Force").length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `card-pool-grid.tsx`**

Adapt the inner block of `pool-panel.tsx` (the search input, filter pills, sort pills, optional summary, scrollable grid, and the `CardHoverPopup` rendering with `getPopupPosition`). Key differences from the original:
- Props instead of store: `cards`, `loading?`, `unknownIds?`, `emptyMessage?`, `className?`, `heightClassName?` (default `"h-[26rem]"`), `showSummary?` (default `true`).
- Import classification helpers from `@/lib/card-types`, not local copies.
- Add `data-testid="card-pool-grid-skeleton"` on the skeleton block and `data-testid="card-pool-grid-unknown"` on each unknown-id tile.
- Add a small "Updating…" pill (`absolute` top-right of the scroll container) shown when `loading && cards.length > 0`.
- Skeleton block (shown when `loading && cards.length === 0`): a `grid` of ~10 `animate-pulse` divs with `aspect-[421/614]` and `rounded-md bg-bg-elevated` classes.
- Use `next/image` exactly as `pool-panel.tsx` does for tile images (with `onError` → `imageErrors` set, fallback `?`).
- Keep the `getPopupPosition` helper (copy from `pool-panel.tsx`) and the hover/focus handlers; render `<CardHoverPopup>` when `hoveredCard && popupPosition`.
- Wrap everything in a single root `<div className={cn("flex flex-col gap-3", className)}>`. No outer card chrome — callers add that.

```tsx
// packages/web/src/components/cards/card-pool-grid.tsx
"use client";

import { useCallback, useDeferredValue, useMemo, useState } from "react";
import Image from "next/image";
import { ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
import {
  isMonster, isSpell, isTrap, isEffectMonster, isNormalMonster, getTypeBadgeClass, getTypeLabel,
  type CardSummary,
} from "@/lib/card-types";

type PoolFilter = "all" | "effect" | "normal" | "spell" | "trap";
type PoolSort = "newest" | "oldest" | "name" | "type";

const POPUP_WIDTH = 288;
const POPUP_HEIGHT = 560;
const POPUP_MARGIN = 16;

function getPopupPosition(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const leftOfItem = rect.left - POPUP_WIDTH - POPUP_MARGIN;
  const left = Math.min(vw - POPUP_WIDTH - POPUP_MARGIN, Math.max(POPUP_MARGIN, leftOfItem));
  const top = Math.min(vh - POPUP_HEIGHT - POPUP_MARGIN, Math.max(POPUP_MARGIN, rect.top + rect.height / 2 - POPUP_HEIGHT / 2));
  return { left, top };
}

interface CardPoolGridProps {
  cards: CardSummary[];
  loading?: boolean;
  unknownIds?: number[];
  emptyMessage?: string;
  className?: string;
  heightClassName?: string;
  showSummary?: boolean;
}

const FILTER_BUTTONS: Array<{ label: string; value: PoolFilter }> = [
  { label: "All", value: "all" },
  { label: "Effect Monsters", value: "effect" },
  { label: "Normal Monsters", value: "normal" },
  { label: "Spells", value: "spell" },
  { label: "Traps", value: "trap" },
];
const SORT_BUTTONS: Array<{ label: string; value: PoolSort }> = [
  { label: "Newest", value: "newest" },
  { label: "Oldest", value: "oldest" },
  { label: "Name", value: "name" },
  { label: "Type", value: "type" },
];

export function CardPoolGrid({
  cards,
  loading = false,
  unknownIds = [],
  emptyMessage = "No cards.",
  className,
  heightClassName = "h-[26rem]",
  showSummary = true,
}: CardPoolGridProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<PoolFilter>("all");
  const [activeSort, setActiveSort] = useState<PoolSort>("newest");
  const [hoveredCard, setHoveredCard] = useState<CardSummary | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number } | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<number>>(new Set());
  const deferredSearch = useDeferredValue(searchTerm);

  const handleImageError = useCallback((id: number) => setImageErrors((p) => new Set(p).add(id)), []);
  const handleEnter = useCallback((card: CardSummary, rect: DOMRect) => {
    setHoveredCard(card);
    setPopupPosition(getPopupPosition(rect));
  }, []);
  const handleLeave = useCallback(() => { setHoveredCard(null); setPopupPosition(null); }, []);

  const { monsterCount, spellCount, trapCount } = useMemo(() => ({
    monsterCount: cards.filter((c) => isMonster(c.type)).length,
    spellCount: cards.filter((c) => isSpell(c.type)).length,
    trapCount: cards.filter((c) => isTrap(c.type)).length,
  }), [cards]);

  const visible = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    let list = cards.filter((card) => {
      const matchSearch = needle.length === 0 || card.name.toLowerCase().includes(needle);
      const matchFilter =
        activeFilter === "all" ||
        (activeFilter === "effect" && isEffectMonster(card)) ||
        (activeFilter === "normal" && isNormalMonster(card)) ||
        (activeFilter === "spell" && isSpell(card.type)) ||
        (activeFilter === "trap" && isTrap(card.type));
      return matchSearch && matchFilter;
    });
    if (activeSort === "newest") list = [...list].reverse();
    else if (activeSort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (activeSort === "type") {
      const order = (c: CardSummary) => (isMonster(c.type) ? 0 : isSpell(c.type) ? 1 : isTrap(c.type) ? 2 : 3);
      list = [...list].sort((a, b) => order(a) - order(b));
    }
    return list;
  }, [cards, deferredSearch, activeFilter, activeSort]);

  const showSkeleton = loading && cards.length === 0;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {showSummary && (
        <div className="grid grid-cols-3 gap-1.5">
          <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
            <span className="font-display text-lg text-text-primary tabular-nums">{monsterCount}</span>
            <span className="text-xs text-text-secondary">Monsters</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
            <span className="font-display text-lg text-text-primary tabular-nums">{spellCount}</span>
            <span className="text-xs text-text-secondary">Spells</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
            <span className="font-display text-lg text-text-primary tabular-nums">{trapCount}</span>
            <span className="text-xs text-text-secondary">Traps</span>
          </div>
        </div>
      )}

      <input
        type="text"
        aria-label="Search cards"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search cards..."
        className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/60"
      />

      <div className="flex flex-wrap gap-1.5">
        {FILTER_BUTTONS.map((fb) => (
          <Button key={fb.value} type="button" size="sm" variant={activeFilter === fb.value ? "secondary" : "ghost"}
            onClick={() => setActiveFilter(fb.value)} aria-pressed={activeFilter === fb.value} className="rounded-full px-3 text-xs">
            {fb.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        {SORT_BUTTONS.map((sb) => (
          <Button key={sb.value} type="button" size="sm" variant={activeSort === sb.value ? "secondary" : "ghost"}
            onClick={() => setActiveSort(sb.value)} aria-pressed={activeSort === sb.value} className="rounded-full px-3 text-xs">
            {sb.label}
          </Button>
        ))}
      </div>

      <div className={cn("relative overflow-y-auto rounded-lg border border-border bg-surface/70", heightClassName)}>
        {loading && cards.length > 0 && (
          <span className="pointer-events-none absolute right-2 top-2 z-10 rounded-full bg-bg-elevated px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
            Updating…
          </span>
        )}
        {showSkeleton ? (
          <div data-testid="card-pool-grid-skeleton" className="grid grid-cols-2 gap-3 p-3 2xl:grid-cols-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="aspect-[421/614] w-full animate-pulse rounded-md bg-bg-elevated" />
            ))}
          </div>
        ) : cards.length === 0 && unknownIds.length === 0 ? (
          <p className="px-3 py-4 text-sm text-text-secondary">{emptyMessage}</p>
        ) : visible.length === 0 && unknownIds.length === 0 ? (
          <p className="px-3 py-4 text-sm text-text-secondary">No cards match.</p>
        ) : (
          <div data-testid="card-pool-grid" className="grid grid-cols-2 gap-3 p-3 2xl:grid-cols-3">
            {visible.map((card) => (
              <button
                key={card.id}
                type="button"
                aria-label={`Preview ${card.name}`}
                className="group flex w-full flex-col gap-2 rounded-lg border border-border/70 bg-bg-elevated/40 p-2 text-left transition-colors duration-150 hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
                onMouseEnter={(e) => handleEnter(card, e.currentTarget.getBoundingClientRect())}
                onMouseLeave={handleLeave}
                onFocus={(e) => handleEnter(card, e.currentTarget.getBoundingClientRect())}
                onBlur={handleLeave}
              >
                <div className="relative aspect-[421/614] w-full overflow-hidden rounded-md bg-bg-elevated">
                  {imageErrors.has(card.id) ? (
                    <div className="flex h-full w-full items-center justify-center text-xs text-text-muted">?</div>
                  ) : (
                    <Image src={card.imageUrlSmall || card.imageUrl} alt="" fill className="object-cover"
                      sizes="(min-width: 1536px) 120px, 160px" onError={() => handleImageError(card.id)} />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="line-clamp-2 text-sm font-medium leading-snug text-text-primary">{card.name}</p>
                  <span className={cn("mt-1 inline-flex rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase", getTypeBadgeClass(card.type))}>
                    {getTypeLabel(card.type)}
                  </span>
                </div>
              </button>
            ))}
            {unknownIds.map((id) => (
              <div key={`unknown-${id}`} data-testid="card-pool-grid-unknown"
                title={`Passcode ${id} is not in the catalog yet`}
                aria-label={`Passcode ${id} not in catalog yet`}
                className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/70 bg-bg-elevated/20 p-2 text-center">
                <div className="flex aspect-[421/614] w-full items-center justify-center rounded-md bg-bg-elevated/40 font-mono text-xs text-text-muted">{id}</div>
                <p className="text-[0.65rem] text-text-muted">not in catalog yet</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {hoveredCard && popupPosition && (
        <CardHoverPopup
          card={hoveredCard}
          position={popupPosition}
          imageError={imageErrors.has(hoveredCard.id)}
          onImageError={() => handleImageError(hoveredCard.id)}
        />
      )}
    </div>
  );
}
```

Note: `<CardHoverPopup>` currently types its `card` prop as `DraftCardDetail` from the draft store. Since `CardSummary` has the same shape, change `card-hover-popup.tsx`'s import to `import type { CardSummary } from "@/lib/card-types"` and the prop type to `CardSummary` (purely a type change — done properly in Task 7; for now it is structurally compatible, so the test passes either way).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx`
Expected: PASS. (If the "opens the preview popup on focus" assertion is flaky because jsdom lacks `getBoundingClientRect` dimensions, `getPopupPosition` still returns a valid `{left, top}` object since `DOMRect` numeric fields default to `0` — the popup renders. If `window.innerWidth`/`innerHeight` are `0` in jsdom, the `Math.max(POPUP_MARGIN, ...)` clamps keep `left`/`top` finite, so it is fine.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-pool-grid.test.tsx
git commit -m "feat(web): add shared CardPoolGrid component"
```

---

## Task 6: Refactor `PoolPanel` to wrap `<CardPoolGrid>`

**Files:**
- Modify: `packages/web/src/components/draft/pool-panel.tsx`
- Verify: `packages/web/tests/components/pool-panel.test.tsx` (if it exists) still passes.

- [ ] **Step 1: Run the existing PoolPanel test to capture the baseline**

Run: `npx vitest run packages/web/tests/components/pool-panel.test.tsx` (skip this step if the file does not exist).
Expected: PASS (baseline). Note any test that asserts on `data-testid="pool-panel-card-grid"`.

- [ ] **Step 2: Rewrite `pool-panel.tsx`**

Keep: the outer desktop card (`<div className="hidden ... sm:block">` with `<h3>Your Pool</h3>`), the "Drafted so far" counter, the "Export YDK" `<Button>` (and `downloadYdk` import), the mobile trigger button, and the mobile `<Sheet>`. Replace the entire inner search/filter/sort/grid/hover block (and the now-unused local type helpers, `getPopupPosition`, and `CardHoverPopup` import) with a `<CardPoolGrid>`:

```tsx
// packages/web/src/components/draft/pool-panel.tsx
"use client";

import { useState } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";
import { downloadYdk } from "@/lib/ydk";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import { Layers, ChevronUp, Download } from "lucide-react";

interface PoolPanelProps {
  className?: string;
}

export function PoolPanel({ className }: PoolPanelProps) {
  const myPool = useDraftStore((s) => s.myPool);
  const [mobileOpen, setMobileOpen] = useState(false);

  const panelContent = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-xl border border-border/70 bg-bg-elevated/25 px-3 py-2">
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-text-muted">Drafted so far</span>
        <span className="font-display text-lg text-text-secondary tabular-nums">{myPool.length}</span>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => downloadYdk(myPool, "draft-pool.ydk")}
        disabled={myPool.length === 0}
        className="w-full"
      >
        <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Export YDK
      </Button>
      <div className="rounded-xl border border-border bg-bg-elevated/40 p-3">
        <div data-testid="pool-panel-card-grid">
          <CardPoolGrid cards={myPool} heightClassName="h-[26rem] xl:h-[34rem]" emptyMessage="No cards drafted yet." />
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className={cn("hidden rounded-xl border border-border bg-surface p-3 sm:block", className)}>
        <h3 className="mb-3 font-display text-lg text-text-primary">Your Pool</h3>
        {panelContent}
      </div>
      <div className="sm:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className={cn("flex w-full items-center justify-between rounded-xl border border-border bg-surface p-4 shadow-card", className)}
        >
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-text-secondary" aria-hidden="true" />
            <span className="font-semibold text-text-primary">Your Pool ({myPool.length})</span>
          </div>
          <ChevronUp className="h-5 w-5 text-text-secondary" aria-hidden="true" />
        </button>
      </div>
      <Sheet open={mobileOpen} onClose={() => setMobileOpen(false)} title="Your Pool">
        {panelContent}
      </Sheet>
    </>
  );
}
```

Note: `myPool` is `DraftCardDetail[]`; that is structurally assignable to `CardSummary[]`. If the typecheck complains, make `DraftCardDetail` in `packages/web/src/lib/stores/draft-store.ts` an alias: `import type { CardSummary } from "@/lib/card-types"; export type DraftCardDetail = CardSummary;` (and delete the inline interface). Update any imports of `DraftCardDetail` only if needed.

- [ ] **Step 3: Run the PoolPanel test**

Run: `npx vitest run packages/web/tests/components/pool-panel.test.tsx` (skip if it does not exist).
Expected: PASS. If a test asserted the old `data-testid="pool-panel-card-grid"` was a direct grid of cards, it still finds the testid wrapper containing the grid — adjust the test only if it queried for a structure that genuinely changed (e.g. it expected `.grid` to be the testid element; change it to query `screen.getByTestId("card-pool-grid")` instead). Keep behavioral assertions intact.

- [ ] **Step 4: Run the broader web suite to catch fallout**

Run: `npm test --workspace=packages/web`
Expected: PASS (the timer-bar / pool-panel / draft-store consumers should be unaffected). Fix any type errors per the alias note above.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/draft/pool-panel.tsx packages/web/src/lib/stores/draft-store.ts packages/web/tests/components/pool-panel.test.tsx
git commit -m "refactor(web): PoolPanel wraps shared CardPoolGrid"
```

---

## Task 7: `<CardHoverPopup>` touch/tap path

**Files:**
- Modify: `packages/web/src/components/draft/card-hover-popup.tsx`
- Test: `packages/web/tests/components/card-hover-popup.test.tsx`

The current popup is `pointer-events-none ... hidden lg:block` — invisible on touch. Add an optional controlled "tap" mode: when `dismissible` is true, the popup is visible at all breakpoints, accepts pointer events, renders a close button, and calls `onDismiss` on outside click / `Escape`. `CardPoolGrid` will (in Task 8 follow-up — actually here) wire a tap handler that opens it in dismissible mode on no-hover devices. To keep scope tight: add the `dismissible`/`onDismiss` props and the close affordance here; have `CardPoolGrid` open it dismissibly when a tile is *clicked* (in addition to hover) — clicking already does nothing else in the viewer contexts.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/tests/components/card-hover-popup.test.tsx
// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CardHoverPopup } from "../../src/components/draft/card-hover-popup";
import type { CardSummary } from "../../src/lib/card-types";

const card: CardSummary = {
  id: 1, name: "Mirror Force", type: "Trap Card", frameType: "trap",
  effectText: "Destroy all attack position monsters.", imageUrl: "u", imageUrlSmall: "s",
};

describe("CardHoverPopup", () => {
  it("renders the card name and effect", () => {
    render(<CardHoverPopup card={card} position={{ left: 0, top: 0 }} imageError onImageError={() => {}} />);
    expect(screen.getByText("Mirror Force")).toBeTruthy();
    expect(screen.getByText(/destroy all attack position monsters/i)).toBeTruthy();
  });

  it("in dismissible mode shows a close button and fires onDismiss on Escape", () => {
    const onDismiss = vi.fn();
    render(<CardHoverPopup card={card} position={{ left: 0, top: 0 }} imageError onImageError={() => {}} dismissible onDismiss={onDismiss} />);
    expect(screen.getByRole("button", { name: /close preview/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("fires onDismiss when the close button is clicked", () => {
    const onDismiss = vi.fn();
    render(<CardHoverPopup card={card} position={{ left: 0, top: 0 }} imageError onImageError={() => {}} dismissible onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /close preview/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/card-hover-popup.test.tsx`
Expected: FAIL — no close button / `onDismiss` not supported (and possibly the import of `CardSummary` if `card-hover-popup.tsx` still references `DraftCardDetail` — that is fine, types are structural in TSX tests, but update it in Step 3).

- [ ] **Step 3: Update `card-hover-popup.tsx`**

```tsx
// packages/web/src/components/draft/card-hover-popup.tsx
import { useEffect } from "react";
import Image from "next/image";
import { Shield, Swords, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardSummary } from "@/lib/card-types";

interface CardHoverPopupProps {
  card: CardSummary;
  position: { left: number; top: number };
  imageError: boolean;
  onImageError: () => void;
  dismissible?: boolean;
  onDismiss?: () => void;
}

export function CardHoverPopup({ card, position, imageError, onImageError, dismissible = false, onDismiss }: CardHoverPopupProps) {
  const isMonster = card.type.toLowerCase().includes("monster");

  useEffect(() => {
    if (!dismissible || !onDismiss) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissible, onDismiss]);

  return (
    <>
      {dismissible && (
        <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onDismiss} />
      )}
      <div
        className={cn(
          "fixed z-50",
          dismissible ? "block" : "pointer-events-none hidden lg:block",
        )}
        style={{ left: `${position.left}px`, top: `${position.top}px` }}
      >
        <div className="relative max-h-[calc(100vh-2rem)] w-72 overflow-auto rounded-xl border border-border bg-bg-surface shadow-card">
          {dismissible && onDismiss && (
            <button
              type="button"
              aria-label="Close preview"
              onClick={onDismiss}
              className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-bg-elevated text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <div className="relative isolate aspect-[3/4] w-full overflow-hidden rounded-t-xl bg-bg-elevated">
            {imageError ? (
              <div className="flex h-full items-center justify-center text-sm text-text-secondary">No image</div>
            ) : (
              <Image src={card.imageUrl} alt={card.name} fill className="object-contain" sizes="288px" onError={onImageError} />
            )}
          </div>
          <div className="space-y-3 p-4">
            <h3 className="mb-1 font-display text-lg text-text-primary">{card.name}</h3>
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              {card.attribute && <span className="rounded-md bg-bg-elevated px-2 py-1">{card.attribute}</span>}
              {card.level !== undefined && <span className="rounded-md bg-bg-elevated px-2 py-1">Level {card.level}</span>}
              <span className="rounded-md bg-bg-elevated px-2 py-1">{card.type}</span>
              <span className="rounded-md bg-bg-elevated px-2 py-1 capitalize">{card.frameType}</span>
            </div>
            <p className="text-sm leading-relaxed text-text-secondary">{card.effectText}</p>
            {isMonster && (card.atk !== undefined || card.def !== undefined) && (
              <div className="flex items-center gap-4 text-sm font-semibold text-text-primary">
                {card.atk !== undefined && (
                  <div className="flex items-center gap-1.5"><Swords className="h-4 w-4 text-accent-cta" aria-hidden="true" /><span>ATK {card.atk}</span></div>
                )}
                {card.def !== undefined && (
                  <div className="flex items-center gap-1.5"><Shield className="h-4 w-4 text-accent-primary" aria-hidden="true" /><span>DEF {card.def}</span></div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
```

Then in `card-pool-grid.tsx`, add `onClick` to each card `<button>` that toggles a `tappedCard` state and opens the popup dismissibly:
- Add state: `const [tapped, setTapped] = useState<CardSummary | null>(null);`
- On card button: `onClick={(e) => { setTapped(card); setPopupPosition(getPopupPosition(e.currentTarget.getBoundingClientRect())); }}`
- Render: when `tapped`, `<CardHoverPopup card={tapped} position={popupPosition ?? {left:16,top:16}} imageError={...} onImageError={...} dismissible onDismiss={() => setTapped(null)} />`. Keep the existing hover popup too (it is `lg:block`-gated and `pointer-events-none`, so it won't conflict on desktop hover; the tapped one takes precedence visually because it is later in the DOM — acceptable). Re-run the Task 5 test to confirm it still passes.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/web/tests/components/card-hover-popup.test.tsx packages/web/tests/components/card-pool-grid.test.tsx`
Expected: PASS for both.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/draft/card-hover-popup.tsx packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-hover-popup.test.tsx
git commit -m "feat(web): add dismissible tap mode to CardHoverPopup and wire it in CardPoolGrid"
```

---

## Task 8: `<PoolBuilder>` component

**Files:**
- Create: `packages/web/src/components/cards/pool-builder.tsx`
- Test: `packages/web/tests/components/pool-builder.test.tsx`

`<PoolBuilder>` renders the `<SetPicker>`, the custom-IDs textarea (with the existing invalid-token helper), and a debounced live `<CardPoolGrid>` preview fed by `/api/cards/resolve` (consulting `cards-cache`).

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/tests/components/pool-builder.test.tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoolBuilder } from "../../src/components/cards/pool-builder";
import { clearCardsCache } from "../../src/lib/cards-cache";

// SetPicker fetches /api/sets — stub everything via fetch.
function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/sets")) return Response.json({ sets: [] });
    if (url === "/api/cards/resolve" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { customCardIds?: number[] };
      const known = (body.customCardIds ?? []).filter((id) => id === 46986414);
      return Response.json({
        cards: known.map((id) => ({ id, name: "Dark Magician", type: "Spellcaster / Normal Monster", frameType: "normal", effectText: "", imageUrl: "u", imageUrlSmall: "s" })),
        unknownIds: (body.customCardIds ?? []).filter((id) => id !== 46986414),
      });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PoolBuilder", () => {
  beforeEach(() => { vi.useFakeTimers(); clearCardsCache(); });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("resolves typed custom ids after debounce and shows them in the preview grid", async () => {
    const fetchMock = stubFetch();
    const value = { setNames: [] as string[], customCardText: "" };
    const onChange = vi.fn();
    const { rerender } = render(<PoolBuilder value={value} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/custom card ids/i), { target: { value: "46986414\n99999999" } });
    // simulate the controlled update flowing back in
    rerender(<PoolBuilder value={{ setNames: [], customCardText: "46986414\n99999999" }} onChange={onChange} />);

    await act(async () => { vi.advanceTimersByTime(400); });

    await waitFor(() => {
      const resolveCall = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/cards/resolve" && (i as RequestInit)?.method === "POST");
      expect(resolveCall).toBeTruthy();
      expect(JSON.parse(String((resolveCall![1] as RequestInit).body))).toMatchObject({ customCardIds: [46986414, 99999999] });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /preview dark magician/i })).toBeTruthy());
    expect(screen.getByText(/99999999/)).toBeTruthy(); // unknown placeholder
  });

  it("surfaces invalid passcode tokens", () => {
    stubFetch();
    const onChange = vi.fn();
    render(<PoolBuilder value={{ setNames: [], customCardText: "abc, 12x" }} onChange={onChange} />);
    expect(screen.getByText(/invalid/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/pool-builder.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `pool-builder.tsx`**

```tsx
// packages/web/src/components/cards/pool-builder.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { getCached, putCards } from "@/lib/cards-cache";
import type { CardSummary } from "@/lib/card-types";
import { SetPicker } from "@/components/draft/set-picker";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";

export interface PoolBuilderValue {
  setNames: string[];
  customCardText: string;
}

interface PoolBuilderProps {
  value: PoolBuilderValue;
  onChange: (value: PoolBuilderValue) => void;
  previewHeightClassName?: string;
}

const DEBOUNCE_MS = 300;

export function PoolBuilder({ value, onChange, previewHeightClassName = "h-[22rem]" }: PoolBuilderProps) {
  const parsed = useMemo(() => parseCustomCardIds(value.customCardText), [value.customCardText]);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [unknownIds, setUnknownIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  // Key the effect on a stable signature so it only re-resolves when the pool changes.
  const signature = useMemo(
    () => JSON.stringify({ s: [...value.setNames].sort(), c: [...parsed.cardIds].sort((a, b) => a - b) }),
    [value.setNames, parsed.cardIds],
  );

  useEffect(() => {
    const setNames = value.setNames;
    const customCardIds = parsed.cardIds;
    if (setNames.length === 0 && customCardIds.length === 0) {
      setCards([]);
      setUnknownIds([]);
      setLoading(false);
      return;
    }
    const handle = setTimeout(async () => {
      const myReq = ++reqId.current;
      setLoading(true);
      // Custom-id-only changes can be served (partly) from cache; sets always re-resolve server-side.
      const { hits } = getCached(customCardIds);
      try {
        const res = await fetch("/api/cards/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setNames, customCardIds }),
        });
        if (myReq !== reqId.current) return;
        if (!res.ok) { setLoading(false); return; }
        const data = (await res.json()) as { cards: CardSummary[]; unknownIds: number[] };
        if (myReq !== reqId.current) return;
        putCards(data.cards);
        // merge cached hits not present in the response (shouldn't happen, but harmless) and dedupe
        const byId = new Map<number, CardSummary>();
        for (const c of [...hits, ...data.cards]) byId.set(c.id, c);
        setCards([...byId.values()]);
        setUnknownIds(data.unknownIds);
      } catch {
        if (myReq === reqId.current) { /* keep prior cards */ }
      } finally {
        if (myReq === reqId.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const count = cards.length;

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-text-primary">Sets</label>
        <SetPicker selectedSets={value.setNames} onSetsChange={(setNames) => onChange({ ...value, setNames })} />
      </div>

      <div>
        <label htmlFor="custom-card-ids" className="mb-1 block text-sm font-medium text-text-primary">Custom Card IDs</label>
        <textarea
          id="custom-card-ids"
          value={value.customCardText}
          onChange={(e) => onChange({ ...value, customCardText: e.target.value })}
          placeholder="46986414&#10;83764718, 12345678"
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <div className="mt-2 flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p className="text-text-secondary">Paste YGOPRODeck passcodes separated by new lines, commas, or spaces.</p>
          {parsed.errors.length > 0 && <p className="text-accent-cta">Invalid: {parsed.errors.slice(0, 3).join(", ")}</p>}
        </div>
      </div>

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
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/pool-builder.test.tsx`
Expected: PASS. (If `SetPicker` does a `fetch` on mount with a URL not matching `/api/sets`, broaden the stub to also return `{ sets: [] }` for whatever it requests; check `packages/web/src/components/draft/set-picker.tsx`.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/cards/pool-builder.tsx packages/web/tests/components/pool-builder.test.tsx
git commit -m "feat(web): add PoolBuilder component with debounced live preview"
```

---

## Task 9: Wire `<PoolBuilder>` into `DraftConfigFields`

**Files:**
- Modify: `packages/web/src/components/draft/draft-config-fields.tsx`
- Verify: `packages/web/tests/components/create-draft-form.test.tsx` still passes (it asserts on `/custom card ids/i`, packs, timer, checkboxes — all preserved).

- [ ] **Step 1: Edit `draft-config-fields.tsx`**

Replace the inline Sets-picker `<div>` and the Custom-Card-IDs `<div>` (the first two children of the returned `<div className="space-y-4">`) with a single `<PoolBuilder>`. Keep `configFromFields`, `fieldsFromConfig`, `validateFields`, `DraftConfigFieldsValue` exactly as they are (they already operate on `setNames` + `customCardText`). The numeric inputs and checkboxes stay.

```tsx
// packages/web/src/components/draft/draft-config-fields.tsx  (only the JSX of DraftConfigFields changes)
"use client";

import * as React from "react";
import type { DraftConfig } from "@yugidraft/shared/types";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { PoolBuilder } from "@/components/cards/pool-builder";

export type DraftConfigFieldsValue = {
  setNames: string[];
  customCardText: string;
  packsPerPlayerText: string;
  pickSecondsText: string;
  alternatePass: boolean;
  randomizeSeats: boolean;
};

// configFromFields, fieldsFromConfig, validateFields  — UNCHANGED, keep exactly as in the current file.

interface DraftConfigFieldsProps {
  value: DraftConfigFieldsValue;
  onChange: (value: DraftConfigFieldsValue) => void;
}

export function DraftConfigFields({ value, onChange }: DraftConfigFieldsProps) {
  const packsPerPlayer = Math.min(10, Math.max(1, parseInt(value.packsPerPlayerText) || 5));
  const cardsPerPack = Math.ceil(40 / packsPerPlayer);

  return (
    <div className="space-y-4">
      <PoolBuilder
        value={{ setNames: value.setNames, customCardText: value.customCardText }}
        onChange={(pb) => onChange({ ...value, setNames: pb.setNames, customCardText: pb.customCardText })}
      />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="packs-per-player" className="mb-1 block text-sm font-medium text-text-primary">Packs per Player</label>
          <input id="packs-per-player" type="number" value={value.packsPerPlayerText}
            onChange={(e) => onChange({ ...value, packsPerPlayerText: e.target.value })} min={1} max={10}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none" />
          <p className="mt-1 text-xs text-text-secondary">
            Each player drafts 40 cards across {packsPerPlayer} pack{packsPerPlayer !== 1 ? "s" : ""} of {cardsPerPack}.
          </p>
        </div>
        <div>
          <label htmlFor="pick-seconds" className="mb-1 block text-sm font-medium text-text-primary">Pick Timer (s)</label>
          <input id="pick-seconds" type="number" value={value.pickSecondsText}
            onChange={(e) => onChange({ ...value, pickSecondsText: e.target.value })} min={5} max={300}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none" />
        </div>
      </div>

      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={value.alternatePass} onChange={(e) => onChange({ ...value, alternatePass: e.target.checked })}
            className="h-4 w-4 rounded border-border accent-accent-primary" />
          Alternate pass direction
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={value.randomizeSeats} onChange={(e) => onChange({ ...value, randomizeSeats: e.target.checked })}
            className="h-4 w-4 rounded border-border accent-accent-primary" />
          Randomize seats
        </label>
      </div>
    </div>
  );
}
```

Keep the bodies of `configFromFields`, `fieldsFromConfig`, `validateFields` exactly as they are in the existing file — do not modify them. `parseCustomCardIds` is still imported because `configFromFields` / `validateFields` use it.

- [ ] **Step 2: Run the affected component tests**

Run: `npx vitest run packages/web/tests/components/create-draft-form.test.tsx packages/web/tests/components/timer-bar.test.tsx`
Expected: PASS. The create-draft-form test stubs `fetch` for `/api/discord/channels` and `/api/draft-templates`; it must also tolerate `/api/sets*` and `/api/cards/resolve` calls now triggered via `<PoolBuilder>`/`<SetPicker>`. If the test's `fetchMock` returns `Response.json({}, { status: 404 })` for unknown URLs, that is fine (the preview just stays empty). Only if it throws on unknown URLs, broaden it. Do NOT change assertions; only broaden the fetch stub if needed.

- [ ] **Step 3: Run the full web suite**

Run: `npm test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/draft/draft-config-fields.tsx packages/web/tests/components/create-draft-form.test.tsx
git commit -m "refactor(web): DraftConfigFields uses shared PoolBuilder (adds live preview)"
```

---

## Task 10: Create form — pool-only "Save Pool" + pool-only template load

**Files:**
- Modify: `packages/web/src/components/draft/create-draft-form.tsx`
- Modify: `packages/web/tests/components/create-draft-form.test.tsx`

Goal: "Save Pool" persists `{ name, config: { setNames, customCardIds } }` only; loading a "Saved Pool" from the dropdown fills only `setNames` + `customCardText` and leaves Packs per Player / Pick Timer / Alternate pass / Randomize seats untouched.

- [ ] **Step 1: Update the existing tests**

In `packages/web/tests/components/create-draft-form.test.tsx`:
- In "loads a saved template into the draft pool and options": change it to assert that loading the "Goat Cube" template fills `setNames` (Metal Raiders chip visible) and the custom card IDs textarea, but **does NOT** change packs/timer/checkboxes from their defaults. Replace the four `expect(screen.getByLabelText(/packs per player/i)).toHaveValue(4)` etc. lines with assertions that they still hold the form defaults (`packsPerPlayer` default `5`, `pickSeconds` default `45`, alternate pass checked by default per `fieldsFromConfig` default `true`, randomize seats unchecked). Rename the test to "loads a saved pool's sets and custom IDs without touching the numeric options".
- In "saves the current pool as a reusable template": after the POST, assert the body is `{ name: "Goat Cube", config: { setNames: [...], customCardIds: [46986414, 83764718] } }` and that `config` does **not** contain `packSize` / `packsPerPlayer` / `pickSeconds`. Use `expect(body.config).not.toHaveProperty("packSize")`.

(Write these test edits first; run to see them fail against the current implementation.)

Run: `npx vitest run packages/web/tests/components/create-draft-form.test.tsx`
Expected: FAIL on the two updated tests.

- [ ] **Step 2: Update `create-draft-form.tsx`**

Find where templates are loaded and where "Save Pool" POSTs. Two changes:
1. **Loading a template** — when the user picks a saved pool, instead of calling `fieldsFromConfig(template.config)` (which fills numerics), only set `setNames` and `customCardText`:
   ```tsx
   const ids = template.config.customCardIds ?? [];
   setFields((f) => ({ ...f, setNames: template.config.setNames ?? [], customCardText: ids.join("\n") }));
   ```
   (Adapt to whatever state setter the form uses — it holds a `DraftConfigFieldsValue`.)
2. **Saving a pool** — build the POST body from the current fields but pool-only:
   ```tsx
   const { cardIds: customCardIds } = parseCustomCardIds(fields.customCardText);
   await fetch("/api/draft-templates", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ name: templateName.trim(), config: { setNames: fields.setNames, customCardIds } }),
   });
   ```
   Remove `packSize` / `packsPerPlayer` / `pickSeconds` / `alternatePassDirection` / `randomizeSeats` from that body if they were present. (Import `parseCustomCardIds` from `@/lib/custom-card-pool` if not already imported.)

Leave the rest of the form (draft creation POST, "Saved Pool" dropdown, "Save Pool" button + name field) intact.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run packages/web/tests/components/create-draft-form.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run the full web suite + typecheck**

Run: `npm test --workspace=packages/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/draft/create-draft-form.tsx packages/web/tests/components/create-draft-form.test.tsx
git commit -m "feat(web): create form saves/loads pool-only templates"
```

---

## Task 11: `draft-templates` API — pool-only POST, richer GET, new PUT/DELETE

**Files:**
- Modify: `packages/web/app/api/draft-templates/route.ts`
- Create: `packages/web/app/api/draft-templates/[id]/route.ts`
- Test: `packages/web/tests/draft-templates-id-route.test.ts`
- Modify (if it exists): `packages/web/tests/draft-templates-route.test.ts`

- [ ] **Step 1: Write the failing test for the new `[id]` route**

```ts
// packages/web/tests/draft-templates-id-route.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function setup() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-templates-id-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare("insert into draft_templates (guild_id, name, config_json, created_by_user_id) values ('guild-1','Alpha', ?, 'u')")
    .run(JSON.stringify({ setNames: ["Metal Raiders"], customCardIds: [1] }));
  db.prepare("insert into draft_templates (guild_id, name, config_json, created_by_user_id) values ('guild-1','Beta', ?, 'u')")
    .run(JSON.stringify({ setNames: [], customCardIds: [2] }));
  db.prepare("insert into draft_templates (guild_id, name, config_json, created_by_user_id) values ('guild-2','Gamma', ?, 'u')")
    .run(JSON.stringify({ setNames: [], customCardIds: [3] }));
  db.close();
}
function idOf(name: string): Promise<number> {
  return (async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(process.env.DATABASE_PATH!);
    const row = db.prepare("select id from draft_templates where name = ?").get(name) as { id: number };
    db.close();
    return row.id;
  })();
}

describe("/api/draft-templates/[id]", () => {
  beforeEach(() => { vi.resetModules(); auth.mockReset(); auth.mockResolvedValue({ user: { id: "u", name: "Yugi" } }); });
  afterEach(() => {
    delete process.env.DATABASE_PATH; delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  it("PUT updates name and pool", async () => {
    await setup();
    const id = await idOf("Alpha");
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(
      new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Alpha Prime", setNames: ["Pharaonic Guardian"], customCardIds: [9, 10] }) }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.template).toMatchObject({ name: "Alpha Prime", setNames: ["Pharaonic Guardian"], customCardIds: [9, 10] });
  });

  it("PUT 409 on name collision with a different template", async () => {
    await setup();
    const id = await idOf("Alpha");
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(
      new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Beta", setNames: [], customCardIds: [1] }) }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(res.status).toBe(409);
  });

  it("PUT 401 unauthenticated", async () => {
    await setup();
    const id = await idOf("Alpha");
    auth.mockResolvedValue(null);
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", body: JSON.stringify({}) }), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(401);
  });

  it("PUT 404 for another guild's template", async () => {
    await setup();
    const id = await idOf("Gamma");
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Gamma2", setNames: [], customCardIds: [1] }) }), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(404);
  });

  it("DELETE removes the template; 404 on already-gone", async () => {
    await setup();
    const id = await idOf("Beta");
    const { DELETE } = await import("../app/api/draft-templates/[id]/route");
    const ok = await DELETE(new Request(`http://localhost/api/draft-templates/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(id) }) });
    expect(ok.status).toBe(200);
    const gone = await DELETE(new Request(`http://localhost/api/draft-templates/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(id) }) });
    expect(gone.status).toBe(404);
  });

  it("DELETE 404 for another guild's template", async () => {
    await setup();
    const id = await idOf("Gamma");
    const { DELETE } = await import("../app/api/draft-templates/[id]/route");
    const res = await DELETE(new Request(`http://localhost/api/draft-templates/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/draft-templates-id-route.test.ts`
Expected: FAIL — cannot find module `../app/api/draft-templates/[id]/route`.

- [ ] **Step 3: Create `app/api/draft-templates/[id]/route.ts`**

```ts
// packages/web/app/api/draft-templates/[id]/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";

type TemplateRow = { id: number; guild_id: string; name: string; config_json: string; created_by_user_id: string };

function poolFromRow(row: TemplateRow) {
  const cfg = JSON.parse(row.config_json) as { setNames?: string[]; customCardIds?: number[] };
  return {
    id: row.id,
    name: row.name,
    setNames: Array.isArray(cfg.setNames) ? cfg.setNames : [],
    customCardIds: Array.isArray(cfg.customCardIds) ? cfg.customCardIds : [],
  };
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const templateId = Number.parseInt(id, 10);
  if (!Number.isInteger(templateId)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { name?: string; setNames?: string[]; customCardIds?: number[] };
  const name = body.name?.trim();
  const setNames = Array.isArray(body.setNames) ? body.setNames.filter((s): s is string => typeof s === "string") : [];
  const customCardIds = Array.isArray(body.customCardIds) ? body.customCardIds.filter((n): n is number => Number.isInteger(n)) : [];
  if (!name || (setNames.length === 0 && customCardIds.length === 0)) {
    return NextResponse.json({ error: "name and a non-empty pool are required" }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare("select * from draft_templates where id = ? and guild_id = ?").get(templateId, env.discordGuildId) as TemplateRow | undefined;
  if (!existing) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const collision = db.prepare("select id from draft_templates where guild_id = ? and name = ? and id != ?").get(env.discordGuildId, name, templateId) as { id: number } | undefined;
  if (collision) return NextResponse.json({ error: `A pool named "${name}" already exists` }, { status: 409 });

  db.prepare("update draft_templates set name = ?, config_json = ? where id = ?")
    .run(name, JSON.stringify({ setNames, customCardIds }), templateId);

  const updated = db.prepare("select * from draft_templates where id = ?").get(templateId) as TemplateRow;
  return NextResponse.json({ template: poolFromRow(updated) });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const templateId = Number.parseInt(id, 10);
  if (!Number.isInteger(templateId)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const db = getDb();
  const result = db.prepare("delete from draft_templates where id = ? and guild_id = ?").run(templateId, env.discordGuildId);
  if (result.changes === 0) return NextResponse.json({ error: "Template not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/draft-templates-id-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `app/api/draft-templates/route.ts` (GET richer, POST pool-only) + its test**

In `GET`, change `mapTemplate` to also expose `setNames` / `customCardIds`:
```ts
function mapTemplate(row: DraftTemplateRow) {
  const config = JSON.parse(row.config_json) as { setNames?: string[]; customCardIds?: number[] };
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    config: JSON.parse(row.config_json) as DraftConfig, // keep for backward compat with the create form's loader
    setNames: Array.isArray(config.setNames) ? config.setNames : [],
    customCardIds: Array.isArray(config.customCardIds) ? config.customCardIds : [],
    createdByUserId: row.created_by_user_id,
  };
}
```
In `POST`, persist pool-only: parse `body.config` but write only `{ setNames, customCardIds }`:
```ts
const incoming = body.config ?? {};
const setNames = Array.isArray(incoming.setNames) ? incoming.setNames : [];
const customCardIds = Array.isArray(incoming.customCardIds) ? incoming.customCardIds : [];
if (!name || (setNames.length === 0 && customCardIds.length === 0)) {
  return NextResponse.json({ error: "name and a draft pool are required" }, { status: 400 });
}
// ...the existing upsert, but with JSON.stringify({ setNames, customCardIds }) as config_json...
```
If `packages/web/tests/draft-templates-route.test.ts` exists, add/adjust an assertion: a POST with extra numeric keys in `config` results in a stored `config_json` of only `{ setNames, customCardIds }` (read it back from the DB in the test), and `GET` returns `setNames` / `customCardIds` on each template. Run that test file.

Run: `npx vitest run packages/web/tests/draft-templates-route.test.ts` (skip if it does not exist).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/app/api/draft-templates packages/web/tests/draft-templates-id-route.test.ts packages/web/tests/draft-templates-route.test.ts
git commit -m "feat(web): draft-templates become pool-only; add PUT/DELETE by id"
```

---

## Task 12: Pending-draft read-only pool viewer

**Files:**
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx`
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`
- Test: `packages/web/tests/components/draft-manage-view.test.tsx` (create if it does not exist, or extend it)

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/tests/components/draft-manage-view.test.tsx  (add this describe block; create the file if missing)
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftManageView } from "../../src/components/draft/draft-manage-view";

const baseDraft = {
  id: 1, name: "My Cube", status: "pending", createdByUserId: "u", createdAt: new Date().toISOString(),
  config: { packsPerPlayer: 5, packSize: 8, pickSeconds: 45, setNames: ["Metal Raiders"], customCardIds: [], alternatePassDirection: true, randomizeSeats: false },
  players: [], playerCount: 0,
};
const noop = async () => {};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("DraftManageView — card pool section", () => {
  it("fetches and renders the resolved pool", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/drafts/my-slug/pool") {
        return Response.json({ cards: [{ id: 46986414, name: "Dark Magician", type: "Spellcaster / Normal Monster", frameType: "normal", effectText: "", imageUrl: "u", imageUrlSmall: "s" }] });
      }
      return Response.json({}, { status: 404 });
    }));
    render(<DraftManageView draft={baseDraft} slug="my-slug" isCreator isParticipant={false} onStart={noop} onCancel={noop} onUpdate={noop} onJoin={noop} />);
    await waitFor(() => expect(screen.getByText(/card pool/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: /preview dark magician/i })).toBeTruthy());
    expect(screen.getByText(/card pool \(1 card/i)).toBeTruthy();
  });

  it("shows the empty state when the pool resolves empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/drafts/my-slug/pool") return Response.json({ cards: [] });
      return Response.json({}, { status: 404 });
    }));
    render(<DraftManageView draft={baseDraft} slug="my-slug" isCreator isParticipant={false} onStart={noop} onCancel={noop} onUpdate={noop} onJoin={noop} />);
    await waitFor(() => expect(screen.getByText(/hasn't been resolved yet/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/draft-manage-view.test.tsx`
Expected: FAIL — `slug` prop not accepted / no "Card Pool" section.

- [ ] **Step 3: Edit `draft-manage-view.tsx`**

- Add `slug: string` to `DraftManageViewProps`.
- Add state + effect near the top of the component:
  ```tsx
  const [poolCards, setPoolCards] = React.useState<CardSummary[] | null>(null);
  const [poolError, setPoolError] = React.useState(false);
  const loadPool = React.useCallback(() => {
    setPoolError(false);
    fetch(`/api/drafts/${slug}/pool`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { cards: CardSummary[] }) => setPoolCards(data.cards))
      .catch(() => setPoolError(true));
  }, [slug]);
  React.useEffect(() => { loadPool(); }, [loadPool]);
  // Re-fetch after a config save so the read-only viewer reflects the new pool:
  const onUpdateWithPoolRefresh = React.useCallback(async (data: { name?: string; config?: unknown }) => {
    await onUpdate(data);
    if (data.config !== undefined) loadPool();
  }, [onUpdate, loadPool]);
  ```
  (Import `CardSummary` from `@/lib/card-types`, `CardPoolGrid` from `@/components/cards/card-pool-grid`.) Use `onUpdateWithPoolRefresh` in place of `onUpdate` inside `handleSaveName` and `handleSaveConfig`.
- Add a new section JSX **after the "Configuration" `<div>` and before `{getActionSection()}`**:
  ```tsx
  <div className="rounded-xl border border-border bg-surface p-6">
    <h2 className="mb-4 font-display text-lg text-text-primary">
      <Layers className="mr-2 inline h-5 w-5 text-accent-primary" />
      Card Pool {poolCards ? <span className="tabular-nums">({poolCards.length} card{poolCards.length === 1 ? "" : "s"})</span> : null}
    </h2>
    {poolError ? (
      <div className="flex items-center justify-between rounded-lg border border-accent-cta/40 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
        <span>Couldn’t load the pool.</span>
        <Button variant="ghost" size="sm" onClick={loadPool}>Retry</Button>
      </div>
    ) : (
      <CardPoolGrid
        cards={poolCards ?? []}
        loading={poolCards === null}
        heightClassName="h-[32rem]"
        emptyMessage="This draft's pool hasn't been resolved yet."
      />
    )}
  </div>
  ```
  (`Layers` is already imported in this file. `Button` is already imported.)

- [ ] **Step 4: Edit `app/(app)/draft/[slug]/page.tsx`**

Find where `<DraftManageView ... />` is rendered (the pending-status branch) and add `slug={slug}` to its props. (`slug` is already destructured from `params` in that file for the summary view; reuse it.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/web/tests/components/draft-manage-view.test.tsx && npm test --workspace=packages/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/draft/draft-manage-view.tsx "packages/web/app/(app)/draft/[slug]/page.tsx" packages/web/tests/components/draft-manage-view.test.tsx
git commit -m "feat(web): inline card-pool viewer on the pending-draft screen"
```

---

## Task 13: `<CardPoolManager>` for Settings

**Files:**
- Create: `packages/web/src/components/settings/card-pool-manager.tsx`
- Test: `packages/web/tests/components/card-pool-manager.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/tests/components/card-pool-manager.test.tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardPoolManager } from "../../src/components/settings/card-pool-manager";

function stubFetch(overrides?: Partial<Record<string, () => Response>>) {
  let templates = [
    { id: 1, name: "Goat Cube", setNames: ["Metal Raiders"], customCardIds: [46986414, 83764718] },
    { id: 2, name: "Pauper", setNames: [], customCardIds: [12345678] },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/sets")) return Response.json({ sets: [] });
    if (url === "/api/cards/resolve") return Response.json({ cards: [], unknownIds: [] });
    if (url === "/api/draft-templates" && method === "GET") return Response.json({ templates });
    if (url === "/api/draft-templates" && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { name: string; config: { setNames: string[]; customCardIds: number[] } };
      const t = { id: 3, name: body.name, setNames: body.config.setNames, customCardIds: body.config.customCardIds };
      templates = [...templates, t];
      return Response.json({ template: t }, { status: 201 });
    }
    if (url.startsWith("/api/draft-templates/") && method === "PUT") {
      const id = Number(url.split("/").pop());
      const body = JSON.parse(String(init!.body)) as { name: string; setNames: string[]; customCardIds: number[] };
      templates = templates.map((t) => (t.id === id ? { id, name: body.name, setNames: body.setNames, customCardIds: body.customCardIds } : t));
      return Response.json({ template: { id, ...body } });
    }
    if (url.startsWith("/api/draft-templates/") && method === "DELETE") {
      const id = Number(url.split("/").pop());
      templates = templates.filter((t) => t.id !== id);
      return Response.json({ ok: true });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("CardPoolManager", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("lists pools with a sets/IDs summary line", async () => {
    stubFetch();
    render(<CardPoolManager />);
    await waitFor(() => expect(screen.getByText("Goat Cube")).toBeTruthy());
    expect(screen.getByText(/1 set · 2 custom ids/i)).toBeTruthy();
    expect(screen.getByText(/0 sets · 1 custom id/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /edit pool goat cube/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete pool goat cube/i })).toBeTruthy();
  });

  it("creates a new pool", async () => {
    const fetchMock = stubFetch();
    render(<CardPoolManager />);
    await waitFor(() => screen.getByText("Goat Cube"));
    fireEvent.click(screen.getByRole("button", { name: /new pool/i }));
    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: "Speed Cube" } });
    fireEvent.change(screen.getByLabelText(/custom card ids/i), { target: { value: "11111111" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/draft-templates" && (i as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ name: "Speed Cube", config: { customCardIds: [11111111] } });
    });
    await waitFor(() => expect(screen.getByText("Speed Cube")).toBeTruthy());
  });

  it("deletes a pool after confirmation", async () => {
    const fetchMock = stubFetch();
    render(<CardPoolManager />);
    await waitFor(() => screen.getByText("Pauper"));
    fireEvent.click(screen.getByRole("button", { name: /delete pool pauper/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i })); // confirm
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/api/draft-templates/2") && (i as RequestInit)?.method === "DELETE");
      expect(del).toBeTruthy();
    });
    await waitFor(() => expect(screen.queryByText("Pauper")).toBeNull());
  });

  it("surfaces a 409 rename collision", async () => {
    stubFetch({});
    // Override PUT to return 409:
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/sets")) return Response.json({ sets: [] });
      if (url === "/api/cards/resolve") return Response.json({ cards: [], unknownIds: [] });
      if (url === "/api/draft-templates" && method === "GET") return Response.json({ templates: [{ id: 1, name: "Goat Cube", setNames: [], customCardIds: [1] }, { id: 2, name: "Pauper", setNames: [], customCardIds: [2] }] });
      if (url.startsWith("/api/draft-templates/") && method === "PUT") return Response.json({ error: 'A pool named "Pauper" already exists' }, { status: 409 });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CardPoolManager />);
    await waitFor(() => screen.getByText("Goat Cube"));
    fireEvent.click(screen.getByRole("button", { name: /edit pool goat cube/i }));
    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: "Pauper" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/card-pool-manager.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `card-pool-manager.tsx`**

```tsx
// packages/web/src/components/settings/card-pool-manager.tsx
"use client";

import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { PoolBuilder, type PoolBuilderValue } from "@/components/cards/pool-builder";

interface PoolListItem {
  id: number;
  name: string;
  setNames: string[];
  customCardIds: number[];
}

type EditorState =
  | { mode: "closed" }
  | { mode: "new"; name: string; pool: PoolBuilderValue }
  | { mode: "edit"; id: number; name: string; pool: PoolBuilderValue };

function summaryLine(p: PoolListItem): string {
  const s = p.setNames.length;
  const c = p.customCardIds.length;
  return `${s} set${s === 1 ? "" : "s"} · ${c} custom ID${c === 1 ? "" : "s"}`;
}

export function CardPoolManager() {
  const [pools, setPools] = React.useState<PoolListItem[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [editor, setEditor] = React.useState<EditorState>({ mode: "closed" });
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [editorError, setEditorError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const res = await fetch("/api/draft-templates");
    if (res.ok) {
      const data = (await res.json()) as { templates: PoolListItem[] };
      setPools(data.templates);
    }
    setLoaded(true);
  }, []);
  React.useEffect(() => { void reload(); }, [reload]);

  const startNew = () => { setEditorError(null); setEditor({ mode: "new", name: "", pool: { setNames: [], customCardText: "" } }); };
  const startEdit = (p: PoolListItem) => {
    setEditorError(null);
    setEditor({ mode: "edit", id: p.id, name: p.name, pool: { setNames: p.setNames, customCardText: p.customCardIds.join("\n") } });
  };
  const closeEditor = () => { setEditor({ mode: "closed" }); setEditorError(null); };

  const save = async () => {
    if (editor.mode === "closed") return;
    setEditorError(null);
    const name = editor.name.trim();
    const { cardIds: customCardIds, errors } = parseCustomCardIds(editor.pool.customCardText);
    if (!name) { setEditorError("Pool name is required."); return; }
    if (errors.length > 0) { setEditorError(`Remove invalid card IDs: ${errors.slice(0, 3).join(", ")}`); return; }
    if (editor.pool.setNames.length === 0 && customCardIds.length === 0) { setEditorError("Add at least one set or one custom card ID."); return; }

    setSaving(true);
    try {
      let res: Response;
      if (editor.mode === "new") {
        res = await fetch("/api/draft-templates", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, config: { setNames: editor.pool.setNames, customCardIds } }),
        });
      } else {
        res = await fetch(`/api/draft-templates/${editor.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, setNames: editor.pool.setNames, customCardIds }),
        });
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setEditorError(body.error ?? `Save failed (${res.status}).`);
        return;
      }
      closeEditor();
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (id: number) => {
    const res = await fetch(`/api/draft-templates/${id}`, { method: "DELETE" });
    setConfirmDeleteId(null);
    if (res.ok) await reload();
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg text-text-primary">Card Pools</h2>
        <Button variant="secondary" size="sm" onClick={startNew}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New Pool
        </Button>
      </div>

      {loaded && pools.length === 0 && editor.mode === "closed" && (
        <p className="text-sm text-text-secondary">No saved pools yet. Create one to reuse it across drafts.</p>
      )}

      <ul className="flex flex-col gap-2" role="list">
        {pools.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-lg border border-border bg-bg-elevated/40 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-text-primary">{p.name}</p>
              <p className="text-xs text-text-muted">{summaryLine(p)}</p>
            </div>
            <Button variant="ghost" size="sm" aria-label={`Edit pool ${p.name}`} onClick={() => startEdit(p)}>
              <Pencil className="h-4 w-4" />
            </Button>
            {confirmDeleteId === p.id ? (
              <span className="flex items-center gap-2 text-xs text-text-secondary">
                Delete &ldquo;{p.name}&rdquo;?
                <Button variant="danger" size="sm" onClick={() => void doDelete(p.id)}>Delete</Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
              </span>
            ) : (
              <Button variant="ghost" size="sm" aria-label={`Delete pool ${p.name}`} onClick={() => setConfirmDeleteId(p.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </li>
        ))}
      </ul>

      {editor.mode !== "closed" && (
        <div className="mt-5 space-y-4 rounded-lg border border-border bg-bg-elevated/30 p-4">
          {editorError && (
            <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">{editorError}</div>
          )}
          <div>
            <label htmlFor="pool-name" className="mb-1 block text-sm font-medium text-text-primary">
              Pool name <span className="text-accent-cta">*</span>
            </label>
            <input
              id="pool-name"
              type="text"
              value={editor.name}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
            />
          </div>
          <PoolBuilder value={editor.pool} onChange={(pool) => setEditor({ ...editor, pool })} />
          <div className="flex gap-3">
            <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>Save</Button>
            <Button variant="ghost" size="sm" onClick={closeEditor} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}
```

(If `Button` has no `loading` prop, drop it — check `packages/web/src/components/ui/button.tsx`; the codebase uses `loading` elsewhere so it should exist.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/card-pool-manager.test.tsx`
Expected: PASS. (If `screen.getByLabelText(/custom card ids/i)` matches two textareas because `PoolBuilder` is rendered both in the editor and... no — it's only in the editor; only one. But the page and the create form both define `id="custom-card-ids"` — within this isolated component test only one exists. Fine.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/settings/card-pool-manager.tsx packages/web/tests/components/card-pool-manager.test.tsx
git commit -m "feat(web): add Card Pools manager component"
```

---

## Task 14: Mount `<CardPoolManager>` on the Settings page

**Files:**
- Modify: `packages/web/app/(app)/settings/page.tsx`
- Test: `packages/web/tests/components/settings-page.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/tests/components/settings-page.test.tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "../../app/(app)/settings/page";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("SettingsPage", () => {
  it("renders the announcement toggles and the card pools manager", () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return Response.json({});
      if (url === "/api/draft-templates") return Response.json({ templates: [] });
      return Response.json({}, { status: 404 });
    }));
    render(<SettingsPage />);
    expect(screen.getByText(/settings/i)).toBeTruthy();
    expect(screen.getByText(/card pools/i)).toBeTruthy();
  });
});
```

(If `AnnouncementToggles` does its own `fetch` to a different URL, broaden the stub to return `{}` for it. If `SettingsPage` is an async server component that cannot be rendered directly by Testing Library, instead test it by importing the page module and asserting it returns an element tree containing `CardPoolManager` — but the current `settings/page.tsx` is a plain sync function component, so direct render works.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/settings-page.test.tsx`
Expected: FAIL — "Card Pools" text not found.

- [ ] **Step 3: Edit `settings/page.tsx`**

```tsx
// packages/web/app/(app)/settings/page.tsx
import { AnnouncementToggles } from "@/components/settings/announcement-toggles";
import { CardPoolManager } from "@/components/settings/card-pool-manager";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <h1 className="font-heading text-2xl text-text-primary">Settings</h1>
      <AnnouncementToggles />
      <CardPoolManager />
    </div>
  );
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run packages/web/tests/components/settings-page.test.tsx && npm test --workspace=packages/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "packages/web/app/(app)/settings/page.tsx" packages/web/tests/components/settings-page.test.tsx
git commit -m "feat(web): mount Card Pools manager on the Settings page"
```

---

## Task 15: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS across `packages/shared`, `packages/bot`, `packages/web`.

- [ ] **Step 2: Typecheck everything**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (Turbo builds `shared` first; `web` builds clean).

- [ ] **Step 4: Manual smoke checklist (document results in the final report; do not skip)**

- Create form: type a passcode → after ~300ms the preview grid shows the card; type a bad token → red "Invalid" text; "Save Pool" → reload form → "Saved Pool" dropdown loads only the sets + IDs (packs/timer untouched).
- Pending draft page (a pending draft created from a set): "Card Pool (N cards)" section renders below Configuration, scrollable, search/filter/sort work, hovering (desktop) / tapping (narrow viewport) a tile shows the preview popup; the preview is dismissible on touch.
- Settings: "Card Pools" section lists pools with the "X sets · Y IDs" line; New Pool → name + builder + preview → Save adds it; Edit → rename → Save; rename to an existing name → inline 409 message; Delete → confirm → row disappears.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "chore(web): card pool viewer & management — verification fixes"
```

(Skip the commit if there is nothing to fix.)

---

## Notes for the executor

- **Order matters:** Tasks 1–4 are foundational (types, cache, two API routes). Task 5 (`CardPoolGrid`) depends on Task 1. Task 6 depends on Task 5. Task 7 touches both `CardHoverPopup` and `CardPoolGrid`. Task 8 (`PoolBuilder`) depends on Tasks 2, 3, 5. Task 9 depends on Task 8. Tasks 10–11 are independent of each other but Task 13 depends on Tasks 8 and 11. Execute in numerical order.
- **`DraftCardDetail` vs `CardSummary`:** they are intentionally the same shape. If TypeScript complains anywhere, make `DraftCardDetail` an alias of `CardSummary` (Task 6 note) rather than duplicating fields.
- **Do not** run `git push` or open a PR. The feature ships via local commits on the current branch.
- If a referenced existing test file (`pool-panel.test.tsx`, `draft-templates-route.test.ts`, `draft-manage-view.test.tsx`) does not exist, create only the parts the task describes; do not invent unrelated coverage.
