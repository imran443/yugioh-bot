# Tournament & Scoring Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface completed tournaments in the web list, and attribute each match-win point award to its tournament so the recent-activity feed can show whether a win came from a casual match or a tournament.

**Architecture:** Two independent fixes. (1) Pure web change: relax the tournaments-list query to include `completed` and render a separate "Completed" section. (2) Vertical slice across `@yugidraft/shared` and web: stamp `tournament_id` onto `match_win` rows in `point_awards` at write time, backfill existing rows via an idempotent startup migration, and update the profile recent-activity label (the read query already joins `tournaments`).

**Tech Stack:** Next.js 16 App Router (server components + route handlers), better-sqlite3, Vitest, `@yugidraft/shared` services.

**Covers:** Task #7 (issue: Tournament — show Completed in web list) and Task #8 (issue: Recent activity — show match/tournament source).

---

### Task 1: Show completed tournaments in the web list

**Decision:** Separate "Completed" section below Active and Pending (chosen). `cancelled` stays hidden.

**Files:**
- Modify: `packages/web/app/api/tournaments/route.ts:14-45` (GET query)
- Modify: `packages/web/app/(app)/tournaments/page.tsx:13-37` (query + add Completed section)
- Test: `packages/web/tests/tournaments-list-route.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/tournaments-list-route.test.ts` (modeled on `tournaments-slug-route.test.ts`'s temp-sqlite harness; the GET handler takes no args and has no auth gate):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

async function setupDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-tournaments-list-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  const ins = db.prepare(
    `insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug)
     values ('guild-1', ?, 'round_robin', ?, 'host', ?)`,
  );
  ins.run("Active Cup", "active", "slug-a");
  ins.run("Pending Cup", "pending", "slug-p");
  ins.run("Done Cup", "completed", "slug-c");
  ins.run("Aborted Cup", "cancelled", "slug-x");
  db.close();
}

describe("GET /api/tournaments includes completed", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns pending, active, and completed but not cancelled", async () => {
    await setupDb();
    const { GET } = await import("../app/api/tournaments/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ name: string; status: string }>;
    const byStatus = Object.fromEntries(json.map((t) => [t.status, t.name]));
    expect(byStatus.active).toBe("Active Cup");
    expect(byStatus.pending).toBe("Pending Cup");
    expect(byStatus.completed).toBe("Done Cup");
    expect(json.some((t) => t.status === "cancelled")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/tournaments-list-route.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — `byStatus.completed` is `undefined` (completed rows excluded by the current `in ('pending', 'active')` filter).

- [ ] **Step 3: Update the API route query**

In `packages/web/app/api/tournaments/route.ts`, change the WHERE/ORDER (lines 28-33):

```ts
        from tournaments t
        left join tournament_participants tp on tp.tournament_id = t.id
        where t.status in ('pending', 'active', 'completed')
        group by t.id
        order by
          case t.status when 'active' then 0 when 'pending' then 1 else 2 end,
          t.created_at desc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/tournaments-list-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Mirror the query in the page and add the Completed section**

In `packages/web/app/(app)/tournaments/page.tsx`, change the WHERE/ORDER (lines 19-21) to match Step 3:

```ts
       where t.status in ('pending', 'active', 'completed')
       group by t.id
       order by case t.status when 'active' then 0 when 'pending' then 1 else 2 end, t.created_at desc`
```

Add a completed slice next to the existing ones (after line 36):

```ts
  const completed = tournaments.filter((t) => t.status === "completed");
```

Add a Completed `<section>` after the Pending section (after line 78, inside the `space-y-8` div):

```tsx
          {completed.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-text-muted">Completed</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {completed.map((t) => (
                  <TournamentCard key={t.id} tournament={t} />
                ))}
              </div>
            </section>
          )}
```

- [ ] **Step 6: Verify the page in the browser**

Run `npm run dev:web`, visit `/tournaments`. Confirm: Active and Pending appear as before; a Completed section lists completed tournaments; cancelled tournaments do not appear. (Server-component query — not unit-tested; the route test in Step 1 covers the equivalent SQL.)

- [ ] **Step 7: Commit**

```bash
git add packages/web/app/api/tournaments/route.ts "packages/web/app/(app)/tournaments/page.tsx" packages/web/tests/tournaments-list-route.test.ts
git commit -m "feat(web): show completed tournaments in a separate list section"
```

---

### Task 2: Stamp tournament_id onto match-win awards at write time

**Files:**
- Modify: `packages/shared/src/services/scoring.ts:143-146` (the `match_win` insert, inside `recordMatchResult`)
- Test: `packages/shared/tests/services/scoring-match.test.ts` (add cases; reuses the file's existing `setup()` and `approvedMatch()` helpers)

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/tests/services/scoring-match.test.ts` inside the `describe("scoring.recordMatchResult", ...)` block:

```ts
  it("tags a tournament match win with its tournament_id", () => {
    const { db, scoring, p1, p2 } = setup();
    const tournamentId = Number(
      db
        .prepare(
          "insert into tournaments (guild_id, name, format, status, created_by_user_id) values ('g1','Cup','round_robin','active','host')",
        )
        .run().lastInsertRowid,
    );
    const matchId = approvedMatch(db, p1, p2, p1);
    db.prepare(
      `insert into tournament_matches (tournament_id, match_id, player_one_id, player_two_id, round_number, status)
       values (?, ?, ?, ?, 1, 'completed')`,
    ).run(tournamentId, matchId, p1, p2);

    scoring.recordMatchResult(matchId);

    const award = db
      .prepare("select tournament_id from point_awards where match_id = ? and kind = 'match_win'")
      .get(matchId) as { tournament_id: number | null };
    expect(award.tournament_id).toBe(tournamentId);
  });

  it("leaves tournament_id null for a casual match win", () => {
    const { db, scoring, p1, p2 } = setup();
    const matchId = approvedMatch(db, p1, p2, p1);
    scoring.recordMatchResult(matchId);
    const award = db
      .prepare("select tournament_id from point_awards where match_id = ? and kind = 'match_win'")
      .get(matchId) as { tournament_id: number | null };
    expect(award.tournament_id).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared/tests/services/scoring-match.test.ts`
Expected: FAIL — the first new test gets `null` (the insert never sets `tournament_id`).

- [ ] **Step 3: Look up the tournament and include it in the insert**

In `packages/shared/src/services/scoring.ts`, inside `recordMatchResult`'s transaction, just before the `insert into point_awards` (currently line 143), add:

```ts
      const tm = db
        .prepare("select tournament_id from tournament_matches where match_id = ?")
        .get(matchId) as { tournament_id: number } | undefined;
```

Then change the insert (lines 143-146) to include `tournament_id`:

```ts
      db.prepare(
        `insert into point_awards (guild_id, season_id, player_id, kind, match_id, tournament_id, points, opponent_elo)
         values (?, ?, ?, 'match_win', ?, ?, ?, ?)`,
      ).run(guildId, season.id, winnerId, matchId, tm?.tournament_id ?? null, points, loserElo);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/shared/tests/services/scoring-match.test.ts`
Expected: PASS (both new tests and all existing ones — the idempotency test still sees exactly one award).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/scoring.ts packages/shared/tests/services/scoring-match.test.ts
git commit -m "feat(shared): record tournament_id on tournament match-win awards"
```

---

### Task 3: Backfill tournament_id on existing match-win awards

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (add an idempotent backfill UPDATE at the end of `migrate(db)`, after all `create table` blocks and `addColumnIfMissing` calls)
- Test: `packages/shared/tests/db/schema.test.ts` (add case)

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/tests/db/schema.test.ts` (it already imports `Database` from `better-sqlite3` and `migrate` from `../../src/db/index.js`; if not, add those imports):

```ts
import Database from "better-sqlite3";
import { migrate } from "../../src/db/index.js";

describe("migrate backfills match-win tournament_id", () => {
  it("sets tournament_id on legacy match_win awards that belong to a tournament match", () => {
    const db = new Database(":memory:");
    migrate(db);
    const guild = "g1";
    const seasonId = Number(
      db.prepare("insert into seasons (guild_id, number, status) values (?, 1, 'active')").run(guild).lastInsertRowid,
    );
    const p1 = Number(
      db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, 'u1', 'A')").run(guild).lastInsertRowid,
    );
    const p2 = Number(
      db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, 'u2', 'B')").run(guild).lastInsertRowid,
    );
    const matchId = Number(
      db
        .prepare(
          "insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source) values (?, ?, ?, ?, ?, 'approved', 'tournament')",
        )
        .run(guild, p1, p2, p1, p1).lastInsertRowid,
    );
    const tournamentId = Number(
      db
        .prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id) values (?, 'Cup', 'round_robin', 'completed', 'host')")
        .run(guild).lastInsertRowid,
    );
    db.prepare(
      "insert into tournament_matches (tournament_id, match_id, player_one_id, player_two_id, round_number, status) values (?, ?, ?, ?, 1, 'completed')",
    ).run(tournamentId, matchId, p1, p2);
    // Legacy award written before tournament_id was stamped.
    db.prepare(
      "insert into point_awards (guild_id, season_id, player_id, kind, match_id, points) values (?, ?, ?, 'match_win', ?, 5)",
    ).run(guild, seasonId, p1, matchId);

    migrate(db); // re-run: the idempotent backfill runs every startup

    const award = db.prepare("select tournament_id from point_awards where match_id = ?").get(matchId) as {
      tournament_id: number | null;
    };
    expect(award.tournament_id).toBe(tournamentId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts`
Expected: FAIL — `award.tournament_id` is `null` (no backfill yet).

- [ ] **Step 3: Add the idempotent backfill to migrate()**

In `packages/shared/src/db/schema.ts`, at the end of `migrate(db)` (after the last table/column setup, so `point_awards` and `tournament_matches` both exist), add:

```ts
  // Backfill tournament_id on match-win awards whose match belongs to a
  // tournament. Idempotent: the `tournament_id is null` guard means already
  // stamped rows are skipped, so this is safe to run on every startup.
  db.exec(`
    update point_awards
    set tournament_id = (
      select tm.tournament_id from tournament_matches tm where tm.match_id = point_awards.match_id
    )
    where kind = 'match_win'
      and tournament_id is null
      and match_id is not null
      and exists (select 1 from tournament_matches tm where tm.match_id = point_awards.match_id);
  `);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/tests/db/schema.test.ts
git commit -m "feat(shared): backfill tournament_id on existing match-win awards"
```

---

### Task 4: Label match wins by source in Recent Activity

**Context:** `getProfile` (`scoring.ts:262-266`) already selects `tournament_id` and `t.name as tournament_name` via `left join tournaments`. With Tasks 2–3, `match_win` rows now carry `tournament_id`, so `tournament_name` is populated for tournament wins. Only the label logic in the UI needs to change. Extract it as a pure helper so it can be unit-tested without a DOM.

**Files:**
- Create: `packages/web/src/lib/recent-activity.ts`
- Modify: `packages/web/src/components/player/profile-view.tsx:270-273` (use the helper)
- Test: `packages/web/tests/recent-activity.test.ts` (create, pure unit)

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/recent-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { recentActivityLabel } from "../src/lib/recent-activity";

describe("recentActivityLabel", () => {
  it("labels a tournament match win with the tournament name", () => {
    expect(recentActivityLabel({ kind: "match_win", tournament_name: "Spring Slam" })).toBe(
      "Match win · Spring Slam",
    );
  });

  it("labels a casual match win", () => {
    expect(recentActivityLabel({ kind: "match_win", tournament_name: null })).toBe("Match win · Casual");
  });

  it("labels a placement with the tournament name", () => {
    expect(recentActivityLabel({ kind: "placement", tournament_name: "Winter Cup" })).toBe("Winter Cup");
  });

  it("falls back when a placement has no tournament name", () => {
    expect(recentActivityLabel({ kind: "placement", tournament_name: null })).toBe("Tournament placement");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/recent-activity.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — module `../src/lib/recent-activity` does not exist.

- [ ] **Step 3: Create the helper**

Create `packages/web/src/lib/recent-activity.ts`:

```ts
export interface RecentEntry {
  kind: string;
  tournament_name: string | null;
}

export function recentActivityLabel(entry: RecentEntry): string {
  if (entry.kind === "placement") {
    return entry.tournament_name ?? "Tournament placement";
  }
  return entry.tournament_name ? `Match win · ${entry.tournament_name}` : "Match win · Casual";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/recent-activity.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Use the helper in the profile view**

In `packages/web/src/components/player/profile-view.tsx`, add the import near the top:

```ts
import { recentActivityLabel } from "@/lib/recent-activity";
```

Replace the inline `label` computation (lines 270-273) with:

```ts
              const label = recentActivityLabel(entry);
```

(`entry` already has `kind` and `tournament_name` in the destructured type at lines 263-269 — no shape change needed.)

- [ ] **Step 6: Run the web suite for regressions**

Run: `npm test --workspace=packages/web`
Expected: PASS (the profile-view render is unchanged except the label string).

- [ ] **Step 7: Verify in the browser**

Run `npm run dev:web`, open a player profile with both a tournament match win and a casual win in Recent Activity. Confirm the tournament win reads `Match win · <tournament>` and the casual win reads `Match win · Casual`.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/lib/recent-activity.ts packages/web/src/components/player/profile-view.tsx packages/web/tests/recent-activity.test.ts
git commit -m "feat(web): label recent activity by match vs tournament source"
```

---

## Self-Review

**Spec coverage:**
- Task #7 (completed tournaments in list) → Task 1 (API query + page section + route test). ✓
- Task #8 (recent activity match/tournament source) → Task 2 (write-time stamp), Task 3 (backfill), Task 4 (UI label). ✓

**Placeholder scan:** No TBDs; every code/test step has full content and an exact command. ✓

**Type consistency:** `recentActivityLabel(entry: RecentEntry)` used identically in test and `profile-view.tsx`; the `point_awards` insert column list matches the schema at `schema.ts:330-343` (adds `tournament_id`, an existing nullable column). ✓

**Note for executor:** If the pack-variety plan (`2026-05-24-pack-variety.md`) lands first, none of these tasks conflict with it — they touch `scoring.ts`, the tournaments query, `profile-view.tsx`, and a `point_awards` backfill, none of which the pack-variety rename touches.
