# Draft Fixes & Tournament Hand-off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five related issues: pool snapshot at creation, editable pending draft config, single packs-per-player knob, create tournament from completed draft, and pick-timer input that can be cleared.

**Architecture:** All business logic stays in `packages/shared`; web routes call shared helpers; Discord bot shares the same `createTournamentFromDraft` helper the web route uses. New columns are added via `addColumnIfMissing`. The only new files are `draft-tournament.ts` (shared service), `draft-config-fields.tsx` (shared component), and the web tournament route.

**Tech Stack:** SQLite/better-sqlite3, Next.js 15 App Router, React 18, Vitest, discord.js

---

## File map

**Create:**
- `packages/shared/src/services/draft-tournament.ts` — shared `createTournamentFromDraft` helper
- `packages/web/app/api/drafts/[slug]/tournament/route.ts` — POST tournament creation route
- `packages/web/src/components/draft/draft-config-fields.tsx` — shared pool+numeric form fields

**Modify:**
- `packages/shared/src/types/index.ts` — add `poolCardIds` to `DraftConfig`
- `packages/shared/src/db/schema.ts` — add `tournament_id` + `complete_message_id` columns to `drafts`
- `packages/shared/src/services/drafts.ts` — add `resolvePoolCardIds`, update `openWave`, update `create`
- `packages/shared/src/services/index.ts` — export new service
- `packages/web/app/api/drafts/route.ts` — POST: snapshot pool
- `packages/web/app/api/drafts/[slug]/route.ts` — PUT: merge config; POST(start): skip syncDraftPool if poolCardIds present
- `packages/web/src/components/draft/create-draft-form.tsx` — use DraftConfigFields, string state for numerics
- `packages/web/src/components/draft/draft-manage-view.tsx` — use DraftConfigFields, send full config
- `packages/web/src/components/draft/draft-summary-view.tsx` — add Create Tournament block
- `packages/web/src/lib/announce-bot.ts` — add `draft-completed` payload type
- `packages/bot/src/announce/server.ts` — add `draft-completed` announce route
- `packages/bot/src/announce/handlers.ts` — implement `onDraftCompleted`
- `packages/bot/src/announce/messages.ts` — add `draftCompletedAnnouncement`
- `packages/bot/src/services/draft-timer.ts` — call announceToBot on completion
- `packages/bot/src/interactions/buttons.ts` — add `draft:create-tournament:<id>` handler + format chooser
- `packages/bot/src/interactions/select-menus.ts` — add `draft:tournament-format:<id>` handler

**Tests (new files):**
- `packages/shared/tests/draft-pool-snapshot.test.ts`
- `packages/shared/tests/draft-tournament-helper.test.ts`
- `packages/web/tests/draft-tournament-route.test.ts`
- `packages/web/tests/drafts-put-route.test.ts`

---

## Task 1: Schema migrations

**Files:**
- Modify: `packages/shared/src/db/schema.ts`

- [ ] **Step 1: Add two columns to drafts via addColumnIfMissing**

At the end of the `migrate` function in `packages/shared/src/db/schema.ts`, after the existing `addColumnIfMissing` calls, add:

```typescript
  addColumnIfMissing(db, "drafts", "tournament_id", "integer references tournaments(id)");
  addColumnIfMissing(db, "drafts", "complete_message_id", "text");
```

- [ ] **Step 2: Run typecheck to confirm no breakage**

```bash
npm run typecheck --workspace=packages/shared
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/db/schema.ts
git commit -m "feat(db): add tournament_id and complete_message_id columns to drafts"
```

---

## Task 2: Extend DraftConfig type

**Files:**
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Add poolCardIds to DraftConfig**

In `packages/shared/src/types/index.ts`, replace the `DraftConfig` interface:

```typescript
export interface DraftConfig {
  setNames?: string[];
  customCardIds?: number[];
  includeNames?: string[];
  excludeNames?: string[];
  packSize?: number;
  packsPerPlayer?: number;
  pickSeconds?: number;
  alternatePassDirection?: boolean;
  randomizeSeats?: boolean;
  poolCardIds?: number[];
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck --workspace=packages/shared
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat(types): add poolCardIds to DraftConfig"
```

---

## Task 3: Add resolvePoolCardIds to draft service + update openWave

**Files:**
- Modify: `packages/shared/src/services/drafts.ts`

- [ ] **Step 1: Extract resolvePoolCardIds from catalogCardIdsForDraft**

The existing `catalogCardIdsForDraft(config)` function does exactly what we need. Add a public `resolvePoolCardIds` method to the returned service object, pointing to the existing internal function. Find the `return {` block at line ~710 and add it to the public surface:

```typescript
    resolvePoolCardIds(config: DraftConfig): number[] {
      return catalogCardIdsForDraft(config);
    },
```

- [ ] **Step 2: Update openWave to prefer poolCardIds**

Replace the first line of `openWave` (currently `const catalogCardIds = catalogCardIdsForDraft(config);`) with:

```typescript
    const catalogCardIds = config.poolCardIds && config.poolCardIds.length > 0
      ? config.poolCardIds
      : catalogCardIdsForDraft(config);
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck --workspace=packages/shared
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/services/drafts.ts
git commit -m "feat(drafts): add resolvePoolCardIds, update openWave to prefer frozen pool"
```

---

## Task 4: Snapshot pool on draft creation (web POST /api/drafts)

**Files:**
- Modify: `packages/web/app/api/drafts/route.ts`

- [ ] **Step 1: Import createCardCatalogService**

At the top of `packages/web/app/api/drafts/route.ts`, the import line currently is:
```typescript
import { createDraftService, createPlayerService } from "@yugidraft/shared/services";
```

Change it to:
```typescript
import { createCardCatalogService, createDraftService, createPlayerService } from "@yugidraft/shared/services";
```

- [ ] **Step 2: Resolve and freeze pool in POST**

In the `POST` handler, after creating the `drafts` service and before calling `drafts.create(...)`, add:

```typescript
  const cards = createCardCatalogService(db);
  await cards.syncDraftPool({
    setNames: config.setNames ?? [],
    customCardIds: config.customCardIds ?? [],
    includeNames: config.includeNames ?? [],
    excludeNames: config.excludeNames ?? [],
  });
  const poolCardIds = drafts.resolvePoolCardIds(config);
  if (poolCardIds.length === 0) {
    return NextResponse.json(
      { error: "No cards matched the selected sets / passcodes" },
      { status: 400 }
    );
  }
  const configWithPool: typeof config = { ...config, poolCardIds };
```

Then change `drafts.create(guildId, resolvedChannelId, name, config, ...)` to use `configWithPool`:

```typescript
  const draft = drafts.create(
    guildId,
    resolvedChannelId,
    name,
    configWithPool,
    session.user.id,
    player.id,
  );
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck --workspace=packages/web
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/app/api/drafts/route.ts
git commit -m "feat(web): snapshot poolCardIds at draft creation"
```

---

## Task 5: Fix PUT /api/drafts/[slug] — merge config + re-resolve pool

**Files:**
- Modify: `packages/web/app/api/drafts/[slug]/route.ts`

- [ ] **Step 1: Import createCardCatalogService in the slug route**

In `packages/web/app/api/drafts/[slug]/route.ts`, update the import line:
```typescript
import { createCardCatalogService, createDraftService } from "@yugidraft/shared/services";
```

- [ ] **Step 2: Replace the config update block in PUT**

Find this block in the `PUT` handler (around line 156):
```typescript
    if (config !== undefined) {
      db.prepare("update drafts set config_json = ? where id = ?").run(JSON.stringify(config), draft.id);
    }
```

Replace it with:
```typescript
    if (config !== undefined) {
      const drafts = createDraftService(db);
      const existing = drafts.findById(draft.id);
      const mergedConfig = { ...existing.config, ...(config as object) };

      const clampedPacks = Math.min(10, Math.max(1, Number((mergedConfig as any).packsPerPlayer) || 5));
      (mergedConfig as any).packsPerPlayer = clampedPacks;
      (mergedConfig as any).packSize = Math.ceil(40 / clampedPacks);

      const hasPool =
        ((mergedConfig as any).setNames?.length ?? 0) > 0 ||
        ((mergedConfig as any).customCardIds?.length ?? 0) > 0;
      if (!hasPool) {
        return NextResponse.json(
          { error: "Select at least one set or paste custom card IDs" },
          { status: 400 }
        );
      }

      const cards = createCardCatalogService(db);
      await cards.syncDraftPool({
        setNames: (mergedConfig as any).setNames ?? [],
        customCardIds: (mergedConfig as any).customCardIds ?? [],
        includeNames: (mergedConfig as any).includeNames ?? [],
        excludeNames: (mergedConfig as any).excludeNames ?? [],
      });
      const poolCardIds = drafts.resolvePoolCardIds(mergedConfig as any);
      if (poolCardIds.length === 0) {
        return NextResponse.json(
          { error: "No cards matched the selected sets / passcodes" },
          { status: 400 }
        );
      }
      (mergedConfig as any).poolCardIds = poolCardIds;

      db.prepare("update drafts set config_json = ? where id = ?").run(
        JSON.stringify(mergedConfig),
        draft.id,
      );
    }
```

- [ ] **Step 3: Skip syncDraftPool in POST(start) when poolCardIds is already set**

In the `POST` handler (the start route, around line 208), replace:
```typescript
    await cards.syncDraftPool({
      setNames: draftModel.config.setNames ?? [],
      customCardIds: draftModel.config.customCardIds ?? [],
      includeNames: draftModel.config.includeNames ?? [],
      excludeNames: draftModel.config.excludeNames ?? [],
    });
```

With:
```typescript
    if (!draftModel.config.poolCardIds || draftModel.config.poolCardIds.length === 0) {
      await cards.syncDraftPool({
        setNames: draftModel.config.setNames ?? [],
        customCardIds: draftModel.config.customCardIds ?? [],
        includeNames: draftModel.config.includeNames ?? [],
        excludeNames: draftModel.config.excludeNames ?? [],
      });
    }
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck --workspace=packages/web
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/drafts/[slug]/route.ts
git commit -m "fix(web): PUT drafts merges config, re-resolves poolCardIds, allows custom-pool-only edits"
```

---

## Task 6: Shared createTournamentFromDraft helper

**Files:**
- Create: `packages/shared/src/services/draft-tournament.ts`
- Modify: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Create the helper file**

Create `packages/shared/src/services/draft-tournament.ts`:

```typescript
import type Database from "better-sqlite3";
import type { TournamentFormat } from "./tournaments.js";

export type CreateTournamentFromDraftInput = {
  draftId: number;
  format: TournamentFormat;
  createdByUserId: string;
};

export type CreateTournamentFromDraftResult = {
  tournamentId: number;
  tournamentName: string;
  webSlug: string | undefined;
};

function assertFormat(format: string): asserts format is TournamentFormat {
  if (format !== "round_robin" && format !== "single_elim") {
    throw new Error("Unsupported tournament format");
  }
}

export function createDraftTournamentService(db: Database.Database) {
  return {
    createTournamentFromDraft(
      input: CreateTournamentFromDraftInput,
    ): CreateTournamentFromDraftResult {
      assertFormat(input.format);

      const draft = db
        .prepare("select id, guild_id, channel_id, name, status, created_by_user_id, tournament_id from drafts where id = ?")
        .get(input.draftId) as {
          id: number;
          guild_id: string;
          channel_id: string;
          name: string;
          status: string;
          created_by_user_id: string;
          tournament_id: number | null;
        } | undefined;

      if (!draft) throw new Error("Draft not found");
      if (draft.created_by_user_id !== input.createdByUserId) {
        throw new Error("Only the draft creator can create a tournament from this draft");
      }
      if (draft.status !== "completed") {
        throw new Error("Draft must be completed before creating a tournament");
      }
      if (draft.tournament_id !== null) {
        const existing = db
          .prepare("select id, web_slug, name from tournaments where id = ?")
          .get(draft.tournament_id) as { id: number; web_slug: string | null; name: string } | undefined;
        if (existing) {
          return {
            tournamentId: existing.id,
            tournamentName: existing.name,
            webSlug: existing.web_slug ?? undefined,
          };
        }
      }

      const { generateWebSlug } = require("../util/web-slug.js") as { generateWebSlug(): string };

      const result = db.transaction(() => {
        const insertResult = db
          .prepare(
            `insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug)
             values (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(draft.guild_id, draft.name, input.format, input.createdByUserId, generateWebSlug());

        const tournamentId = Number(insertResult.lastInsertRowid);

        const players = db
          .prepare("select player_id from draft_players where draft_id = ? order by joined_at asc, rowid asc")
          .all(draft.id) as Array<{ player_id: number }>;

        const joinStmt = db.prepare(
          "insert into tournament_participants (tournament_id, player_id) values (?, ?)",
        );
        for (const { player_id } of players) {
          joinStmt.run(tournamentId, player_id);
        }

        db.prepare("update drafts set tournament_id = ? where id = ?").run(tournamentId, draft.id);

        const tournament = db
          .prepare("select id, name, web_slug from tournaments where id = ?")
          .get(tournamentId) as { id: number; name: string; web_slug: string | null };

        return {
          tournamentId: tournament.id,
          tournamentName: tournament.name,
          webSlug: tournament.web_slug ?? undefined,
        };
      })();

      return result;
    },
  };
}

export type DraftTournamentService = ReturnType<typeof createDraftTournamentService>;
```

- [ ] **Step 2: Export from shared services index**

In `packages/shared/src/services/index.ts`, add:
```typescript
export { createDraftTournamentService } from "./draft-tournament.js";
export type { DraftTournamentService, CreateTournamentFromDraftInput, CreateTournamentFromDraftResult } from "./draft-tournament.js";
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck --workspace=packages/shared
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/services/draft-tournament.ts packages/shared/src/services/index.ts
git commit -m "feat(shared): add createDraftTournamentService helper"
```

---

## Task 7: Web route POST /api/drafts/[slug]/tournament

**Files:**
- Create: `packages/web/app/api/drafts/[slug]/tournament/route.ts`

- [ ] **Step 1: Create the route file**

Create `packages/web/app/api/drafts/[slug]/tournament/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createDraftTournamentService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();
    const guildId = env.discordGuildId;

    const draft = db
      .prepare("select id, created_by_user_id, status, tournament_id from drafts where web_slug = ? and guild_id = ?")
      .get(slug, guildId) as {
        id: number;
        created_by_user_id: string;
        status: string;
        tournament_id: number | null;
      } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.tournament_id !== null) {
      const existing = db
        .prepare("select id, name, web_slug, format from tournaments where id = ?")
        .get(draft.tournament_id) as { id: number; name: string; web_slug: string | null; format: string } | undefined;
      if (existing) {
        return NextResponse.json(
          { id: existing.id, name: existing.name, webSlug: existing.web_slug, format: existing.format },
          { status: 409 },
        );
      }
    }

    const body = await request.json();
    const { format } = body as { format?: string };

    if (!format || (format !== "round_robin" && format !== "single_elim")) {
      return NextResponse.json({ error: "format must be round_robin or single_elim" }, { status: 400 });
    }

    const service = createDraftTournamentService(db);
    const result = service.createTournamentFromDraft({
      draftId: draft.id,
      format,
      createdByUserId: session.user.id,
    });

    const tournament = db
      .prepare("select id, name, web_slug, format from tournaments where id = ?")
      .get(result.tournamentId) as { id: number; name: string; web_slug: string | null; format: string };

    return NextResponse.json(
      { id: tournament.id, name: tournament.name, webSlug: tournament.web_slug, format: tournament.format },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message.includes("Only the draft creator") ||
        error.message.includes("must be completed")
      ) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    console.error("[api/drafts/[slug]/tournament POST] error:", error);
    return NextResponse.json({ error: "Failed to create tournament" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck --workspace=packages/web
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/api/drafts/[slug]/tournament/route.ts
git commit -m "feat(web): POST /api/drafts/[slug]/tournament creates tournament from completed draft"
```

---

## Task 8: Shared DraftConfigFields component

**Files:**
- Create: `packages/web/src/components/draft/draft-config-fields.tsx`

- [ ] **Step 1: Create the component**

Create `packages/web/src/components/draft/draft-config-fields.tsx`:

```tsx
"use client";

import * as React from "react";
import type { DraftConfig } from "@yugidraft/shared/types";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { SetPicker } from "./set-picker";

export type DraftConfigFieldsValue = {
  setNames: string[];
  customCardText: string;
  packsPerPlayerText: string;
  pickSecondsText: string;
  alternatePass: boolean;
  randomizeSeats: boolean;
};

export function configFromFields(fields: DraftConfigFieldsValue): DraftConfig {
  const packsPerPlayer = Math.min(10, Math.max(1, parseInt(fields.packsPerPlayerText) || 5));
  const packSize = Math.ceil(40 / packsPerPlayer);
  const pickSeconds = Math.min(300, Math.max(5, parseInt(fields.pickSecondsText) || 45));
  const { cardIds: customCardIds } = parseCustomCardIds(fields.customCardText);
  return {
    setNames: fields.setNames,
    customCardIds,
    includeNames: [],
    excludeNames: [],
    packsPerPlayer,
    packSize,
    pickSeconds,
    alternatePassDirection: fields.alternatePass,
    randomizeSeats: fields.randomizeSeats,
  };
}

export function fieldsFromConfig(config: DraftConfig, customCardIds?: number[]): DraftConfigFieldsValue {
  const ids = customCardIds ?? config.customCardIds ?? [];
  return {
    setNames: config.setNames ?? [],
    customCardText: ids.join("\n"),
    packsPerPlayerText: String(config.packsPerPlayer ?? 5),
    pickSecondsText: String(config.pickSeconds ?? 45),
    alternatePass: config.alternatePassDirection ?? true,
    randomizeSeats: config.randomizeSeats ?? false,
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
  const packs = parseInt(fields.packsPerPlayerText);
  if (!packs || packs < 1 || packs > 10) {
    return "Packs per player must be between 1 and 10";
  }
  const secs = parseInt(fields.pickSecondsText);
  if (!secs || secs < 5 || secs > 300) {
    return "Pick timer must be between 5 and 300 seconds";
  }
  return null;
}

interface DraftConfigFieldsProps {
  value: DraftConfigFieldsValue;
  onChange: (value: DraftConfigFieldsValue) => void;
}

export function DraftConfigFields({ value, onChange }: DraftConfigFieldsProps) {
  const customCardParse = parseCustomCardIds(value.customCardText);
  const packsPerPlayer = Math.min(10, Math.max(1, parseInt(value.packsPerPlayerText) || 5));
  const cardsPerPack = Math.ceil(40 / packsPerPlayer);

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-text-primary">Sets</label>
        <SetPicker
          selectedSets={value.setNames}
          onSetsChange={(setNames) => onChange({ ...value, setNames })}
        />
      </div>

      <div>
        <label htmlFor="custom-card-ids" className="mb-1 block text-sm font-medium text-text-primary">
          Custom Card IDs
        </label>
        <textarea
          id="custom-card-ids"
          value={value.customCardText}
          onChange={(e) => onChange({ ...value, customCardText: e.target.value })}
          placeholder="46986414&#10;83764718, 12345678"
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <div className="mt-2 flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p className="text-text-secondary">
            Paste YGOPRODeck passcodes separated by new lines, commas, or spaces.
          </p>
          {customCardParse.errors.length > 0 && (
            <p className="text-accent-cta">Invalid: {customCardParse.errors.slice(0, 3).join(", ")}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="packs-per-player" className="mb-1 block text-sm font-medium text-text-primary">
            Packs per Player
          </label>
          <input
            id="packs-per-player"
            type="number"
            value={value.packsPerPlayerText}
            onChange={(e) => onChange({ ...value, packsPerPlayerText: e.target.value })}
            min={1}
            max={10}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
          <p className="mt-1 text-xs text-text-secondary">
            Each player drafts 40 cards across {packsPerPlayer} pack{packsPerPlayer !== 1 ? "s" : ""} of {cardsPerPack}.
          </p>
        </div>

        <div>
          <label htmlFor="pick-seconds" className="mb-1 block text-sm font-medium text-text-primary">
            Pick Timer (s)
          </label>
          <input
            id="pick-seconds"
            type="number"
            value={value.pickSecondsText}
            onChange={(e) => onChange({ ...value, pickSecondsText: e.target.value })}
            min={5}
            max={300}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
      </div>

      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={value.alternatePass}
            onChange={(e) => onChange({ ...value, alternatePass: e.target.checked })}
            className="h-4 w-4 rounded border-border accent-accent-primary"
          />
          Alternate pass direction
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={value.randomizeSeats}
            onChange={(e) => onChange({ ...value, randomizeSeats: e.target.checked })}
            className="h-4 w-4 rounded border-border accent-accent-primary"
          />
          Randomize seats
        </label>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck --workspace=packages/web
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/draft/draft-config-fields.tsx
git commit -m "feat(web): add shared DraftConfigFields component with string state for numerics"
```

---

## Task 9: Update CreateDraftForm to use DraftConfigFields

**Files:**
- Modify: `packages/web/src/components/draft/create-draft-form.tsx`

- [ ] **Step 1: Replace the form's pool+config state with DraftConfigFields**

Replace the entire `create-draft-form.tsx` content. The new version uses `DraftConfigFieldsValue` for pool state and `configFromFields`/`validateFields` on submit:

```tsx
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { DraftConfig } from "@yugidraft/shared/types";
import { Button } from "@/components/ui/button";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import {
  DraftConfigFields,
  type DraftConfigFieldsValue,
  configFromFields,
  validateFields,
} from "./draft-config-fields";

type Channel = { id: string; name: string };
type DraftTemplate = { id: number; name: string; config: DraftConfig };

export function CreateDraftForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [channelId, setChannelId] = React.useState("");
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = React.useState(true);
  const [templates, setTemplates] = React.useState<DraftTemplate[]>([]);
  const [selectedTemplateName, setSelectedTemplateName] = React.useState("");
  const [templateName, setTemplateName] = React.useState("");
  const [templateStatus, setTemplateStatus] = React.useState<string | null>(null);
  const [fields, setFields] = React.useState<DraftConfigFieldsValue>({
    setNames: [],
    customCardText: "",
    packsPerPlayerText: "5",
    pickSecondsText: "45",
    alternatePass: true,
    randomizeSeats: false,
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setChannelsLoading(true);
    fetch("/api/discord/channels")
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setChannels(data.channels ?? []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setChannelsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/draft-templates")
      .then((res) => (res.ok ? res.json() : { templates: [] }))
      .then((data) => { if (!cancelled) setTemplates(data.templates ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const applyTemplate = (template: DraftTemplate) => {
    const c = template.config;
    setSelectedTemplateName(template.name);
    setTemplateName(template.name);
    setFields({
      setNames: c.setNames ?? [],
      customCardText: (c.customCardIds ?? []).join("\n"),
      packsPerPlayerText: String(c.packsPerPlayer ?? 5),
      pickSecondsText: String(c.pickSeconds ?? 45),
      alternatePass: c.alternatePassDirection ?? true,
      randomizeSeats: c.randomizeSeats ?? false,
    });
    setTemplateStatus(`Loaded ${template.name}`);
  };

  const handleTemplateChange = (tName: string) => {
    const t = templates.find((item) => item.name === tName);
    if (t) applyTemplate(t);
  };

  const handleSaveTemplate = async () => {
    setTemplateStatus(null);
    setError(null);
    if (!templateName.trim()) { setError("Template name is required"); return; }
    const poolError = validateFields(fields);
    if (poolError) { setError(poolError); return; }

    const res = await fetch("/api/draft-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: templateName.trim(), config: configFromFields(fields) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to save pool");
      return;
    }
    const data = await res.json();
    const saved = data.template as DraftTemplate;
    setTemplates((cur) =>
      [...cur.filter((item) => item.name !== saved.name), saved].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setSelectedTemplateName(saved.name);
    setTemplateStatus(`Saved ${saved.name}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Draft name is required"); return; }
    const poolError = validateFields(fields);
    if (poolError) { setError(poolError); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          channelId: channelId || undefined,
          config: configFromFields(fields),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create draft");
      }
      const draft = await res.json();
      router.push(draft.webSlug ? `/draft/${draft.webSlug}` : "/drafts");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  const { cardIds } = parseCustomCardIds(fields.customCardText);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="draft-name" className="mb-1 block text-sm font-medium text-text-primary">
          Draft Name
        </label>
        <input
          id="draft-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Awesome Draft"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
          required
        />
      </div>

      <div>
        <label htmlFor="draft-channel" className="mb-1 block text-sm font-medium text-text-primary">
          Channel
        </label>
        <select
          id="draft-channel"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="native-select w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
        >
          <option value="">Default Channel</option>
          {channelsLoading ? (
            <option disabled>Loading channels...</option>
          ) : (
            channels.map((ch) => (
              <option key={ch.id} value={ch.id}>#{ch.name}</option>
            ))
          )}
        </select>
      </div>

      <div className="rounded-xl border border-border bg-surface/60 p-4">
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-text-primary">Pool Source</h2>
            <p className="mt-1 text-sm text-text-secondary">Combine synced sets with exact passcodes for a server-ready cube.</p>
          </div>
          <div className="flex gap-2 text-xs text-text-secondary">
            <span className="rounded-full border border-border px-2 py-1">{fields.setNames.length} sets</span>
            <span className="rounded-full border border-border px-2 py-1">{cardIds.length} cards</span>
          </div>
        </div>

        <div className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-border bg-bg-elevated/50 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div>
              <label htmlFor="saved-pool" className="mb-1 block text-sm font-medium text-text-primary">
                Saved Pool
              </label>
              <select
                id="saved-pool"
                value={selectedTemplateName}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className="native-select w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
              >
                <option value="">Choose a saved pool</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.name}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="template-name" className="mb-1 block text-sm font-medium text-text-primary">
                Template Name
              </label>
              <input
                id="template-name"
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Goat Cube"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={handleSaveTemplate}
              className="rounded-lg border border-accent-primary/60 bg-accent-primary/10 px-4 py-2 text-sm font-semibold text-accent-primary hover:bg-accent-primary/20"
            >
              Save Pool
            </button>
            {templateStatus && <p className="text-xs text-accent-primary sm:col-span-3">{templateStatus}</p>}
          </div>

          <DraftConfigFields value={fields} onChange={setFields} />
        </div>
      </div>

      <Button type="submit" loading={submitting} size="lg" className="w-full">
        Create Draft
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck --workspace=packages/web
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/draft/create-draft-form.tsx
git commit -m "refactor(web): CreateDraftForm uses DraftConfigFields, string state for numerics"
```

---

## Task 10: Update DraftManageView to use DraftConfigFields

**Files:**
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx`

- [ ] **Step 1: Add customCardIds to the draft prop type**

In `DraftManageViewProps`, update the `config` shape:
```typescript
    config: {
      packSize?: number;
      packsPerPlayer?: number;
      pickSeconds?: number;
      setNames?: string[];
      customCardIds?: number[];
      alternatePassDirection?: boolean;
      randomizeSeats?: boolean;
    };
```

- [ ] **Step 2: Replace config-edit state with DraftConfigFieldsValue**

Remove these state declarations:
```typescript
  const [editSetNames, setEditSetNames] = React.useState<string[]>(draft.config.setNames ?? []);
  const [editPackSize, setEditPackSize] = React.useState(draft.config.packSize ?? 8);
  const [editPacksPerPlayer, setEditPacksPerPlayer] = React.useState(draft.config.packsPerPlayer ?? 5);
  const [editPickSeconds, setEditPickSeconds] = React.useState(draft.config.pickSeconds ?? 45);
```

Add imports and replace with:
```typescript
import {
  DraftConfigFields,
  type DraftConfigFieldsValue,
  configFromFields,
  validateFields,
  fieldsFromConfig,
} from "./draft-config-fields";

// inside component, replacing the four removed state lines:
  const [editFields, setEditFields] = React.useState<DraftConfigFieldsValue>(() =>
    fieldsFromConfig(draft.config, draft.config.customCardIds),
  );
```

- [ ] **Step 3: Update handleStartEditConfig**

Replace the body of `handleStartEditConfig`:
```typescript
  const handleStartEditConfig = () => {
    setEditFields(fieldsFromConfig(draft.config, draft.config.customCardIds));
    setEditError(null);
    setIsEditingConfig(true);
  };
```

- [ ] **Step 4: Update handleCancelEditConfig**

Replace:
```typescript
  const handleCancelEditConfig = () => {
    setIsEditingConfig(false);
    setEditFields(fieldsFromConfig(draft.config, draft.config.customCardIds));
    setEditError(null);
  };
```

- [ ] **Step 5: Update handleSaveConfig**

Replace the entire `handleSaveConfig` function:
```typescript
  const handleSaveConfig = async () => {
    setEditError(null);
    const err = validateFields(editFields);
    if (err) { setEditError(err); return; }

    setConfigSaving(true);
    try {
      await onUpdate({ config: configFromFields(editFields) });
      setIsEditingConfig(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setConfigSaving(false);
    }
  };
```

- [ ] **Step 6: Replace the editing form JSX**

In the editing branch (`{isEditingConfig ? ( ... ) : ( ... )}`), replace the inner form with:
```tsx
          <div className="space-y-5">
            {editError && (
              <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
                {editError}
              </div>
            )}
            <DraftConfigFields value={editFields} onChange={setEditFields} />
            <div className="flex gap-3">
              <Button variant="primary" size="sm" loading={configSaving} onClick={handleSaveConfig}>
                Save Configuration
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancelEditConfig} disabled={configSaving}>
                Cancel
              </Button>
            </div>
          </div>
```

- [ ] **Step 7: Update the read view to show Packs/Player + Cards/Pack instead of Pack Size**

In the non-editing config display (the `sm:grid-cols-3` grid), replace the "Pack Size" tile with a "Cards/Pack" tile derived from the config:

```tsx
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
                  <span className="block text-xs text-text-muted">
                    <Package className="mr-1 inline h-3.5 w-3.5" />
                    Packs/Player
                  </span>
                  <span className="mt-1 block text-lg font-semibold text-text-primary">
                    {draft.config.packsPerPlayer ?? "—"}
                  </span>
                </div>
                <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
                  <span className="block text-xs text-text-muted">
                    <Package className="mr-1 inline h-3.5 w-3.5" />
                    Cards/Pack
                  </span>
                  <span className="mt-1 block text-lg font-semibold text-text-primary">
                    {draft.config.packSize ?? "—"}
                  </span>
                </div>
                <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
                  <span className="block text-xs text-text-muted">
                    <Clock className="mr-1 inline h-3.5 w-3.5" />
                    Pick Timer
                  </span>
                  <span className="mt-1 block text-lg font-semibold text-text-primary">
                    {draft.config.pickSeconds ? `${draft.config.pickSeconds}s` : "—"}
                  </span>
                </div>
              </div>
```

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck --workspace=packages/web
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/draft/draft-manage-view.tsx
git commit -m "fix(web): DraftManageView uses DraftConfigFields, merges custom IDs, fixes set-only validation"
```

---

## Task 11: Update DraftSummaryView — Create Tournament block

**Files:**
- Modify: `packages/web/src/components/draft/draft-summary-view.tsx`

- [ ] **Step 1: Add tournamentId to the draft prop type**

In `DraftSummaryViewProps`, update the draft type to include `tournamentId`:
```typescript
  draft: {
    id: number;
    name: string;
    status: string;
    createdByUserId: string;
    createdAt: string;
    startedAt?: string;
    endedAt?: string;
    config: {
      packSize?: number;
      packsPerPlayer?: number;
      pickSeconds?: number;
      setNames?: string[];
    };
    players: Array<{ ... }>;
    playerCount: number;
    participantPickCount?: number;
    tournamentId?: number | null;
  };
```

- [ ] **Step 2: Add tournament creation state**

Inside `DraftSummaryView`, add:
```typescript
  const [tournamentFormat, setTournamentFormat] = React.useState<"round_robin" | "single_elim">("round_robin");
  const [creatingTournament, setCreatingTournament] = React.useState(false);
  const [tournamentError, setTournamentError] = React.useState<string | null>(null);
  const [linkedTournament, setLinkedTournament] = React.useState<{ id: number; name: string; webSlug: string | null } | null>(null);
```

- [ ] **Step 3: Add handleCreateTournament**

```typescript
  const handleCreateTournament = async () => {
    setCreatingTournament(true);
    setTournamentError(null);
    try {
      const res = await fetch(`/api/drafts/${draft.id}/tournament`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: tournamentFormat }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.webSlug) {
          setLinkedTournament({ id: data.id, name: data.name, webSlug: data.webSlug });
          return;
        }
        throw new Error(data.error ?? "Failed to create tournament");
      }
      setLinkedTournament({ id: data.id, name: data.name, webSlug: data.webSlug });
    } catch (err) {
      setTournamentError(err instanceof Error ? err.message : "Failed to create tournament");
    } finally {
      setCreatingTournament(false);
    }
  };
```

Note: the fetch URL uses `draft.id` as a numeric id but we need the slug. The page passes `draft` with `id` but the route uses `slug`. Update the fetch to use the draft's webSlug if available. Because `DraftSummaryView` doesn't receive `webSlug` directly, we should pass `slug` as a prop. Add `slug: string` to `DraftSummaryViewProps` and update the call site in `page.tsx` (pass `slug={slug}`). Then use:
```typescript
      const res = await fetch(`/api/drafts/${slug}/tournament`, { ... });
```

- [ ] **Step 4: Add the Create Tournament block in JSX**

After the "Your Pool" section and before the Configuration section, add:

```tsx
      {isCompleted && isCreator && !linkedTournament && !draft.tournamentId && (
        <div className="rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-4 font-display text-lg text-text-primary">Create Tournament</h2>
          <p className="mb-4 text-sm text-text-secondary">
            Create a tournament seeded with all {draft.playerCount} players from this draft.
          </p>
          {tournamentError && (
            <div className="mb-4 rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
              {tournamentError}
            </div>
          )}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div>
              <label htmlFor="tournament-format" className="mb-1 block text-sm font-medium text-text-primary">
                Format
              </label>
              <select
                id="tournament-format"
                value={tournamentFormat}
                onChange={(e) => setTournamentFormat(e.target.value as "round_robin" | "single_elim")}
                className="native-select rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
              >
                <option value="round_robin">Round Robin</option>
                <option value="single_elim">Single Elimination</option>
              </select>
            </div>
            <Button variant="primary" loading={creatingTournament} onClick={handleCreateTournament}>
              Create Tournament
            </Button>
          </div>
        </div>
      )}

      {isCompleted && isCreator && (linkedTournament ?? draft.tournamentId) && (
        <div className="rounded-xl border border-border bg-surface p-6">
          <p className="text-sm text-text-secondary">
            Tournament created.{" "}
            {linkedTournament?.webSlug && (
              <a
                href={`/tournament/${linkedTournament.webSlug}`}
                className="font-semibold text-accent-primary underline"
              >
                View tournament
              </a>
            )}
          </p>
        </div>
      )}
```

- [ ] **Step 5: Pass slug from page.tsx**

In `packages/web/app/(app)/draft/[slug]/page.tsx`, find the `DraftSummaryView` usage and add `slug={slug}`:
```tsx
      <DraftSummaryView
        draft={draft}
        slug={slug}
        isParticipant={isParticipant}
        isCreator={isCreator}
        onExportYdk={handleExportYdk}
        onDelete={handleDelete}
        myPool={draft.myPool}
      />
```

Also update the `DraftData` type to include `tournamentId?: number | null` and pass it through.

- [ ] **Step 6: Update API response to include tournamentId**

In `packages/web/app/api/drafts/[slug]/helpers.ts` (or wherever `buildDraftResponse` is), include `tournament_id` in the returned data. If the field isn't yet in the query, add it. Look at the `buildDraftResponse` function and ensure `tournament_id` is mapped to `tournamentId`.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck --workspace=packages/web
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/draft/draft-summary-view.tsx \
        packages/web/app/\(app\)/draft/\[slug\]/page.tsx
git commit -m "feat(web): DraftSummaryView shows Create Tournament block for completed drafts"
```

---

## Task 12: Bot — draft-completed announce plumbing

**Files:**
- Modify: `packages/web/src/lib/announce-bot.ts`
- Modify: `packages/bot/src/announce/server.ts`
- Modify: `packages/bot/src/announce/handlers.ts`
- Modify: `packages/bot/src/announce/messages.ts`

- [ ] **Step 1: Add draft-completed payload to announce-bot.ts**

In `packages/web/src/lib/announce-bot.ts`, add to the `AnnouncePayload` union:
```typescript
  | { kind: "draft-completed"; draftId: number; channelId: string; name: string; webSlug: string }
```

- [ ] **Step 2: Add the route in announce server**

In `packages/bot/src/announce/server.ts`, add to the `AnnouncePayload` union:
```typescript
  | { kind: "draft-completed"; draftId: number; channelId: string; name: string; webSlug: string }
```

Add `onDraftCompleted` to `AnnounceHandlers`:
```typescript
  onDraftCompleted(payload: OmitKind<Extract<AnnouncePayload, { kind: "draft-completed" }>>): Promise<void>;
```

Add the route in the `routes` object inside `createAnnounceServer`:
```typescript
    "/internal/announce/draft-completed": (d) => opts.handlers.onDraftCompleted(d),
```

- [ ] **Step 3: Add draftCompletedAnnouncement to messages.ts**

In `packages/bot/src/announce/messages.ts`, add:
```typescript
export function draftCompletedAnnouncement(input: { name: string; webSlug: string; webUrl?: string }): {
  content: string;
  components: import("discord.js").ActionRowBuilder<import("discord.js").ButtonBuilder>[];
} {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
  return {
    content: `**${input.name}** has completed! View results: ${webBaseUrl(input.webUrl)}/draft/${input.webSlug}`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`draft:create-tournament:${input.webSlug}`)
          .setLabel("Create Tournament")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}
```

Note: because the bot's announce/messages.ts is plain TypeScript (not CJS), use ESM imports at the top of the file instead of `require`. Add these imports at the top of `messages.ts`:
```typescript
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
```

And the function body becomes:
```typescript
export function draftCompletedAnnouncement(input: { name: string; webSlug: string; webUrl?: string }): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    content: `**${input.name}** has completed! View results: ${webBaseUrl(input.webUrl)}/draft/${input.webSlug}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`draft:create-tournament:${input.webSlug}`)
          .setLabel("Create Tournament")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}
```

- [ ] **Step 4: Implement onDraftCompleted in handlers.ts**

In `packages/bot/src/announce/handlers.ts`, import the new message function and add `onDraftCompleted` to the returned `AnnounceHandlers`:

```typescript
import { draftCreatedAnnouncement, draftCompletedAnnouncement, tournamentCreatedAnnouncement, tournamentStartedAnnouncement } from "./messages.js";

// In createAnnounceHandlers, add to the handlers object:
    async onDraftCompleted({ draftId, channelId, name, webSlug }) {
      const db = (drafts as any)._db ?? undefined; // we need db access — see note below
      // Check complete_message_id to avoid double-posting
      // We need db access here; pass it via the factory params
    },
```

**Note:** `createAnnounceHandlers` currently receives `{ client, drafts, messenger }`. The `drafts` service doesn't expose `complete_message_id`. We need to expose a method on the service — or pass `db` directly. The simplest approach: add `setCompleteMessageId(draftId, messageId)` and `findById` (already public) to the draft service and expose `completeMessageId` from `findById`. Since `Draft` type doesn't carry `completeMessageId` yet, the cleanest path is to query raw DB in the announce handler via a passed `db` param.

Update `createAnnounceHandlers` signature to accept `db`:

```typescript
import type Database from "better-sqlite3";

export function createAnnounceHandlers({
  client,
  db,
}: {
  client: Pick<Client, "channels">;
  drafts: DraftService;
  messenger: DraftMessenger;
  db: Database.Database;
}): AnnounceHandlers {
```

Then `onDraftCompleted`:
```typescript
    async onDraftCompleted({ draftId, channelId, name, webSlug }) {
      const existing = db
        .prepare("select complete_message_id from drafts where id = ?")
        .get(draftId) as { complete_message_id: string | null } | undefined;
      if (existing?.complete_message_id) return; // already posted

      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;

      const msg = await channel.send(draftCompletedAnnouncement({ name, webSlug }));
      db.prepare("update drafts set complete_message_id = ? where id = ?").run(msg.id, draftId);
    },
```

- [ ] **Step 5: Pass db to createAnnounceHandlers in index.ts**

In `packages/bot/src/index.ts`, find the `createAnnounceHandlers` call and add `db`:
```typescript
  const announceHandlers = createAnnounceHandlers({ client, drafts: deps.drafts, messenger, db });
```

- [ ] **Step 6: Typecheck bot**

```bash
npm run typecheck --workspace=packages/bot
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/lib/announce-bot.ts \
        packages/bot/src/announce/server.ts \
        packages/bot/src/announce/handlers.ts \
        packages/bot/src/announce/messages.ts \
        packages/bot/src/index.ts
git commit -m "feat(bot): add draft-completed announce handler with Create Tournament button"
```

---

## Task 13: Bot draft-timer — post completion message

**Files:**
- Modify: `packages/bot/src/services/draft-timer.ts`

- [ ] **Step 1: Add announceToBot to draft-timer**

Update `createDraftTimerService` to accept the announce URL+secret:

```typescript
import { announceToBot } from "../lib/announce-bot.js";
// (announceToBot is already used in the web; the bot has its own copy or we need to create one)
```

Check if `packages/bot/src/lib/announce-bot.ts` exists. If not, create it as a copy of the web version (same HMAC logic but pointing at the bot's own announce server — actually we need to post to the WEB's announce server or we need a different mechanism).

**Actually:** Looking at the architecture, the bot's draft-timer runs in the bot process. To call `onDraftCompleted`, we can either:
- Call `announceHandlers.onDraftCompleted(...)` directly (since timer and handlers are in the same process)
- Or post HTTP to the bot's own announce endpoint

The simplest and most correct approach: pass `onDraftCompleted` as a callback into `createDraftTimerService`.

Update `createDraftTimerService`:

```typescript
export function createDraftTimerService({
  drafts,
  messenger,
  wsCfg,
  onDraftCompleted,
}: {
  drafts: DraftService;
  messenger: DraftMessenger;
  wsCfg: { url: string; secret: string };
  onDraftCompleted?: (draftId: number) => Promise<void>;
}) {
```

Then in the tick where `updatedDraft.status === "completed"`, add:
```typescript
        if (updatedDraft.status === "completed") {
          await notifyWs(wsCfg, "complete", updatedDraft.webSlug);
          if (onDraftCompleted) {
            await onDraftCompleted(updatedDraft.id).catch((err) =>
              console.warn(`[draft-timer] onDraftCompleted failed for ${updatedDraft.id}:`, err),
            );
          }
        }
```

- [ ] **Step 2: Wire onDraftCompleted in index.ts**

In `packages/bot/src/index.ts`, pass the callback to `createDraftTimerService`:

```typescript
const timer = createDraftTimerService({
  drafts: deps.drafts,
  messenger,
  wsCfg: { url: wsInternalUrl, secret: wsInternalSecret },
  onDraftCompleted: async (draftId) => {
    const draft = deps.drafts.findById(draftId);
    if (!draft.webSlug || !draft.channelId) return;
    await announceHandlers.onDraftCompleted({
      draftId: draft.id,
      channelId: draft.channelId,
      name: draft.name,
      webSlug: draft.webSlug,
    });
  },
});
```

- [ ] **Step 3: Typecheck bot**

```bash
npm run typecheck --workspace=packages/bot
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/bot/src/services/draft-timer.ts packages/bot/src/index.ts
git commit -m "feat(bot): draft-timer posts completion announcement via callback"
```

---

## Task 14: Bot buttons — draft:create-tournament handler

**Files:**
- Modify: `packages/bot/src/interactions/buttons.ts`
- Modify: `packages/bot/src/interactions/select-menus.ts`

- [ ] **Step 1: Add createDraftTournamentService to button dependencies**

In `packages/bot/src/interactions/buttons.ts`, add to imports:
```typescript
import { createDraftTournamentService } from "@yugidraft/shared/services";
import type Database from "better-sqlite3";
```

Add `db` to `ButtonDependencies`:
```typescript
type ButtonDependencies = {
  matches: MatchService;
  players: PlayerRepository;
  tournaments: TournamentService;
  drafts: DraftService;
  cards: CardCatalogService;
  db: Database.Database;
};
```

- [ ] **Step 2: Add the draft:create-tournament button handler**

In `handleButton`, before the final `throw new Error("Unsupported button interaction")`, add:

```typescript
  const createTournament = /^draft:create-tournament:([a-z0-9-]+)$/.exec(interaction.customId);

  if (createTournament) {
    const webSlug = createTournament[1];
    const guildId = requireGuildId(interaction);

    const draft = deps.drafts.autocomplete({ guildId, query: "" })
      .find(() => true); // we need to look up by webSlug — use raw db

    // Look up the draft by webSlug via the db passed in deps
    const draftRow = (deps as any).db
      .prepare("select id, created_by_user_id, status, tournament_id, channel_id, name from drafts where web_slug = ?")
      .get(webSlug) as {
        id: number;
        created_by_user_id: string;
        status: string;
        tournament_id: number | null;
        channel_id: string;
        name: string;
      } | undefined;

    if (!draftRow) {
      await interaction.reply({ content: "Draft not found.", ephemeral: true });
      return;
    }

    if (draftRow.created_by_user_id !== interaction.user.id) {
      await interaction.reply({ content: "Only the draft creator can create a tournament.", ephemeral: true });
      return;
    }

    if (draftRow.tournament_id !== null) {
      const existingTournament = deps.tournaments.findById(draftRow.tournament_id);
      const link = existingTournament.webSlug ? ` View: ${WEB_URL}/tournament/${existingTournament.webSlug}` : "";
      await interaction.reply({ content: `Tournament already created.${link}`, ephemeral: true });
      return;
    }

    await interaction.reply({
      content: "Choose a tournament format:",
      ephemeral: true,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`draft:tournament-format:${webSlug}`)
            .setPlaceholder("Select format")
            .addOptions(
              { label: "Round Robin", value: "round_robin" },
              { label: "Single Elimination", value: "single_elim" },
            ),
        ),
      ],
    });
    return;
  }
```

- [ ] **Step 3: Add draft:tournament-format select-menu handler**

In `packages/bot/src/interactions/select-menus.ts`, add `db` to `SelectMenuDependencies`:
```typescript
import type Database from "better-sqlite3";
import { createDraftTournamentService } from "@yugidraft/shared/services";

type SelectMenuDependencies = {
  tournaments: TournamentService;
  players: PlayerRepository;
  drafts: DraftService;
  cards: CardCatalogService;
  messenger: DraftMessenger;
  db: Database.Database;
};
```

Before the final `throw new Error("Unsupported select menu interaction")`, add:

```typescript
  const draftTournamentFormat = /^draft:tournament-format:([a-z0-9-]+)$/.exec(interaction.customId);

  if (draftTournamentFormat) {
    const webSlug = draftTournamentFormat[1];
    const format = interaction.values[0];

    if (format !== "round_robin" && format !== "single_elim") {
      await interaction.reply({ content: "Invalid format.", ephemeral: true });
      return;
    }

    const draftRow = deps.db
      .prepare("select id, created_by_user_id, status from drafts where web_slug = ?")
      .get(webSlug) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!draftRow) {
      await interaction.reply({ content: "Draft not found.", ephemeral: true });
      return;
    }

    if (draftRow.created_by_user_id !== interaction.user.id) {
      await interaction.reply({ content: "Only the draft creator can create a tournament.", ephemeral: true });
      return;
    }

    const service = createDraftTournamentService(deps.db);
    try {
      const result = service.createTournamentFromDraft({
        draftId: draftRow.id,
        format,
        createdByUserId: interaction.user.id,
      });
      const link = result.webSlug ? ` View: ${WEB_URL}/tournament/${result.webSlug}` : "";
      await interaction.reply({ content: `Tournament **${result.tournamentName}** created.${link}`, ephemeral: true });
    } catch (err) {
      await interaction.reply({
        content: err instanceof Error ? err.message : "Failed to create tournament.",
        ephemeral: true,
      });
    }
    return;
  }
```

Add `const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";` near the top of select-menus.ts.

- [ ] **Step 4: Pass db to button/select-menu deps in index.ts**

In `packages/bot/src/index.ts`, ensure the `deps` objects passed to `handleButton` and `handleSelectMenu` include `db`.

- [ ] **Step 5: Typecheck bot**

```bash
npm run typecheck --workspace=packages/bot
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/bot/src/interactions/buttons.ts packages/bot/src/interactions/select-menus.ts packages/bot/src/index.ts
git commit -m "feat(bot): draft:create-tournament button + format select-menu handler"
```

---

## Task 15: Tests — pool snapshot (shared)

**Files:**
- Create: `packages/shared/tests/draft-pool-snapshot.test.ts`

- [ ] **Step 1: Write the tests**

Create `packages/shared/tests/draft-pool-snapshot.test.ts`:

```typescript
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { createDraftService } from "../src/services/drafts.js";

function seedDb(db: Database.Database) {
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u1', 'Alice')").run();
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u2', 'Bob')").run();
  // Insert catalog cards with set membership
  const insertCard = db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, 'Effect Monster', 'effect', '', '', ?, current_timestamp)`,
  );
  for (let i = 1; i <= 20; i++) {
    insertCard.run(i, `Card ${i}`, JSON.stringify([{ set_name: "Set A" }]));
  }
}

describe("pool snapshot", () => {
  it("resolvePoolCardIds returns cards matching the recipe", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db);
    const drafts = createDraftService(db);
    const ids = drafts.resolvePoolCardIds({ setNames: ["Set A"] });
    expect(ids).toHaveLength(20);
    expect(ids).toContain(1);
  });

  it("openWave uses poolCardIds when present, ignoring catalog changes", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db);

    const drafts = createDraftService(db);
    const poolCardIds = drafts.resolvePoolCardIds({ setNames: ["Set A"] });

    const alice = db.prepare("select id from players where discord_user_id = 'u1'").get() as { id: number };
    const bob = db.prepare("select id from players where discord_user_id = 'u2'").get() as { id: number };

    const draft = drafts.create("g1", "ch1", "Test Draft", {
      setNames: ["Set A"],
      poolCardIds,
      packsPerPlayer: 5,
      packSize: 8,
      pickSeconds: 45,
    }, "u1", alice.id);

    drafts.join(draft.id, bob.id);

    // Add a new card to catalog AFTER draft creation (simulates daily sync)
    db.prepare(
      `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
       values (999, 'New Card', 'Effect Monster', 'effect', '', '', '[{"set_name":"Set A"}]', current_timestamp)`,
    ).run();

    // Start the draft — openWave should not include card 999
    drafts.start(draft.id);

    const waveCards = db
      .prepare("select catalog_card_id from draft_cards where draft_id = ?")
      .all(draft.id) as Array<{ catalog_card_id: number }>;

    const cardIds = waveCards.map((r) => r.catalog_card_id);
    expect(cardIds).not.toContain(999);
  });

  it("openWave falls back to catalog when poolCardIds is absent (old draft)", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db);

    const drafts = createDraftService(db);
    const alice = db.prepare("select id from players where discord_user_id = 'u1'").get() as { id: number };
    const bob = db.prepare("select id from players where discord_user_id = 'u2'").get() as { id: number };

    // Create draft WITHOUT poolCardIds (simulates old draft)
    const draft = drafts.create("g1", "ch1", "Old Draft", {
      setNames: ["Set A"],
      packsPerPlayer: 5,
      packSize: 8,
      pickSeconds: 45,
    }, "u1", alice.id);

    drafts.join(draft.id, bob.id);
    drafts.start(draft.id);

    const waveCards = db
      .prepare("select catalog_card_id from draft_cards where draft_id = ?")
      .all(draft.id) as Array<{ catalog_card_id: number }>;

    expect(waveCards.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
npx vitest run packages/shared/tests/draft-pool-snapshot.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/tests/draft-pool-snapshot.test.ts
git commit -m "test(shared): pool snapshot — resolvePoolCardIds, openWave uses frozen pool, fallback for old drafts"
```

---

## Task 16: Tests — createTournamentFromDraft (shared)

**Files:**
- Create: `packages/shared/tests/draft-tournament-helper.test.ts`

- [ ] **Step 1: Write the tests**

Create `packages/shared/tests/draft-tournament-helper.test.ts`:

```typescript
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { createDraftService } from "../src/services/drafts.js";
import { createDraftTournamentService } from "../src/services/draft-tournament.js";

function seedDb(db: Database.Database) {
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u1', 'Alice')").run();
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u2', 'Bob')").run();
  for (let i = 1; i <= 40; i++) {
    db.prepare(
      `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
       values (?, ?, 'Effect Monster', 'effect', '', '', '[{"set_name":"Set A"}]', current_timestamp)`,
    ).run(i, `Card ${i}`);
  }
}

function completeDraft(db: Database.Database) {
  seedDb(db);
  const drafts = createDraftService(db);
  const alice = db.prepare("select id from players where discord_user_id = 'u1'").get() as { id: number };
  const bob = db.prepare("select id from players where discord_user_id = 'u2'").get() as { id: number };
  const poolCardIds = drafts.resolvePoolCardIds({ setNames: ["Set A"] });
  const draft = drafts.create("g1", "ch1", "Test Draft", {
    setNames: ["Set A"], poolCardIds, packsPerPlayer: 5, packSize: 8, pickSeconds: 45,
  }, "u1", alice.id);
  drafts.join(draft.id, bob.id);
  db.prepare("update drafts set status = 'completed' where id = ?").run(draft.id);
  return { draft, aliceId: alice.id, bobId: bob.id };
}

describe("createTournamentFromDraft", () => {
  it("creates a tournament and seeds all players", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { draft } = completeDraft(db);
    const service = createDraftTournamentService(db);

    const result = service.createTournamentFromDraft({
      draftId: draft.id,
      format: "round_robin",
      createdByUserId: "u1",
    });

    expect(result.tournamentName).toBe("Test Draft");
    const participants = db
      .prepare("select player_id from tournament_participants where tournament_id = ?")
      .all(result.tournamentId) as Array<{ player_id: number }>;
    expect(participants).toHaveLength(2);
  });

  it("is idempotent — second call returns existing tournament", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { draft } = completeDraft(db);
    const service = createDraftTournamentService(db);

    const r1 = service.createTournamentFromDraft({ draftId: draft.id, format: "round_robin", createdByUserId: "u1" });
    const r2 = service.createTournamentFromDraft({ draftId: draft.id, format: "single_elim", createdByUserId: "u1" });

    expect(r1.tournamentId).toBe(r2.tournamentId);
  });

  it("rejects non-creator", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { draft } = completeDraft(db);
    const service = createDraftTournamentService(db);

    expect(() =>
      service.createTournamentFromDraft({ draftId: draft.id, format: "round_robin", createdByUserId: "u2" }),
    ).toThrow("Only the draft creator");
  });

  it("rejects non-completed draft", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db);
    const drafts = createDraftService(db);
    const alice = db.prepare("select id from players where discord_user_id = 'u1'").get() as { id: number };
    const poolCardIds = drafts.resolvePoolCardIds({ setNames: ["Set A"] });
    const draft = drafts.create("g1", "ch1", "Pending", {
      setNames: ["Set A"], poolCardIds, packsPerPlayer: 5, packSize: 8, pickSeconds: 45,
    }, "u1", alice.id);

    const service = createDraftTournamentService(db);
    expect(() =>
      service.createTournamentFromDraft({ draftId: draft.id, format: "round_robin", createdByUserId: "u1" }),
    ).toThrow("must be completed");
  });

  it("stores tournament_id on the draft row", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { draft } = completeDraft(db);
    const service = createDraftTournamentService(db);

    const result = service.createTournamentFromDraft({ draftId: draft.id, format: "round_robin", createdByUserId: "u1" });

    const row = db.prepare("select tournament_id from drafts where id = ?").get(draft.id) as { tournament_id: number };
    expect(row.tournament_id).toBe(result.tournamentId);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
npx vitest run packages/shared/tests/draft-tournament-helper.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/tests/draft-tournament-helper.test.ts
git commit -m "test(shared): createTournamentFromDraft — happy path, idempotent, rejects non-creator/non-completed"
```

---

## Task 17: Tests — web routes (PUT merge + tournament route)

**Files:**
- Create: `packages/web/tests/drafts-put-route.test.ts`
- Create: `packages/web/tests/draft-tournament-route.test.ts`

- [ ] **Step 1: Write PUT route tests**

Create `packages/web/tests/drafts-put-route.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("PUT /api/drafts/[slug]", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "creator-user", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_DEFAULT_CHANNEL_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function setupDraftWithCustomPool() {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-put-route-"));
    const dbPath = join(tempDir, "test.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const db = new Database(dbPath);
    migrate(db);

    // Seed catalog cards
    for (let i = 1; i <= 10; i++) {
      db.prepare(
        `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
         values (?, ?, 'Effect Monster', 'effect', '', '', '[]', current_timestamp)`,
      ).run(i, `Card ${i}`);
    }

    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1', 'creator-user', 'Yugi')").run();
    const playerRow = db.prepare("select id from players where discord_user_id = 'creator-user'").get() as { id: number };

    db.prepare(
      `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug)
       values ('guild-1', 'channel-1', 'My Draft', 'pending', 'creator-user', ?, 'test-slug')`,
    ).run(JSON.stringify({
      customCardIds: [1, 2, 3],
      setNames: [],
      packsPerPlayer: 5,
      packSize: 8,
      pickSeconds: 45,
      poolCardIds: [1, 2, 3],
    }));
    db.prepare("insert into draft_players (draft_id, player_id) values (1, ?)").run(playerRow.id);
    db.close();

    return dbPath;
  }

  it("merges config without dropping customCardIds when only numeric fields sent", async () => {
    await setupDraftWithCustomPool();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const request = new Request("http://localhost/api/drafts/test-slug", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { packsPerPlayer: 3 } }),
    }) as NextRequest;

    const response = await PUT(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.config.customCardIds).toEqual([1, 2, 3]);
    expect(data.config.packsPerPlayer).toBe(3);
    expect(data.config.packSize).toBe(14); // ceil(40/3)
  });

  it("allows editing when 0 sets but customCardIds are present", async () => {
    await setupDraftWithCustomPool();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const request = new Request("http://localhost/api/drafts/test-slug", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { setNames: [], customCardIds: [1, 2, 3], pickSeconds: 60 } }),
    }) as NextRequest;

    const response = await PUT(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(200);
  });

  it("rejects when merged config has no pool", async () => {
    await setupDraftWithCustomPool();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const request = new Request("http://localhost/api/drafts/test-slug", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { setNames: [], customCardIds: [] } }),
    }) as NextRequest;

    const response = await PUT(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/at least one set/i);
  });
});
```

- [ ] **Step 2: Write tournament route tests**

Create `packages/web/tests/draft-tournament-route.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/drafts/[slug]/tournament", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "creator-user", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function setupCompletedDraft() {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-tournament-route-"));
    const dbPath = join(tempDir, "test.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const db = new Database(dbPath);
    migrate(db);

    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1', 'creator-user', 'Yugi')").run();
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1', 'other-user', 'Kaiba')").run();
    const p1 = db.prepare("select id from players where discord_user_id = 'creator-user'").get() as { id: number };
    const p2 = db.prepare("select id from players where discord_user_id = 'other-user'").get() as { id: number };

    db.prepare(
      `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug)
       values ('guild-1', 'ch1', 'My Draft', 'completed', 'creator-user', '{}', 'test-slug')`,
    ).run();
    db.prepare("insert into draft_players (draft_id, player_id) values (1, ?)").run(p1.id);
    db.prepare("insert into draft_players (draft_id, player_id) values (1, ?)").run(p2.id);
    db.close();
  }

  it("creates a round-robin tournament seeded with draft players", async () => {
    await setupCompletedDraft();
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    const request = new Request("http://localhost/api/drafts/test-slug/tournament", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "round_robin" }),
    }) as NextRequest;

    const response = await POST(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.format).toBe("round_robin");
    expect(data.name).toBe("My Draft");
  });

  it("returns 409 when tournament already linked", async () => {
    await setupCompletedDraft();
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    const req = () => new Request("http://localhost/api/drafts/test-slug/tournament", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "round_robin" }),
    }) as NextRequest;

    await POST(req(), { params: Promise.resolve({ slug: "test-slug" }) });
    const response2 = await POST(req(), { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response2.status).toBe(409);
  });

  it("returns 403 when non-creator calls the route", async () => {
    await setupCompletedDraft();
    auth.mockResolvedValue({ user: { id: "other-user", name: "Kaiba" } });
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    const request = new Request("http://localhost/api/drafts/test-slug/tournament", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "round_robin" }),
    }) as NextRequest;

    const response = await POST(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid format", async () => {
    await setupCompletedDraft();
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    const request = new Request("http://localhost/api/drafts/test-slug/tournament", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "invalid" }),
    }) as NextRequest;

    const response = await POST(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run all new tests**

```bash
npx vitest run packages/web/tests/drafts-put-route.test.ts packages/web/tests/draft-tournament-route.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/web/tests/drafts-put-route.test.ts packages/web/tests/draft-tournament-route.test.ts
git commit -m "test(web): PUT drafts merge config, POST tournament route — creator-only, idempotent, format validation"
```

---

## Task 18: Final typecheck and full test run

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all packages pass.

- [ ] **Step 2: Run full typecheck**

```bash
npm run typecheck
```

Expected: zero errors across all packages.

- [ ] **Step 3: Build shared to confirm no compile regressions**

```bash
npm run build --workspace=packages/shared
```

Expected: clean build.

- [ ] **Step 4: Commit if any final fixes were needed**

```bash
git add -A
git commit -m "fix: final typecheck and test pass cleanup"
```
