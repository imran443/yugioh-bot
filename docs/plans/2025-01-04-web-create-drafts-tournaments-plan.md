# Web Draft & Tournament Creation + Settings — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow authenticated web users to create drafts and tournaments from the web UI, with set browsing, channel selection, and per-guild announcement settings.

**Architecture:** Use env vars for default guild/channel, auto-create `players` rows for web users, add `guild_settings` table for announcement toggles, cache YGOPRODeck sets aggressively, and build multi-step forms with existing UI components.

**Tech Stack:** Next.js 16, better-sqlite3, NextAuth (Discord), SWR, Zustand, TailwindCSS v4, lucide-react, vitest + @testing-library/react

---

## Task 1: Add `card_count` column to `card_sets` table

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (add migration line)

**Step 1: Add migration line**

In `schema.ts`, after the existing `addColumnIfMissing` calls (around line 218), add:

```ts
addColumnIfMissing(db, "card_sets", "card_count", "integer");
addColumnIfMissing(db, "card_sets", "set_code", "text");
```

**Step 2: Run typecheck**

Run: `npx turbo run typecheck --filter=@yugioh-discord-bot/web`
Expected: PASS

**Step 3: Start the dev server briefly and verify the column exists**

Run: `sqlite3 data/bot.sqlite "PRAGMA table_info(card_sets);"` — should show `card_count` and `set_code` columns.

**Step 4: Commit**

```bash
git add packages/shared/src/db/schema.ts
git commit -m "feat: add card_count and set_code columns to card_sets table"
```

---

## Task 2: Update `syncSets` to store `card_count` and `set_code`

**Files:**
- Modify: `packages/shared/src/services/card-catalog.ts`

**Step 1: Update the `syncSets` method**

The YGOPRODeck `/api/v7/cardsets.php` response includes more fields than just `set_name`. Update the response type and insert to capture `card_count` and `set_code`:

```ts
type YgoprodeckSetInfo = {
  set_name: string;
  set_code: string;
  num_cards: number;
};
```

Change `syncSets` to parse `YgoprodeckSetInfo[]`, and insert `set_code` and `card_count`:

```ts
const payload = (await response.json()) as YgoprodeckSetInfo[];
const insert = db.prepare(
  `insert or replace into card_sets (set_name, set_code, card_count, synced_at) values (?, ?, ?, ?)`
);
db.transaction(() => {
  for (const set of payload) {
    insert.run(set.set_name, set.set_code, set.num_cards, syncedAt);
  }
})();
return payload.map((s) => s.set_name);
```

Also update `listSets` to return `set_code` and `card_count` in its result:

```ts
listSets(query?: string): Array<{ setName: string; setCode: string; cardCount: number }> {
  const hasQuery = query && query.trim().length > 0;
  const sql = hasQuery
    ? `select set_name, set_code, card_count from card_sets where lower(set_name) like lower(?) order by set_name limit 25`
    : `select set_name, set_code, card_count from card_sets order by set_name limit 25`;
  const rows = hasQuery
    ? db.prepare(sql).all(`%${query.trim()}%`)
    : db.prepare(sql).all();
  return (rows as Array<{ set_name: string; set_code: string; card_count: number }>).map((row) => ({
    setName: row.set_name,
    setCode: row.set_code ?? "",
    cardCount: row.card_count ?? 0,
  }));
}
```

**Step 2: Update the return type on the exported `CardCatalogService` type if needed**

**Step 3: Run typecheck**

Run: `npx turbo run typecheck --filter=@yugidraft/shared`
Then: `npx turbo run typecheck --filter=@yugioh-discord-bot/web`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/shared/src/services/card-catalog.ts
git commit -m "feat: store set_code and card_count when syncing card sets"
```

---

## Task 3: Add `guild_settings` table to the schema

**Files:**
- Modify: `packages/shared/src/db/schema.ts`

**Step 1: Add the `guild_settings` table creation inside the `migrate` function**

After the existing `create table if not exists card_sets` block, add:

```ts
db.exec(`
  create table if not exists guild_settings (
    guild_id text primary key not null,
    announce_draft_created integer not null default 1,
    announce_draft_started integer not null default 1,
    announce_draft_completed integer not null default 1,
    announce_tournament_created integer not null default 1,
    announce_tournament_completed integer not null default 1,
    announce_channel_id text
  );
`);
```

**Step 2: Run the app briefly to apply the migration, then verify**

Run: `sqlite3 data/bot.sqlite ".schema guild_settings"` — should show the table.

**Step 3: Commit**

```bash
git add packages/shared/src/db/schema.ts
git commit -m "feat: add guild_settings table for announcement toggles"
```

---

## Task 4: Add `guildSettings` service to shared package

**Files:**
- Create: `packages/shared/src/services/guild-settings.ts`
- Modify: `packages/shared/src/services/index.ts` (export new service)

**Step 1: Write the service**

`packages/shared/src/services/guild-settings.ts`:

```ts
import type Database from "better-sqlite3";

export type GuildSettings = {
  guildId: string;
  announceDraftCreated: boolean;
  announceDraftStarted: boolean;
  announceDraftCompleted: boolean;
  announceTournamentCreated: boolean;
  announceTournamentCompleted: boolean;
  announceChannelId: string | null;
};

function mapSettings(row: any): GuildSettings {
  return {
    guildId: row.guild_id,
    announceDraftCreated: Boolean(row.announce_draft_created),
    announceDraftStarted: Boolean(row.announce_draft_started),
    announceDraftCompleted: Boolean(row.announce_draft_completed),
    announceTournamentCreated: Boolean(row.announce_tournament_created),
    announceTournamentCompleted: Boolean(row.announce_tournament_completed),
    announceChannelId: row.announce_channel_id ?? null,
  };
}

export function createGuildSettingsService(db: Database.Database) {
  const getSettings = db.prepare(
    "select * from guild_settings where guild_id = ?"
  );

  const upsertSettings = db.prepare(`
    insert into guild_settings (
      guild_id, announce_draft_created, announce_draft_started,
      announce_draft_completed, announce_tournament_created,
      announce_tournament_completed, announce_channel_id
    ) values (?, ?, ?, ?, ?, ?, ?)
    on conflict(guild_id) do update set
      announce_draft_created = excluded.announce_draft_created,
      announce_draft_started = excluded.announce_draft_started,
      announce_draft_completed = excluded.announce_draft_completed,
      announce_tournament_created = excluded.announce_tournament_created,
      announce_tournament_completed = excluded.announce_tournament_completed,
      announce_channel_id = excluded.announce_channel_id
  `);

  return {
    get(guildId: string): GuildSettings {
      const row = getSettings.get(guildId) as any | undefined;
      if (!row) {
        return {
          guildId,
          announceDraftCreated: true,
          announceDraftStarted: true,
          announceDraftCompleted: true,
          announceTournamentCreated: true,
          announceTournamentCompleted: true,
          announceChannelId: null,
        };
      }
      return mapSettings(row);
    },

    update(guildId: string, settings: Partial<Omit<GuildSettings, "guildId">>): GuildSettings {
      const current = this.get(guildId);
      const merged = { ...current, ...settings };
      upsertSettings.run(
        guildId,
        merged.announceDraftCreated ? 1 : 0,
        merged.announceDraftStarted ? 1 : 0,
        merged.announceDraftCompleted ? 1 : 0,
        merged.announceTournamentCreated ? 1 : 0,
        merged.announceTournamentCompleted ? 1 : 0,
        merged.announceChannelId,
      );
      return this.get(guildId);
    },
  };
}

export type GuildSettingsService = ReturnType<typeof createGuildSettingsService>;
```

**Step 2: Export from `packages/shared/src/services/index.ts`**

Add: `export { createGuildSettingsService } from "./guild-settings.js";`
Add: `export type { GuildSettingsService, GuildSettings } from "./guild-settings.js";`

**Step 3: Rebuild shared package**

Run: `npm run build --workspace=@yugidraft/shared`

**Step 4: Typecheck**

Run: `npx turbo run typecheck --filter=@yugidraft/shared`

**Step 5: Commit**

```bash
git add packages/shared/src/services/guild-settings.ts packages/shared/src/services/index.ts
git commit -m "feat: add guildSettings service with get/update for announcement toggles"
```

---

## Task 5: Add helper to auto-create player rows for web users

**Files:**
- Create: `packages/shared/src/services/players.ts`
- Modify: `packages/shared/src/services/index.ts` (export)

**Step 1: Write the players service**

`packages/shared/src/services/players.ts`:

```ts
import type Database from "better-sqlite3";

export type Player = {
  id: number;
  guildId: string;
  discordUserId: string;
  displayName: string;
  createdAt: string;
};

function mapPlayer(row: any): Player {
  return {
    id: row.id,
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export function createPlayerService(db: Database.Database) {
  const findByGuildAndUser = db.prepare(
    "select * from players where guild_id = ? and discord_user_id = ?"
  );

  const insert = db.prepare(
    "insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)"
  );

  return {
    findByGuildAndUser(guildId: string, discordUserId: string): Player | undefined {
      const row = findByGuildAndUser.get(guildId, discordUserId) as any | undefined;
      return row ? mapPlayer(row) : undefined;
    },

    findOrCreate(guildId: string, discordUserId: string, displayName: string): Player {
      const existing = this.findByGuildAndUser(guildId, discordUserId);
      if (existing) return existing;

      const result = insert.run(guildId, discordUserId, displayName);
      return {
        id: Number(result.lastInsertRowid),
        guildId,
        discordUserId,
        displayName,
        createdAt: new Date().toISOString(),
      };
    },
  };
}

export type PlayerService = ReturnType<typeof createPlayerService>;
```

**Step 2: Export from index.ts**

Add: `export { createPlayerService } from "./players.js";`
Add: `export type { PlayerService, Player } from "./players.js";`

**Step 3: Rebuild and typecheck**

Run: `npm run build --workspace=@yugidraft/shared && npx turbo run typecheck --filter=@yugidraft/shared`

**Step 4: Commit**

```bash
git add packages/shared/src/services/players.ts packages/shared/src/services/index.ts
git commit -m "feat: add player service with findOrCreate for web users"
```

---

## Task 6: Add `getSetPreview` method to card catalog service

**Files:**
- Modify: `packages/shared/src/services/card-catalog.ts`

**Step 1: Add a `getSetPreview` method**

This method returns card count + sample cards for a given set name, fetching from YGOPRODeck if not cached:

```ts
async getSetPreview(setName: string): Promise<{ name: string; cardCount: number; cached: boolean; sampleCards: CardCatalogCard[] }> {
  const cachedCount = db.prepare("select card_count from card_sets where set_name = ?").get(setName) as { card_count: number } | undefined;

  const sampleFromDb = db.prepare(`
    select * from card_catalog
    where ygoprodeck_id in (
      select ygoprodeck_id from card_catalog cc, json_each(cc.card_sets_json) as je
      where je.value->>'set_name' = ?
      limit 6
    )
  `).all(setName) as any[];

  if (sampleFromDb.length > 0 && cachedCount?.card_count) {
    return {
      name: setName,
      cardCount: cachedCount.card_count,
      cached: true,
      sampleCards: sampleFromDb.map(mapCard),
    };
  }

  const fetched = await fetchCards("cardset", setName);
  if (fetched.length === 0) {
    return { name: setName, cardCount: 0, cached: false, sampleCards: [] };
  }

  const nonExtraDeck = fetched.filter((c) => !isExtraDeckCard(c));
  upsertCards(nonExtraDeck.length > 0 ? nonExtraDeck : fetched);

  const sample = nonExtraDeck.slice(0, 6).length > 0 ? nonExtraDeck.slice(0, 6) : fetched.slice(0, 6);

  return {
    name: setName,
    cardCount: fetched.length,
    cached: false,
    sampleCards: sample.map((c) => mapYgoprodeckCard(c)),
  };
}
```

Also add a helper `mapYgoprodeckCard` at the top of the returned object to convert `YgoprodeckCard` to `CardCatalogCard` format for the uncached case.

**Step 2: Typecheck**

Run: `npx turbo run typecheck --filter=@yugidraft/shared`

**Step 3: Commit**

```bash
git add packages/shared/src/services/card-catalog.ts
git commit -m "feat: add getSetPreview for set browsing with caching"
```

---

## Task 7: Add env vars to the web app for default guild/channel

**Files:**
- Modify: `packages/web/src/lib/env.ts` (create if not exists)
- Modify: `packages/web/next.config.ts` (if needed for env exposure)

**Step 1: Create `packages/web/src/lib/env.ts`**

```ts
export const env = {
  discordGuildId: process.env.DISCORD_GUILD_ID ?? "",
  discordDefaultChannelId: process.env.DISCORD_DEFAULT_CHANNEL_ID ?? process.env.DISCORD_REMINDER_CHANNEL_ID ?? "",
};
```

**Step 2: Add to `.env.example`**

Add these lines under the Web App Auth section:

```
# --- Web App Defaults ---
DISCORD_GUILD_ID=
DISCORD_DEFAULT_CHANNEL_ID=
```

**Step 3: Commit**

```bash
git add packages/web/src/lib/env.ts .env.example
git commit -m "feat: add env helper for DISCORD_GUILD_ID and DISCORD_DEFAULT_CHANNEL_ID"
```

---

## Task 8: API route — `GET /api/sets` (list/search sets)

**Files:**
- Create: `packages/web/app/api/sets/route.ts`

**Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createCardCatalogService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? undefined;
  const db = getDb();
  const catalog = createCardCatalogService(db);
  const sets = catalog.listSets(query);
  return NextResponse.json({ sets });
}
```

**Step 2: Typecheck and test manually**

Run: `npx turbo run typecheck --filter=@yugioh-discord-bot/web`

**Step 3: Commit**

```bash
git add packages/web/app/api/sets/route.ts
git commit -m "feat: add GET /api/sets route for set search"
```

---

## Task 9: API route — `GET /api/sets/[name]/preview` (set preview with card images)

**Files:**
- Create: `packages/web/app/api/sets/[name]/route.ts`

**Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createCardCatalogService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);
  const db = getDb();
  const catalog = createCardCatalogService(db);

  try {
    const preview = await catalog.getSetPreview(decodedName);
    return NextResponse.json(preview);
  } catch (error) {
    console.error("[api/sets/preview] error:", error);
    return NextResponse.json({ error: "Failed to load set preview" }, { status: 500 });
  }
}
```

**Step 2: Typecheck**

Run: `npx turbo run typecheck --filter=@yugioh-discord-bot/web`

**Step 3: Commit**

```bash
git add packages/web/app/api/sets/
git commit -m "feat: add GET /api/sets/[name]/preview route"
```

---

## Task 10: API route — `GET /api/discord/channels` (fetch guild channels from Discord API)

**Files:**
- Create: `packages/web/app/api/discord/channels/route.ts`

**Step 1: Write the route**

This route uses the user's Discord OAuth token to fetch channels for the configured guild. It needs a Discord API call using the bot token or the user's access token:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const guildId = env.discordGuildId;
  const botToken = process.env.DISCORD_TOKEN;

  if (!botToken) {
    return NextResponse.json({ error: "Bot token not configured" }, { status: 500 });
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch channels from Discord" }, { status: res.status });
    }

    const channels = await res.json();
    const textChannels = channels
      .filter((ch: any) => ch.type === 0)
      .map((ch: any) => ({ id: ch.id, name: ch.name }));

    return NextResponse.json({ channels: textChannels });
  } catch (error) {
    console.error("[api/discord/channels] error:", error);
    return NextResponse.json({ error: "Failed to fetch channels" }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add packages/web/app/api/discord/channels/route.ts
git commit -m "feat: add GET /api/discord/channels route"
```

---

## Task 11: API route — `POST /api/drafts` (create draft from web)

**Files:**
- Modify: `packages/web/app/api/drafts/route.ts` (add POST handler)

**Step 1: Add the POST handler**

In the existing `route.ts`, add a `POST` export:

```ts
import { createDraftService } from "@yugidraft/shared/services";
import { createPlayerService } from "@yugidraft/shared/services";
import { env } from "@/lib/env";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      name,
      channelId,
      config,
    } = body as {
      name: string;
      channelId?: string;
      config: {
        setNames?: string[];
        packSize?: number;
        packsPerPlayer?: number;
        pickSeconds?: number;
        alternatePassDirection?: boolean;
        randomizeSeats?: boolean;
      };
    };

    if (!name || !config?.setNames?.length) {
      return NextResponse.json({ error: "Name and at least one set are required" }, { status: 400 });
    }

    const guildId = env.discordGuildId;
    const effectiveChannelId = channelId || env.discordDefaultChannelId;

    if (!guildId) {
      return NextResponse.json({ error: "DISCORD_GUILD_ID not configured" }, { status: 500 });
    }

    const db = getDb();
    const players = createPlayerService(db);
    const drafts = createDraftService(db);

    const displayName = session.user.name ?? session.user.id;
    const player = players.findOrCreate(guildId, session.user.id, displayName);

    const draftConfig: DraftConfig = {
      setNames: config.setNames,
      includeNames: [],
      excludeNames: [],
      packSize: config.packSize ?? 8,
      packsPerPlayer: config.packsPerPlayer ?? 5,
      pickSeconds: config.pickSeconds ?? 45,
      alternatePassDirection: config.alternatePassDirection ?? true,
      randomizeSeats: config.randomizeSeats ?? false,
    };

    const draftId = drafts.createDraft(guildId, effectiveChannelId, name.trim(), draftConfig, session.user.id, player.id);

    const draft = drafts.findById(draftId);

    return NextResponse.json({
      id: draft.id,
      name: draft.name,
      status: draft.status,
      webSlug: draft.webSlug,
    }, { status: 201 });
  } catch (error) {
    console.error("[api/drafts POST] error:", error);
    return NextResponse.json({ error: "Failed to create draft" }, { status: 500 });
  }
}
```

Also add the `DraftConfig` import from `@yugidraft/shared/types` and `NextRequest` import.

**Step 2: Typecheck**

Run: `npx turbo run typecheck --filter=@yugioh-discord-bot/web`

**Step 3: Commit**

```bash
git add packages/web/app/api/drafts/route.ts packages/web/src/lib/env.ts
git commit -m "feat: add POST /api/drafts to create drafts from web"
```

---

## Task 12: API route — `POST /api/tournaments` (create tournament from web)

**Files:**
- Modify: `packages/web/app/api/tournaments/route.ts` (add POST handler)

**Step 1: Add POST handler**

Similar pattern to drafts — auto-create player, use guild env, create tournament:

```ts
import { createPlayerService, createTournamentService } from "@yugidraft/shared/services";
import { env } from "@/lib/env";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { name, format } = body as { name: string; format: string };

    if (!name || !format) {
      return NextResponse.json({ error: "Name and format are required" }, { status: 400 });
    }

    const guildId = env.discordGuildId;

    if (!guildId) {
      return NextResponse.json({ error: "DISCORD_GUILD_ID not configured" }, { status: 500 });
    }

    const db = getDb();
    const players = createPlayerService(db);
    const displayName = session.user.name ?? session.user.id;
    const player = players.findOrCreate(guildId, session.user.id, displayName);

    const tournaments = createTournamentService(db);
    const tournamentId = tournaments.create(name.trim(), format, guildId, session.user.id, player.id);

    const tournament = tournaments.findById(tournamentId);

    return NextResponse.json({
      id: tournament.id,
      name: tournament.name,
      format: tournament.format,
      status: tournament.status,
      webSlug: tournament.webSlug,
    }, { status: 201 });
  } catch (error) {
    console.error("[api/tournaments POST] error:", error);
    return NextResponse.json({ error: "Failed to create tournament" }, { status: 500 });
  }
}
```

**Step 2: Check if `createTournamentService` exists and has `create` method**

If not, add it to `packages/shared/src/services/` first. Check the tournament service file.

**Step 3: Typecheck**

Run: `npx turbo run typecheck --filter=@yugioh-discord-bot/web`

**Step 4: Commit**

```bash
git add packages/web/app/api/tournaments/route.ts
git commit -m "feat: add POST /api/tournaments to create tournaments from web"
```

---

## Task 13: API routes — Settings (`GET` and `PUT`)

**Files:**
- Create: `packages/web/app/api/settings/route.ts`

**Step 1: Write both GET and PUT**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createGuildSettingsService } from "@yugidraft/shared/services";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const guildId = env.discordGuildId;
  const db = getDb();
  const settings = createGuildSettingsService(db);
  const guildSettings = settings.get(guildId);

  return NextResponse.json(guildSettings);
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const guildId = env.discordGuildId;
  const body = await request.json();
  const db = getDb();
  const settings = createGuildSettingsService(db);
  const updated = settings.update(guildId, body);

  return NextResponse.json(updated);
}
```

**Step 2: Typecheck**

**Step 3: Commit**

```bash
git add packages/web/app/api/settings/route.ts
git commit -m "feat: add GET/PUT /api/settings for guild announcement settings"
```

---

## Task 14: Create Draft form page — `/drafts/new`

**Files:**
- Create: `packages/web/app/drafts/new/page.tsx`
- Create: `packages/web/src/components/draft/create-draft-form.tsx`
- Create: `packages/web/src/components/draft/set-picker.tsx`
- Create: `packages/web/src/components/draft/set-browser-modal.tsx`

This is the largest task. Build the form step by step:

**Step 1: Create `set-picker.tsx`** — A combobox/search input that queries `GET /api/sets?q=...` as the user types. Shows set name, set code, and card count inline. Selected chips appear below the input.

**Step 2: Create `set-browser-modal.tsx`** — Uses the `Modal` component. Shows a full list of sets with search. Clicking a set calls `GET /api/sets/[name]/preview` and shows sample card images + card count. Add/remove sets from here.

**Step 3: Create `create-draft-form.tsx`** — The full form with:
- Name input
- Channel dropdown (fetched from `GET /api/discord/channels`, default from env)
- Set picker + browse modal
- Numeric inputs: pack size, packs per player, pick timer
- Toggles: alternate pass direction, randomize seats
- Submit button → `POST /api/drafts`
- On success, redirect to `/draft/[webSlug]`

**Step 4: Create `packages/web/app/drafts/new/page.tsx`** — Simple wrapper:

```tsx
import { CreateDraftForm } from "@/components/draft/create-draft-form";

export default function NewDraftPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 font-heading text-2xl text-text-primary">Create New Draft</h1>
      <CreateDraftForm />
    </div>
  );
}
```

**Step 5: Typecheck and manual test**

**Step 6: Commit**

```bash
git add packages/web/app/drafts/new/ packages/web/src/components/draft/
git commit -m "feat: add /drafts/new page with set picker, browser modal, and form"
```

---

## Task 15: Create Tournament form page — `/tournaments/new`

**Files:**
- Create: `packages/web/app/tournaments/new/page.tsx`
- Create: `packages/web/src/components/tournament/create-tournament-form.tsx`

**Step 1: Create `create-tournament-form.tsx`** — Simpler than draft form:
- Name input
- Format selector (dropdown: "Swiss", "Single Elimination", "Round Robin")
- Channel dropdown (same as draft form, reuse if possible)
- Submit → `POST /api/tournaments`
- On success, redirect to tournament page

**Step 2: Create `packages/web/app/tournaments/new/page.tsx`**

**Step 3: Typecheck and commit**

```bash
git add packages/web/app/tournaments/new/ packages/web/src/components/tournament/create-tournament-form.tsx
git commit -m "feat: add /tournaments/new page with create form"
```

---

## Task 16: Settings page — `/settings`

**Files:**
- Create: `packages/web/app/settings/page.tsx`
- Create: `packages/web/src/components/settings/announcement-toggles.tsx`

**Step 1: Create `announcement-toggles.tsx`**

A component that renders 5 toggle switches:
- Announce draft created
- Announce draft started
- Announce draft completed
- Announce tournament created
- Announce tournament completed

Plus a channel dropdown for the announcements channel.

Uses `GET /api/settings` to load, `PUT /api/settings` to save.

**Step 2: Create the page**

```tsx
import { AnnouncementToggles } from "@/components/settings/announcement-toggles";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 font-heading text-2xl text-text-primary">Settings</h1>
      <AnnouncementToggles />
    </div>
  );
}
```

**Step 3: Add "Settings" to the nav**

Modify `packages/web/src/lib/nav-items.ts` to add a Settings entry with the gear icon from lucide-react.

**Step 4: Typecheck and commit**

```bash
git add packages/web/app/settings/ packages/web/src/components/settings/ packages/web/src/lib/nav-items.ts
git commit -m "feat: add /settings page with announcement toggles and nav entry"
```

---

## Task 17: Add "Create Draft" and "Create Tournament" buttons to existing pages

**Files:**
- Modify: `packages/web/app/drafts/page.tsx`
- Modify: `packages/web/app/tournaments/page.tsx`

**Step 1: Add a "New Draft" button** at the top of the drafts page, linking to `/drafts/new`.

**Step 2: Add a "New Tournament" button** at the top of the tournaments page, linking to `/tournaments/new`.

**Step 3: Typecheck and commit**

```bash
git add packages/web/app/drafts/page.tsx packages/web/app/tournaments/page.tsx
git commit -m "feat: add create buttons to drafts and tournaments pages"
```

---

## Task 18: Write tests for `POST /api/drafts` and `POST /api/tournaments`

**Files:**
- Create: `packages/web/tests/api/drafts-create.test.ts`
- Create: `packages/web/tests/api/tournaments-create.test.ts`

**Step 1: Write tests for draft creation**

Test cases:
- Returns 401 if not authenticated
- Returns 400 if name or setNames missing
- Returns 201 and draft data on success
- Auto-creates player row if user doesn't have one
- Uses existing player row if user has one

**Step 2: Write tests for tournament creation**

Test cases:
- Returns 401 if not authenticated
- Returns 400 if name or format missing
- Returns 201 and tournament data on success

**Step 3: Create test helper for mocking auth**

Create `packages/web/tests/helpers/mock-auth.ts` that provides a reusable `mockAuth` function to set `session.user`.

**Step 4: Run tests**

Run: `npx vitest run --exclude '.next/**'`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/web/tests/
git commit -m "test: add API tests for draft and tournament creation"
```

---

## Task 19: Integration — connect bot announcement logic to guild_settings

**Files:**
- Modify: `packages/bot/src/index.ts` (or wherever announcements are triggered)

**Step 1: Find where the bot sends draft/tournament messages**

Search for where the bot currently posts draft start/completion messages.

**Step 2: Wrap each announcement in a guild_settings check**

Before posting, call `guildSettings.get(guildId)` and check the relevant toggle. If the toggle is off, skip the announcement. Use `announceChannelId` or fall back to `DISCORD_REMINDER_CHANNEL_ID`.

**Step 3: Typecheck bot**

Run: `npx turbo run typecheck --filter=@yugioh-discord-bot/bot`

**Step 4: Commit**

```bash
git add packages/bot/src/
git commit -m "feat: bot checks guild settings before posting announcements"
```

---

## Summary of Tasks

| # | Task | Files |
|---|------|-------|
| 1 | Add `card_count` + `set_code` columns to `card_sets` | schema.ts |
| 2 | Update `syncSets` to store new fields | card-catalog.ts |
| 3 | Add `guild_settings` table | schema.ts |
| 4 | Add `guildSettings` service | guild-settings.ts, index.ts |
| 5 | Add `players` service (findOrCreate) | players.ts, index.ts |
| 6 | Add `getSetPreview` to card catalog | card-catalog.ts |
| 7 | Add env helper for guild/channel | env.ts, .env.example |
| 8 | API route — `GET /api/sets` | route.ts |
| 9 | API route — `GET /api/sets/[name]/preview` | route.ts |
| 10 | API route — `GET /api/discord/channels` | route.ts |
| 11 | API route — `POST /api/drafts` | route.ts |
| 12 | API route — `POST /api/tournaments` | route.ts |
| 13 | API routes — Settings GET/PUT | route.ts |
| 14 | Create Draft form page | page.tsx, 3 components |
| 15 | Create Tournament form page | page.tsx, 1 component |
| 16 | Settings page + nav entry | page.tsx, 1 component |
| 17 | Add create buttons to existing pages | page.tsx x2 |
| 18 | API tests | 2 test files |
| 19 | Bot announcement integration | bot source |