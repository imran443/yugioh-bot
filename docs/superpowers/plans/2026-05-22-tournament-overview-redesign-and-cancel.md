# Tournament Overview Redesign + Active-Cancel Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the organizer's ability to cancel an *active* tournament from the web UI (a regression), and redesign the sparse Overview tab into a richer two-column dashboard.

**Architecture:** The Overview tab becomes a responsive 2-column orchestrator (`overview-tab.tsx`) composed of small, focused presentational components. A thin data-layer change surfaces three timestamps the UI needs (`resolvedAt`, `startedAt`, `createdAt`) that already exist in SQLite. Cancel reuses the existing `DELETE /api/tournaments/:slug` route (which already accepts `active` status) via a new organizer-only Host Controls card that mirrors the inline-confirm pattern already used in the pending lobby.

**Tech Stack:** Next.js 16 App Router, React client components, Tailwind with semantic design tokens (`bg-surface`, `border-border`, `text-text-primary/secondary/muted`, `accent-primary`, `accent-cta`, `accent-success`, `accent-gold`, `bg-bg-deep`), better-sqlite3, vitest (web config: `-c packages/web/vitest.config.ts`), lucide-react icons, native `Intl` for absolute date formatting.

---

## Design decisions (read before starting)

- **Cancel, not "end early."** Cancel marks the tournament `cancelled` with no auto-winner. The backend `DELETE` handler already does exactly this (`route.ts:167`). We are *only* restoring the missing UI entry point for `active` tournaments.
- **Absolute timestamps.** Per user decision, Recent Results and the Info card show absolute dates (e.g. `May 18, 14:30`), not relative ("8m ago"). We follow the existing codebase pattern (`draft-summary-view.tsx:47` uses `toLocaleDateString`) but centralize it in a testable helper.
- **No separate "Up Next" component.** `YourActionCard` already surfaces the user's single most important actionable match with inline reporting. A separate Up Next list would duplicate it. We keep `YourActionCard` as the left-column hero and add *Recent Results* below it for richness. (If the user later wants a full list of all their open matches, that is a follow-up.)
- **Preserve test-critical strings.** The Progress card MUST keep the exact substrings `"{n}/{total} matches done"` and `"Round {current} of {max}"` (single-elim only). `tests/components/tournament-detail-page.test.tsx:185-195` asserts these.
- **`roundsAreMeaningful = format === "single_elim"`** — round numbers are a real sequential concept only for single elimination. Round-robin shows match progress only. This logic is carried over verbatim from the current `overview-tab.tsx:48`.

## Responsive / mobile behavior (mobile-first)

Reviewed against ui-ux-pro-max §5 (Layout & Responsive), §2 (Touch), §6 (Typography/Color), §8 (Forms/Feedback). The web subset of those rules:

- **Mobile-first stacking.** The only breakpoint is `lg` (≥1024px). Below `lg` every card is a full-width single column; at `lg` the secondary content moves into a right rail. No `md` 2-col stage — a 2-col grid on a ~768px tablet would cramp the standings table.
- **Source order = mobile priority** (`content-priority`). Mobile reads top→bottom: **Your match → Progress → Standings → Recent results → Details → Settings (host) → Host controls (host)**. The most actionable thing is first; the destructive Cancel is last (`destructive-nav-separation`).
- **Progress is a full-width strip** above the 2-col grid (not buried in the rail), so on mobile it appears right under the action card instead of after the entire left column.
- **No horizontal scroll** (`horizontal-scroll`): long player names truncate with `min-w-0` + `truncate` (Recent results) and the standings name cell truncates; numeric W/L use `tabular-nums` (`number-tabular`) so columns don't jitter.
- **Touch targets ≥44px** (`touch-target-size`): the "See full standings", "Cancel tournament", "Go back" controls get `min-h-[44px]` / vertical padding on mobile; the destructive confirm uses `Button size="md"` (not `sm`) so it clears 44px.
- **Empty states** (`empty-states`): Recent results renders a "No results yet" card instead of disappearing, so a freshly-started tournament still looks intentional (directly addresses the "page seems empty" complaint).
- **Reduced motion**: progress bar transition stays behind `motion-safe:` (already in the extracted markup).

## File Structure

**Create:**
- `packages/web/src/lib/format-date.ts` — `formatMatchTime(iso, opts?)` absolute-date helper (testable via injectable locale/timeZone).
- `packages/web/src/components/tournament/overview-progress.tsx` — progress bar + label (extracted, preserving strings).
- `packages/web/src/components/tournament/overview-recent-results.tsx` — last 5 completed matches.
- `packages/web/src/components/tournament/overview-standings.tsx` — top-3 standings card (extracted from current overview-tab) with podium rank icons.
- `packages/web/src/components/tournament/overview-info.tsx` — Format · Started · Players summary.
- `packages/web/src/components/tournament/overview-host-controls.tsx` — organizer-only Cancel with inline confirm.

**Modify:**
- `packages/web/app/api/tournaments/[slug]/route.ts` — GET: add `m.resolved_at` to the matches select & map to `resolvedAt`; add `startedAt` + `createdAt` to the response body.
- `packages/web/src/components/tournament/types.ts` — add `Match.resolvedAt`, `TournamentDetail.startedAt`, `TournamentDetail.createdAt`.
- `packages/web/src/components/tournament/overview-tab.tsx` — rework into a 2-column grid orchestrator that composes the new components.

**Test:**
- `packages/web/tests/api/tournaments-id-route.test.ts` — extend with a case asserting the new fields.
- `packages/web/tests/lib/format-date.test.ts` — new unit test.
- `packages/web/tests/components/overview-recent-results.test.tsx` — new.
- `packages/web/tests/components/overview-host-controls.test.tsx` — new.
- `packages/web/tests/components/tournament-detail-page.test.tsx` — existing; must continue to pass (progress strings preserved). Extend with a Recent Results assertion.

**Test command reminder:** web tests need the web config:
`npx vitest run packages/web/tests/<file> -c packages/web/vitest.config.ts`

---

### Task 1: Data layer — surface `resolvedAt`, `startedAt`, `createdAt`

**Files:**
- Modify: `packages/web/app/api/tournaments/[slug]/route.ts:11-21` (TournamentRow type), `:59-93` (matches select+map), `:116-130` (response body)
- Modify: `packages/web/src/components/tournament/types.ts:6-32`
- Test: `packages/web/tests/api/tournaments-id-route.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `it(...)` block inside the `describe("GET /api/tournaments/[slug]", ...)` in `packages/web/tests/api/tournaments-id-route.test.ts` (after the existing "looks up tournament by slug" test):

```ts
  it("surfaces startedAt, createdAt, and per-match resolvedAt", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);

    seedDb
      .prepare(
        "insert into tournaments (id, guild_id, name, format, status, created_by_user_id, web_slug, created_at, started_at) values (1, 'guild-1', 'Locals', 'round_robin', 'active', 'user-1', 'abcd1234', '2026-05-01T10:00:00Z', '2026-05-02T12:00:00Z')",
      )
      .run();
    seedDb.prepare("insert into players (id, guild_id, discord_user_id, display_name) values (1, 'guild-1', 'u-a', 'Alice')").run();
    seedDb.prepare("insert into players (id, guild_id, discord_user_id, display_name) values (2, 'guild-1', 'u-b', 'Bob')").run();
    seedDb.prepare("insert into tournament_participants (tournament_id, player_id) values (1, 1)").run();
    seedDb.prepare("insert into tournament_participants (tournament_id, player_id) values (1, 2)").run();
    seedDb
      .prepare(
        "insert into matches (id, guild_id, player_one_id, player_two_id, status, winner_id, resolved_at) values (500, 'guild-1', 1, 2, 'completed', 1, '2026-05-03T14:30:00Z')",
      )
      .run();
    seedDb
      .prepare(
        "insert into tournament_matches (id, tournament_id, match_id, player_one_id, player_two_id, round_number, status, metadata_json) values (700, 1, 500, 1, 2, 1, 'completed', '{}')",
      )
      .run();
    seedDb.close();

    const { GET } = await import("../../app/api/tournaments/[slug]/route");
    const res = await GET(new Request("http://localhost/api/tournaments/abcd1234"), {
      params: Promise.resolve({ slug: "abcd1234" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.startedAt).toBe("2026-05-02T12:00:00Z");
    expect(body.createdAt).toBe("2026-05-01T10:00:00Z");
    expect(body.matches[0].resolvedAt).toBe("2026-05-03T14:30:00Z");
  });
```

> Note: confirm the `matches` table insert columns against `packages/shared/src/db/schema.ts` (around lines 140-148) before running — if `matches` has additional NOT NULL columns without defaults, add them to the insert. The columns referenced (`guild_id`, `player_one_id`, `player_two_id`, `status`, `winner_id`, `resolved_at`) are the ones this test depends on.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/api/tournaments-id-route.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — `body.startedAt` is `undefined` (and `body.matches[0].resolvedAt` undefined).

- [ ] **Step 3: Implement the route changes**

In `packages/web/app/api/tournaments/[slug]/route.ts`:

(a) Extend the `TournamentRow` type (lines 11-21) to include the two timestamps:

```ts
type TournamentRow = {
  id: number;
  guild_id: string;
  name: string;
  format: string;
  status: string;
  created_by_user_id: string;
  web_slug: string | null;
  deadline_at: string | null;
  report_confirm_window_hours: number | null;
  created_at: string;
  started_at: string | null;
};
```

(b) Add `m.resolved_at` to the matches SELECT (inside the select list at lines 71-73, after `m.approver_id`):

```ts
          m.winner_id,
          m.reporter_id,
          m.approver_id,
          m.resolved_at
```

(c) Add `resolvedAt` to the matches `.map(...)` (after `approverId: row.approver_id,` at line 92):

```ts
        approverId: row.approver_id,
        resolvedAt: row.resolved_at,
```

(d) Add `startedAt` + `createdAt` to the GET response object (in the `NextResponse.json({...})` at lines 116-130, after `reportConfirmWindowHours: ...`):

```ts
      reportConfirmWindowHours: tournament.report_confirm_window_hours ?? undefined,
      startedAt: tournament.started_at ?? null,
      createdAt: tournament.created_at,
```

- [ ] **Step 4: Update the shared types**

In `packages/web/src/components/tournament/types.ts`, add `resolvedAt` to `Match` (after `reporterId` on line 16) and the two tournament timestamps to `TournamentDetail` (after `currentUserPlayerId` on line 29):

```ts
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
  resolvedAt: string | null;
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
  startedAt: string | null;
  createdAt: string;
  deadlineAt?: string;
  reportConfirmWindowHours?: number;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/api/tournaments-id-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (all cases in the file).

- [ ] **Step 6: Commit**

```bash
git add packages/web/app/api/tournaments/[slug]/route.ts packages/web/src/components/tournament/types.ts packages/web/tests/api/tournaments-id-route.test.ts
git commit -m "feat(web): surface tournament timestamps (resolvedAt/startedAt/createdAt) in detail API"
```

---

### Task 2: Absolute date helper

**Files:**
- Create: `packages/web/src/lib/format-date.ts`
- Test: `packages/web/tests/lib/format-date.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/lib/format-date.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatMatchTime } from "../../src/lib/format-date";

describe("formatMatchTime", () => {
  it("formats an ISO timestamp as an absolute month/day/time string", () => {
    const out = formatMatchTime("2026-05-18T14:30:00Z", { locale: "en-US", timeZone: "UTC" });
    expect(out).toBe("May 18, 14:30");
  });

  it("returns an empty string for null/empty input", () => {
    expect(formatMatchTime(null)).toBe("");
    expect(formatMatchTime("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/lib/format-date.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — cannot find module `../../src/lib/format-date`.

- [ ] **Step 3: Implement the helper**

Create `packages/web/src/lib/format-date.ts`:

```ts
export function formatMatchTime(
  iso: string | null | undefined,
  opts?: { locale?: string; timeZone?: string },
): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(opts?.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: opts?.timeZone,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/lib/format-date.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/format-date.ts packages/web/tests/lib/format-date.test.ts
git commit -m "feat(web): add formatMatchTime absolute-date helper"
```

---

### Task 3: Host Controls card (restore Cancel for active tournaments)

**Files:**
- Create: `packages/web/src/components/tournament/overview-host-controls.tsx`
- Test: `packages/web/tests/components/overview-host-controls.test.tsx`

This mirrors the inline-confirm Cancel pattern from `tournament-lobby.tsx:84-100` (handler) and `:371-404` (UI), adapted to redirect to `/tournaments` on success.

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/components/overview-host-controls.test.tsx`:

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

describe("OverviewHostControls", () => {
  it("requires inline confirmation, calls DELETE, then redirects to /tournaments", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 1, status: "cancelled" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewHostControls tournamentSlug="goat-cup" />);

    // First click reveals the confirm row, does NOT call fetch yet.
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

    render(<OverviewHostControls tournamentSlug="goat-cup" />);
    fireEvent.click(screen.getByRole("button", { name: /cancel tournament/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText(/only the tournament creator can cancel it/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/overview-host-controls.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — cannot find module `overview-host-controls`.

- [ ] **Step 3: Implement the component**

Create `packages/web/src/components/tournament/overview-host-controls.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function OverviewHostControls({ tournamentSlug }: { tournamentSlug: string }) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      {showConfirm ? (
        <div className="flex flex-col gap-3 rounded-lg border border-accent-cta/40 bg-accent-cta/5 px-4 py-3 text-sm">
          <span className="text-text-secondary">
            Cancel this tournament? Players will be notified and standings will be frozen. This cannot be undone.
          </span>
          <div className="flex items-center gap-3">
            <Button variant="danger" size="md" loading={loading} onClick={handleCancel}>
              Yes, cancel
            </Button>
            <button
              type="button"
              className="inline-flex min-h-[44px] items-center px-2 text-text-secondary hover:text-text-primary"
              onClick={() => setShowConfirm(false)}
            >
              Go back
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          className="inline-flex min-h-[44px] items-center gap-1.5 py-2 text-sm text-text-secondary motion-safe:transition-colors hover:text-accent-cta"
        >
          <X className="h-4 w-4" />
          Cancel tournament
        </button>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/overview-host-controls.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/overview-host-controls.tsx packages/web/tests/components/overview-host-controls.test.tsx
git commit -m "feat(web): organizer Host Controls card to cancel an active tournament"
```

---

### Task 4: Progress card (extract, preserve test-critical strings)

**Files:**
- Create: `packages/web/src/components/tournament/overview-progress.tsx`

No new test file — coverage comes from the existing `tournament-detail-page.test.tsx:185-195`, which Task 9 keeps green. This task just extracts the markup so the orchestrator stays readable.

- [ ] **Step 1: Implement the component**

Create `packages/web/src/components/tournament/overview-progress.tsx`. The label logic and exact strings are copied verbatim from the current `overview-tab.tsx:66-91`:

```tsx
import type { TournamentDetail } from "./types";

export function OverviewProgress({ tournament }: { tournament: TournamentDetail }) {
  const allRounds = tournament.matches.map((m) => m.roundNumber);
  const maxRound = allRounds.length > 0 ? Math.max(...allRounds) : 0;
  const completedMatches = tournament.matches.filter((m) => m.status === "completed").length;
  const totalMatches = tournament.matches.length;

  // Round numbers are a real, sequential bracket concept only for single elimination.
  // For round-robin all rounds are generated up front and played in any order, so the
  // "current round" is a meaningless scheduling artifact — show progress only.
  const roundsAreMeaningful = tournament.format === "single_elim";
  const incompleteRounds = tournament.matches
    .filter((m) => m.status !== "completed")
    .map((m) => m.roundNumber);
  const currentRound = incompleteRounds.length > 0 ? Math.min(...incompleteRounds) : maxRound;

  if (totalMatches === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
        Progress
      </h2>
      <p className="text-sm text-text-secondary">
        {roundsAreMeaningful && maxRound > 0 ? (
          <>
            <span className="font-semibold text-text-primary">
              Round {currentRound} of {maxRound}
            </span>
            {" · "}
            {completedMatches}/{totalMatches} matches done
          </>
        ) : (
          <span className="font-semibold text-text-primary">
            {completedMatches}/{totalMatches} matches done
          </span>
        )}
      </p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-deep">
        <div
          className="h-full bg-accent-primary motion-safe:transition-all motion-safe:duration-300"
          style={{ width: `${(completedMatches / totalMatches) * 100}%` }}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/tournament/overview-progress.tsx
git commit -m "refactor(web): extract OverviewProgress card from overview-tab"
```

---

### Task 5: Recent Results card

**Files:**
- Create: `packages/web/src/components/tournament/overview-recent-results.tsx`
- Test: `packages/web/tests/components/overview-recent-results.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/components/overview-recent-results.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewRecentResults } from "../../src/components/tournament/overview-recent-results";
import type { Match } from "../../src/components/tournament/types";

function match(over: Partial<Match>): Match {
  return {
    id: 1,
    matchId: 1,
    roundNumber: 1,
    playerOneId: 11,
    playerTwoId: 22,
    playerOneName: "Alice",
    playerTwoName: "Bob",
    status: "completed",
    winnerId: 11,
    reporterId: null,
    resolvedAt: null,
    metadata: {},
    ...over,
  };
}

describe("OverviewRecentResults", () => {
  it("renders an empty state when there are no completed matches", () => {
    render(<OverviewRecentResults matches={[match({ status: "open", winnerId: null })]} />);
    expect(screen.getByText(/no results yet/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows '<winner> def. <loser>' newest-first and caps at 5", () => {
    const matches: Match[] = [
      match({ id: 1, winnerId: 11, resolvedAt: "2026-05-01T10:00:00Z" }),
      match({ id: 2, winnerId: 22, resolvedAt: "2026-05-03T10:00:00Z" }),
      match({ id: 3, winnerId: 11, resolvedAt: "2026-05-02T10:00:00Z" }),
    ];
    render(<OverviewRecentResults matches={matches} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // newest (id:2, 05-03) first → "Bob def. Alice"
    expect(items[0]).toHaveTextContent(/bob\s+def\.\s+alice/i);
    expect(items[1]).toHaveTextContent(/alice\s+def\.\s+bob/i); // id:3, 05-02
  });

  it("ignores non-completed and winner-less matches", () => {
    const matches: Match[] = [
      match({ id: 1, status: "open", winnerId: null }),
      match({ id: 2, status: "completed", winnerId: 22, resolvedAt: "2026-05-03T10:00:00Z" }),
    ];
    render(<OverviewRecentResults matches={matches} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/overview-recent-results.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — cannot find module `overview-recent-results`.

- [ ] **Step 3: Implement the component**

Create `packages/web/src/components/tournament/overview-recent-results.tsx`. Note the round label uses `R{n}` (NOT "Round {n} of {m}") so it never collides with the round-robin assertion `queryByText(/round \d+ of \d+/i)` in the page integration test.

```tsx
import { History } from "lucide-react";
import { formatMatchTime } from "@/lib/format-date";
import type { Match } from "./types";

export function OverviewRecentResults({ matches }: { matches: Match[] }) {
  const completed = matches
    .filter((m) => m.status === "completed" && m.winnerId != null)
    .sort((a, b) => {
      const ta = a.resolvedAt ? Date.parse(a.resolvedAt) : 0;
      const tb = b.resolvedAt ? Date.parse(b.resolvedAt) : 0;
      return tb - ta;
    })
    .slice(0, 5);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4 text-text-secondary" />
        <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
          Recent results
        </h2>
      </div>
      {completed.length === 0 ? (
        <p className="text-sm text-text-muted">No results yet — completed matches will show up here.</p>
      ) : (
        <ul className="space-y-2">
          {completed.map((m) => {
            const winnerName = m.winnerId === m.playerOneId ? m.playerOneName : m.playerTwoName;
            const loserName = m.winnerId === m.playerOneId ? m.playerTwoName : m.playerOneName;
            const when = formatMatchTime(m.resolvedAt);
            return (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 border-t border-border pt-2 text-sm first:border-t-0 first:pt-0"
              >
                <span className="min-w-0 truncate text-text-primary">
                  <span className="font-semibold text-accent-success">{winnerName}</span>
                  <span className="text-text-muted"> def. </span>
                  <span className="text-text-secondary">{loserName ?? "—"}</span>
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                  R{m.roundNumber}
                  {when ? ` · ${when}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/overview-recent-results.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/overview-recent-results.tsx packages/web/tests/components/overview-recent-results.test.tsx
git commit -m "feat(web): Recent Results card for the tournament Overview tab"
```

---

### Task 6: Standings card (extract with podium icons)

**Files:**
- Create: `packages/web/src/components/tournament/overview-standings.tsx`

Extracted from the current `overview-tab.tsx:94-147`. Adds a rank glyph so first/second/third are distinguishable by *more than color* (accessibility: color is not the only signal). Keeps its own standings fetch (the orchestrator passes the slug + the "see full standings" callback).

- [ ] **Step 1: Implement the component**

Create `packages/web/src/components/tournament/overview-standings.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { StandingsRow } from "./types";

function rankGlyph(index: number): string {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return `${index + 1}`;
}

export function OverviewStandings({
  tournamentSlug,
  currentUserPlayerId,
  onGoToStandings,
}: {
  tournamentSlug: string;
  currentUserPlayerId: number | null;
  onGoToStandings: () => void;
}) {
  const [standings, setStandings] = useState<StandingsRow[] | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/tournaments/${tournamentSlug}/standings`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: StandingsRow[]) => {
        if (active) setStandings(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [tournamentSlug]);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
          Top standings
        </h2>
        <button
          type="button"
          onClick={onGoToStandings}
          className="inline-flex min-h-[44px] items-center gap-1 py-2 text-xs text-accent-primary hover:underline"
        >
          See full standings
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {standings === null ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-bg-deep" />
          ))}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="py-1">#</th>
              <th>Player</th>
              <th className="text-right">W</th>
              <th className="text-right">L</th>
            </tr>
          </thead>
          <tbody>
            {standings.slice(0, 3).map((r, i) => (
              <tr key={r.playerId} className="border-t border-border">
                <td className="py-1.5 font-mono text-text-muted">{rankGlyph(i)}</td>
                <td
                  className={`max-w-0 truncate ${
                    r.playerId === currentUserPlayerId
                      ? "font-semibold text-accent-primary"
                      : "text-text-primary"
                  }`}
                  title={r.displayName}
                >
                  {r.displayName}
                </td>
                <td className="w-8 text-right tabular-nums text-accent-success">{r.wins}</td>
                <td className="w-8 text-right tabular-nums text-text-secondary">{r.losses}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/tournament/overview-standings.tsx
git commit -m "refactor(web): extract OverviewStandings card with podium rank glyphs"
```

---

### Task 7: Tournament Info card

**Files:**
- Create: `packages/web/src/components/tournament/overview-info.tsx`

- [ ] **Step 1: Implement the component**

Create `packages/web/src/components/tournament/overview-info.tsx`:

```tsx
import { formatMatchTime } from "@/lib/format-date";
import type { TournamentDetail } from "./types";

function formatLabel(format: string): string {
  if (format === "round_robin") return "Round Robin";
  if (format === "single_elim") return "Single Elimination";
  return format;
}

export function OverviewInfo({ tournament }: { tournament: TournamentDetail }) {
  const started = formatMatchTime(tournament.startedAt);
  const rows: Array<{ label: string; value: string }> = [
    { label: "Format", value: formatLabel(tournament.format) },
    { label: "Started", value: started || "—" },
    { label: "Players", value: String(tournament.participants.length) },
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
        Details
      </h2>
      <dl className="space-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3">
            <dt className="text-text-muted">{row.label}</dt>
            <dd className="text-text-primary">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/tournament/overview-info.tsx
git commit -m "feat(web): tournament Details/Info card for Overview tab"
```

---

### Task 8: Rework `overview-tab.tsx` into a 2-column orchestrator

**Files:**
- Modify (full rewrite): `packages/web/src/components/tournament/overview-tab.tsx`

The orchestrator now composes the extracted/new cards. Left column (main) holds the action card + recent results; the right rail holds progress, standings, details, settings (organizer), and host controls (organizer). On mobile everything stacks. The component signature is unchanged so `page.tsx:137-148` needs no edits.

- [ ] **Step 1: Replace the file contents**

Overwrite `packages/web/src/components/tournament/overview-tab.tsx` with:

```tsx
"use client";

import { YourActionCard } from "./your-action-card";
import { TournamentSettingsForm } from "./tournament-settings-form";
import { OverviewProgress } from "./overview-progress";
import { OverviewRecentResults } from "./overview-recent-results";
import { OverviewStandings } from "./overview-standings";
import { OverviewInfo } from "./overview-info";
import { OverviewHostControls } from "./overview-host-controls";
import { deriveMyMatches } from "./use-my-matches";
import type { TournamentDetail } from "./types";

export function OverviewTab({
  tournament,
  tournamentSlug,
  isHost,
  currentUserPlayerId,
  onChanged,
  onGoToStandings,
}: {
  tournament: TournamentDetail;
  tournamentSlug: string;
  isHost: boolean;
  currentUserPlayerId: number | null;
  onChanged: () => void;
  onGoToStandings: () => void;
}) {
  const isActive = tournament.status === "active";
  const { actionMatch } = deriveMyMatches(tournament);
  const showActionCard = isActive && tournament.isParticipant;

  if (!isActive) {
    // Non-active overview is never reached today (page only mounts Overview for
    // active tournaments), but guard so the component is safe in isolation.
    return (
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5 lg:col-start-8">
          <OverviewInfo tournament={tournament} />
        </div>
      </div>
    );
  }

  // Mobile-first: everything is a full-width column by default. Progress and the
  // action card span full width at the top so they read first on mobile; at lg the
  // secondary cards drop into a right rail. Source order == mobile priority.
  return (
    <div className="space-y-6">
      {showActionCard && (
        <YourActionCard
          actionMatch={actionMatch}
          tournamentSlug={tournamentSlug}
          tournamentFormat={tournament.format}
          currentUserPlayerId={currentUserPlayerId}
          onChanged={onChanged}
        />
      )}
      <OverviewProgress tournament={tournament} />

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-7">
          <OverviewStandings
            tournamentSlug={tournamentSlug}
            currentUserPlayerId={currentUserPlayerId}
            onGoToStandings={onGoToStandings}
          />
          <OverviewRecentResults matches={tournament.matches} />
        </div>

        <aside className="space-y-6 lg:col-span-5">
          <OverviewInfo tournament={tournament} />
          {isHost && (
            <TournamentSettingsForm
              tournamentSlug={tournamentSlug}
              initialDeadlineAt={tournament.deadlineAt}
              initialReportConfirmWindowHours={tournament.reportConfirmWindowHours}
              onSaved={onChanged}
            />
          )}
          {isHost && <OverviewHostControls tournamentSlug={tournamentSlug} />}
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run the page integration test to verify nothing regressed**

Run: `npx vitest run packages/web/tests/components/tournament-detail-page.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS — including `round-robin overview shows match progress but NOT a round number` and `single-elim overview still shows the current round`. (The Progress card preserves the exact strings; Recent Results uses `R{n}`, which does not match `/round \d+ of \d+/i`.)

> If the round-robin test now fails on `queryByText(/round \d+ of \d+/i)`, the regression is almost certainly a stray "Round N of M" string — re-check `overview-recent-results.tsx` uses `R{n}`.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/tournament/overview-tab.tsx
git commit -m "feat(web): 2-column Overview dashboard composing progress/results/standings/info/host controls"
```

---

### Task 9: Extend the page integration test for Recent Results + Cancel visibility

**Files:**
- Modify: `packages/web/tests/components/tournament-detail-page.test.tsx`

Locks in two behaviors end-to-end: (a) Recent Results renders completed matches on the active Overview, and (b) the organizer sees the Cancel control on an *active* tournament (the regression we fixed).

- [ ] **Step 1: Add the test cases**

Append inside the `describe("TournamentDetailPage (tabbed integration)", ...)` block:

```tsx
  it("active overview shows Recent Results for completed matches", async () => {
    renderPage(roundRobinTournament);
    expect(await screen.findByText(/recent results/i)).toBeInTheDocument();
    // round-robin fixture has two completed matches → at least one "def." line
    expect(screen.getAllByText(/def\./i).length).toBeGreaterThan(0);
  });

  it("organizer can cancel an ACTIVE tournament from the Overview", async () => {
    // tournament fixture: status active, createdByUserId 'user-1' === session user.
    searchParams = new URLSearchParams("tab=overview");
    vi.stubGlobal("fetch", stubFetch());

    render(<TournamentDetailPage />);

    expect(await screen.findByRole("button", { name: /cancel tournament/i })).toBeInTheDocument();
  });
```

> Fixture note: the default `tournament` fixture and `roundRobinTournament` do not include `resolvedAt`/`startedAt`/`createdAt` keys. That is fine — `formatMatchTime(undefined)` returns `""`, Recent Results still renders the "def." lines, and the Info card shows "—" for Started. No fixture edits are required for these assertions. (Optionally add `resolvedAt: null, startedAt: null, createdAt: "..."` to fixtures for realism, but not required.)

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/tournament-detail-page.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (all cases, old and new).

- [ ] **Step 3: Commit**

```bash
git add packages/web/tests/components/tournament-detail-page.test.tsx
git commit -m "test(web): cover Recent Results + active-tournament Cancel on Overview"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 2: Run the full web test suite**

Run: `npm test --workspace=packages/web`
Expected: all files pass (baseline was 328 passing; new tests add to that).

- [ ] **Step 3: Build web**

Run: `npm run build --workspace=packages/web`
Expected: successful production build (catches App Router / RSC boundary issues the unit tests miss).

- [ ] **Step 4: Manual UI verification**

Start the dev stack (`npm run dev:web`, plus bot/ws if testing the cancel WS broadcast end-to-end), then as the organizer of an **active** tournament:
1. Open the tournament → Overview tab. Confirm the 2-column layout, Progress, Top Standings (with 🥇/🥈/🥉), Recent Results (absolute timestamps), and Details cards render.
2. Resize to mobile width → confirm cards stack in a single column.
3. Click **Cancel tournament** → confirm inline confirm appears, no request fired yet.
4. Click **Yes, cancel** → confirm redirect to `/tournaments` and the tournament now shows `cancelled`.
5. As a non-organizer, confirm **Host controls** / Cancel is not visible.

- [ ] **Step 5: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "chore(web): tournament overview redesign + active cancel verification fixes"
```

---

## Self-Review

**1. Spec coverage**
- Restore Cancel for active tournaments → Task 3 (component) + Task 8 (wired into rail, organizer-only) + Task 9 (integration assertion). Backend already supports active cancel (`route.ts:163` rejects only completed/cancelled), so no API change needed for cancel. ✓
- Redesign sparse Overview → Tasks 4-8 (Progress, Recent Results, Standings, Info, 2-col orchestrator). ✓
- Absolute timestamps → Task 2 helper + used in Recent Results (Task 5) and Info (Task 7). ✓
- Preserve test-critical strings → Task 4 keeps "matches done" / "Round X of Y"; Task 8 Step 2 verifies. ✓

**2. Placeholder scan** — no TBD/TODO/"handle edge cases"; every code step has full code. ✓

**3. Type consistency** — `Match.resolvedAt: string | null`, `TournamentDetail.startedAt: string | null`, `TournamentDetail.createdAt: string` defined in Task 1 and consumed consistently in Tasks 5/7. `formatMatchTime(iso: string | null | undefined)` accepts the nullable fields. `OverviewTab` prop signature unchanged, so `page.tsx` needs no edits. Component names match across tasks (`OverviewProgress`, `OverviewRecentResults`, `OverviewStandings`, `OverviewInfo`, `OverviewHostControls`). ✓

## Risks / things to watch

- **`matches` insert columns (Task 1 test):** verify against `schema.ts` ~lines 140-148 before running; add any other NOT-NULL-without-default columns to the seed insert.
- **Locale-dependent date formatting:** `formatMatchTime` is tested with explicit `locale`/`timeZone`; production uses the browser locale. Manual step 4.1 confirms real output.
- **Standings fetch in isolation:** `OverviewStandings` fetches on mount; in the page integration test the stub returns `[]` for unmatched URLs, so it renders an empty table (no crash).
