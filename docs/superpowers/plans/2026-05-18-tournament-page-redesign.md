# Tournament Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the public tournament page into a tabbed UI with a "your matches" view, notify the opponent in Discord when a result is reported, and let the host reopen a wrongly-approved round-robin match.

**Architecture:** Four independently-shippable phases. Phase 1 adds two nullable `matches` columns. Phase 2 adds a round-robin-only host "reopen" path (shared service + web route). Phase 3 adds an auto-deleting Discord channel notification on report (new announce kinds, bot handlers, TTL sweep). Phase 4 refactors the 549-line `tournament/[slug]/page.tsx` into a tabbed component tree (Overview / My Matches / All Matches / Players / Standings) and surfaces the reopen + action UI. Phases 2–4 each depend only on Phase 1's migration; they do not depend on each other and can be merged separately.

**Tech Stack:** TypeScript monorepo (npm workspaces + Turborepo). `packages/shared` (better-sqlite3, services as factory functions), `packages/bot` (discord.js), `packages/web` (Next.js 16 App Router, NextAuth v5, Tailwind v4 design tokens). Tests: Vitest in every package; web component tests use `@testing-library/react` + jsdom.

**Reference spec:** `docs/superpowers/specs/2026-05-17-tournament-page-redesign-design.md`

**Conventions (apply to every task):**
- Shared service tests: `import Database from "better-sqlite3"; import { migrate } from "../../src/db/index.js";` then `const db = new Database(":memory:"); migrate(db);`.
- Bot tests: `import { migrate } from "../../src/db/schema.js";` and `createMatchService`/`createTournamentService` from `@yugidraft/shared/services`.
- Web route tests: `vi.mock("@/lib/auth", () => ({ auth }))` with `const auth = vi.fn()`; dynamic `await import("../app/api/.../route")`; temp DB via `mkdtempSync` + `process.env.DATABASE_PATH`; `process.env.DISCORD_GUILD_ID`.
- Web component tests: first line `// @vitest-environment jsdom`; mock `next/navigation` and `next/image`; stub `fetch` via `vi.stubGlobal`.
- Run a single shared test: `npx vitest run packages/shared/tests/<file> ` (no config). Single bot test: `npx vitest run packages/bot/tests/<file>`. Single web test: `npx vitest run packages/web/tests/<file> -c packages/web/vitest.config.ts`.
- Commit after each green task. Branch is the worktree branch `worktree-tournament-page-redesign`. End commit messages with the repo's `Co-Authored-By` trailer.

---

## Phase 1 — Schema migration (foundation)

### Task 1: Add notify columns to `matches`

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (inside `migrate(db)`, with the other `addColumnIfMissing` calls)
- Test: `packages/shared/tests/db/notify-columns.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/tests/db/notify-columns.test.ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe("matches notify columns", () => {
  it("adds notify_channel_id and notify_message_id to matches", () => {
    const db = new Database(":memory:");
    migrate(db);
    const cols = columns(db, "matches");
    expect(cols).toContain("notify_channel_id");
    expect(cols).toContain("notify_message_id");
  });

  it("is idempotent when migrate runs twice", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db);
    expect(columns(db, "matches").filter((c) => c === "notify_channel_id")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/shared/tests/db/notify-columns.test.ts`
Expected: FAIL — `expected [ ... ] to contain 'notify_channel_id'`.

- [ ] **Step 3: Add the columns**

In `packages/shared/src/db/schema.ts`, find the block of existing `addColumnIfMissing(db, ...)` calls inside `migrate(db)` and add at the end of that block:

```typescript
addColumnIfMissing(db, "matches", "notify_channel_id", "text");
addColumnIfMissing(db, "matches", "notify_message_id", "text");
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/shared/tests/db/notify-columns.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Build shared + commit**

```bash
npm run build --workspace=packages/shared
git add packages/shared/src/db/schema.ts packages/shared/tests/db/notify-columns.test.ts
git commit -m "feat(shared): add notify_channel_id/notify_message_id to matches

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Host reopen (round-robin only)

### Task 2: `reopenTournamentMatch` shared service method

**Files:**
- Modify: `packages/shared/src/services/tournaments.ts` (add a method to the object returned by `createTournamentService`)
- Test: `packages/shared/tests/services/tournament-reopen.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/tests/services/tournament-reopen.test.ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createTournamentService } from "../../src/services/tournaments.js";
import { createMatchService } from "../../src/services/matches.js";

function insertPlayer(db: Database.Database, guildId: string, discordUserId: string, name: string) {
  return Number(
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)")
      .run(guildId, discordUserId, name).lastInsertRowid,
  );
}

// Round-robin with 2 players => exactly one match. Report+approve completes the tournament.
function completedRoundRobin() {
  const db = new Database(":memory:");
  migrate(db);
  const tournaments = createTournamentService(db);
  const matches = createMatchService(db);
  const a = insertPlayer(db, "g1", "u-a", "Alice");
  const b = insertPlayer(db, "g1", "u-b", "Bob");
  const t = tournaments.create("g1", "RR", "round_robin", "u-creator");
  tournaments.join(t.id, a);
  tournaments.join(t.id, b);
  tournaments.start(t.id);
  const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(t.id) as any;
  const reported = tournaments.reportTournamentMatch(tm.id, a, a); // Alice wins
  matches.approve(reported.id, b); // Bob approves -> tournament_match completed, tournament completed
  return { db, tournaments, t, tm, matchId: reported.id, a, b };
}

describe("reopenTournamentMatch", () => {
  it("reopens a completed round-robin match and reactivates the tournament", () => {
    const { db, tournaments, t, tm } = completedRoundRobin();
    expect((db.prepare("select status from tournaments where id = ?").get(t.id) as any).status).toBe("completed");

    tournaments.reopenTournamentMatch(tm.id, "u-creator");

    const tmAfter = db.prepare("select * from tournament_matches where id = ?").get(tm.id) as any;
    expect(tmAfter.status).toBe("open");
    expect(tmAfter.match_id).toBeNull();
    const tour = db.prepare("select * from tournaments where id = ?").get(t.id) as any;
    expect(tour.status).toBe("active");
    expect(tour.ended_at).toBeNull();
    const m = db.prepare("select status from matches where id = ?").get((tm as any).id ? tmAfter.match_id ?? 0 : 0);
    // the prior matches row is now denied so it drops out of standings
    const denied = db.prepare("select status from matches where tournament_id = ? order by id desc limit 1").get(t.id) as any;
    expect(denied.status).toBe("denied");
  });

  it("rejects a non-creator", () => {
    const { tournaments, tm } = completedRoundRobin();
    expect(() => tournaments.reopenTournamentMatch(tm.id, "u-not-creator")).toThrow(/organizer/i);
  });

  it("rejects single-elimination tournaments", () => {
    const db = new Database(":memory:");
    migrate(db);
    const tournaments = createTournamentService(db);
    const matches = createMatchService(db);
    const a = insertPlayer(db, "g1", "u-a", "A");
    const b = insertPlayer(db, "g1", "u-b", "B");
    const t = tournaments.create("g1", "SE", "single_elim", "u-creator");
    tournaments.join(t.id, a);
    tournaments.join(t.id, b);
    tournaments.start(t.id);
    const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(t.id) as any;
    const reported = tournaments.reportTournamentMatch(tm.id, a, a);
    matches.approve(reported.id, b);
    expect(() => tournaments.reopenTournamentMatch(tm.id, "u-creator")).toThrow(/round-robin/i);
  });

  it("rejects a match that is not completed", () => {
    const db = new Database(":memory:");
    migrate(db);
    const tournaments = createTournamentService(db);
    const a = insertPlayer(db, "g1", "u-a", "A");
    const b = insertPlayer(db, "g1", "u-b", "B");
    const t = tournaments.create("g1", "RR", "round_robin", "u-creator");
    tournaments.join(t.id, a);
    tournaments.join(t.id, b);
    tournaments.start(t.id);
    const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(t.id) as any;
    expect(() => tournaments.reopenTournamentMatch(tm.id, "u-creator")).toThrow(/not completed/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/shared/tests/services/tournament-reopen.test.ts`
Expected: FAIL — `tournaments.reopenTournamentMatch is not a function`.

- [ ] **Step 3: Implement the method**

In `packages/shared/src/services/tournaments.ts`, inside the object literal returned by `createTournamentService` (the `return { ... }` block, alongside `reportTournamentMatch`), add this method. It uses the same `db` and `findById` already in scope:

```typescript
    reopenTournamentMatch(tournamentMatchId: number, requesterUserId: string): void {
      const tm = db
        .prepare("select * from tournament_matches where id = ?")
        .get(tournamentMatchId) as
        | { id: number; tournament_id: number; match_id: number | null; status: string }
        | undefined;
      if (!tm) {
        throw new Error("Tournament match not found");
      }

      const tournament = findById(tm.tournament_id);
      if (tournament.createdByUserId !== requesterUserId) {
        throw new Error("Only the organizer can reopen a match");
      }
      if (tournament.format !== "round_robin") {
        throw new Error("Reopening results is only available for round-robin events");
      }
      if (tm.status !== "completed" || tm.match_id === null) {
        throw new Error("Match is not completed");
      }

      db.prepare(
        "update matches set status = 'denied', resolved_at = current_timestamp where id = ?",
      ).run(tm.match_id);

      db.prepare(
        "update tournament_matches set status = 'open', match_id = null where id = ?",
      ).run(tm.id);

      db.prepare(
        "update tournaments set status = 'active', ended_at = null where id = ? and status = 'completed'",
      ).run(tm.tournament_id);
    },
```

> Note: `findById` and `Tournament` already exist in this file (`createTournamentService`); `Tournament.createdByUserId`, `.format`, `.status` are existing fields. Do not redefine them.

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/shared/tests/services/tournament-reopen.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Build + commit**

```bash
npm run build --workspace=packages/shared
git add packages/shared/src/services/tournaments.ts packages/shared/tests/services/tournament-reopen.test.ts
git commit -m "feat(shared): reopenTournamentMatch for round-robin host correction

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3: `POST /api/tournaments/[slug]/reopen` route

**Files:**
- Create: `packages/web/app/api/tournaments/[slug]/reopen/route.ts`
- Test: `packages/web/tests/tournament-reopen-route.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/tournament-reopen-route.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createTournamentService, createMatchService } from "@yugidraft/shared/services";

const auth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth }));
const tempDirs: string[] = [];

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "reopen-"));
  tempDirs.push(dir);
  const path = join(dir, "bot.sqlite");
  process.env.DATABASE_PATH = path;
  process.env.DISCORD_GUILD_ID = "g1";
  const db = new Database(path);
  migrate(db);
  return db;
}

function player(db: Database.Database, discordId: string, name: string) {
  return Number(
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', ?, ?)")
      .run(discordId, name).lastInsertRowid,
  );
}

describe("POST /api/tournaments/[slug]/reopen", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u-creator", name: "Host" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  async function setupCompletedRR(db: Database.Database) {
    const t = createTournamentService(db);
    const m = createMatchService(db);
    const a = player(db, "u-a", "Alice");
    const b = player(db, "u-b", "Bob");
    const tour = t.create("g1", "RR", "round_robin", "u-creator");
    db.prepare("update tournaments set web_slug = 'slug1' where id = ?").run(tour.id);
    t.join(tour.id, a);
    t.join(tour.id, b);
    t.start(tour.id);
    const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(tour.id) as any;
    const rep = t.reportTournamentMatch(tm.id, a, a);
    m.approve(rep.id, b);
    return { tm };
  }

  it("401 when unauthenticated", async () => {
    freshDb();
    auth.mockResolvedValue(null);
    const { POST } = await import("../app/api/tournaments/[slug]/reopen/route");
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ tournamentMatchId: 1 }) }),
      { params: Promise.resolve({ slug: "slug1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("reopens for the host", async () => {
    const db = freshDb();
    const { tm } = await setupCompletedRR(db);
    const { POST } = await import("../app/api/tournaments/[slug]/reopen/route");
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ tournamentMatchId: tm.id }) }),
      { params: Promise.resolve({ slug: "slug1" }) },
    );
    expect(res.status).toBe(200);
    const after = db.prepare("select status from tournament_matches where id = ?").get(tm.id) as any;
    expect(after.status).toBe("open");
  });

  it("403 for a non-host", async () => {
    const db = freshDb();
    const { tm } = await setupCompletedRR(db);
    auth.mockResolvedValue({ user: { id: "u-a", name: "Alice" } });
    const { POST } = await import("../app/api/tournaments/[slug]/reopen/route");
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ tournamentMatchId: tm.id }) }),
      { params: Promise.resolve({ slug: "slug1" }) },
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/tournament-reopen-route.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — cannot find module `../app/api/tournaments/[slug]/reopen/route`.

- [ ] **Step 3: Create the route**

```typescript
// packages/web/app/api/tournaments/[slug]/reopen/route.ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService } from "@yugidraft/shared/services";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const body = (await request.json()) as { tournamentMatchId?: number };
    if (!body.tournamentMatchId) {
      return NextResponse.json({ error: "Missing tournamentMatchId" }, { status: 400 });
    }

    const db = getDb();
    const tournament = db
      .prepare("select id from tournaments where web_slug = ?")
      .get(slug) as { id: number } | undefined;
    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    const tm = db
      .prepare("select tournament_id from tournament_matches where id = ?")
      .get(body.tournamentMatchId) as { tournament_id: number } | undefined;
    if (!tm || tm.tournament_id !== tournament.id) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    try {
      createTournamentService(db).reopenTournamentMatch(body.tournamentMatchId, session.user.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reopen";
      const status = /organizer/i.test(message) ? 403 : 400;
      return NextResponse.json({ error: message }, { status });
    }

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "match-updated", slug },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/tournaments/[slug]/reopen] error:", error);
    return NextResponse.json({ error: "Failed to reopen match" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/tournament-reopen-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/[slug]/reopen/route.ts packages/web/tests/tournament-reopen-route.test.ts
git commit -m "feat(web): POST /api/tournaments/[slug]/reopen (host, round-robin)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

> The reopen *UI control* (host-only button on completed round-robin matches) is built in Phase 4 Task 14, where the match card lives in the new component tree.

---

## Phase 3 — Notify opponent on report (auto-deleting channel ping)

### Task 4: New announce kinds in the web announce client

**Files:**
- Modify: `packages/web/src/lib/announce-bot.ts:3-8` (extend `AnnouncePayload` union)
- Test: `packages/web/tests/announce-bot-types.test.ts` (create — a type/shape smoke test)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/announce-bot-types.test.ts
import { describe, expect, it, vi } from "vitest";
import { announceToBot, type AnnouncePayload } from "@/lib/announce-bot";

describe("announce-bot new kinds", () => {
  it("accepts match-report-pending and match-resolved payloads", async () => {
    const pending: AnnouncePayload = {
      kind: "match-report-pending",
      guildId: "g1",
      slug: "s1",
      matchId: 5,
      tournamentMatchId: 9,
      tournamentName: "RR",
      roundNumber: 2,
      reporterDiscordId: "u-a",
      opponentDiscordId: "u-b",
      reporterName: "Alice",
      opponentName: "Bob",
      opponentLost: true,
    };
    const resolved: AnnouncePayload = { kind: "match-resolved", matchId: 5 };
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await announceToBot({ url: "http://bot", secret: "x" }, pending);
    await announceToBot({ url: "http://bot", secret: "x" }, resolved);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bot/internal/announce/match-report-pending",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bot/internal/announce/match-resolved",
      expect.any(Object),
    );
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/announce-bot-types.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — TypeScript error: object not assignable to `AnnouncePayload` (kind `"match-report-pending"` not in union).

- [ ] **Step 3: Extend the union**

In `packages/web/src/lib/announce-bot.ts`, append two members to the `AnnouncePayload` union (after the `tournament-started` member, before the closing `;`):

```typescript
  | {
      kind: "match-report-pending";
      guildId: string;
      slug: string;
      matchId: number;
      tournamentMatchId: number;
      tournamentName: string;
      roundNumber: number;
      reporterDiscordId: string;
      opponentDiscordId: string;
      reporterName: string;
      opponentName: string;
      opponentLost: boolean;
    }
  | { kind: "match-resolved"; matchId: number };
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/announce-bot-types.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/announce-bot.ts packages/web/tests/announce-bot-types.test.ts
git commit -m "feat(web): add match-report-pending/match-resolved announce kinds

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5: Emit `match-report-pending` from the report route

**Files:**
- Modify: `packages/web/app/api/tournaments/[slug]/report/route.ts` (after the existing `notifyWsTournament` call, before the final `return NextResponse.json({ success: true, matchId })`)
- Test: `packages/web/tests/report-route-notify.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/report-route-notify.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createTournamentService } from "@yugidraft/shared/services";

const auth = vi.fn();
const announceToBot = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/announce-bot", () => ({ announceToBot }));
const tempDirs: string[] = [];

describe("report route notifies opponent", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    announceToBot.mockClear();
    auth.mockResolvedValue({ user: { id: "u-a", name: "Alice" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("calls announceToBot with match-report-pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rep-"));
    tempDirs.push(dir);
    process.env.DATABASE_PATH = join(dir, "bot.sqlite");
    process.env.DISCORD_GUILD_ID = "g1";
    const db = new Database(process.env.DATABASE_PATH);
    migrate(db);
    const aId = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u-a','Alice')").run().lastInsertRowid);
    const bId = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u-b','Bob')").run().lastInsertRowid);
    const t = createTournamentService(db);
    const tour = t.create("g1", "RR", "round_robin", "u-creator");
    db.prepare("update tournaments set web_slug = 'slug1' where id = ?").run(tour.id);
    t.join(tour.id, aId);
    t.join(tour.id, bId);
    t.start(tour.id);
    const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(tour.id) as any;

    const { POST } = await import("../app/api/tournaments/[slug]/report/route");
    const res = await POST(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ tournamentMatchId: tm.id, result: "win" }),
      }),
      { params: Promise.resolve({ slug: "slug1" }) },
    );
    expect(res.status).toBe(200);
    expect(announceToBot).toHaveBeenCalledTimes(1);
    const payload = announceToBot.mock.calls[0][1];
    expect(payload).toMatchObject({
      kind: "match-report-pending",
      slug: "slug1",
      reporterDiscordId: "u-a",
      opponentDiscordId: "u-b",
      reporterName: "Alice",
      opponentName: "Bob",
      roundNumber: 1,
      opponentLost: true,
    });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/report-route-notify.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — `announceToBot` not called (0 times).

- [ ] **Step 3: Emit the announce in the report route**

In `packages/web/app/api/tournaments/[slug]/report/route.ts`:

Add imports at the top (next to the existing imports):

```typescript
import { announceToBot } from "@/lib/announce-bot";
```

Immediately **after** the existing `void notifyWsTournament(...)` call and **before** `return NextResponse.json({ success: true, matchId });`, insert:

```typescript
    const meta = db
      .prepare(
        `
        select
          t.name as tournament_name,
          tm.round_number as round_number,
          rp.discord_user_id as reporter_discord_id,
          rp.display_name as reporter_name,
          op.discord_user_id as opponent_discord_id,
          op.display_name as opponent_name
        from tournament_matches tm
        join tournaments t on t.id = tm.tournament_id
        join players rp on rp.id = ?
        join players op on op.id = ?
        where tm.id = ?
      `,
      )
      .get(reporterId, opponentId, tournamentMatch.id) as
      | {
          tournament_name: string;
          round_number: number;
          reporter_discord_id: string;
          reporter_name: string;
          opponent_discord_id: string;
          opponent_name: string;
        }
      | undefined;

    if (meta) {
      void announceToBot(
        { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
        {
          kind: "match-report-pending",
          guildId: tournament.guild_id,
          slug,
          matchId,
          tournamentMatchId: tournamentMatch.id,
          tournamentName: meta.tournament_name,
          roundNumber: meta.round_number,
          reporterDiscordId: meta.reporter_discord_id,
          opponentDiscordId: meta.opponent_discord_id,
          reporterName: meta.reporter_name,
          opponentName: meta.opponent_name,
          opponentLost: winnerId === reporterId,
        },
      );
    }
```

> `reporterId`, `opponentId`, `winnerId`, `matchId`, `tournament`, `tournamentMatch`, `slug`, `db`, and `env` are all already in scope in this handler (verified in the existing route).

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/report-route-notify.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/[slug]/report/route.ts packages/web/tests/report-route-notify.test.ts
git commit -m "feat(web): emit match-report-pending announce on report

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 6: Emit `match-resolved` from approve & deny routes

**Files:**
- Modify: `packages/web/app/api/matches/[id]/approve/route.ts`
- Modify: `packages/web/app/api/matches/[id]/deny/route.ts`
- Test: `packages/web/tests/match-resolve-notify.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/match-resolve-notify.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createTournamentService } from "@yugidraft/shared/services";

const auth = vi.fn();
const announceToBot = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/announce-bot", () => ({ announceToBot }));
const tempDirs: string[] = [];

function scenario() {
  const dir = mkdtempSync(join(tmpdir(), "mr-"));
  tempDirs.push(dir);
  process.env.DATABASE_PATH = join(dir, "bot.sqlite");
  process.env.DISCORD_GUILD_ID = "g1";
  const db = new Database(process.env.DATABASE_PATH);
  migrate(db);
  const aId = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u-a','A')").run().lastInsertRowid);
  const bId = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u-b','B')").run().lastInsertRowid);
  const t = createTournamentService(db);
  const tour = t.create("g1", "RR", "round_robin", "u-creator");
  db.prepare("update tournaments set web_slug = 'slug1' where id = ?").run(tour.id);
  t.join(tour.id, aId); t.join(tour.id, bId); t.start(tour.id);
  const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(tour.id) as any;
  const rep = t.reportTournamentMatch(tm.id, aId, aId);
  return { db, matchId: rep.id };
}

describe("approve/deny emit match-resolved", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    announceToBot.mockClear();
    auth.mockResolvedValue({ user: { id: "u-b", name: "B" } }); // opponent resolves
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  it("approve emits match-resolved", async () => {
    const { matchId } = scenario();
    const { POST } = await import("../app/api/matches/[id]/approve/route");
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: String(matchId) }) });
    expect(res.status).toBe(200);
    expect(announceToBot).toHaveBeenCalledWith(
      expect.any(Object),
      { kind: "match-resolved", matchId },
    );
  });

  it("deny emits match-resolved", async () => {
    const { matchId } = scenario();
    const { POST } = await import("../app/api/matches/[id]/deny/route");
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: String(matchId) }) });
    expect(res.status).toBe(200);
    expect(announceToBot).toHaveBeenCalledWith(
      expect.any(Object),
      { kind: "match-resolved", matchId },
    );
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/match-resolve-notify.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — `announceToBot` not called.

- [ ] **Step 3: Emit `match-resolved` in both routes**

In **both** `packages/web/app/api/matches/[id]/approve/route.ts` and `.../deny/route.ts`, add the import:

```typescript
import { announceToBot } from "@/lib/announce-bot";
```

In `approve/route.ts`, immediately after `const approved = matches.approve(matchId, player.id);` and before the `if (match.tournament_slug)` block, add:

```typescript
    void announceToBot(
      { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
      { kind: "match-resolved", matchId },
    );
```

In `deny/route.ts`, immediately after `const denied = matches.deny(matchId, player.id);` and before the `if (match.tournament_slug)` block, add the same `void announceToBot(... { kind: "match-resolved", matchId })` call.

> `env` is already imported in both routes (used for `env.wsInternalUrl`). `matchId` is already in scope.

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/match-resolve-notify.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/matches/[id]/approve/route.ts packages/web/app/api/matches/[id]/deny/route.ts packages/web/tests/match-resolve-notify.test.ts
git commit -m "feat(web): emit match-resolved announce on approve/deny

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 7: `deleteNotifyMessage` bot helper

**Files:**
- Create: `packages/bot/src/lib/notify-message.ts`
- Test: `packages/bot/tests/lib/notify-message.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bot/tests/lib/notify-message.test.ts
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { deleteNotifyMessage } from "../../src/lib/notify-message.js";

function dbWithMatch(notify: { channel: string | null; message: string | null }) {
  const db = new Database(":memory:");
  migrate(db);
  const a = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','a','A')").run().lastInsertRowid);
  const b = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','b','B')").run().lastInsertRowid);
  const id = Number(
    db.prepare(
      "insert into matches (guild_id, player_one_id, player_two_id, reporter_id, status, source, notify_channel_id, notify_message_id) values ('g',?,?,?, 'approved','tournament',?,?)",
    ).run(a, b, a, notify.channel, notify.message).lastInsertRowid,
  );
  return { db, id };
}

describe("deleteNotifyMessage", () => {
  it("deletes the stored message and clears the columns", async () => {
    const { db, id } = dbWithMatch({ channel: "c1", message: "m1" });
    const del = vi.fn(async () => {});
    const client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, messages: { delete: del } })) },
    };
    await deleteNotifyMessage(client as any, db, id);
    expect(client.channels.fetch).toHaveBeenCalledWith("c1");
    expect(del).toHaveBeenCalledWith("m1");
    const row = db.prepare("select notify_channel_id, notify_message_id from matches where id = ?").get(id) as any;
    expect(row.notify_channel_id).toBeNull();
    expect(row.notify_message_id).toBeNull();
  });

  it("no-ops when there is no stored message", async () => {
    const { db, id } = dbWithMatch({ channel: null, message: null });
    const client = { channels: { fetch: vi.fn() } };
    await deleteNotifyMessage(client as any, db, id);
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("clears columns even if the Discord delete throws (message already gone)", async () => {
    const { db, id } = dbWithMatch({ channel: "c1", message: "m1" });
    const client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, messages: { delete: vi.fn(async () => { throw new Error("Unknown Message"); }) } })) },
    };
    await deleteNotifyMessage(client as any, db, id);
    const row = db.prepare("select notify_message_id from matches where id = ?").get(id) as any;
    expect(row.notify_message_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/bot/tests/lib/notify-message.test.ts`
Expected: FAIL — cannot find module `../../src/lib/notify-message.js`.

- [ ] **Step 3: Implement the helper**

```typescript
// packages/bot/src/lib/notify-message.ts
import type { Client } from "discord.js";
import type Database from "better-sqlite3";

/**
 * Deletes the Discord notification message recorded on a match (if any) and
 * clears notify_channel_id / notify_message_id. Safe to call repeatedly and
 * tolerant of an already-deleted message.
 */
export async function deleteNotifyMessage(
  client: Pick<Client, "channels">,
  db: Database.Database,
  matchId: number,
): Promise<void> {
  const row = db
    .prepare("select notify_channel_id, notify_message_id from matches where id = ?")
    .get(matchId) as { notify_channel_id: string | null; notify_message_id: string | null } | undefined;

  if (!row?.notify_channel_id || !row.notify_message_id) {
    return;
  }

  try {
    const channel = await client.channels.fetch(row.notify_channel_id);
    if (channel && "messages" in channel && channel.isTextBased()) {
      await channel.messages.delete(row.notify_message_id);
    }
  } catch {
    // message already gone / no access — fall through and clear columns
  }

  db.prepare(
    "update matches set notify_channel_id = null, notify_message_id = null where id = ?",
  ).run(matchId);
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/bot/tests/lib/notify-message.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/lib/notify-message.ts packages/bot/tests/lib/notify-message.test.ts
git commit -m "feat(bot): deleteNotifyMessage helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 8: Announce server — add the two kinds + routes + handler interface

**Files:**
- Modify: `packages/bot/src/announce/server.ts` (`AnnouncePayload` union, `AnnounceHandlers` interface, `routes` table)
- Test: `packages/bot/tests/announce/server-routes.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bot/tests/announce/server-routes.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAnnounceServer } from "../../src/announce/server.js";

function sign(body: string, secret: string) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("announce server new routes", () => {
  it("dispatches match-report-pending and match-resolved", async () => {
    const onMatchReportPending = vi.fn(async () => {});
    const onMatchResolved = vi.fn(async () => {});
    const server = createAnnounceServer({
      secret: "s",
      handlers: {
        onDraftCreated: vi.fn(), onDraftStarted: vi.fn(), onDraftCompleted: vi.fn(),
        onTournamentCreated: vi.fn(), onTournamentStarted: vi.fn(),
        onMatchReportPending, onMatchResolved,
      },
    });
    const body1 = JSON.stringify({ matchId: 1 });
    const res1 = await server.handle(
      new Request("http://x/internal/announce/match-resolved", {
        method: "POST", body: body1, headers: { "x-announce-signature": sign(body1, "s") },
      }),
    );
    expect(res1.status).toBe(200);
    expect(onMatchResolved).toHaveBeenCalledWith({ matchId: 1 });

    const body2 = JSON.stringify({ guildId: "g", matchId: 2 });
    const res2 = await server.handle(
      new Request("http://x/internal/announce/match-report-pending", {
        method: "POST", body: body2, headers: { "x-announce-signature": sign(body2, "s") },
      }),
    );
    expect(res2.status).toBe(200);
    expect(onMatchReportPending).toHaveBeenCalledWith({ guildId: "g", matchId: 2 });
  });
});
```

> If `createAnnounceServer` does not expose a `handle(request)` method, adapt this test to the actual public surface discovered in `server.ts` (e.g. call the exported request handler directly). Keep the assertions: signed POST to each new path dispatches to the matching handler.

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/bot/tests/announce/server-routes.test.ts`
Expected: FAIL — 404 / handler not found for the new paths (and TS error: handlers object missing `onMatchReportPending`).

- [ ] **Step 3: Extend server.ts**

In `packages/bot/src/announce/server.ts`:

Add to the `AnnouncePayload` union (mirror the web client exactly):

```typescript
  | {
      kind: "match-report-pending";
      guildId: string;
      slug: string;
      matchId: number;
      tournamentMatchId: number;
      tournamentName: string;
      roundNumber: number;
      reporterDiscordId: string;
      opponentDiscordId: string;
      reporterName: string;
      opponentName: string;
      opponentLost: boolean;
    }
  | { kind: "match-resolved"; matchId: number };
```

Add to the `AnnounceHandlers` interface:

```typescript
  onMatchReportPending(payload: OmitKind<Extract<AnnouncePayload, { kind: "match-report-pending" }>>): Promise<void>;
  onMatchResolved(payload: OmitKind<Extract<AnnouncePayload, { kind: "match-resolved" }>>): Promise<void>;
```

Add to the `routes` table:

```typescript
  "/internal/announce/match-report-pending": (d) => opts.handlers.onMatchReportPending(d),
  "/internal/announce/match-resolved": (d) => opts.handlers.onMatchResolved(d),
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/bot/tests/announce/server-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/announce/server.ts packages/bot/tests/announce/server-routes.test.ts
git commit -m "feat(bot): announce routes for match-report-pending/resolved

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 9: Announce message builder for the report ping

**Files:**
- Modify: `packages/bot/src/announce/messages.ts` (add a builder next to `tournamentCreatedAnnouncement`)
- Test: `packages/bot/tests/announce/report-ping-message.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bot/tests/announce/report-ping-message.test.ts
import { describe, expect, it } from "vitest";
import { reportPendingAnnouncement } from "../../src/announce/messages.js";

describe("reportPendingAnnouncement", () => {
  it("pings the opponent and includes approve/deny buttons for the match", () => {
    const msg = reportPendingAnnouncement({
      matchId: 42,
      tournamentName: "Friday Cube",
      roundNumber: 2,
      reporterName: "Alice",
      opponentDiscordId: "111",
      opponentLost: true,
    });
    expect(msg.content).toContain("<@111>");
    expect(msg.content).toContain("Alice");
    expect(msg.content).toContain("Friday Cube");
    expect(msg.content.toLowerCase()).toContain("lost");
    const ids = msg.components[0].components.map((c: any) => c.data.custom_id);
    expect(ids).toEqual(["dashboard_approve:42", "dashboard_deny:42"]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/bot/tests/announce/report-ping-message.test.ts`
Expected: FAIL — `reportPendingAnnouncement` is not exported.

- [ ] **Step 3: Add the builder**

In `packages/bot/src/announce/messages.ts` add (it already imports `ActionRowBuilder`, `ButtonBuilder`, `ButtonStyle` for the existing builders — reuse those imports):

```typescript
export function reportPendingAnnouncement(input: {
  matchId: number;
  tournamentName: string;
  roundNumber: number;
  reporterName: string;
  opponentDiscordId: string;
  opponentLost: boolean;
}): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const verb = input.opponentLost ? "lost" : "won";
  return {
    content:
      `<@${input.opponentDiscordId}> — **${input.reporterName}** reported that you **${verb}** ` +
      `Round ${input.roundNumber} of **${input.tournamentName}**. Approve or deny:`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`dashboard_approve:${input.matchId}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`dashboard_deny:${input.matchId}`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/bot/tests/announce/report-ping-message.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/announce/messages.ts packages/bot/tests/announce/report-ping-message.test.ts
git commit -m "feat(bot): reportPendingAnnouncement message builder

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 10: Announce handlers — post the ping & delete on resolve

**Files:**
- Modify: `packages/bot/src/announce/handlers.ts` (`createAnnounceHandlers` signature gains `guildSettings`; add `onMatchReportPending`, `onMatchResolved`)
- Modify: `packages/bot/src/index.ts` (pass `guildSettings: deps.guildSettings` into `createAnnounceHandlers`)
- Test: `packages/bot/tests/announce/match-handlers.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bot/tests/announce/match-handlers.test.ts
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createGuildSettingsService } from "@yugidraft/shared/services";
import { createAnnounceHandlers } from "../../src/announce/handlers.js";

function baseDeps() {
  const db = new Database(":memory:");
  migrate(db);
  const a = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','a','A')").run().lastInsertRowid);
  const b = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','b','B')").run().lastInsertRowid);
  const matchId = Number(
    db.prepare("insert into matches (guild_id, player_one_id, player_two_id, reporter_id, status, source) values ('g',?,?,?, 'pending','tournament')")
      .run(a, b, a).lastInsertRowid,
  );
  const guildSettings = createGuildSettingsService(db);
  return { db, matchId, guildSettings };
}

describe("announce match handlers", () => {
  it("onMatchReportPending posts to the announce channel and stores notify ids", async () => {
    const { db, matchId, guildSettings } = baseDeps();
    db.prepare("insert into guild_settings (guild_id, announce_channel_id) values ('g','chan-1')").run();
    const sent = { id: "msg-1" };
    const send = vi.fn(async () => sent);
    const client = { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) } };
    const handlers = createAnnounceHandlers({
      client: client as any, db, guildSettings,
      drafts: {} as any, messenger: {} as any,
    });
    await handlers.onMatchReportPending({
      guildId: "g", slug: "s", matchId, tournamentMatchId: 7,
      tournamentName: "RR", roundNumber: 1,
      reporterDiscordId: "a", opponentDiscordId: "b",
      reporterName: "A", opponentName: "B", opponentLost: true,
    });
    expect(client.channels.fetch).toHaveBeenCalledWith("chan-1");
    expect(send).toHaveBeenCalled();
    const row = db.prepare("select notify_channel_id, notify_message_id from matches where id = ?").get(matchId) as any;
    expect(row.notify_channel_id).toBe("chan-1");
    expect(row.notify_message_id).toBe("msg-1");
  });

  it("onMatchReportPending no-ops when no announce channel is set", async () => {
    const { db, matchId, guildSettings } = baseDeps();
    const client = { channels: { fetch: vi.fn() } };
    const handlers = createAnnounceHandlers({
      client: client as any, db, guildSettings, drafts: {} as any, messenger: {} as any,
    });
    await handlers.onMatchReportPending({
      guildId: "g", slug: "s", matchId, tournamentMatchId: 7, tournamentName: "RR",
      roundNumber: 1, reporterDiscordId: "a", opponentDiscordId: "b",
      reporterName: "A", opponentName: "B", opponentLost: true,
    });
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("onMatchResolved deletes the stored message", async () => {
    const { db, matchId, guildSettings } = baseDeps();
    db.prepare("update matches set notify_channel_id='chan-1', notify_message_id='msg-1' where id = ?").run(matchId);
    const del = vi.fn(async () => {});
    const client = { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, messages: { delete: del } })) } };
    const handlers = createAnnounceHandlers({
      client: client as any, db, guildSettings, drafts: {} as any, messenger: {} as any,
    });
    await handlers.onMatchResolved({ matchId });
    expect(del).toHaveBeenCalledWith("msg-1");
    const row = db.prepare("select notify_message_id from matches where id = ?").get(matchId) as any;
    expect(row.notify_message_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/bot/tests/announce/match-handlers.test.ts`
Expected: FAIL — `handlers.onMatchReportPending is not a function` / signature missing `guildSettings`.

- [ ] **Step 3: Implement the handlers**

In `packages/bot/src/announce/handlers.ts`:

1. Add imports:

```typescript
import type { GuildSettingsService } from "@yugidraft/shared/services";
import { reportPendingAnnouncement } from "./messages.js";
import { deleteNotifyMessage } from "../lib/notify-message.js";
```

2. Add `guildSettings: GuildSettingsService;` to the destructured parameter type of `createAnnounceHandlers({ client, db, ... })`.

3. Add these two handlers to the returned object:

```typescript
    async onMatchReportPending(p) {
      const channelId = guildSettings.get(p.guildId).announceChannelId;
      if (!channelId) return; // graceful no-op
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || !channel.isTextBased()) return;
      const msg = await channel.send(
        reportPendingAnnouncement({
          matchId: p.matchId,
          tournamentName: p.tournamentName,
          roundNumber: p.roundNumber,
          reporterName: p.reporterName,
          opponentDiscordId: p.opponentDiscordId,
          opponentLost: p.opponentLost,
        }),
      );
      db.prepare(
        "update matches set notify_channel_id = ?, notify_message_id = ? where id = ?",
      ).run(channelId, msg.id, p.matchId);
    },

    async onMatchResolved(p) {
      await deleteNotifyMessage(client, db, p.matchId);
    },
```

> `client` and `db` are already destructured params of `createAnnounceHandlers`. `guildSettings.get(guildId).announceChannelId` is the existing `GuildSettingsService` accessor.

4. In `packages/bot/src/index.ts`, find the `createAnnounceHandlers({ client, db, drafts: deps.drafts, messenger: deps.messenger })` call and add `guildSettings: deps.guildSettings,` to it.

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/bot/tests/announce/match-handlers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Build bot + commit**

```bash
npm run build --workspace=packages/bot
git add packages/bot/src/announce/handlers.ts packages/bot/src/index.ts packages/bot/tests/announce/match-handlers.test.ts
git commit -m "feat(bot): post/delete report-pending notification in announce channel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 11: Delete the ping when resolved via a Discord button

**Files:**
- Modify: `packages/bot/src/interactions/buttons.ts` (in the `dashboard_approve` and `dashboard_deny` blocks, after the match is resolved)
- Modify: `packages/bot/src/index.ts` (wire an optional `deleteNotifyMessage` into the button `deps`)
- Test: `packages/bot/tests/interactions/buttons-notify-cleanup.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bot/tests/interactions/buttons-notify-cleanup.test.ts
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleButton, type ButtonInteractionLike } from "../../src/interactions/buttons.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createMatchService, createTournamentService } from "@yugidraft/shared/services";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return {
    db,
    matches: createMatchService(db),
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
    drafts: createDraftService(db),
    cards: createCardCatalogService(db),
  };
}

describe("dashboard approve clears notify message", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("calls deleteNotifyMessage with the resolved match id", async () => {
    const app = setup();
    const a = app.players.upsert("guild-1", "u-a", "A");
    const b = app.players.upsert("guild-1", "u-b", "B");
    const tour = app.tournaments.create("guild-1", "RR", "round_robin", "u-creator");
    app.tournaments.join(tour.id, a.id);
    app.tournaments.join(tour.id, b.id);
    app.tournaments.start(tour.id);
    const tm = app.db.prepare("select * from tournament_matches where tournament_id = ?").get(tour.id) as any;
    const rep = app.tournaments.reportTournamentMatch(tm.id, a.id, a.id);

    const deleteNotifyMessage = vi.fn(async () => {});
    const replies: any[] = [];
    const interaction: ButtonInteractionLike = {
      customId: `dashboard_approve:${rep.id}`,
      channelId: "c", guildId: "guild-1",
      user: { id: "u-b", username: "B" },
      reply: (m) => { replies.push(m); },
      showModal: () => {},
    };

    await handleButton(interaction, { ...app, deleteNotifyMessage });
    expect(deleteNotifyMessage).toHaveBeenCalledWith(rep.id);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/bot/tests/interactions/buttons-notify-cleanup.test.ts`
Expected: FAIL — `deleteNotifyMessage` not called.

- [ ] **Step 3: Call the optional dep in both branches**

In `packages/bot/src/interactions/buttons.ts`, in the `dashboard_approve` block, after `const match = deps.matches.approve(...)` and before `await interaction.reply(...)`, add:

```typescript
  if (deps.deleteNotifyMessage) {
    await deps.deleteNotifyMessage(match.id);
  }
```

Add the identical block in the `dashboard_deny` block (after `deps.matches.deny(...)`).

Add `deleteNotifyMessage?` to the `deps` type used by `handleButton` (the existing dependencies type/interface in this file) as:

```typescript
  deleteNotifyMessage?: (matchId: number) => Promise<void>;
```

In `packages/bot/src/index.ts`, where the button `deps` object is assembled (the object passed to `handleButton`/the interaction router — same object that has `matches`, `players`, `tournaments`), add:

```typescript
  deleteNotifyMessage: (matchId: number) => deleteNotifyMessage(client, db, matchId),
```

and import it at the top of `index.ts`:

```typescript
import { deleteNotifyMessage } from "./lib/notify-message.js";
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/bot/tests/interactions/buttons-notify-cleanup.test.ts`
Expected: PASS. Also run the existing `npx vitest run packages/bot/tests/interactions/buttons.test.ts` — Expected: still PASS (optional dep, existing tests omit it).

- [ ] **Step 5: Build bot + commit**

```bash
npm run build --workspace=packages/bot
git add packages/bot/src/interactions/buttons.ts packages/bot/src/index.ts packages/bot/tests/interactions/buttons-notify-cleanup.test.ts
git commit -m "feat(bot): delete report ping when resolved via Discord button

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 12: TTL sweep for orphaned notify messages

**Files:**
- Create: `packages/bot/src/services/notify-cleanup.ts`
- Modify: `packages/bot/src/index.ts` (start the sweep on a `setInterval`, like `draft-timer`)
- Test: `packages/bot/tests/services/notify-cleanup.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bot/tests/services/notify-cleanup.test.ts
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createNotifyCleanupService } from "../../src/services/notify-cleanup.js";

function matchRow(db: Database.Database, status: string, ageMinutes: number) {
  const a = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','a','A')").run().lastInsertRowid);
  const b = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','b','B')").run().lastInsertRowid);
  const id = Number(
    db.prepare(
      "insert into matches (guild_id, player_one_id, player_two_id, reporter_id, status, source, created_at, notify_channel_id, notify_message_id) values ('g',?,?,?,?, 'tournament', datetime('now', ?), 'c','m')",
    ).run(a, b, a, status, `-${ageMinutes} minutes`).lastInsertRowid,
  );
  return id;
}

describe("notify cleanup sweep", () => {
  it("clears notify ids for resolved matches and for stale pending ones", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const resolved = matchRow(db, "approved", 1);
    const stalePending = matchRow(db, "pending", 9999);
    const freshPending = matchRow(db, "pending", 1);
    const calls: number[] = [];
    const svc = createNotifyCleanupService({
      db,
      ttlMinutes: 720,
      deleteNotifyMessage: async (id: number) => { calls.push(id); },
    });

    await svc.tick();

    expect(calls.sort()).toEqual([resolved, stalePending].sort());
    expect(calls).not.toContain(freshPending);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/bot/tests/services/notify-cleanup.test.ts`
Expected: FAIL — cannot find module `notify-cleanup.js`.

- [ ] **Step 3: Implement the service**

```typescript
// packages/bot/src/services/notify-cleanup.ts
import type Database from "better-sqlite3";

export function createNotifyCleanupService(opts: {
  db: Database.Database;
  ttlMinutes: number;
  deleteNotifyMessage: (matchId: number) => Promise<void>;
}) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    const rows = opts.db
      .prepare(
        `
        select id from matches
        where notify_message_id is not null
          and (
            status != 'pending'
            or created_at < datetime('now', ?)
          )
      `,
      )
      .all(`-${opts.ttlMinutes} minutes`) as Array<{ id: number }>;

    for (const row of rows) {
      try {
        await opts.deleteNotifyMessage(row.id);
      } catch (error) {
        console.warn(`[notify-cleanup] failed for match ${row.id}`, error);
      }
    }
  }

  return {
    tick,
    start() {
      if (intervalId) return;
      intervalId = setInterval(() => {
        void tick();
      }, 60_000);
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
}

export type NotifyCleanupService = ReturnType<typeof createNotifyCleanupService>;
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/bot/tests/services/notify-cleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into bot startup**

In `packages/bot/src/index.ts`, after the announce server is started and after `deleteNotifyMessage` is in scope (Task 11 import), add:

```typescript
import { createNotifyCleanupService } from "./services/notify-cleanup.js";
// ...
const notifyCleanup = createNotifyCleanupService({
  db,
  ttlMinutes: Number(process.env.NOTIFY_MESSAGE_TTL_MINUTES ?? 720),
  deleteNotifyMessage: (matchId: number) => deleteNotifyMessage(client, db, matchId),
});
notifyCleanup.start();
```

(Place it near where `draftTimer.start()` is invoked.)

- [ ] **Step 6: Build bot + commit**

```bash
npm run build --workspace=packages/bot
git add packages/bot/src/services/notify-cleanup.ts packages/bot/src/index.ts packages/bot/tests/services/notify-cleanup.test.ts
git commit -m "feat(bot): TTL sweep for orphaned notify messages

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 13: Phase 3 integration check

- [ ] **Step 1: Typecheck + full test for touched packages**

Run: `npm run typecheck && npm test --workspace=packages/shared && npm test --workspace=packages/bot && npm test --workspace=packages/web`
Expected: all green. Fix any breakage before continuing (likely a missing `OmitKind` import or handler-object literal in a test that constructs `AnnounceHandlers`).

- [ ] **Step 2: Commit any fixes**

```bash
git add -A && git commit -m "test: phase 3 integration fixes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Tabbed tournament page

> The current page is `packages/web/app/(app)/tournament/[slug]/page.tsx` (~549 lines, one client component). This phase decomposes it. New components live in `packages/web/src/components/tournament/` (existing convention — that directory already holds `create-tournament-form.tsx`). The page file becomes a thin shell.

**Target file structure (created across the tasks below):**
- `packages/web/src/components/ui/tabs.tsx` — generic accessible Tabs primitive.
- `packages/web/src/components/tournament/types.ts` — shared `TournamentDetail`/`Match`/`Participant` types (moved out of the page).
- `packages/web/src/components/tournament/use-my-matches.ts` — derive "my matches", action item, badge count from a `TournamentDetail`.
- `packages/web/src/components/tournament/match-card.tsx` — extracted MatchCard + report form + approve/deny + host reopen.
- `packages/web/src/components/tournament/your-action-card.tsx` — pinned report/approve/deny card.
- `packages/web/src/components/tournament/overview-tab.tsx`, `my-matches-tab.tsx`, `all-matches-tab.tsx`, `players-tab.tsx`, `standings-tab.tsx`.
- `packages/web/src/components/tournament/tournament-lobby.tsx` — the pending-state UI extracted as-is.
- `packages/web/app/(app)/tournament/[slug]/page.tsx` — shell: fetch, websocket, status routing, tab state synced to `?tab=`.
- `packages/web/app/(app)/tournament/[slug]/standings/page.tsx` — redirect to `?tab=standings`.

### Task 14: Tabs primitive

**Files:**
- Create: `packages/web/src/components/ui/tabs.tsx`
- Test: `packages/web/tests/components/tabs.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/components/tabs.test.tsx
// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "../../src/components/ui/tabs";

describe("Tabs", () => {
  it("renders tabs, marks the active one, and fires onChange", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        value="overview"
        onChange={onChange}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "my", label: "My Matches", badge: 2 },
          { id: "all", label: "All Matches" },
        ]}
      />,
    );
    const active = screen.getByRole("tab", { name: /overview/i });
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("2")).toBeTruthy(); // badge
    fireEvent.click(screen.getByRole("tab", { name: /my matches/i }));
    expect(onChange).toHaveBeenCalledWith("my");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/components/tabs.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — cannot find module `../../src/components/ui/tabs`.

- [ ] **Step 3: Implement Tabs**

```typescript
// packages/web/src/components/ui/tabs.tsx
"use client";

import { cn } from "@/lib/utils";

export interface TabDef {
  id: string;
  label: string;
  badge?: number;
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Tournament sections"
      className="mb-6 flex gap-1 overflow-x-auto border-b border-border"
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative whitespace-nowrap px-4 py-2.5 text-sm font-medium motion-safe:transition-colors",
              selected
                ? "border-b-2 border-accent-primary text-text-primary"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {tab.label}
            {typeof tab.badge === "number" && tab.badge > 0 && (
              <span className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-accent-primary px-1 text-xs text-white">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

> Confirm `@/lib/utils` exports `cn` (it is used by `button.tsx`/`badge.tsx`). If the helper lives elsewhere, import from the same path those components use.

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/components/tabs.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/ui/tabs.tsx packages/web/tests/components/tabs.test.tsx
git commit -m "feat(web): accessible Tabs primitive

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 15: Tournament types module + `useMyMatches` derivation

**Files:**
- Create: `packages/web/src/components/tournament/types.ts`
- Create: `packages/web/src/components/tournament/use-my-matches.ts`
- Test: `packages/web/tests/components/use-my-matches.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/components/use-my-matches.test.ts
import { describe, expect, it } from "vitest";
import { deriveMyMatches } from "../../src/components/tournament/use-my-matches";
import type { TournamentDetail } from "../../src/components/tournament/types";

const base: TournamentDetail = {
  id: 1, name: "RR", format: "round_robin", status: "active",
  createdByUserId: "host", participants: [], isParticipant: true,
  currentUserPlayerId: 10,
  matches: [
    { id: 1, matchId: null, roundNumber: 1, playerOneId: 10, playerTwoId: 20, playerOneName: "Me", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {} },
    { id: 2, matchId: 5, roundNumber: 1, playerOneId: 20, playerTwoId: 10, playerOneName: "Bob", playerTwoName: "Me", status: "pending_approval", winnerId: 20, reporterId: 20, metadata: {} },
    { id: 3, matchId: null, roundNumber: 1, playerOneId: 20, playerTwoId: 30, playerOneName: "Bob", playerTwoName: "Cy", status: "open", winnerId: null, reporterId: null, metadata: {} },
  ],
};

describe("deriveMyMatches", () => {
  it("returns only the current user's matches", () => {
    const r = deriveMyMatches(base);
    expect(r.mine.map((m) => m.id).sort()).toEqual([1, 2]);
  });

  it("counts items needing the user (own open + opponent-pending)", () => {
    const r = deriveMyMatches(base);
    // match 1: my open -> needs me. match 2: opponent reported, pending my approval -> needs me.
    expect(r.needsMeCount).toBe(2);
    expect(r.actionMatch?.id).toBe(1); // first actionable
  });

  it("zero count when not a participant", () => {
    const r = deriveMyMatches({ ...base, currentUserPlayerId: null });
    expect(r.mine).toEqual([]);
    expect(r.needsMeCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/components/use-my-matches.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Implement types + derivation**

```typescript
// packages/web/src/components/tournament/types.ts
export interface Participant {
  playerId: number;
  displayName: string;
}

export interface Match {
  id: number;
  matchId: number | null;
  roundNumber: number;
  playerOneId: number;
  playerTwoId: number | null;
  playerOneName: string;
  playerTwoName: string | null;
  status: string;
  winnerId: number | null;
  reporterId: number | null;
  metadata: Record<string, unknown>;
}

export interface TournamentDetail {
  id: number;
  name: string;
  format: string;
  status: string;
  createdByUserId: string;
  participants: Participant[];
  matches: Match[];
  isParticipant: boolean;
  currentUserPlayerId: number | null;
}

export interface StandingsRow {
  playerId: number;
  displayName: string;
  wins: number;
  losses: number;
}
```

```typescript
// packages/web/src/components/tournament/use-my-matches.ts
import type { Match, TournamentDetail } from "./types";

export interface MyMatches {
  mine: Match[];
  needsMeCount: number;
  actionMatch: Match | null;
}

function isMine(m: Match, playerId: number): boolean {
  return m.playerOneId === playerId || m.playerTwoId === playerId;
}

// "needs me": an open match I'm in (I can report), OR a pending_approval
// match where my opponent reported (I must approve/deny).
function needsMe(m: Match, playerId: number): boolean {
  if (!isMine(m, playerId)) return false;
  if (m.status === "open") return true;
  if (m.status === "pending_approval" && m.reporterId !== null && m.reporterId !== playerId) {
    return true;
  }
  return false;
}

export function deriveMyMatches(t: TournamentDetail): MyMatches {
  const playerId = t.currentUserPlayerId;
  if (playerId === null) {
    return { mine: [], needsMeCount: 0, actionMatch: null };
  }
  const mine = t.matches.filter((m) => isMine(m, playerId));
  const actionable = mine.filter((m) => needsMe(m, playerId));
  return {
    mine,
    needsMeCount: actionable.length,
    actionMatch: actionable[0] ?? null,
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/components/use-my-matches.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/types.ts packages/web/src/components/tournament/use-my-matches.ts packages/web/tests/components/use-my-matches.test.ts
git commit -m "feat(web): tournament types + my-matches derivation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 16: Extract `MatchCard` (with host reopen) into a component

**Files:**
- Create: `packages/web/src/components/tournament/match-card.tsx` (move the existing inline `MatchCard` + `handleReport` from `page.tsx` here; add host "Reopen" for completed round-robin matches calling `POST /api/tournaments/[slug]/reopen`)
- Test: `packages/web/tests/components/match-card.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/components/match-card.test.tsx
// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchCard } from "../../src/components/tournament/match-card";
import type { Match } from "../../src/components/tournament/types";

const completed: Match = {
  id: 3, matchId: 9, roundNumber: 1, playerOneId: 10, playerTwoId: 20,
  playerOneName: "Me", playerTwoName: "Bob", status: "completed",
  winnerId: 10, reporterId: 10, metadata: {},
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("MatchCard host reopen", () => {
  it("shows Reopen for the host on a completed round-robin match and posts to the reopen API", async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onResolved = vi.fn();
    render(
      <MatchCard
        match={completed}
        tournamentSlug="slug1"
        tournamentFormat="round_robin"
        currentUserPlayerId={99}
        isHost
        isReporting={false}
        onReport={() => {}}
        onCancelReport={() => {}}
        onReported={() => {}}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reopen/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tournaments/slug1/reopen",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it("does not show Reopen for single-elim", () => {
    render(
      <MatchCard
        match={completed}
        tournamentSlug="slug1"
        tournamentFormat="single_elim"
        currentUserPlayerId={99}
        isHost
        isReporting={false}
        onReport={() => {}}
        onCancelReport={() => {}}
        onReported={() => {}}
        onResolved={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /reopen/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/components/match-card.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — cannot find module `match-card`.

- [ ] **Step 3: Create the component**

Move the existing `MatchCard` function and its `handleReport` helper out of `packages/web/app/(app)/tournament/[slug]/page.tsx` into `packages/web/src/components/tournament/match-card.tsx`. Convert it to a `"use client"` module, import `Match` from `./types`, `Button`/`Badge` from `@/components/ui/*`, and the icons it uses from `lucide-react`. Change the props so it takes `tournamentSlug` (string) instead of `tournamentId`, and add `tournamentFormat: string` and `isHost: boolean`. Keep the existing report-form and approve/deny behavior identical. Add, after the approve/deny controls, this host-reopen control (rendered only when `isHost && match.status === "completed" && tournamentFormat === "round_robin"`):

```typescript
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [reopenLoading, setReopenLoading] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  async function handleReopen() {
    setReopenLoading(true);
    setReopenError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}/reopen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tournamentMatchId: match.id }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to reopen");
      }
      setConfirmReopen(false);
      onResolved();
    } catch (err) {
      setReopenError(err instanceof Error ? err.message : "Failed to reopen");
    } finally {
      setReopenLoading(false);
    }
  }
```

JSX (place below the status row):

```tsx
  {isHost && match.status === "completed" && tournamentFormat === "round_robin" && (
    <div className="mt-3 border-t border-border pt-3 text-sm">
      {confirmReopen ? (
        <div className="flex items-center gap-3">
          <span className="text-text-secondary">Reopen this match for re-reporting?</span>
          <Button variant="danger" size="sm" loading={reopenLoading} onClick={handleReopen}>
            Confirm
          </Button>
          <button type="button" className="text-text-secondary hover:text-text-primary" onClick={() => setConfirmReopen(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmReopen(true)}
          className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent-cta"
        >
          Reopen match
        </button>
      )}
      {reopenError && <p className="mt-1 text-accent-cta">{reopenError}</p>}
    </div>
  )}
```

Update the report form's fetch to use `tournamentSlug` (`/api/tournaments/${tournamentSlug}/report`). Export `MatchCard`.

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/components/match-card.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/match-card.tsx packages/web/tests/components/match-card.test.tsx
git commit -m "feat(web): extract MatchCard with host reopen control

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 17: `YourActionCard`

**Files:**
- Create: `packages/web/src/components/tournament/your-action-card.tsx`
- Test: `packages/web/tests/components/your-action-card.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/components/your-action-card.test.tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YourActionCard } from "../../src/components/tournament/your-action-card";
import type { Match } from "../../src/components/tournament/types";

const openMine: Match = {
  id: 1, matchId: null, roundNumber: 2, playerOneId: 10, playerTwoId: 20,
  playerOneName: "Me", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {},
};

describe("YourActionCard", () => {
  it("prompts to report when the action match is an open match", () => {
    render(
      <YourActionCard
        actionMatch={openMine}
        tournamentSlug="s1"
        tournamentFormat="round_robin"
        currentUserPlayerId={10}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/your match/i)).toBeTruthy();
    expect(screen.getByText(/round 2/i)).toBeTruthy();
  });

  it("shows a caught-up state when there is no action match", () => {
    render(
      <YourActionCard
        actionMatch={null}
        tournamentSlug="s1"
        tournamentFormat="round_robin"
        currentUserPlayerId={10}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/caught up/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/components/your-action-card.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/web/src/components/tournament/your-action-card.tsx
"use client";

import { useState } from "react";
import { Swords, Check } from "lucide-react";
import { MatchCard } from "./match-card";
import type { Match } from "./types";

export function YourActionCard({
  actionMatch,
  tournamentSlug,
  tournamentFormat,
  currentUserPlayerId,
  onChanged,
}: {
  actionMatch: Match | null;
  tournamentSlug: string;
  tournamentFormat: string;
  currentUserPlayerId: number | null;
  onChanged: () => void;
}) {
  const [reporting, setReporting] = useState(false);

  if (!actionMatch) {
    return (
      <section className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-surface p-5 text-text-secondary">
        <Check className="h-5 w-5 text-accent-success" />
        <span>You&apos;re all caught up — nothing needs your attention right now.</span>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded-xl border border-accent-primary/40 bg-accent-primary/5 p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-accent-primary">
        <Swords className="h-4 w-4" />
        Your match — Round {actionMatch.roundNumber}
      </div>
      <MatchCard
        match={actionMatch}
        tournamentSlug={tournamentSlug}
        tournamentFormat={tournamentFormat}
        currentUserPlayerId={currentUserPlayerId}
        isHost={false}
        isReporting={reporting}
        onReport={() => setReporting(true)}
        onCancelReport={() => setReporting(false)}
        onReported={() => {
          setReporting(false);
          onChanged();
        }}
        onResolved={onChanged}
      />
    </section>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/components/your-action-card.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/your-action-card.tsx packages/web/tests/components/your-action-card.test.tsx
git commit -m "feat(web): YourActionCard

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 18: Tab panels (Overview / My Matches / All Matches / Players / Standings)

**Files:**
- Create: `packages/web/src/components/tournament/overview-tab.tsx`, `my-matches-tab.tsx`, `all-matches-tab.tsx`, `players-tab.tsx`, `standings-tab.tsx`
- Test: `packages/web/tests/components/tournament-tabs.test.tsx` (create — one file covering the panels)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/components/tournament-tabs.test.tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyMatchesTab } from "../../src/components/tournament/my-matches-tab";
import { AllMatchesTab } from "../../src/components/tournament/all-matches-tab";
import { StandingsTab } from "../../src/components/tournament/standings-tab";
import type { TournamentDetail } from "../../src/components/tournament/types";

const t: TournamentDetail = {
  id: 1, name: "RR", format: "round_robin", status: "active", createdByUserId: "host",
  isParticipant: true, currentUserPlayerId: 10,
  participants: [{ playerId: 10, displayName: "Me" }, { playerId: 20, displayName: "Bob" }],
  matches: [
    { id: 1, matchId: null, roundNumber: 1, playerOneId: 10, playerTwoId: 20, playerOneName: "Me", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {} },
    { id: 2, matchId: null, roundNumber: 1, playerOneId: 20, playerTwoId: 30, playerOneName: "Bob", playerTwoName: "Cy", status: "open", winnerId: null, reporterId: null, metadata: {} },
  ],
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("tournament tab panels", () => {
  it("MyMatchesTab shows only the user's matches", () => {
    render(<MyMatchesTab tournament={t} tournamentSlug="s1" onChanged={() => {}} />);
    expect(screen.getByText(/me/i)).toBeTruthy();
    expect(screen.queryByText(/cy/i)).toBeNull();
  });

  it("AllMatchesTab groups by round", () => {
    render(<AllMatchesTab tournament={t} tournamentSlug="s1" onChanged={() => {}} />);
    expect(screen.getByText(/round 1/i)).toBeTruthy();
  });

  it("StandingsTab fetches and renders standings", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([{ playerId: 10, displayName: "Me", wins: 2, losses: 0 }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<StandingsTab tournamentSlug="s1" />);
    await waitFor(() => expect(screen.getByText("Me")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/s1/standings");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/components/tournament-tabs.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the five panels**

`my-matches-tab.tsx` — render `deriveMyMatches(tournament).mine` as `MatchCard`s (host=false), split "Needs you" first using `needsMe` semantics; pass `tournamentSlug`, `tournament.format`, `tournament.currentUserPlayerId`, and `onChanged` through to each card's `onReported`/`onResolved`.

`all-matches-tab.tsx` — reproduce the current page's "group by round" rendering using `MatchCard`. Completed rounds (`every match in round has status completed/bye`) start collapsed behind a `▸ Round N (completed)` toggle button; the current/incomplete round renders expanded. Pass `isHost` through so the host reopen control appears.

`players-tab.tsx` — move the existing Players `<section>` markup from `page.tsx` (chips, host/you badges, kick button, leave row) verbatim into this component, taking `tournament`, `isCreator`, `tournamentSlug`, `onChanged` props and calling the existing `/api/tournaments/[slug]/kick` and `/leave` endpoints exactly as today.

`overview-tab.tsx` — renders `<YourActionCard actionMatch={deriveMyMatches(tournament).actionMatch} ... />`, a progress line ("Round X of Y · N/M matches done", computed from `tournament.matches`), and a top-3 standings peek that lazily fetches `/api/tournaments/[slug]/standings` (show a small skeleton until loaded) and links to the Standings tab via the `onGoToStandings` prop.

`standings-tab.tsx`:

```typescript
// packages/web/src/components/tournament/standings-tab.tsx
"use client";

import { useEffect, useState } from "react";
import type { StandingsRow } from "./types";

export function StandingsTab({ tournamentSlug }: { tournamentSlug: string }) {
  const [rows, setRows] = useState<StandingsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/tournaments/${tournamentSlug}/standings`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load standings");
        return r.json();
      })
      .then((data: StandingsRow[]) => {
        if (active) setRows(data);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Failed"));
    return () => {
      active = false;
    };
  }, [tournamentSlug]);

  if (error) return <p className="text-accent-cta">{error}</p>;
  if (!rows) return <div className="h-24 animate-pulse rounded-xl bg-surface" />;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-text-muted">
          <th className="py-2">#</th>
          <th>Player</th>
          <th className="text-right">W</th>
          <th className="text-right">L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.playerId} className="border-t border-border">
            <td className="py-2 text-text-muted">{i + 1}</td>
            <td className="text-text-primary">{r.displayName}</td>
            <td className="text-right text-accent-success">{r.wins}</td>
            <td className="text-right text-text-secondary">{r.losses}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Build the other four panels following the descriptions above, reusing `MatchCard`, `deriveMyMatches`, `Button`, `Badge`, and the design tokens. Each panel is a `"use client"` module exporting a single named component.

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/components/tournament-tabs.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/overview-tab.tsx packages/web/src/components/tournament/my-matches-tab.tsx packages/web/src/components/tournament/all-matches-tab.tsx packages/web/src/components/tournament/players-tab.tsx packages/web/src/components/tournament/standings-tab.tsx packages/web/tests/components/tournament-tabs.test.tsx
git commit -m "feat(web): tournament tab panels

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 19: Extract the pending-state lobby

**Files:**
- Create: `packages/web/src/components/tournament/tournament-lobby.tsx`
- Test: `packages/web/tests/components/tournament-lobby.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/components/tournament-lobby.test.tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TournamentLobby } from "../../src/components/tournament/tournament-lobby";
import type { TournamentDetail } from "../../src/components/tournament/types";

const pending: TournamentDetail = {
  id: 1, name: "Friday", format: "round_robin", status: "pending", createdByUserId: "host",
  isParticipant: false, currentUserPlayerId: null,
  participants: [{ playerId: 1, displayName: "Ann" }],
  matches: [],
};

describe("TournamentLobby", () => {
  it("renders invite link and players for a pending tournament", () => {
    render(
      <TournamentLobby
        tournament={pending}
        tournamentSlug="slug1"
        isCreator={false}
        currentUserId={null}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/invite link/i)).toBeTruthy();
    expect(screen.getByText("Ann")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/components/tournament-lobby.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Move the pending-state JSX from `page.tsx` (the invite/share `<section>`, the Players `<section>` as used in pending mode, the Start/Join primary-action block, and the cancel link) into `TournamentLobby`. It takes `{ tournament, tournamentSlug, isCreator, currentUserId, onChanged }`. Keep all existing fetch calls (`/join`, `/leave`, `/kick`, `/announce`, `DELETE`, `POST` start) and their loading/error state exactly as in the current page. Re-use `PlayersTab` internals if convenient, or keep the pending players markup inline — either is acceptable as long as behavior is unchanged. Export `TournamentLobby`.

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/components/tournament-lobby.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/tournament-lobby.tsx packages/web/tests/components/tournament-lobby.test.tsx
git commit -m "feat(web): extract pending-state TournamentLobby

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 20: Rewrite the page shell with tab state synced to `?tab=`

**Files:**
- Modify: `packages/web/app/(app)/tournament/[slug]/page.tsx` (becomes the thin shell)
- Test: `packages/web/tests/components/tournament-page-shell.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/components/tournament-page-shell.test.tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "slug1" }),
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/hooks/use-tournament-websocket", () => ({
  useTournamentWebsocket: () => {},
}));

import TournamentDetailPage from "../../app/(app)/tournament/[slug]/page";

const activeTournament = {
  id: 1, name: "RR", format: "round_robin", status: "active", createdByUserId: "host",
  isParticipant: true, currentUserPlayerId: 10,
  participants: [{ playerId: 10, displayName: "Me" }],
  matches: [{ id: 1, matchId: null, roundNumber: 1, playerOneId: 10, playerTwoId: 20, playerOneName: "Me", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, metadata: {} }],
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); searchParams = new URLSearchParams(); });

describe("tournament page shell", () => {
  it("renders the tab bar for an active tournament and defaults to Overview", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/auth/session") return Response.json({ user: { id: "host" } });
      if (url === "/api/tournaments/slug1") return Response.json(activeTournament);
      return Response.json([], { status: 200 });
    }));
    render(<TournamentDetailPage />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeTruthy());
    expect(screen.getByRole("tab", { name: /overview/i }).getAttribute("aria-selected")).toBe("true");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/components/tournament-page-shell.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — no `tablist` (current page has no tabs).

- [ ] **Step 3: Rewrite the shell**

Replace the body of `packages/web/app/(app)/tournament/[slug]/page.tsx` with a thin client component that:

- Keeps the existing data fetching (`/api/auth/session`, `/api/tournaments/[slug]`), `useTournamentWebsocket` wiring, and loading/error states.
- Imports types from `@/components/tournament/types` (delete the duplicated interfaces from the page).
- Computes `isCreator = currentUserId === tournament.createdByUserId`.
- If `tournament.status === "pending"`: render `<TournamentLobby ... />` (no tabs).
- Else: render the header (back link, title, status badge, format), then `<Tabs>` and the active panel. Tab set: `overview` (active only), `my` (label "My Matches", `badge = deriveMyMatches(tournament).needsMeCount`), `all`, `players`, `standings`. For `status !== "active"` omit the `overview` tab and default to `standings`; for `active` default to `overview`.
- Reads the active tab from `useSearchParams().get("tab")`, validated against the allowed set for the current status (fallback to the status default). On tab change, call `router.replace(\`/tournament/${slug}?tab=${id}\`)` (use `next/navigation` `useRouter`).
- Passes a single `onChanged={fetchTournament}` callback into panels so report/approve/deny/reopen refresh the data (mirrors the current `fetchTournament` refetch behavior).

Use the `useSearchParams`/`useRouter`/`useParams` imports from `next/navigation` (the test mocks all three).

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/components/tournament-page-shell.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/(app)/tournament/[slug]/page.tsx packages/web/tests/components/tournament-page-shell.test.tsx
git commit -m "feat(web): tabbed tournament page shell

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 21: Redirect the old standings route to the tab

**Files:**
- Modify: `packages/web/app/(app)/tournament/[slug]/standings/page.tsx` (replace with a redirect)
- Test: `packages/web/tests/standings-redirect.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/standings-redirect.test.tsx
import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect }));

describe("old standings route", () => {
  it("redirects to the standings tab", async () => {
    const mod = await import("../app/(app)/tournament/[slug]/standings/page");
    await mod.default({ params: Promise.resolve({ slug: "slug1" }) } as any);
    expect(redirect).toHaveBeenCalledWith("/tournament/slug1?tab=standings");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/web/tests/standings-redirect.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — redirect not called (current standings page renders a table).

- [ ] **Step 3: Replace the standings page**

```typescript
// packages/web/app/(app)/tournament/[slug]/standings/page.tsx
import { redirect } from "next/navigation";

export default async function StandingsRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/tournament/${slug}?tab=standings`);
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/web/tests/standings-redirect.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/(app)/tournament/[slug]/standings/page.tsx packages/web/tests/standings-redirect.test.tsx
git commit -m "feat(web): redirect legacy standings route to ?tab=standings

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 22: Phase 4 integration check

- [ ] **Step 1: Full web verification**

Run: `npm run typecheck && npm run build --workspace=packages/web && npm test --workspace=packages/web`
Expected: typecheck clean, web build succeeds, all web tests pass. Fix any dangling references to the removed inline `MatchCard`/types in `page.tsx`.

- [ ] **Step 2: Commit any fixes**

```bash
git add -A && git commit -m "test: phase 4 integration fixes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Final whole-repo gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all packages green. This is the completion gate for the whole plan.

---

## Self-Review

**Spec coverage:**
- Tabbed layout (pending=lobby, active tabs, completed→standings, `?tab=` deep link) → Tasks 14, 18, 19, 20, 21. ✓
- "Your matches" filter (My Matches tab + action card + badge) → Tasks 15, 17, 18, 20. ✓
- Notify opponent on report (announce kinds, channel ping, reuse approve/deny buttons, auto-delete via Discord + web, TTL sweep, graceful no-op) → Tasks 4, 5, 6, 7, 8, 9, 10, 11, 12. ✓
- Misreport amend (host reopen, round-robin only, single-elim untouched, un-complete tournament) → Tasks 2, 3, 16. ✓
- Schema columns → Task 1. ✓
- Component split of the 549-line page → Tasks 15–21. ✓

**Placeholder scan:** Tasks 18 and 19 describe several components by behavior rather than full source (Overview/My Matches/All Matches/Players panels, the lobby). This is deliberate: they are mechanical moves of existing JSX from `page.tsx` plus composition of already-fully-specified components (`MatchCard`, `deriveMyMatches`, `StandingsTab` are given in full). Each has a concrete test gating it. The novel/risky code (Tabs, derivation, reopen, notify pipeline, page shell) is given verbatim. Acceptable.

**Type consistency:** `TournamentDetail`/`Match`/`Participant`/`StandingsRow` defined once in Task 15 `types.ts` and imported everywhere after. `deriveMyMatches` returns `{ mine, needsMeCount, actionMatch }` — consumed consistently in Tasks 17, 18, 20. `MatchCard` prop set (`tournamentSlug`, `tournamentFormat`, `isHost`, `currentUserPlayerId`, `isReporting`, `onReport`, `onCancelReport`, `onReported`, `onResolved`, `match`) is consistent across Tasks 16, 17, 18. Announce payload shape for `match-report-pending`/`match-resolved` is identical in the web client (Task 4) and bot server (Task 8) and consumed unchanged in Tasks 5, 10. `deleteNotifyMessage(client, db, matchId)` signature consistent across Tasks 7, 10, 11, 12.

**Gaps found & resolved:** Original draft surfaced the reopen control in Phase 2; moved its UI to Task 16 (Phase 4) so Phase 2 stays backend-only and independently shippable, and the control lives with the extracted `MatchCard`. No spec requirement left unassigned.
