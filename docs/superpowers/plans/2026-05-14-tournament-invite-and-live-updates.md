# Tournament Invite & Live Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "Failed to start tournament" UX, auto-join the organizer, add shareable invite links + manual Discord announce, allow Leave/Kick on pending tournaments, and make the tournament detail page update live as participants join/leave.

**Architecture:** Service-layer changes in `packages/shared` add Leave/Kick; the web layer adds three new routes (`/leave`, `/kick`, `/announce`) and auto-joins the organizer on create. A new tournament Socket.IO room (`tournament:<slug>`) is added by extending `packages/ws` with `/internal/tournament/*` HTTP broadcast routes parallel to the existing draft routes. The detail page subscribes via a new `useTournamentWebsocket` hook and refetches on every event. The Discord announce embed is enriched with organizer mention + participant count and is only fired by an explicit user click.

**Tech Stack:** SQLite/better-sqlite3, Next.js 16 App Router, React, Vitest, discord.js, Socket.IO, TypeScript.

---

## File map

**Create:**
- `packages/web/app/api/tournaments/[slug]/leave/route.ts` — POST: participant removes self while pending
- `packages/web/app/api/tournaments/[slug]/kick/route.ts` — POST: organizer removes a participant while pending
- `packages/web/app/api/tournaments/[slug]/announce/route.ts` — POST: organizer triggers Discord announcement
- `packages/web/src/lib/notify-ws-tournament.ts` — typed helper for tournament WS broadcasts
- `packages/web/src/lib/hooks/use-tournament-websocket.ts` — client-side WS hook for the detail page
- `packages/shared/tests/services/tournaments.test.ts` — unit tests for create-auto-join, leave, kick
- `packages/web/tests/api/tournaments-leave-route.test.ts`
- `packages/web/tests/api/tournaments-kick-route.test.ts`
- `packages/web/tests/api/tournaments-announce-route.test.ts`
- `packages/web/tests/notify-ws-tournament.test.ts`

**Modify:**
- `packages/shared/src/ws/events.ts` — add `TournamentBroadcastPayload` union and `TOURNAMENT_BROADCAST_KINDS`
- `packages/shared/src/services/tournaments.ts` — add `leave(tournamentId, playerId)`, `kick(tournamentId, organizerUserId, playerId)`, `participantCount(tournamentId)`
- `packages/ws/src/events.ts` — add `tournament:join` client event + `tournament:*` server-to-client events
- `packages/ws/src/internal-http.ts` — add `/internal/tournament/{participant-joined,participant-left,started,cancelled}` routes
- `packages/web/app/api/tournaments/route.ts` — auto-join organizer; REMOVE auto-announce-on-create
- `packages/web/app/api/tournaments/[slug]/route.ts` — bubble actual `start()` error (400 + message), broadcast `tournament:started` and `tournament:cancelled`
- `packages/web/app/api/tournaments/[slug]/join/route.ts` — broadcast `tournament:participant-joined`
- `packages/web/app/(app)/tournament/[slug]/page.tsx` — disable Start when <2 participants, add Copy-Link / Announce / Leave / Kick controls, subscribe via WS hook
- `packages/bot/src/announce/server.ts` — extend `tournament-created` payload to include `organizerUserId` and `participantCount`
- `packages/bot/src/announce/handlers.ts` — pass new fields to message builder
- `packages/bot/src/announce/messages.ts` — enrich `tournamentCreatedAnnouncement` (organizer mention + participant count)
- `packages/web/src/lib/announce-bot.ts` — update `AnnouncePayload` union with new fields

---

## Task 1: Shared service — auto-join helper, Leave, Kick

**Files:**
- Modify: `packages/shared/src/services/tournaments.ts`
- Create: `packages/shared/tests/services/tournaments.test.ts`

- [ ] **Step 1: Write failing tests for the new service methods**

Create `packages/shared/tests/services/tournaments.test.ts`:

```typescript
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, tournaments: createTournamentService(db) };
}

function insertPlayer(db: Database.Database, guildId: string, discordUserId: string, name: string) {
  const r = db
    .prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)")
    .run(guildId, discordUserId, name);
  return Number(r.lastInsertRowid);
}

describe("tournaments service", () => {
  describe("leave", () => {
    it("removes a participant from a pending tournament", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);

      tournaments.leave(t.id, alice);

      expect(tournaments.participants(t.id)).toEqual([]);
    });

    it("throws when the tournament is not pending", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);
      tournaments.join(t.id, bob);
      tournaments.start(t.id);

      expect(() => tournaments.leave(t.id, alice)).toThrow(/already started|not pending/i);
    });

    it("throws when the participant is not in the tournament", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");

      expect(() => tournaments.leave(t.id, alice)).toThrow(/not a participant|not joined/i);
    });
  });

  describe("kick", () => {
    it("lets the organizer remove a participant from a pending tournament", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);
      tournaments.join(t.id, bob);

      tournaments.kick(t.id, "u-alice", bob);

      expect(tournaments.participants(t.id)).toEqual([alice]);
    });

    it("rejects kick when caller is not the organizer", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, bob);

      expect(() => tournaments.kick(t.id, "u-bob", bob)).toThrow(/only the organizer/i);
    });

    it("rejects kick when the tournament is not pending", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);
      tournaments.join(t.id, bob);
      tournaments.start(t.id);

      expect(() => tournaments.kick(t.id, "u-alice", bob)).toThrow(/not pending|already started/i);
    });
  });

  describe("participantCount", () => {
    it("returns the number of participants", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);
      tournaments.join(t.id, bob);

      expect(tournaments.participantCount(t.id)).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run packages/shared/tests/services/tournaments.test.ts`
Expected: FAIL — `tournaments.leave is not a function`, `tournaments.kick is not a function`, `tournaments.participantCount is not a function`.

- [ ] **Step 3: Implement Leave, Kick, and participantCount in the service**

Open `packages/shared/src/services/tournaments.ts`. Inside the returned object from `createTournamentService`, add the three methods. Place them next to `join` (around line 324) to keep related methods grouped:

```typescript
    leave(tournamentId: number, playerId: number): void {
      const tournament = findById(tournamentId);

      if (tournament.status !== "pending") {
        throw new Error("Tournament is not pending; cannot leave");
      }

      const result = db
        .prepare("delete from tournament_participants where tournament_id = ? and player_id = ?")
        .run(tournamentId, playerId);

      if (result.changes === 0) {
        throw new Error("You are not a participant in this tournament");
      }
    },

    kick(tournamentId: number, organizerUserId: string, playerId: number): void {
      const tournament = findById(tournamentId);

      if (tournament.createdByUserId !== organizerUserId) {
        throw new Error("Only the organizer can kick participants");
      }

      if (tournament.status !== "pending") {
        throw new Error("Tournament is not pending; cannot kick");
      }

      const result = db
        .prepare("delete from tournament_participants where tournament_id = ? and player_id = ?")
        .run(tournamentId, playerId);

      if (result.changes === 0) {
        throw new Error("That player is not a participant in this tournament");
      }
    },

    participantCount(tournamentId: number): number {
      const row = db
        .prepare("select count(*) as c from tournament_participants where tournament_id = ?")
        .get(tournamentId) as { c: number };
      return row.c;
    },
```

- [ ] **Step 4: Run the tests until they pass**

Run: `npx vitest run packages/shared/tests/services/tournaments.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/tournaments.ts packages/shared/tests/services/tournaments.test.ts
git commit -m "feat(shared): add tournament leave/kick/participantCount service methods"
```

---

## Task 2: Web — auto-join organizer on tournament create + remove auto-announce

**Files:**
- Modify: `packages/web/app/api/tournaments/route.ts`
- Modify: `packages/web/src/lib/announce-bot.ts` (remove unused-import cleanup if needed after; otherwise leave alone)
- Create: `packages/web/tests/api/tournaments-create-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/api/tournaments-create-route.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/tournaments", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "user-org", name: "Organizer" } });
    delete process.env.BOT_ANNOUNCE_URL;
    delete process.env.BOT_ANNOUNCE_SECRET;
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("auto-joins the organizer as the first participant", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-create-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb.close();

    const { POST } = await import("../../app/api/tournaments/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments", {
        method: "POST",
        body: JSON.stringify({ name: "My Tournament", format: "round_robin" }),
      }) as any,
    );
    expect(res.status).toBe(201);

    const verifyDb = new Database(dbPath);
    const participants = verifyDb
      .prepare(
        `select p.discord_user_id from tournament_participants tp
         inner join players p on p.id = tp.player_id`,
      )
      .all() as Array<{ discord_user_id: string }>;
    verifyDb.close();

    expect(participants).toHaveLength(1);
    expect(participants[0].discord_user_id).toBe("user-org");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run packages/web/tests/api/tournaments-create-route.test.ts`
Expected: FAIL — `participants` has length 0 (creator not joined).

- [ ] **Step 3: Modify the create route to auto-join and remove auto-announce**

Open `packages/web/app/api/tournaments/route.ts`. Replace the `try {` block in `POST` (lines 89–123) with this body:

```typescript
  try {
    const db = getDb();
    const players = createPlayerService(db);
    const organizerPlayer = players.findOrCreate(guildId, session.user.id, session.user.name ?? "Unknown");

    const tournaments = createTournamentService(db);
    const tournament = tournaments.create(guildId, name, format as "round_robin" | "single_elim", session.user.id);

    tournaments.join(tournament.id, organizerPlayer.id);

    return NextResponse.json(
      {
        id: tournament.id,
        name: tournament.name,
        format: tournament.format,
        status: tournament.status,
        webSlug: tournament.webSlug,
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create tournament";
    console.error("[api/tournaments POST] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
```

Also remove the now-unused imports at the top:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createPlayerService, createTournamentService } from "@yugidraft/shared/services";
```

(Drop the `import { announceToBot } from "@/lib/announce-bot";` line.)

- [ ] **Step 4: Run the test until it passes**

Run: `npx vitest run packages/web/tests/api/tournaments-create-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/route.ts packages/web/tests/api/tournaments-create-route.test.ts
git commit -m "feat(web): auto-join organizer on tournament create, remove auto-announce"
```

---

## Task 3: Web — POST /api/tournaments/[slug]/leave

**Files:**
- Create: `packages/web/app/api/tournaments/[slug]/leave/route.ts`
- Create: `packages/web/tests/api/tournaments-leave-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/api/tournaments-leave-route.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/tournaments/[slug]/leave", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("removes the caller from the participants list", async () => {
    auth.mockResolvedValue({ user: { id: "user-leaver", name: "Leaver" } });

    const tempDir = mkdtempSync(join(tmpdir(), "tourney-leave-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);

    seedDb.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'user-leaver', 'Leaver')").run();
    const playerId = (seedDb.prepare("select id from players where discord_user_id = ?").get("user-leaver") as any).id;
    seedDb
      .prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1', 'T', 'round_robin', 'pending', 'user-org', 'slug-1')")
      .run();
    const tId = (seedDb.prepare("select id from tournaments where web_slug = 'slug-1'").get() as any).id;
    seedDb.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)").run(tId, playerId);
    seedDb.close();

    const { POST } = await import("../../app/api/tournaments/[slug]/leave/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/leave", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(200);

    const verifyDb = new Database(dbPath);
    const count = (verifyDb.prepare("select count(*) as c from tournament_participants").get() as any).c;
    verifyDb.close();
    expect(count).toBe(0);
  });

  it("returns 401 when unauthenticated", async () => {
    auth.mockResolvedValue(null);
    const { POST } = await import("../../app/api/tournaments/[slug]/leave/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/leave", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run packages/web/tests/api/tournaments-leave-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `packages/web/app/api/tournaments/[slug]/leave/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService } from "@yugidraft/shared/services";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();

    const tournament = db
      .prepare("select id, guild_id, status from tournaments where web_slug = ?")
      .get(slug) as { id: number; guild_id: string; status: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    const player = db
      .prepare("select id from players where guild_id = ? and discord_user_id = ?")
      .get(tournament.guild_id, session.user.id) as { id: number } | undefined;

    if (!player) {
      return NextResponse.json({ error: "You are not a participant in this tournament" }, { status: 400 });
    }

    const tournaments = createTournamentService(db);
    tournaments.leave(tournament.id, player.id);

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "participant-left", slug, playerId: player.id },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to leave tournament";
    console.error("[api/tournaments/[slug]/leave] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

> The test imports the route before `notifyWsTournament` exists. Task 6 creates that helper. Either: (a) implement Task 6 first then come back to step 3, or (b) write a stub helper now and let Task 6 fill it in. Recommended: do Task 6 next, then run this task's tests.

- [ ] **Step 4: Defer test run until Task 6 is complete**

After Task 6, run: `npx vitest run packages/web/tests/api/tournaments-leave-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (after the test passes)**

```bash
git add packages/web/app/api/tournaments/[slug]/leave/route.ts packages/web/tests/api/tournaments-leave-route.test.ts
git commit -m "feat(web): POST /api/tournaments/[slug]/leave"
```

---

## Task 4: Web — POST /api/tournaments/[slug]/kick

**Files:**
- Create: `packages/web/app/api/tournaments/[slug]/kick/route.ts`
- Create: `packages/web/tests/api/tournaments-kick-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/api/tournaments-kick-route.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

function seedTournamentWithParticipants(dbPath: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { migrate } = require("../../../shared/src/db/schema");
  const seedDb = new Database(dbPath);
  migrate(seedDb);
  seedDb.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u-org', 'Org'), ('g1', 'u-vict', 'Vict')").run();
  seedDb.prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1', 'T', 'round_robin', 'pending', 'u-org', 'slug-1')").run();
  const tId = (seedDb.prepare("select id from tournaments where web_slug = 'slug-1'").get() as any).id;
  const victId = (seedDb.prepare("select id from players where discord_user_id = 'u-vict'").get() as any).id;
  seedDb.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)").run(tId, victId);
  seedDb.close();
  return { victId };
}

describe("POST /api/tournaments/[slug]/kick", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("organizer can kick a participant", async () => {
    auth.mockResolvedValue({ user: { id: "u-org", name: "Org" } });

    const tempDir = mkdtempSync(join(tmpdir(), "tourney-kick-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const { victId } = seedTournamentWithParticipants(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/kick/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/kick", {
        method: "POST",
        body: JSON.stringify({ playerId: victId }),
      }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );
    expect(res.status).toBe(200);

    const Database = (await import("better-sqlite3")).default;
    const verifyDb = new Database(dbPath);
    const count = (verifyDb.prepare("select count(*) as c from tournament_participants").get() as any).c;
    verifyDb.close();
    expect(count).toBe(0);
  });

  it("non-organizer cannot kick", async () => {
    auth.mockResolvedValue({ user: { id: "u-vict", name: "Vict" } });

    const tempDir = mkdtempSync(join(tmpdir(), "tourney-kick-2-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const { victId } = seedTournamentWithParticipants(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/kick/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/kick", {
        method: "POST",
        body: JSON.stringify({ playerId: victId }),
      }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run packages/web/tests/api/tournaments-kick-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `packages/web/app/api/tournaments/[slug]/kick/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService } from "@yugidraft/shared/services";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const body = await request.json();
    const playerId = Number(body?.playerId);
    if (!playerId || !Number.isInteger(playerId)) {
      return NextResponse.json({ error: "playerId is required" }, { status: 400 });
    }

    const db = getDb();
    const tournament = db
      .prepare("select id, created_by_user_id, status from tournaments where web_slug = ?")
      .get(slug) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the organizer can kick participants" }, { status: 403 });
    }

    const tournaments = createTournamentService(db);
    tournaments.kick(tournament.id, session.user.id, playerId);

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "participant-left", slug, playerId },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to kick participant";
    console.error("[api/tournaments/[slug]/kick] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 4: Defer test run until Task 6 is complete**

(Same `notifyWsTournament` dependency.)

- [ ] **Step 5: Commit (after Task 6 lands)**

```bash
git add packages/web/app/api/tournaments/[slug]/kick/route.ts packages/web/tests/api/tournaments-kick-route.test.ts
git commit -m "feat(web): POST /api/tournaments/[slug]/kick (organizer-only)"
```

---

## Task 5: Web — bubble start() error message

**Files:**
- Modify: `packages/web/app/api/tournaments/[slug]/route.ts`
- Create: `packages/web/tests/api/tournaments-start-route.test.ts`

The current POST handler swallows the actual error from `tournaments.start()` and returns "Failed to start tournament" with status 500. The user sees no diagnostic. We'll surface the real message with status 400 (validation) instead.

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/api/tournaments-start-route.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/tournaments/[slug] (start)", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u-org", name: "Org" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns the actual validation error with 400 when starting fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-start-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb
      .prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','T','round_robin','pending','u-org','slug-1')")
      .run();
    seedDb.close();

    const { POST } = await import("../../app/api/tournaments/[slug]/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least two/i);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run packages/web/tests/api/tournaments-start-route.test.ts`
Expected: FAIL — receives status 500 with generic message.

- [ ] **Step 3: Fix the error handler in the POST handler**

Open `packages/web/app/api/tournaments/[slug]/route.ts`. Replace the trailing `catch` block of the `POST` function (currently lines 277–280) with:

```typescript
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start tournament";
    console.error("[api/tournaments/[slug] POST] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
```

- [ ] **Step 4: Run the test until it passes**

Run: `npx vitest run packages/web/tests/api/tournaments-start-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/[slug]/route.ts packages/web/tests/api/tournaments-start-route.test.ts
git commit -m "fix(web): surface real start() error instead of generic 500"
```

---

## Task 6: Shared — tournament WS broadcast types + web notifyWsTournament helper

**Files:**
- Modify: `packages/shared/src/ws/events.ts`
- Create: `packages/web/src/lib/notify-ws-tournament.ts`
- Create: `packages/web/tests/notify-ws-tournament.test.ts`

- [ ] **Step 1: Add tournament broadcast types in shared**

Open `packages/shared/src/ws/events.ts` and append:

```typescript
export type TournamentParticipantJoinedBroadcast = {
  kind: "participant-joined";
  slug: string;
  playerId: number;
  displayName: string;
};

export type TournamentParticipantLeftBroadcast = {
  kind: "participant-left";
  slug: string;
  playerId: number;
};

export type TournamentStartedBroadcast = {
  kind: "started";
  slug: string;
};

export type TournamentCancelledBroadcast = {
  kind: "cancelled";
  slug: string;
};

export type TournamentBroadcastPayload =
  | TournamentParticipantJoinedBroadcast
  | TournamentParticipantLeftBroadcast
  | TournamentStartedBroadcast
  | TournamentCancelledBroadcast;

export const TOURNAMENT_BROADCAST_KINDS = [
  "participant-joined",
  "participant-left",
  "started",
  "cancelled",
] as const;
```

- [ ] **Step 2: Build shared so consumers see the type**

Run: `npm run build --workspace=packages/shared`
Expected: PASS — the package emits an updated `dist/`.

- [ ] **Step 3: Write the failing test for the web helper**

Create `packages/web/tests/notify-ws-tournament.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyWsTournament } from "../src/lib/notify-ws-tournament";

describe("notifyWsTournament", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({ ok: true } as any);
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the kind-specific internal route with a signed body", async () => {
    await notifyWsTournament(
      { url: "http://ws:4002", secret: "shh" },
      { kind: "participant-joined", slug: "abc", playerId: 7, displayName: "Alice" },
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://ws:4002/internal/tournament/participant-joined");
    expect((init as any).headers["x-announce-signature"]).toMatch(/^sha256=/);
    const body = JSON.parse((init as any).body as string);
    expect(body).toEqual({ slug: "abc", playerId: 7, displayName: "Alice" });
  });

  it("is a no-op when url or secret is empty", async () => {
    await notifyWsTournament({ url: "", secret: "shh" }, { kind: "started", slug: "a" });
    await notifyWsTournament({ url: "http://ws", secret: "" }, { kind: "started", slug: "a" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the failing test**

Run: `npx vitest run packages/web/tests/notify-ws-tournament.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the helper**

Create `packages/web/src/lib/notify-ws-tournament.ts`:

```typescript
import { createHmac } from "node:crypto";
import type { TournamentBroadcastPayload } from "@yugidraft/shared/ws";

export type { TournamentBroadcastPayload };

export async function notifyWsTournament(
  cfg: { url: string; secret: string },
  payload: TournamentBroadcastPayload,
): Promise<void> {
  if (!cfg.url || !cfg.secret) return;
  const { kind, ...data } = payload;
  const body = JSON.stringify(data);
  const sig = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  try {
    const res = await fetch(`${cfg.url}/internal/tournament/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-announce-signature": sig,
      },
      body,
    });
    if (!res.ok) console.warn(`[notify-ws-tournament] non-2xx for ${kind}: ${res.status}`);
  } catch (err) {
    console.warn(`[notify-ws-tournament] failed for ${kind}:`, err);
  }
}
```

- [ ] **Step 6: Run the test until it passes**

Run: `npx vitest run packages/web/tests/notify-ws-tournament.test.ts`
Expected: PASS.

- [ ] **Step 7: Now run the deferred tests from Tasks 3 and 4**

Run: `npx vitest run packages/web/tests/api/tournaments-leave-route.test.ts packages/web/tests/api/tournaments-kick-route.test.ts`
Expected: PASS for both.

- [ ] **Step 8: Commit Task 6 + the deferred Task 3 and 4 commits**

```bash
git add packages/shared/src/ws/events.ts \
        packages/web/src/lib/notify-ws-tournament.ts \
        packages/web/tests/notify-ws-tournament.test.ts
git commit -m "feat(shared,web): tournament WS broadcast types + notifyWsTournament helper"

git add packages/web/app/api/tournaments/[slug]/leave \
        packages/web/tests/api/tournaments-leave-route.test.ts
git commit -m "feat(web): POST /api/tournaments/[slug]/leave"

git add packages/web/app/api/tournaments/[slug]/kick \
        packages/web/tests/api/tournaments-kick-route.test.ts
git commit -m "feat(web): POST /api/tournaments/[slug]/kick (organizer-only)"
```

---

## Task 7: WS server — tournament rooms + internal HTTP broadcast routes

**Files:**
- Modify: `packages/ws/src/events.ts`
- Modify: `packages/ws/src/internal-http.ts`
- Create: `packages/ws/tests/internal-http-tournament.test.ts`

The existing `DraftRoomManager` keeps per-slug socket bookkeeping. Tournaments don't need pick-step state, so we can rely on Socket.IO's native room mechanism (`socket.join`, `io.to`) with a `tournament:<slug>` prefix — no separate manager.

- [ ] **Step 1: Extend the typed event interfaces**

Open `packages/ws/src/events.ts` and update `ServerToClientEvents` and `ClientToServerEvents`:

```typescript
export interface ServerToClientEvents {
  "draft:status": (data: { status: DraftStatus }) => void;
  "draft:pick": (data: { playerId: number; packRound: number; pickStep: number }) => void;
  "draft:resync": (data: { packRound: number; pickStep: number }) => void;
  "draft:complete": (data: Record<string, never>) => void;
  "draft:seats": (data: Record<string, never>) => void;
  "tournament:participant-joined": (data: { playerId: number; displayName: string }) => void;
  "tournament:participant-left": (data: { playerId: number }) => void;
  "tournament:started": (data: Record<string, never>) => void;
  "tournament:cancelled": (data: Record<string, never>) => void;
}

export interface ClientToServerEvents {
  "draft:join": (
    payload: DraftJoinPayload,
    ack?: (result?: { error?: string }) => void,
  ) => void;
  "tournament:join": (
    payload: { slug: string },
    ack?: (result?: { error?: string }) => void,
  ) => void;
}
```

Add the `tournament:join` handler inside `registerEventHandlers`, right after the `draft:join` handler (around line 68):

```typescript
    socket.on("tournament:join", (payload, ack) => {
      try {
        const slug = payload?.slug;
        if (typeof slug !== "string" || slug.length === 0) {
          ack?.({ error: "slug required" });
          return;
        }
        socket.join(`tournament:${slug}`);
        ack?.();
      } catch (err) {
        console.error(`[ws] tournament:join error for ${socket.id}`, err);
        ack?.({ error: err instanceof Error ? err.message : String(err) });
      }
    });
```

(No `disconnecting` change needed — Socket.IO auto-leaves rooms.)

- [ ] **Step 2: Write the failing test for the internal HTTP routes**

Create `packages/ws/tests/internal-http-tournament.test.ts`:

```typescript
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInternalHttpHandler } from "../src/internal-http.js";

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function makeIo() {
  const emits: Array<{ room: string; event: string; data: unknown }> = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => {
        emits.push({ room, event, data });
      },
    }),
  };
  return { io: io as any, emits };
}

describe("internal HTTP — tournament routes", () => {
  const secret = "shh";

  it("broadcasts participant-joined to the tournament room", async () => {
    const { io, emits } = makeIo();
    const handle = createInternalHttpHandler({ io, secret });
    const body = JSON.stringify({ slug: "abc", playerId: 9, displayName: "Alice" });
    const res = await handle(
      new Request("http://x/internal/tournament/participant-joined", {
        method: "POST",
        headers: { "x-announce-signature": sign(body, secret) },
        body,
      }),
    );
    expect(res.status).toBe(204);
    expect(emits).toEqual([
      {
        room: "tournament:abc",
        event: "tournament:participant-joined",
        data: { playerId: 9, displayName: "Alice" },
      },
    ]);
  });

  it("broadcasts participant-left", async () => {
    const { io, emits } = makeIo();
    const handle = createInternalHttpHandler({ io, secret });
    const body = JSON.stringify({ slug: "abc", playerId: 9 });
    const res = await handle(
      new Request("http://x/internal/tournament/participant-left", {
        method: "POST",
        headers: { "x-announce-signature": sign(body, secret) },
        body,
      }),
    );
    expect(res.status).toBe(204);
    expect(emits[0]).toEqual({
      room: "tournament:abc",
      event: "tournament:participant-left",
      data: { playerId: 9 },
    });
  });

  it("broadcasts started and cancelled", async () => {
    const { io, emits } = makeIo();
    const handle = createInternalHttpHandler({ io, secret });

    for (const kind of ["started", "cancelled"] as const) {
      const body = JSON.stringify({ slug: "abc" });
      const res = await handle(
        new Request(`http://x/internal/tournament/${kind}`, {
          method: "POST",
          headers: { "x-announce-signature": sign(body, secret) },
          body,
        }),
      );
      expect(res.status).toBe(204);
    }
    expect(emits.map((e) => e.event)).toEqual(["tournament:started", "tournament:cancelled"]);
  });

  it("rejects bad payloads with 400", async () => {
    const { io } = makeIo();
    const handle = createInternalHttpHandler({ io, secret });
    const body = JSON.stringify({ slug: "" });
    const res = await handle(
      new Request("http://x/internal/tournament/participant-joined", {
        method: "POST",
        headers: { "x-announce-signature": sign(body, secret) },
        body,
      }),
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run packages/ws/tests/internal-http-tournament.test.ts`
Expected: FAIL — routes return 404.

- [ ] **Step 4: Add the four tournament routes to internal-http**

Open `packages/ws/src/internal-http.ts`. Above `createInternalHttpHandler`, add parsers and tournament body types:

```typescript
type TournamentJoinedBody = { slug: string; playerId: number; displayName: string };
type TournamentLeftBody = { slug: string; playerId: number };
type TournamentSlugOnlyBody = { slug: string };

function parseTournamentJoined(v: unknown): TournamentJoinedBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  if (typeof o.playerId !== "number") return null;
  if (!isNonEmptyString(o.displayName)) return null;
  return { slug: o.slug, playerId: o.playerId, displayName: o.displayName };
}

function parseTournamentLeft(v: unknown): TournamentLeftBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  if (typeof o.playerId !== "number") return null;
  return { slug: o.slug, playerId: o.playerId };
}

function parseTournamentSlugOnly(v: unknown): TournamentSlugOnlyBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  return { slug: o.slug };
}
```

Inside `createInternalHttpHandler`, inside the `switch (url.pathname)` block (after the existing `case "/internal/draft/seats":`), add:

```typescript
      case "/internal/tournament/participant-joined": {
        const data = parseTournamentJoined(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io
          .to(`tournament:${data.slug}`)
          .emit("tournament:participant-joined", { playerId: data.playerId, displayName: data.displayName });
        return new Response(null, { status: 204 });
      }
      case "/internal/tournament/participant-left": {
        const data = parseTournamentLeft(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io
          .to(`tournament:${data.slug}`)
          .emit("tournament:participant-left", { playerId: data.playerId });
        return new Response(null, { status: 204 });
      }
      case "/internal/tournament/started": {
        const data = parseTournamentSlugOnly(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(`tournament:${data.slug}`).emit("tournament:started", {});
        return new Response(null, { status: 204 });
      }
      case "/internal/tournament/cancelled": {
        const data = parseTournamentSlugOnly(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(`tournament:${data.slug}`).emit("tournament:cancelled", {});
        return new Response(null, { status: 204 });
      }
```

- [ ] **Step 5: Run the test until it passes**

Run: `npx vitest run packages/ws/tests/internal-http-tournament.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ws/src/events.ts packages/ws/src/internal-http.ts packages/ws/tests/internal-http-tournament.test.ts
git commit -m "feat(ws): tournament rooms + internal broadcast routes"
```

---

## Task 8: Web — wire WS notifications into join, start, and cancel

**Files:**
- Modify: `packages/web/app/api/tournaments/[slug]/join/route.ts`
- Modify: `packages/web/app/api/tournaments/[slug]/route.ts`

- [ ] **Step 1: Update join to broadcast participant-joined**

Open `packages/web/app/api/tournaments/[slug]/join/route.ts`. Add imports at the top:

```typescript
import { env } from "@/lib/env";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";
```

After the `db.prepare("insert into tournament_participants ...").run(...)` line, add:

```typescript
    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      {
        kind: "participant-joined",
        slug,
        playerId: player.id,
        displayName: player.displayName,
      },
    );
```

- [ ] **Step 2: Update DELETE (cancel) and POST (start) to broadcast**

Open `packages/web/app/api/tournaments/[slug]/route.ts`. Add the imports at the top:

```typescript
import { notifyWsTournament } from "@/lib/notify-ws-tournament";
```

In the `DELETE` handler, immediately after the `db.prepare("update tournaments set status = 'cancelled' ...").run(...)` call (around line 162), add:

```typescript
    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "cancelled", slug },
    );
```

In the `POST` handler, immediately after the existing `announceToBot` call (around line 271, after `void announceToBot(...)`), add:

```typescript
    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "started", slug },
    );
```

- [ ] **Step 3: Run the existing route tests to confirm nothing regressed**

Run: `npx vitest run packages/web/tests/api/tournaments-id-route.test.ts packages/web/tests/api/tournaments-start-route.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/app/api/tournaments/[slug]/route.ts packages/web/app/api/tournaments/[slug]/join/route.ts
git commit -m "feat(web): broadcast tournament participant-joined/started/cancelled via WS"
```

---

## Task 9: Client hook — useTournamentWebsocket

**Files:**
- Create: `packages/web/src/lib/hooks/use-tournament-websocket.ts`

This hook mirrors the shape of `use-draft-websocket.ts` but doesn't touch Zustand — tournament state stays in component-local React state via a refetch callback.

- [ ] **Step 1: Create the hook**

```typescript
"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001");

interface UseTournamentWebsocketOptions {
  onParticipantJoined?: (data: { playerId: number; displayName: string }) => void;
  onParticipantLeft?: (data: { playerId: number }) => void;
  onStarted?: () => void;
  onCancelled?: () => void;
}

export function useTournamentWebsocket(slug: string, options: UseTournamentWebsocketOptions = {}) {
  const socketRef = useRef<Socket | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!slug) return;

    const socket = io(WS_URL, { autoConnect: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("tournament:join", { slug });
    });

    socket.on("tournament:participant-joined", (payload: { playerId: number; displayName: string }) => {
      optionsRef.current.onParticipantJoined?.(payload);
    });

    socket.on("tournament:participant-left", (payload: { playerId: number }) => {
      optionsRef.current.onParticipantLeft?.(payload);
    });

    socket.on("tournament:started", () => {
      optionsRef.current.onStarted?.();
    });

    socket.on("tournament:cancelled", () => {
      optionsRef.current.onCancelled?.();
    });

    socket.on("connect_error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("Tournament WS connect error:", err.message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [slug]);

  return socketRef;
}
```

- [ ] **Step 2: Typecheck the package**

Run: `npm run typecheck --workspace=packages/web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/hooks/use-tournament-websocket.ts
git commit -m "feat(web): useTournamentWebsocket client hook"
```

---

## Task 10: Bot — enrich tournament announce payload + message

**Files:**
- Modify: `packages/bot/src/announce/server.ts`
- Modify: `packages/bot/src/announce/handlers.ts`
- Modify: `packages/bot/src/announce/messages.ts`
- Modify: `packages/web/src/lib/announce-bot.ts`

We're adding `organizerUserId` and `participantCount` to the `tournament-created` payload so the embed can include `<@organizerId>` and "Pending — N participants" per Q6c. Per Q6b, the manual button (Task 12) is what fires this; auto-fire from create was removed in Task 2.

- [ ] **Step 1: Update the bot announce payload type**

Open `packages/bot/src/announce/server.ts`. Replace the `tournament-created` variant in the `AnnouncePayload` union with:

```typescript
  | { kind: "tournament-created"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string; organizerUserId: string; participantCount: number }
```

(Keep `tournament-started` unchanged.)

- [ ] **Step 2: Update the message builder**

Open `packages/bot/src/announce/messages.ts`. Replace `tournamentCreatedAnnouncement` with:

```typescript
export function tournamentCreatedAnnouncement(input: {
  name: string;
  format: string;
  webSlug: string;
  organizerUserId: string;
  participantCount: number;
  webUrl?: string;
}): string {
  const formatLabel = input.format === "round_robin" ? "Round Robin" : input.format === "single_elim" ? "Single Elimination" : input.format;
  return [
    `🏆 **${input.name}** — Signups open`,
    `Format: ${formatLabel} · Pending — ${input.participantCount} participant${input.participantCount === 1 ? "" : "s"}`,
    `Organizer: <@${input.organizerUserId}>`,
    `Join: ${webBaseUrl(input.webUrl)}/tournament/${input.webSlug}`,
  ].join("\n");
}
```

- [ ] **Step 3: Update the handler to pass the new fields**

Open `packages/bot/src/announce/handlers.ts`. Replace `onTournamentCreated`:

```typescript
    async onTournamentCreated({ channelId, name, format, webSlug, organizerUserId, participantCount }) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) return;
      await channel.send(
        tournamentCreatedAnnouncement({ name, format, webSlug, organizerUserId, participantCount }),
      );
    },
```

- [ ] **Step 4: Update the web announce payload type**

Open `packages/web/src/lib/announce-bot.ts`. Replace the `tournament-created` variant in the `AnnouncePayload` union with:

```typescript
  | { kind: "tournament-created"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string; organizerUserId: string; participantCount: number }
```

- [ ] **Step 5: Run bot tests + typecheck**

Run: `npm test --workspace=packages/bot && npm run typecheck --workspace=packages/web`
Expected: PASS. (Existing announce tests do not assert tournament-created shape; if any fail, update the fixtures with the two new fields.)

- [ ] **Step 6: Commit**

```bash
git add packages/bot/src/announce packages/web/src/lib/announce-bot.ts
git commit -m "feat(bot,web): enrich tournament-created announce with organizer mention + participant count"
```

---

## Task 11: Web — POST /api/tournaments/[slug]/announce

**Files:**
- Create: `packages/web/app/api/tournaments/[slug]/announce/route.ts`
- Create: `packages/web/tests/api/tournaments-announce-route.test.ts`

Channel resolution per Q8: `guild_settings.announce_channel_id` → `DISCORD_DEFAULT_CHANNEL_ID` env → `DISCORD_REMINDER_CHANNEL_ID` env → 400 with "configure an announcement channel".

- [ ] **Step 1: Write the failing tests**

Create `packages/web/tests/api/tournaments-announce-route.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

function seedTournament(dbPath: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { migrate } = require("../../../shared/src/db/schema");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u-org', 'Org')").run();
  const orgPlayerId = (db.prepare("select id from players where discord_user_id = 'u-org'").get() as any).id;
  db.prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','My Tournament','round_robin','pending','u-org','slug-1')").run();
  const tId = (db.prepare("select id from tournaments where web_slug = 'slug-1'").get() as any).id;
  db.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)").run(tId, orgPlayerId);
  db.close();
}

describe("POST /api/tournaments/[slug]/announce", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({ ok: true } as any);
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.DISCORD_DEFAULT_CHANNEL_ID;
    delete process.env.DISCORD_REMINDER_CHANNEL_ID;
    process.env.BOT_ANNOUNCE_URL = "http://bot:4001";
    process.env.BOT_ANNOUNCE_SECRET = "shh";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DATABASE_PATH;
    delete process.env.BOT_ANNOUNCE_URL;
    delete process.env.BOT_ANNOUNCE_SECRET;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns 400 when no announce channel is configured", async () => {
    auth.mockResolvedValue({ user: { id: "u-org", name: "Org" } });
    const tempDir = mkdtempSync(join(tmpdir(), "ta-1-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    seedTournament(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/announce/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/announce", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/announcement channel/i);
  });

  it("falls back to DISCORD_DEFAULT_CHANNEL_ID and POSTs to the bot announce endpoint", async () => {
    auth.mockResolvedValue({ user: { id: "u-org", name: "Org" } });
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-default";

    const tempDir = mkdtempSync(join(tmpdir(), "ta-2-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    seedTournament(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/announce/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/announce", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(200);

    // announceToBot fires a non-awaited fetch; flush microtasks
    await new Promise((r) => setImmediate(r));

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://bot:4001/internal/announce/tournament-created");
    const body = JSON.parse((init as any).body as string);
    expect(body.channelId).toBe("channel-default");
    expect(body.organizerUserId).toBe("u-org");
    expect(body.participantCount).toBe(1);
    expect(body.name).toBe("My Tournament");
  });

  it("returns 403 for non-organizer", async () => {
    auth.mockResolvedValue({ user: { id: "u-someone-else", name: "Stranger" } });
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-default";

    const tempDir = mkdtempSync(join(tmpdir(), "ta-3-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    seedTournament(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/announce/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/announce", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run packages/web/tests/api/tournaments-announce-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `packages/web/app/api/tournaments/[slug]/announce/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService, createGuildSettingsService } from "@yugidraft/shared/services";
import { announceToBot } from "@/lib/announce-bot";

export const runtime = "nodejs";

function resolveAnnounceChannelId(db: ReturnType<typeof getDb>, guildId: string): string {
  const guildSettings = createGuildSettingsService(db);
  const settings = guildSettings.get(guildId);
  if (settings.announceChannelId) return settings.announceChannelId;
  return env.discordDefaultChannelId;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();

    const tournament = db
      .prepare("select id, guild_id, name, format, status, created_by_user_id, web_slug from tournaments where web_slug = ?")
      .get(slug) as
      | { id: number; guild_id: string; name: string; format: string; status: string; created_by_user_id: string; web_slug: string }
      | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the organizer can announce" }, { status: 403 });
    }

    if (tournament.status !== "pending") {
      return NextResponse.json({ error: "Can only announce pending tournaments" }, { status: 400 });
    }

    const channelId = resolveAnnounceChannelId(db, tournament.guild_id);
    if (!channelId) {
      return NextResponse.json(
        { error: "Configure an announcement channel in guild settings first" },
        { status: 400 },
      );
    }

    const tournaments = createTournamentService(db);
    const participantCount = tournaments.participantCount(tournament.id);

    void announceToBot(
      { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
      {
        kind: "tournament-created",
        tournamentId: tournament.id,
        channelId,
        name: tournament.name,
        format: tournament.format,
        webSlug: tournament.web_slug,
        organizerUserId: tournament.created_by_user_id,
        participantCount,
      },
    );

    return NextResponse.json({ success: true, channelId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to announce";
    console.error("[api/tournaments/[slug]/announce] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

> Confirm `createGuildSettingsService` is exported from `@yugidraft/shared/services`. Quick check: `grep "createGuildSettingsService" packages/shared/src/services/index.ts`. If not exported, add a line `export * from "./guild-settings.js";` (or equivalent) to that index file.

- [ ] **Step 4: Run the tests until they pass**

Run: `npx vitest run packages/web/tests/api/tournaments-announce-route.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/[slug]/announce packages/web/tests/api/tournaments-announce-route.test.ts
git commit -m "feat(web): POST /api/tournaments/[slug]/announce (organizer-only)"
```

---

## Task 12: Detail page — disabled Start, invite link, Announce, Leave, Kick, live updates

**Files:**
- Modify: `packages/web/app/(app)/tournament/[slug]/page.tsx`

Multiple UI changes in one task; the detail page is one file, so we commit together.

- [ ] **Step 1: Add imports and the WS hook subscription**

Open `packages/web/app/(app)/tournament/[slug]/page.tsx`. Add to the icon import line at the top:

```typescript
import { Trophy, Users, Swords, BarChart3, ChevronLeft, Play, X, Link as LinkIcon, LogOut, Megaphone } from "lucide-react";
```

Add the new hook import:

```typescript
import { useTournamentWebsocket } from "@/lib/hooks/use-tournament-websocket";
```

Inside `TournamentDetailPage`, add the subscription right below the existing `useEffect(() => { fetchTournament(); }, [fetchTournament]);` block:

```typescript
  useTournamentWebsocket(id, {
    onParticipantJoined: () => fetchTournament(),
    onParticipantLeft: () => fetchTournament(),
    onStarted: () => fetchTournament(),
    onCancelled: () => fetchTournament(),
  });
```

- [ ] **Step 2: Disable Start button until ≥2 participants and add helper state**

Right after `const isParticipant = tournament.isParticipant;` (around the calculation block), add:

```typescript
  const participantCount = tournament.participants.length;
  const canStart = tournament.status === "pending" && participantCount >= 2;
  const [copiedLink, setCopiedLink] = useState(false);
```

Hoist `useState` for copiedLink to the existing block at the top of the component (where other `useState` calls live).

Replace the existing Start Tournament button (around lines 254–263):

```tsx
                  {tournament.status === "pending" && (
                    <Button
                      variant="primary"
                      loading={actionLoading === "start"}
                      disabled={!canStart}
                      title={!canStart ? "Need at least 2 participants" : undefined}
                      onClick={handleStart}
                    >
                      <Play className="h-4 w-4" />
                      Start Tournament
                    </Button>
                  )}
```

Below the existing helper paragraph "Start the tournament once all players have joined.", add a count line shown only when below the threshold:

```tsx
                    {tournament.status === "pending" && !canStart && (
                      <p className="text-xs text-text-muted">
                        {participantCount} / 2 minimum participants
                      </p>
                    )}
```

- [ ] **Step 3: Add Copy invite link + Announce buttons (organizer, pending only)**

Inside the organizer panel (the existing `{isCreator && (tournament.status === "pending" || tournament.status === "active") && (...)}` block), inside the inner `else` branch's bottom row of buttons, add — after the Start button — two new buttons (only when `tournament.status === "pending"`):

```tsx
                  {tournament.status === "pending" && (
                    <>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          const url = `${window.location.origin}/tournament/${id}`;
                          await navigator.clipboard.writeText(url);
                          setCopiedLink(true);
                          setTimeout(() => setCopiedLink(false), 1500);
                        }}
                      >
                        <LinkIcon className="h-4 w-4" />
                        {copiedLink ? "Copied!" : "Copy invite link"}
                      </Button>
                      <Button
                        variant="ghost"
                        loading={actionLoading === "announce"}
                        onClick={async () => {
                          setActionLoading("announce");
                          setActionError(null);
                          try {
                            const res = await fetch(`/api/tournaments/${id}/announce`, { method: "POST" });
                            if (!res.ok) {
                              const body = await res.json();
                              throw new Error(body.error ?? "Failed to announce");
                            }
                          } catch (err) {
                            setActionError(err instanceof Error ? err.message : "Failed to announce");
                          } finally {
                            setActionLoading(null);
                          }
                        }}
                      >
                        <Megaphone className="h-4 w-4" />
                        Announce in Discord
                      </Button>
                    </>
                  )}
```

- [ ] **Step 4: Add Leave button for participants (non-organizer or organizer who joined)**

Replace the existing `{!isCreator && tournament.status === "pending" && isParticipant && (...)}` block:

```tsx
        {tournament.status === "pending" && isParticipant && (
          <div className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-text-secondary">
              {isCreator ? "You're hosting and playing in this tournament." : "You have joined this tournament. Waiting for the organizer to start."}
            </p>
            <Button
              variant="ghost"
              loading={actionLoading === "leave"}
              onClick={async () => {
                setActionLoading("leave");
                setActionError(null);
                try {
                  const res = await fetch(`/api/tournaments/${id}/leave`, { method: "POST" });
                  if (!res.ok) {
                    const body = await res.json();
                    throw new Error(body.error ?? "Failed to leave");
                  }
                  fetchTournament();
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : "Failed to leave");
                } finally {
                  setActionLoading(null);
                }
              }}
            >
              <LogOut className="h-4 w-4" />
              {isCreator ? "Leave as participant (stay as host)" : "Leave tournament"}
            </Button>
          </div>
        )}
```

- [ ] **Step 5: Add Kick X button next to each participant chip (organizer view)**

Replace the participants list rendering block (currently lines 320–329 — `tournament.participants.map((p) => (...))`):

```tsx
            <div className="flex flex-wrap gap-2">
              {tournament.participants.map((p) => (
                <span
                  key={p.playerId}
                  className="inline-flex items-center gap-1 rounded-full bg-bg-elevated px-3 py-1 text-sm text-text-secondary"
                >
                  {p.displayName}
                  {isCreator && tournament.status === "pending" && p.playerId !== tournament.currentUserPlayerId && (
                    <button
                      type="button"
                      aria-label={`Remove ${p.displayName}`}
                      className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-bg-default"
                      onClick={async () => {
                        setActionLoading(`kick-${p.playerId}`);
                        setActionError(null);
                        try {
                          const res = await fetch(`/api/tournaments/${id}/kick`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ playerId: p.playerId }),
                          });
                          if (!res.ok) {
                            const body = await res.json();
                            throw new Error(body.error ?? "Failed to remove");
                          }
                          fetchTournament();
                        } catch (err) {
                          setActionError(err instanceof Error ? err.message : "Failed to remove");
                        } finally {
                          setActionLoading(null);
                        }
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
```

- [ ] **Step 6: Manual smoke test in dev mode**

Launch the dev stack:

```bash
npm run dev:bot &
npm run dev:ws &
npm run dev:web &
```

Open `http://localhost:3000/tournaments`, sign in, create a new tournament, and verify:
1. The detail page shows you as participant #1 (organizer auto-joined).
2. The Start button is disabled with helper text "1 / 2 minimum participants".
3. The "Copy invite link" button copies a URL like `http://localhost:3000/tournament/<slug>`.
4. In a second browser/incognito window, sign in as a different Discord account, paste the link → the first window's participant chip appears within ~1s without refresh.
5. The Start button becomes enabled when 2 participants are present.
6. Click "Announce in Discord" → a message appears in the configured channel with organizer mention + participant count.
7. As organizer, click the X on the non-organizer chip → that chip disappears live in the other window.
8. As the kicked user, navigate back, click Join again, click "Leave tournament" → chip disappears live.
9. Click Start Tournament → both windows transition to the active view automatically.

Stop the dev stack when finished. (Use `kill %1 %2 %3` or `jobs -p | xargs kill`.)

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck --workspace=packages/web
git add packages/web/app/(app)/tournament/[slug]/page.tsx
git commit -m "feat(web): tournament detail — disabled start, invite link, announce, leave, kick, live updates"
```

---

## Task 13: Wire up live updates in existing route tests (regression check)

**Files:**
- Confirm existing tests still pass and add coverage for join+broadcast and announce-on-button.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS for all packages.

- [ ] **Step 2: If any draft or tournament tests regressed, fix them**

Most likely culprits:
- `packages/web/tests/api/tournaments-id-route.test.ts` — unaffected (no auto-join expectations).
- Any test that asserted `auth` returned a 500 for "Failed to start tournament" — update to expect 400 with the actual message (Task 5 already covers this for new tests; an existing test may still expect 500).

- [ ] **Step 3: Final commit**

If any test updates were needed:

```bash
git add packages/web/tests
git commit -m "test(web): align existing route tests with new error semantics"
```

If no changes, skip this step.

---

## Task 14: Update CLAUDE.md and CONTEXT.md if needed

**Files:**
- Modify (if applicable): `CLAUDE.md`, `CONTEXT.md`

`CONTEXT.md` was already updated during the grilling session. Verify it still reflects the implementation (Organizer auto-joined, Leave/Kick semantics, Invite link, Announcement).

- [ ] **Step 1: Skim CONTEXT.md against the merged code**

Open `CONTEXT.md`. Confirm the **Organizer**, **Participant**, **Invite link**, **Announcement**, **Kick**, **Leave** entries match the implementation. Adjust if any term drifted (e.g., if a method got renamed).

- [ ] **Step 2: Commit any drift fix**

```bash
git add CONTEXT.md
git commit -m "docs(context): sync glossary with tournament invite + live update implementation"
```

(Skip if no changes.)

---

## Verification

After all tasks land, the following should be true. Run these explicitly before declaring done:

- [ ] `npm test` — green across all packages
- [ ] `npm run typecheck` — green
- [ ] `npm run build` — green
- [ ] Manual smoke test from Task 12 Step 6 passes end-to-end
- [ ] The original screenshot scenario ("My test tournamnet" with 1 participant) is no longer reachable: new tournaments auto-join the organizer, and Start is disabled (not 500-ing) until a second participant joins
