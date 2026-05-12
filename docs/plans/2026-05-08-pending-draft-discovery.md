# Pending Draft Discovery & Card Popup Visual Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show all guild pending drafts to every logged-in user (not just participants), and make the card hover popup card name pop with a glow outline and attribute-specific badge colors.

**Architecture:** Three places run the "my drafts" query — the API route (`/api/drafts`), the Drafts page, and the Dashboard page. Each switches its `INNER JOIN` on `draft_players` to a `LEFT JOIN` scoped to the guild, adding `d.status = 'pending'` as an OR condition so all pending drafts are visible. A new `isParticipant` boolean is added to the response so the `DraftCard` component can show "Join Draft →" vs "Manage Draft →". The `CardHoverPopup` gets a larger/bolder card name with a text-shadow glow and attribute-specific badge colors mapped to YuGiOh attribute types.

**Tech Stack:** Next.js 15 App Router (server components + API routes), better-sqlite3, React, Tailwind CSS, Vitest

---

## File Map

| File | Change |
|------|--------|
| `packages/web/src/components/draft/draft-card.tsx` | Add `isParticipant?: boolean` prop; "Join Draft →" for non-participant pending |
| `packages/web/app/api/drafts/route.ts` | Query all guild pending + user's non-pending; add `isParticipant` |
| `packages/web/app/(app)/drafts/page.tsx` | Same SQL change as API route |
| `packages/web/app/(app)/dashboard/page.tsx` | Same SQL change for the drafts section |
| `packages/web/tests/drafts-list-route.test.ts` | **New** — tests for `GET /api/drafts` list behavior |
| `packages/web/src/components/draft/card-hover-popup.tsx` | Text glow on name, attribute-specific badge colors |

---

## Task 1: Update DraftCard for participant vs. non-participant pending

**Files:**
- Modify: `packages/web/src/components/draft/draft-card.tsx`

`DraftCard` currently shows "Manage Draft →" for all pending drafts. A non-participant who can now see pending drafts in their list should see "Join Draft →" instead.

- [ ] **Step 1: Read the current file**

Open `packages/web/src/components/draft/draft-card.tsx` and note the current `isLinkable` logic and CTA text block.

- [ ] **Step 2: Add `isParticipant` prop and update CTA text**

Replace the full file content:

```tsx
import Link from "next/link";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface DraftCardProps {
  id: number;
  name: string;
  status: string;
  currentPackRound: number;
  currentPickStep: number;
  playerCount: number;
  webSlug?: string;
  createdAt?: string;
  endedAt?: string;
  isParticipant?: boolean;
}

export function DraftCard({ draft }: { draft: DraftCardProps }) {
  const statusVariant =
    draft.status === "active"
      ? "success"
      : draft.status === "pending"
        ? "warning"
        : draft.status === "cancelled"
          ? "danger"
          : "default";

  const statusLabel =
    draft.status === "completed"
      ? "Completed"
      : draft.status === "cancelled"
        ? "Cancelled"
        : draft.status.charAt(0).toUpperCase() + draft.status.slice(1);

  const isLinkable =
    draft.webSlug &&
    (draft.status === "active" ||
      draft.status === "pending" ||
      draft.status === "completed" ||
      draft.status === "cancelled");

  function ctaLabel(): string {
    if (draft.status === "active") return "Open Draft Room →";
    if (draft.status === "pending") {
      return draft.isParticipant === false ? "Join Draft →" : "Manage Draft →";
    }
    if (draft.status === "cancelled") return "View Summary →";
    return "View Deck →";
  }

  const card = (
    <div className="rounded-xl border border-border bg-surface p-5 motion-safe:transition-colors hover:border-accent-primary/30 hover:bg-bg-elevated">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-body text-lg font-semibold text-text-primary">
            {draft.name}
          </h3>
          <div className="mt-2 flex items-center gap-3">
            <Badge variant={statusVariant}>{statusLabel}</Badge>
            {draft.status === "active" && (
              <span className="text-sm text-text-muted">
                Pack {draft.currentPackRound}, Pick {draft.currentPickStep}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Users className="h-4 w-4" />
          <span>{draft.playerCount} players</span>
        </div>
        {isLinkable && (
          <span className="text-sm font-semibold text-accent-primary hover:text-accent-secondary">
            {ctaLabel()}
          </span>
        )}
      </div>
    </div>
  );

  if (isLinkable) {
    return (
      <Link href={`/draft/${draft.webSlug}`} className="block">
        {card}
      </Link>
    );
  }

  return card;
}
```

- [ ] **Step 3: TypeScript check**

Run: `cd /home/imran/yugioh-discord-bot && npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/draft/draft-card.tsx
git commit -m "feat(web): add isParticipant prop to DraftCard; show Join vs Manage for pending"
```

---

## Task 2: Update GET /api/drafts to surface all guild pending drafts

**Files:**
- Modify: `packages/web/app/api/drafts/route.ts`

The current query uses `INNER JOIN draft_players dp_me` which only returns drafts the user is in. Switch to `LEFT JOIN` scoped with the guild, add `isParticipant` to the mapped response, and handle users with no player record.

- [ ] **Step 1: Replace `packages/web/app/api/drafts/route.ts` GET handler**

The key SQL change:
- `inner join draft_players dp_me on dp_me.draft_id = d.id` → `left join draft_players dp_me on dp_me.draft_id = d.id and dp_me.player_id in (${placeholders})`
- WHERE changes from `dp_me.player_id in (...)` → `d.guild_id = ? and (d.status = 'pending' or dp_me.player_id is not null)`
- Add `max(dp_me.player_id) as my_player_id` to SELECT to detect participation
- Use `[-1]` as fallback when `playerIds` is empty (no real player has id -1)

Replace the entire `GET` export:

```ts
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const guildId = env.discordGuildId;
    if (!guildId) {
      return NextResponse.json({ active: [], pending: [], completed: [], cancelled: [] });
    }

    const discordUserId = session.user.id;
    const db = getDb();

    const playerRows = db
      .prepare("select id from players where discord_user_id = ?")
      .all(discordUserId) as Array<{ id: number }>;

    const playerIds = playerRows.map((r) => r.id);

    // Use [-1] when player has no records — no real player has id -1, so the
    // LEFT JOIN matches nothing and we still see pending drafts via the guild filter.
    const idParams = playerIds.length > 0 ? playerIds : [-1];
    const placeholders = idParams.map(() => "?").join(",");

    const drafts = db
      .prepare(
        `
        select
          d.id,
          d.guild_id,
          d.name,
          d.status,
          d.web_slug,
          d.current_wave_number,
          d.current_pick_step,
          d.created_at,
          d.ended_at,
          count(dp.player_id) as player_count,
          max(dp_me.player_id) as my_player_id
        from drafts d
        left join draft_players dp_me on dp_me.draft_id = d.id
          and dp_me.player_id in (${placeholders})
        left join draft_players dp on dp.draft_id = d.id
        where d.guild_id = ?
          and (d.status = 'pending' or dp_me.player_id is not null)
        group by d.id
        order by
          case d.status
            when 'active' then 0
            when 'pending' then 1
            when 'completed' then 2
            when 'cancelled' then 3
          end,
          d.created_at desc
      `
      )
      .all(...idParams, guildId)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        currentPackRound: row.current_wave_number ?? 0,
        currentPickStep: row.current_pick_step ?? 0,
        playerCount: row.player_count,
        createdAt: toUtcIso(row.created_at),
        endedAt: toUtcIso(row.ended_at),
        isParticipant: row.my_player_id !== null && row.my_player_id !== undefined,
      }));

    const active = drafts.filter((d: any) => d.status === "active");
    const pending = drafts.filter((d: any) => d.status === "pending");
    const completed = drafts.filter((d: any) => d.status === "completed");
    const cancelled = drafts.filter((d: any) => d.status === "cancelled");

    return NextResponse.json({ active, pending, completed, cancelled });
  } catch (error) {
    console.error("[api/drafts] error:", error);
    return NextResponse.json(
      { error: "Failed to load drafts" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: TypeScript check**

Run: `cd /home/imran/yugioh-discord-bot && npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/api/drafts/route.ts
git commit -m "feat(web): GET /api/drafts shows all guild pending drafts with isParticipant flag"
```

---

## Task 3: Write tests for GET /api/drafts list endpoint

**Files:**
- Create: `packages/web/tests/drafts-list-route.test.ts`

Follow the same test pattern used in `packages/web/tests/drafts-route.test.ts` — create a temp SQLite DB, run the seed script to create a pending draft, then call the route handler with different auth users.

- [ ] **Step 1: Write the failing tests first**

Create `packages/web/tests/drafts-list-route.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const repoRoot = "/home/imran/yugioh-discord-bot";
const testTimeoutMs = 40000;

vi.mock("@/lib/auth", () => ({ auth }));

describe("GET /api/drafts (list)", () => {
  let tempDir: string;
  let dbPath: string;
  const guildId = "196382772699332609";
  const creatorDiscordId = "196382527131222016";

  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    tempDir = mkdtempSync(join(tmpdir(), "yugioh-drafts-list-"));
    dbPath = join(tempDir, "test.sqlite");
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = guildId;

    // Seed a pending draft created by the creator user
    execFileSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_PATH: dbPath,
        DISCORD_USER_ID: creatorDiscordId,
        DISCORD_GUILD_ID: guildId,
      },
      stdio: "pipe",
    });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    "returns pending drafts to a user who is not a participant",
    async () => {
      // Auth as a completely different user with no player record in this guild
      auth.mockResolvedValue({ user: { id: "outsider-user-999", name: "Outsider" } });

      const { GET } = await import("../app/api/drafts/route");
      const response = await GET();

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.pending.length).toBeGreaterThan(0);
      expect(data.pending[0].isParticipant).toBe(false);
    },
    testTimeoutMs,
  );

  it(
    "does not return active drafts to non-participants",
    async () => {
      // Promote the seeded draft to active
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);
      db.prepare(
        "update drafts set status = 'active', current_wave_number = 1, current_pick_step = 1, started_at = datetime('now') where guild_id = ?",
      ).run(guildId);
      db.close();

      // Auth as an outsider
      auth.mockResolvedValue({ user: { id: "outsider-user-999", name: "Outsider" } });

      const { GET } = await import("../app/api/drafts/route");
      const response = await GET();

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.active).toHaveLength(0);
      expect(data.pending).toHaveLength(0);
    },
    testTimeoutMs,
  );

  it(
    "sets isParticipant=true for drafts the authed user is in",
    async () => {
      // Auth as the creator — they ARE a participant
      auth.mockResolvedValue({ user: { id: creatorDiscordId, name: "imran443" } });

      const { GET } = await import("../app/api/drafts/route");
      const response = await GET();

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.pending.length).toBeGreaterThan(0);
      expect(data.pending[0].isParticipant).toBe(true);
    },
    testTimeoutMs,
  );

  it(
    "returns 200 with only pending when DISCORD_GUILD_ID is set but user has no player record",
    async () => {
      // A brand-new Discord user who has never joined a game
      auth.mockResolvedValue({ user: { id: "brand-new-user-000", name: "NewGuy" } });

      const { GET } = await import("../app/api/drafts/route");
      const response = await GET();

      expect(response.status).toBe(200);

      const data = await response.json();

      // Should still see the pending draft even though they have no player record
      expect(data.pending.length).toBeGreaterThan(0);
      expect(data.active).toHaveLength(0);
      expect(data.completed).toHaveLength(0);
    },
    testTimeoutMs,
  );
});
```

- [ ] **Step 2: Run tests to confirm they fail (pre-implementation)**

Wait — the implementation was done in Task 2 already. Run to confirm they pass:

Run: `cd /home/imran/yugioh-discord-bot && npx vitest run packages/web/tests/drafts-list-route.test.ts`
Expected: all 4 tests PASS.

If any fail, read the error and fix `packages/web/app/api/drafts/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/web/tests/drafts-list-route.test.ts
git commit -m "test(web): add GET /api/drafts list endpoint tests for pending draft discovery"
```

---

## Task 4: Update Drafts page to show all guild pending drafts

**Files:**
- Modify: `packages/web/app/(app)/drafts/page.tsx`

The Drafts page directly queries SQLite (server component). Apply the same LEFT JOIN pattern as Task 2, and pass `isParticipant` to `DraftCard`.

- [ ] **Step 1: Read the current file**

Open `packages/web/app/(app)/drafts/page.tsx` and note the SQL query inside the `if (playerIds.length > 0)` block.

- [ ] **Step 2: Replace the file**

```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { Layers, Plus } from "lucide-react";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { toUtcIso } from "@/lib/utils";
import { DraftCard, type DraftCardProps } from "@/components/draft/draft-card";

interface DraftsData {
  active: DraftCardProps[];
  pending: DraftCardProps[];
  completed: DraftCardProps[];
  cancelled: DraftCardProps[];
}

export default async function DraftsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const guildId = env.discordGuildId;
  const discordUserId = session.user.id;
  const db = getDb();

  const playerRows = db
    .prepare("select id from players where discord_user_id = ?")
    .all(discordUserId) as Array<{ id: number }>;
  const playerIds = playerRows.map((r) => r.id);

  let data: DraftsData = { active: [], pending: [], completed: [], cancelled: [] };

  if (guildId) {
    const idParams = playerIds.length > 0 ? playerIds : [-1];
    const ph = idParams.map(() => "?").join(",");

    const drafts = db
      .prepare(
        `select d.id, d.guild_id, d.name, d.status, d.web_slug,
                d.current_wave_number, d.current_pick_step,
                d.created_at, d.ended_at,
                count(dp.player_id) as player_count,
                max(dp_me.player_id) as my_player_id
         from drafts d
         left join draft_players dp_me on dp_me.draft_id = d.id
           and dp_me.player_id in (${ph})
         left join draft_players dp on dp.draft_id = d.id
         where d.guild_id = ?
           and (d.status = 'pending' or dp_me.player_id is not null)
         group by d.id
         order by
           case d.status
             when 'active' then 0
             when 'pending' then 1
             when 'completed' then 2
             when 'cancelled' then 3
           end,
           d.created_at desc`,
      )
      .all(...idParams, guildId)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        currentPackRound: row.current_wave_number ?? 0,
        currentPickStep: row.current_pick_step ?? 0,
        playerCount: row.player_count,
        createdAt: toUtcIso(row.created_at),
        endedAt: row.ended_at ? toUtcIso(row.ended_at) : undefined,
        isParticipant: row.my_player_id !== null && row.my_player_id !== undefined,
      }));

    data = {
      active: drafts.filter((d: any) => d.status === "active"),
      pending: drafts.filter((d: any) => d.status === "pending"),
      completed: drafts.filter((d: any) => d.status === "completed"),
      cancelled: drafts.filter((d: any) => d.status === "cancelled"),
    };
  }

  const totalDrafts =
    data.active.length + data.pending.length + data.completed.length + data.cancelled.length;

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <h1 className="font-display text-2xl text-text-primary sm:text-3xl">Drafts</h1>
        <Link
          href="/drafts/new"
          className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:bg-accent-secondary"
        >
          <Plus className="h-4 w-4" />
          New Draft
        </Link>
      </div>

      {totalDrafts === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <Layers className="mx-auto mb-4 h-12 w-12 text-text-muted" />
          <p className="text-lg text-text-secondary">No drafts yet</p>
          <p className="mt-2 text-sm text-text-muted">Drafts created in Discord will appear here</p>
        </div>
      ) : (
        <div className="space-y-8">
          {data.active.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-accent-success">Active</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.active.map((d) => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            </section>
          )}
          {data.pending.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-accent-gold">Pending</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.pending.map((d) => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            </section>
          )}
          {data.completed.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-text-secondary">Completed</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.completed.map((d) => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            </section>
          )}
          {data.cancelled.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-text-muted">Cancelled</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.cancelled.map((d) => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: TypeScript check**

Run: `cd /home/imran/yugioh-discord-bot && npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "packages/web/app/(app)/drafts/page.tsx"
git commit -m "feat(web): show all guild pending drafts on the /drafts page"
```

---

## Task 5: Update Dashboard page to show all guild pending drafts

**Files:**
- Modify: `packages/web/app/(app)/dashboard/page.tsx`

The dashboard shows "Your Drafts" (pending + active). Change the drafts query to show all pending guild drafts plus active drafts the user is in.

**IMPORTANT:** The current `drafts` query is inside the `if (playerIds.length > 0)` block, which means users with no player record never see any drafts. The fix requires moving the `drafts` query into its own separate `if (env.discordGuildId)` block so it runs regardless of whether the user has a player record. `tournaments` and `stats` remain inside the `if (playerIds.length > 0)` block since they genuinely require participation data.

- [ ] **Step 1: Replace the full file**

```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { Trophy, Layers, Swords, TrendingUp, ArrowRight, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TournamentCard, type TournamentCardProps } from "@/components/tournament/tournament-card";
import { DraftCard, type DraftCardProps } from "@/components/draft/draft-card";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";

interface Stats {
  wins: number;
  losses: number;
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const discordUserId = session.user.id;
  const db = getDb();

  const playerRows = db
    .prepare("select id, guild_id from players where discord_user_id = ?")
    .all(discordUserId) as Array<{ id: number; guild_id: string }>;
  const playerIds = playerRows.map((r) => r.id);

  let tournaments: TournamentCardProps[] = [];
  let drafts: DraftCardProps[] = [];
  let stats: Stats = { wins: 0, losses: 0 };

  if (playerIds.length > 0) {
    const ph = playerIds.map(() => "?").join(",");

    tournaments = db
      .prepare(
        `select t.id, t.guild_id, t.name, t.format, t.status, t.web_slug,
           count(tp2.player_id) as participant_count
         from tournaments t
         inner join tournament_participants tp on tp.tournament_id = t.id
         left join tournament_participants tp2 on tp2.tournament_id = t.id
         where tp.player_id in (${ph}) and t.status in ('pending', 'active')
         group by t.id
         order by case t.status when 'active' then 0 else 1 end, t.created_at desc`,
      )
      .all(...playerIds)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        format: row.format,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        participantCount: row.participant_count,
      }));

    const statsRow = db
      .prepare(
        `select
           sum(case when winner_id in (${ph}) then 1 else 0 end) as wins,
           sum(case
             when (player_one_id in (${ph}) or player_two_id in (${ph}))
               and winner_id is not null
               and winner_id not in (${ph})
             then 1 else 0 end) as losses
         from matches
         where status = 'completed'
           and (player_one_id in (${ph}) or player_two_id in (${ph}))`,
      )
      .get(
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds,
      ) as { wins: number | null; losses: number | null } | undefined;

    stats = { wins: statsRow?.wins ?? 0, losses: statsRow?.losses ?? 0 };
  }

  // Drafts run outside the playerIds guard — all pending drafts from the guild are visible
  // to every logged-in user, even those with no player record yet.
  if (env.discordGuildId) {
    const idParams = playerIds.length > 0 ? playerIds : [-1];
    const phDrafts = idParams.map(() => "?").join(",");

    drafts = db
      .prepare(
        `select d.id, d.guild_id, d.name, d.status, d.web_slug,
                d.current_wave_number, d.current_pick_step,
                count(dp2.player_id) as player_count,
                max(dp_me.player_id) as my_player_id
         from drafts d
         left join draft_players dp_me on dp_me.draft_id = d.id
           and dp_me.player_id in (${phDrafts})
         left join draft_players dp2 on dp2.draft_id = d.id
         where d.guild_id = ?
           and d.status in ('pending', 'active')
           and (d.status = 'pending' or dp_me.player_id is not null)
         group by d.id
         order by case d.status when 'active' then 0 else 1 end, d.created_at desc`,
      )
      .all(...idParams, env.discordGuildId)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        currentPackRound: row.current_wave_number,
        currentPickStep: row.current_pick_step,
        playerCount: row.player_count,
        isParticipant: row.my_player_id !== null && row.my_player_id !== undefined,
      }));
  }

  const totalGames = stats.wins + stats.losses;
  const winRate = totalGames > 0 ? Math.round((stats.wins / totalGames) * 100) : 0;

  return (
    <div>
      <h1 className="mb-8 font-display text-2xl text-text-primary sm:text-3xl">Dashboard</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard icon={<Trophy className="h-5 w-5 text-accent-gold" />} label="Wins" value={stats.wins} />
        <StatCard icon={<Target className="h-5 w-5 text-accent-cta" />} label="Losses" value={stats.losses} />
        <StatCard icon={<Swords className="h-5 w-5 text-accent-primary" />} label="Matches" value={totalGames} />
        <StatCard icon={<TrendingUp className="h-5 w-5 text-accent-success" />} label="Win Rate" value={`${winRate}%`} />
      </div>

      <section className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
            <Trophy className="h-5 w-5 text-accent-gold" />
            Your Tournaments
          </h2>
          <Link href="/tournaments">
            <Button variant="ghost" size="sm">
              View All
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
        {tournaments.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center">
            <p className="text-text-secondary">No active tournaments. Join one from Discord!</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {tournaments.map((t) => (
              <TournamentCard key={t.id} tournament={t} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
            <Layers className="h-5 w-5 text-accent-primary" />
            Your Drafts
          </h2>
          <Link href="/drafts">
            <Button variant="ghost" size="sm">
              View All
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
        {drafts.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center">
            <p className="text-text-secondary">No active drafts. Join one from Discord!</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {drafts.map((d) => (
              <DraftCard key={d.id} draft={d} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      </div>
      <div className="font-display text-2xl text-text-primary">{value}</div>
    </div>
  );
}
```

- [ ] **Step 3: TypeScript check**

Run: `cd /home/imran/yugioh-discord-bot && npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Run the full test suite**

Run: `cd /home/imran/yugioh-discord-bot && npx vitest run packages/web`
Expected: all tests pass (including the new `drafts-list-route.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add "packages/web/app/(app)/dashboard/page.tsx"
git commit -m "feat(web): show all guild pending drafts on the dashboard"
```

---

## Task 6: CardHoverPopup — text glow and attribute-specific badge colors

**Files:**
- Modify: `packages/web/src/components/draft/card-hover-popup.tsx`

Make the card name larger, bolder, and add a subtle purple glow. Map YuGiOh attribute names to specific color badges so DARK looks purple, FIRE looks red, WATER looks blue, etc.

- [ ] **Step 1: Replace the full file**

```tsx
import Image from "next/image";
import { Shield, Swords } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DraftCardDetail } from "@/lib/stores/draft-store";

interface CardHoverPopupProps {
  card: DraftCardDetail;
  position: { left: number; top: number };
  imageError: boolean;
  onImageError: () => void;
}

function attributeBadgeClass(attribute: string): string {
  switch (attribute.toUpperCase()) {
    case "DARK":
      return "border border-purple-700/50 bg-purple-900/50 text-purple-300";
    case "LIGHT":
      return "border border-yellow-600/50 bg-yellow-900/50 text-yellow-200";
    case "FIRE":
      return "border border-red-700/50 bg-red-900/50 text-red-300";
    case "WATER":
      return "border border-blue-700/50 bg-blue-900/50 text-blue-300";
    case "EARTH":
      return "border border-amber-700/50 bg-amber-900/50 text-amber-300";
    case "WIND":
      return "border border-green-700/50 bg-green-900/50 text-green-300";
    case "DIVINE":
      return "border border-yellow-500/50 bg-yellow-800/50 text-yellow-100";
    default:
      return "bg-bg-elevated text-text-secondary";
  }
}

export function CardHoverPopup({ card, position, imageError, onImageError }: CardHoverPopupProps) {
  const isMonster = card.type.toLowerCase().includes("monster");

  return (
    <div
      className="pointer-events-none fixed z-50 hidden lg:block"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      <div className="max-h-[calc(100vh-2rem)] w-72 overflow-auto rounded-xl border border-border bg-bg-surface shadow-card">
        <div className="relative isolate aspect-[3/4] w-full overflow-hidden rounded-t-xl bg-bg-elevated">
          {imageError ? (
            <div className="flex h-full items-center justify-center text-sm text-text-secondary">
              No image
            </div>
          ) : (
            <Image
              src={card.imageUrl}
              alt={card.name}
              fill
              className="object-contain"
              sizes="288px"
              onError={onImageError}
            />
          )}
        </div>
        <div className="space-y-3 border-t border-accent-primary/20 p-4">
          <h3 className="mb-1 font-display text-xl font-bold tracking-wide text-white [text-shadow:0_0_20px_rgba(147,51,234,0.45),0_1px_4px_rgba(0,0,0,0.8)]">
            {card.name}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {card.attribute && (
              <span className={cn("rounded-md px-2 py-1 font-semibold", attributeBadgeClass(card.attribute))}>
                {card.attribute}
              </span>
            )}
            {card.level !== undefined && (
              <span className="rounded-md bg-bg-elevated px-2 py-1 text-text-secondary">
                Level {card.level}
              </span>
            )}
            <span className="rounded-md bg-bg-elevated px-2 py-1 text-text-secondary">
              {card.type}
            </span>
            <span className="rounded-md bg-bg-elevated px-2 py-1 capitalize text-text-secondary">
              {card.frameType}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-text-secondary">{card.effectText}</p>
          {isMonster && (card.atk !== undefined || card.def !== undefined) && (
            <div className="flex items-center gap-4 text-sm font-semibold text-text-primary">
              {card.atk !== undefined && (
                <div className="flex items-center gap-1.5">
                  <Swords className="h-4 w-4 text-accent-cta" aria-hidden="true" />
                  <span>ATK {card.atk}</span>
                </div>
              )}
              {card.def !== undefined && (
                <div className="flex items-center gap-1.5">
                  <Shield className="h-4 w-4 text-accent-primary" aria-hidden="true" />
                  <span>DEF {card.def}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

Changes from the original:
- Added `cn` import from `@/lib/utils`
- Added `attributeBadgeClass` module-scope helper mapping YuGiOh attributes to Tailwind color classes
- `h3`: `text-lg` → `text-xl font-bold tracking-wide text-white` + text-shadow glow
- Content `div`: added `border-t border-accent-primary/20` separator between image and text
- Attribute badge: uses `attributeBadgeClass` for semantic colors
- Other badges: explicit `text-text-secondary` (previously inherited)

- [ ] **Step 2: TypeScript check**

Run: `cd /home/imran/yugioh-discord-bot && npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Run full test suite**

Run: `cd /home/imran/yugioh-discord-bot && npx vitest run packages/web`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/draft/card-hover-popup.tsx
git commit -m "feat(web): card name glow + attribute-specific badge colors in hover popup"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| All logged-in users see pending drafts | Tasks 2, 4, 5 |
| `isParticipant` field in API response | Task 2 |
| "Join Draft →" for non-participant pending in DraftCard | Task 1 |
| Tests for new pending draft visibility behavior | Task 3 |
| Card popup text pops more with outline/glow | Task 6 |
| Attribute-specific badge colors | Task 6 |

**Placeholder scan:** None — all code blocks are complete.

**Type consistency:**
- `isParticipant?: boolean` added to `DraftCardProps` in Task 1; used when mapping rows in Tasks 2, 4, 5.
- `attributeBadgeClass(attribute: string): string` defined in Task 6, called in the same file.
- `idParams: number[]` and `placeholders: string` pattern is identical across Tasks 2, 4, 5.
- `toUtcIso` imported from `@/lib/utils` in Task 4 (was already imported in the original `drafts/page.tsx` via a re-check needed — confirm before applying).
