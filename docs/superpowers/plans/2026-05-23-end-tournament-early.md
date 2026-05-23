# End Tournament Early (Organizer Manual Completion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tournament organizer manually end an *active* tournament early from the web dashboard, finalizing the standings (current leader = winner) without requiring every match to be played.

**Architecture:** Mirror the existing Cancel path. Add a `complete()` method to the shared tournament service (active → completed, stamp `ended_at`). Expose it through a new `POST /api/tournaments/[slug]/complete` route that fires the *existing* Discord `tournament-completed` announcement (deduped via the existing `claimTournamentCompletionAnnouncement` claim) and broadcasts a new `completed` WebSocket event so every viewer's page refetches. Add an "End tournament now" action to the organizer's Host Controls card in the Overview tab.

**Tech Stack:** TypeScript, npm workspaces + Turborepo, better-sqlite3, Next.js 16 App Router, NextAuth v5, Socket.IO, vitest, React Testing Library, Tailwind.

**Key decisions (confirmed with the user):**
- **Both formats** (round_robin AND single_elim) support manual early completion. Winner = current standings leader in both. (Single-elim mid-bracket simply uses best W/L so far.)
- **Unplayed matches are left as-is.** Open / pending_approval matches are untouched at completion. Standings already ignore non-completed matches, so they don't affect the winner. This keeps the action reversible via the existing per-match Reopen flow (which flips a completed tournament back to active).
- **Web UI only.** No new Discord bot command in this plan. (The Discord winner *announcement* still fires, because that infrastructure already exists and auto-complete already uses it — manual completion must behave consistently.)

**Why this is safe / non-duplicative:**
- `tournaments.cancel()` (status → `cancelled`, no winner) already exists and is exposed via `DELETE /api/tournaments/[slug]`. This plan adds the *complementary* `complete()` (status → `completed`, winner via standings). They are distinct.
- The bot already auto-completes tournaments when all matches resolve (`packages/shared/src/services/matches.ts`) and on deadline (`tournaments.closeForDeadline()` + bot timer). Manual completion is a third trigger for the *same* end state.
- The bot already exposes `/internal/announce/tournament-completed` (`announce-bot.ts` payload `{ kind: "tournament-completed"; tournamentId }`), handled by `announceTournamentCompleted()`. We reuse it; we do **not** build new bot surface.
- The winner is **derived from standings** (`standings/route.ts`: wins desc, losses asc). There is **no `winner_id` column** and we are **not** adding one — consistent with how every other completion path works.

---

## File Structure

**Shared (`packages/shared`)**
- Modify: `src/services/tournaments.ts` — add `complete(tournamentId)` (insert right after `cancel()`, ~line 702).
- Modify: `src/ws/events.ts` — add `TournamentCompletedBroadcast`, add it to the `TournamentBroadcastPayload` union, add `"completed"` to `TOURNAMENT_BROADCAST_KINDS`.
- Test: `tests/services/tournaments.test.ts` — add a `describe("complete", ...)` block.

**WebSocket server (`packages/ws`)**
- Modify: `src/events.ts` — add `"tournament:completed"` to the server→client events interface.
- Modify: `src/internal-http.ts` — add a `case "/internal/tournament/completed"` (reuses existing `parseTournamentSlugOnly`).
- Test: `tests/internal-http-tournament.test.ts` — add a "broadcasts completed" test.

**Web (`packages/web`)**
- Create: `app/api/tournaments/[slug]/complete/route.ts` — `POST` handler.
- Modify: `src/lib/hooks/use-tournament-websocket.ts` — add `onCompleted` option + `socket.on("tournament:completed", ...)`.
- Modify: `app/(app)/tournament/[slug]/page.tsx` — wire `onCompleted: () => fetchTournament()`.
- Modify: `src/components/tournament/overview-host-controls.tsx` — add "End tournament now" action alongside Cancel; new required prop `onCompleted`.
- Modify: `src/components/tournament/overview-tab.tsx` — pass `onCompleted={onChanged}` to `OverviewHostControls`.
- Test (create): `tests/api/tournaments-complete-route.test.ts`.
- Test (modify): `tests/components/overview-host-controls.test.tsx` — pass the new prop on existing renders; add "End now" cases.
- Test (modify): `tests/components/tournament-detail-page.test.tsx` — add "organizer can end an ACTIVE tournament" case.

**Parallelization (per user's standing "work in parallel" preference + `[[feedback_parallel_subagent_impl]]`):**
- **Wave A (foundation, parallel — file-disjoint):** Task 1 (shared service) ‖ Task 2 (shared ws types) ‖ Task 3 (ws server). Task 3's test only needs the ws-local route; Task 2's shared type addition is what `notify-ws-tournament.ts` (web) needs later. Run all three concurrently.
- **Task 4 (rebuild shared)** is a sequential gate — must run after Tasks 1 & 2 so web/ws consumers resolve the new exports.
- **Wave B (web, parallel after Task 4):** Task 5 (route) ‖ Task 6 (hook+page) ‖ Task 7 (UI). These touch disjoint files.
- **Task 8** depends on Task 7 (component) + Task 6 (page wiring).
- **Task 9** (verification) last.
- Subagents should **not commit** (avoid `.git/index.lock` races in the shared worktree); the controller commits centrally after each task/wave.

---

### Task 1: Shared service — `complete(tournamentId)`

**Files:**
- Modify: `packages/shared/src/services/tournaments.ts` (insert after `cancel()`, currently ends at line 702)
- Test: `packages/shared/tests/services/tournaments.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this block inside `packages/shared/tests/services/tournaments.test.ts`, after the existing `describe("tournaments timing settings", ...)` block (it can be a new top-level `describe`). It reuses the `setup()` and `insertPlayer()` helpers already defined at the top of the file.

```ts
describe("tournaments complete (manual early finish)", () => {
  it("completes an active tournament and stamps ended_at", () => {
    const { tournaments, db } = setup();
    const p1 = insertPlayer(db, "g1", "u1", "Yugi");
    const p2 = insertPlayer(db, "g1", "u2", "Kaiba");
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    tournaments.join(t.id, p1);
    tournaments.join(t.id, p2);
    tournaments.start(t.id); // -> active

    const completed = tournaments.complete(t.id);

    expect(completed.status).toBe("completed");
    const row = db
      .prepare("select ended_at from tournaments where id = ?")
      .get(t.id) as { ended_at: string | null };
    expect(row.ended_at).not.toBeNull();
  });

  it("throws when the tournament is still pending (never started)", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    expect(() => tournaments.complete(t.id)).toThrow(/cannot be completed/i);
  });

  it("throws when the tournament is already completed", () => {
    const { tournaments, db } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    db.prepare("update tournaments set status = 'completed' where id = ?").run(t.id);
    expect(() => tournaments.complete(t.id)).toThrow(/cannot be completed/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/shared/tests/services/tournaments.test.ts -t "complete"`
Expected: FAIL — `tournaments.complete is not a function`.

- [ ] **Step 3: Implement `complete()`**

In `packages/shared/src/services/tournaments.ts`, insert this method immediately after the `cancel()` method (after its closing `},` at ~line 702, before `updateSettings`):

```ts
    complete(tournamentId: number): Tournament {
      const tournament = findById(tournamentId);

      if (tournament.status !== "active") {
        throw new Error(`Tournament cannot be completed in status '${tournament.status}'`);
      }

      db.prepare(
        "update tournaments set status = 'completed', ended_at = current_timestamp where id = ?",
      ).run(tournamentId);

      return findById(tournamentId);
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/shared/tests/services/tournaments.test.ts -t "complete"`
Expected: PASS (3/3).

- [ ] **Step 5: Commit** (controller commits; subagent reports DONE)

```bash
git add packages/shared/src/services/tournaments.ts packages/shared/tests/services/tournaments.test.ts
git commit -m "feat(shared): add tournaments.complete() for manual early finish"
```

---

### Task 2: Shared WS events — `completed` broadcast

**Files:**
- Modify: `packages/shared/src/ws/events.ts`

There is no dedicated unit test for the broadcast type union (it is a TS type + a const array). Its runtime behavior is exercised by the ws-server test in Task 3 and the route test in Task 5. This task is a type/const addition only.

- [ ] **Step 1: Add the broadcast type**

In `packages/shared/src/ws/events.ts`, after `TournamentCancelledBroadcast` (ends at line 62), add:

```ts
export type TournamentCompletedBroadcast = {
  kind: "completed";
  slug: string;
};
```

- [ ] **Step 2: Add it to the union**

Update the `TournamentBroadcastPayload` union (currently lines 69-74) to include the new type:

```ts
export type TournamentBroadcastPayload =
  | TournamentParticipantJoinedBroadcast
  | TournamentParticipantLeftBroadcast
  | TournamentStartedBroadcast
  | TournamentCancelledBroadcast
  | TournamentCompletedBroadcast
  | TournamentMatchUpdatedBroadcast;
```

- [ ] **Step 3: Add `"completed"` to the kinds array**

Update `TOURNAMENT_BROADCAST_KINDS` (currently lines 76-82):

```ts
export const TOURNAMENT_BROADCAST_KINDS = [
  "participant-joined",
  "participant-left",
  "started",
  "cancelled",
  "completed",
  "match-updated",
] as const;
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run typecheck --workspace=packages/shared`
Expected: PASS (no type errors).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/ws/events.ts
git commit -m "feat(shared): add 'completed' tournament WS broadcast type"
```

---

### Task 3: WS server — emit `tournament:completed`

**Files:**
- Modify: `packages/ws/src/events.ts` (server→client event types)
- Modify: `packages/ws/src/internal-http.ts` (route handler)
- Test: `packages/ws/tests/internal-http-tournament.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/ws/tests/internal-http-tournament.test.ts`, add this test inside the existing `describe("createInternalHttpHandler — tournament routes", ...)` block, right after the "broadcasts cancelled" test (line 62):

```ts
  it("broadcasts completed", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/tournament/completed", { slug: "abc" }));
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("tournament:abc");
    expect(emit).toHaveBeenCalledWith("tournament:completed", {});
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/ws/tests/internal-http-tournament.test.ts -t "completed"`
Expected: FAIL — handler returns 404 (route not yet defined), so `res.status` is 404 not 204.

- [ ] **Step 3: Add the server→client event type**

In `packages/ws/src/events.ts`, after the `"tournament:cancelled"` line (line 19), add:

```ts
  "tournament:completed": (data: Record<string, never>) => void;
```

- [ ] **Step 4: Add the route case**

In `packages/ws/src/internal-http.ts`, after the `case "/internal/tournament/cancelled"` block (ends line 157), add:

```ts
      case "/internal/tournament/completed": {
        const data = parseTournamentSlugOnly(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(`tournament:${data.slug}`).emit("tournament:completed", {});
        return new Response(null, { status: 204 });
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/ws/tests/internal-http-tournament.test.ts`
Expected: PASS (all tournament-route tests, including the new one).

- [ ] **Step 6: Commit**

```bash
git add packages/ws/src/events.ts packages/ws/src/internal-http.ts packages/ws/tests/internal-http-tournament.test.ts
git commit -m "feat(ws): broadcast tournament:completed on /internal/tournament/completed"
```

---

### Task 4: Rebuild shared (sequential gate)

The web route test (Task 5) imports `@yugidraft/shared/services` and `@yugidraft/shared/ws` from the **built** package. After Tasks 1 & 2 changed shared source, rebuild before running web/ws consumers.

- [ ] **Step 1: Build shared**

Run: `npm run build --workspace=packages/shared`
Expected: build succeeds, `packages/shared/dist` updated.

(No commit — `dist` is git-ignored / build output.)

---

### Task 5: Web API route — `POST /api/tournaments/[slug]/complete`

**Files:**
- Create: `packages/web/app/api/tournaments/[slug]/complete/route.ts`
- Test: `packages/web/tests/api/tournaments-complete-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/api/tournaments-complete-route.test.ts` (mirrors `tournaments-start-route.test.ts`):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

function seedActive(dbPath: string) {
  // imported lazily so each test gets a fresh module graph
  return import("better-sqlite3").then(async ({ default: Database }) => {
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb
      .prepare(
        "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','T','round_robin','active','u-org','slug-1')",
      )
      .run();
    seedDb.close();
  });
}

describe("POST /api/tournaments/[slug]/complete", () => {
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

  it("completes an active tournament and returns status completed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-complete-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    await seedActive(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/complete/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/complete", { method: "POST" }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");

    const Database = (await import("better-sqlite3")).default;
    const check = new Database(dbPath);
    const row = check.prepare("select status, ended_at from tournaments where web_slug = 'slug-1'").get() as {
      status: string;
      ended_at: string | null;
    };
    check.close();
    expect(row.status).toBe("completed");
    expect(row.ended_at).not.toBeNull();
  });

  it("returns 400 when the tournament is not active", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-complete-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb
      .prepare(
        "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','T','round_robin','pending','u-org','slug-1')",
      )
      .run();
    seedDb.close();

    const { POST } = await import("../../app/api/tournaments/[slug]/complete/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/complete", { method: "POST" }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cannot end a pending/i);
  });

  it("returns 403 when the caller is not the creator", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-complete-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    await seedActive(dbPath);
    auth.mockResolvedValue({ user: { id: "u-someone-else", name: "Nope" } });

    const { POST } = await import("../../app/api/tournaments/[slug]/complete/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/complete", { method: "POST" }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/tests/api/tournaments-complete-route.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — `Cannot find module '.../complete/route'`.

- [ ] **Step 3: Create the route**

Create `packages/web/app/api/tournaments/[slug]/complete/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService, createMatchService } from "@yugidraft/shared/services";
import { announceToBot } from "@/lib/announce-bot";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();

    const tournament = db
      .prepare("select id, status, created_by_user_id from tournaments where web_slug = ?")
      .get(slug) as { id: number; status: string; created_by_user_id: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the tournament creator can end it" }, { status: 403 });
    }

    if (tournament.status !== "active") {
      return NextResponse.json({ error: `Cannot end a ${tournament.status} tournament` }, { status: 400 });
    }

    const tournaments = createTournamentService(db);
    const completed = tournaments.complete(tournament.id);

    // Fire the Discord winner announcement exactly once. The claim guards against
    // a double-announce if the bot's auto-complete path also runs.
    const matches = createMatchService(db);
    if (matches.claimTournamentCompletionAnnouncement(completed.id)) {
      void announceToBot(
        { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
        { kind: "tournament-completed", tournamentId: completed.id },
      );
    }

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "completed", slug },
    );

    return NextResponse.json({ id: completed.id, status: completed.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to end tournament";
    console.error("[api/tournaments/[slug]/complete] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

Note: `announceToBot` and `notifyWsTournament` both short-circuit to a no-op when their url/secret are unset, so the test (which has no bot/ws env configured) exercises the DB path safely without network calls or mocks.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/web/tests/api/tournaments-complete-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/[slug]/complete/route.ts packages/web/tests/api/tournaments-complete-route.test.ts
git commit -m "feat(web): POST /api/tournaments/[slug]/complete to end a tournament early"
```

---

### Task 6: Web — WebSocket hook + page wiring (`onCompleted`)

**Files:**
- Modify: `packages/web/src/lib/hooks/use-tournament-websocket.ts`
- Modify: `packages/web/app/(app)/tournament/[slug]/page.tsx`

This is wiring for live updates to *other* viewers (the acting host already refetches via `onChanged` in Task 7). The integration test in Task 8 mocks the hook, so there is no separate unit test here; verification is via typecheck + the build.

- [ ] **Step 1: Add `onCompleted` to the hook options**

In `packages/web/src/lib/hooks/use-tournament-websocket.ts`, add to the `UseTournamentWebsocketOptions` interface (after `onCancelled?` line 14):

```ts
  onCompleted?: () => void;
```

- [ ] **Step 2: Add the socket listener**

In the same file, after the `socket.on("tournament:cancelled", ...)` block (lines 45-47), add:

```ts
    socket.on("tournament:completed", () => {
      optionsRef.current.onCompleted?.();
    });
```

- [ ] **Step 3: Wire it in the page**

In `packages/web/app/(app)/tournament/[slug]/page.tsx`, in the `useTournamentWebsocket(slug, { ... })` call (lines 61-67), add the `onCompleted` handler:

```tsx
  useTournamentWebsocket(slug, {
    onParticipantJoined: () => fetchTournament(),
    onParticipantLeft: () => fetchTournament(),
    onStarted: () => fetchTournament(),
    onCancelled: () => fetchTournament(),
    onCompleted: () => fetchTournament(),
    onMatchUpdated: () => fetchTournament(),
  });
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run typecheck --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/hooks/use-tournament-websocket.ts "packages/web/app/(app)/tournament/[slug]/page.tsx"
git commit -m "feat(web): refetch tournament on tournament:completed WS broadcast"
```

---

### Task 7: Web UI — "End tournament now" in Host Controls

**Files:**
- Modify: `packages/web/src/components/tournament/overview-host-controls.tsx`
- Modify: `packages/web/src/components/tournament/overview-tab.tsx`
- Test: `packages/web/tests/components/overview-host-controls.test.tsx`

**Design / responsive (ui-ux-pro-max):** Two distinct actions in the same card. "End tournament now" is the positive/primary action (accent-primary, `Flag` icon); "Cancel tournament" stays the subdued destructive action (accent-cta, `X` icon). Each has its own inline confirmation (no nested ternaries — a single `confirm` state of `"none" | "complete" | "cancel"`). All triggers and the "Go back" buttons keep `min-h-[44px]` touch targets. On successful completion the card calls `onCompleted()` (refetch) rather than navigating away, so the page re-renders into its completed state (Overview tab drops out; the page defaults to Standings — see `page.tsx` `allowedTabs`/`defaultTab`). Cancel keeps its existing navigate-to-`/tournaments` behavior.

- [ ] **Step 1: Update existing tests + write new failing tests**

Replace the entire body of `packages/web/tests/components/overview-host-controls.test.tsx` with:

```tsx
// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

import { OverviewHostControls } from "../../src/components/tournament/overview-host-controls";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OverviewHostControls — cancel", () => {
  it("requires inline confirmation, calls DELETE, then redirects to /tournaments", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 1, status: "cancelled" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewHostControls tournamentSlug="goat-cup" onCompleted={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /cancel tournament/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/goat-cup", { method: "DELETE" });
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/tournaments");
    });
  });

  it("surfaces the server error message and stays on the page", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "Only the tournament creator can cancel it" }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewHostControls tournamentSlug="goat-cup" onCompleted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel tournament/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText(/only the tournament creator can cancel it/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("OverviewHostControls — end now (complete)", () => {
  it("requires inline confirmation, POSTs to /complete, then calls onCompleted (no redirect)", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 1, status: "completed" }));
    vi.stubGlobal("fetch", fetchMock);
    const onCompleted = vi.fn();

    render(<OverviewHostControls tournamentSlug="goat-cup" onCompleted={onCompleted} />);

    // First click reveals the confirm row, does NOT call fetch yet.
    fireEvent.click(screen.getByRole("button", { name: /end tournament now/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /yes, end now/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/goat-cup/complete", { method: "POST" });
    });
    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalled();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("surfaces the server error message and does not call onCompleted", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "Cannot end a pending tournament" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onCompleted = vi.fn();

    render(<OverviewHostControls tournamentSlug="goat-cup" onCompleted={onCompleted} />);
    fireEvent.click(screen.getByRole("button", { name: /end tournament now/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, end now/i }));

    expect(await screen.findByText(/cannot end a pending tournament/i)).toBeInTheDocument();
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/web/tests/components/overview-host-controls.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — the "end now" buttons don't exist yet (and the component doesn't accept `onCompleted`).

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `packages/web/src/components/tournament/overview-host-controls.tsx` with:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Flag, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type ConfirmKind = "none" | "complete" | "cancel";

export function OverviewHostControls({
  tournamentSlug,
  onCompleted,
}: {
  tournamentSlug: string;
  onCompleted: () => void;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<ConfirmKind>("none");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleComplete() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}/complete`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to end tournament");
      }
      setConfirm("none");
      setLoading(false);
      onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to end tournament");
      setLoading(false);
    }
  }

  async function handleCancel() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to cancel");
      }
      router.push("/tournaments");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel");
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-text-secondary" />
        <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
          Host controls
        </h2>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-3 py-2 text-sm text-accent-cta">
          {error}
        </div>
      )}

      {confirm === "complete" && (
        <div className="mb-3 flex flex-col gap-3 rounded-lg border border-accent-primary/40 bg-accent-primary/5 px-4 py-3 text-sm">
          <span className="text-text-secondary">
            End this tournament now? Any unplayed matches are left as-is and the current
            standings leader becomes the winner. You can still reopen a match later if needed.
          </span>
          <div className="flex items-center gap-3">
            <Button variant="primary" size="md" loading={loading} onClick={handleComplete}>
              Yes, end now
            </Button>
            <button
              type="button"
              className="inline-flex min-h-[44px] items-center px-2 text-text-secondary hover:text-text-primary"
              onClick={() => setConfirm("none")}
            >
              Go back
            </button>
          </div>
        </div>
      )}

      {confirm === "cancel" && (
        <div className="mb-3 flex flex-col gap-3 rounded-lg border border-accent-cta/40 bg-accent-cta/5 px-4 py-3 text-sm">
          <span className="text-text-secondary">
            Cancel this tournament? No winner will be recorded and standings will be frozen. This cannot be undone.
          </span>
          <div className="flex items-center gap-3">
            <Button variant="danger" size="md" loading={loading} onClick={handleCancel}>
              Yes, cancel
            </Button>
            <button
              type="button"
              className="inline-flex min-h-[44px] items-center px-2 text-text-secondary hover:text-text-primary"
              onClick={() => setConfirm("none")}
            >
              Go back
            </button>
          </div>
        </div>
      )}

      {confirm === "none" && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setConfirm("complete")}
            className="inline-flex min-h-[44px] items-center gap-1.5 py-2 text-sm font-semibold text-accent-primary motion-safe:transition-colors hover:text-accent-secondary"
          >
            <Flag className="h-4 w-4" />
            End tournament now
          </button>
          <button
            type="button"
            onClick={() => setConfirm("cancel")}
            className="inline-flex min-h-[44px] items-center gap-1.5 py-2 text-sm text-text-secondary motion-safe:transition-colors hover:text-accent-cta"
          >
            <X className="h-4 w-4" />
            Cancel tournament
          </button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Pass the new prop from the orchestrator**

In `packages/web/src/components/tournament/overview-tab.tsx`, update the host-controls render (line 80) from:

```tsx
          {isHost && <OverviewHostControls tournamentSlug={tournamentSlug} />}
```

to:

```tsx
          {isHost && <OverviewHostControls tournamentSlug={tournamentSlug} onCompleted={onChanged} />}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/overview-host-controls.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/tournament/overview-host-controls.tsx packages/web/src/components/tournament/overview-tab.tsx packages/web/tests/components/overview-host-controls.test.tsx
git commit -m "feat(web): add 'End tournament now' action to host controls"
```

---

### Task 8: Web integration — organizer can end an active tournament

**Files:**
- Test: `packages/web/tests/components/tournament-detail-page.test.tsx`

- [ ] **Step 1: Write the failing test**

In `packages/web/tests/components/tournament-detail-page.test.tsx`, add this case at the end of the `describe("TournamentDetailPage (tabbed integration)", ...)` block, right after the existing "organizer can cancel an ACTIVE tournament" test (line 212):

```tsx
  it("organizer can end an ACTIVE tournament from the Overview", async () => {
    // tournament fixture: status active, createdByUserId 'user-1' === session user.
    searchParams = new URLSearchParams("tab=overview");
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<TournamentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: /end tournament now/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, end now/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tournaments/goat-cup/complete", { method: "POST" });
    });
  });
```

(The default branch of `stubFetch` returns `Response.json([], { status: 200 })` for unknown URLs, so the `/complete` POST resolves `res.ok === true`, which triggers the page's `onChanged` refetch. No extra stubbing needed.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/tests/components/tournament-detail-page.test.tsx -c packages/web/vitest.config.ts -t "end an ACTIVE"`
Expected: FAIL initially **only if run before Task 7 is built into the component graph**. Since Task 7 is already implemented, this will PASS — that is acceptable for an integration test that documents end-to-end wiring. If you are running tasks strictly in order and Task 7 is complete, note the test passes immediately; confirm it genuinely exercises the button by temporarily asserting a wrong URL to see it fail, then revert. (Do not leave the temporary assertion in.)

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run packages/web/tests/components/tournament-detail-page.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (all cases).

- [ ] **Step 4: Commit**

```bash
git add packages/web/tests/components/tournament-detail-page.test.tsx
git commit -m "test(web): organizer can end an active tournament from Overview"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Rebuild shared (in case of any later edits)**

Run: `npm run build --workspace=packages/shared`
Expected: success.

- [ ] **Step 2: Typecheck all packages**

Run: `npm run typecheck`
Expected: PASS (all turbo tasks).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS across shared, bot, ws, web (no regressions; new tests green).

- [ ] **Step 4: Build web**

Run: `npm run build --workspace=packages/web`
Expected: success.

- [ ] **Step 5: Manual browser smoke (cannot be automated here — note for the human)**

With `npm run dev:web` (+ ws + bot for full flow):
- As the organizer, open an **active** tournament → Overview → Host controls → "End tournament now" → confirm. Page should flip to the completed state (Overview tab gone, Standings shown), winner = top of standings.
- Verify at 375px (mobile) the two actions stack, are tap-friendly, and the confirm copy wraps without horizontal scroll.
- Verify a non-organizer does not see Host controls.
- Verify "Cancel tournament" still navigates to `/tournaments`.

---

## Self-Review

**Spec coverage:**
- Manual early completion for **both formats** → `complete()` is format-agnostic (Task 1); UI/route impose no format gate (Tasks 5, 7). ✓
- **Unplayed matches left as-is** → `complete()` only flips tournament status; no match writes (Task 1). Confirm copy states this (Task 7). ✓
- **Web UI only** → no bot command added; Discord *announcement* reuses existing infra (Task 5). ✓
- Winner via standings → no `winner_id` added; completion just freezes state, standings route already ranks (no change needed). ✓
- Live update for other viewers → `completed` WS broadcast end-to-end (Tasks 2, 3, 6). ✓
- Acting host sees completed state → `onCompleted` → refetch → page recomputes tabs (Task 7 + existing `page.tsx`). ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. ✓

**Type consistency:**
- `tournaments.complete(id): Tournament` used identically in Task 1 (def) and Task 5 (call). ✓
- WS kind `"completed"` consistent across shared union (Task 2), ws event name `"tournament:completed"` (Task 3), web `notifyWsTournament({ kind: "completed", slug })` (Task 5), hook listener (Task 6). ✓
- `OverviewHostControls` prop `onCompleted: () => void` defined (Task 7 component) and supplied as `onChanged` (Task 7 orchestrator) and `() => {}` / `vi.fn()` (Task 7 tests). ✓
- `createMatchService(db).claimTournamentCompletionAnnouncement(id): boolean` — matches `packages/shared/src/services/matches.ts:390`. ✓
- `announceToBot` payload `{ kind: "tournament-completed"; tournamentId }` — matches `announce-bot.ts:24`. ✓

**Edge cases considered:**
- Double-announce: guarded by `claimTournamentCompletionAnnouncement` (status='completed' AND completed_announced_at IS NULL). ✓
- Completing a non-active tournament: 400 from route + throw from service. ✓
- No bot/ws env in tests: `announceToBot`/`notifyWsTournament` no-op. ✓

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-23-end-tournament-early.md`.

**Open decision before execution:** these commits will land on the current worktree branch `worktree-fix-tournament-ux`, which already has open PR #33 (cancel + Overview redesign). Either (a) append to PR #33 (thematically "tournament UX"), or (b) branch off for a separate PR. Confirm preference at execution time.

Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, parallel waves per the Parallelization note, controller commits centrally.
2. **Inline Execution** — execute tasks in this session with checkpoints.
