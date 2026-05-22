# Tournament Timing & Report Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make async multi-day tournaments finish by auto-approving stale match reports in the reporter's favor and auto-closing tournaments past an optional deadline, both driven by one new 60s bot poller.

**Architecture:** Two nullable config columns on `tournaments` (`deadline_at`, `report_confirm_window_hours`). New shared service functions (`matches.autoApprove`, `matches.findOverduePendingConfirmations`, `tournaments.updateSettings`, `tournaments.closeForDeadline`, `tournaments.findOverdueActive`) reuse the existing `completeTournamentMatch` / completion-announce / ws-notify paths. A new `tournament-timer.ts` bot poller mirrors `draft-timer.ts`. Web (create form + host edit) and bot (`/event create` options) surface the two config values.

**Tech Stack:** TypeScript, better-sqlite3, discord.js, Next.js 16 App Router, vitest. npm workspaces + Turborepo.

**Execution grouping (for parallelism):**
- **Group S — shared foundation (Tasks 1–4):** must complete and commit FIRST. All later tasks import from `@yugidraft/shared`.
- **Group B — bot (Tasks 5–7)** and **Group W — web (Tasks 8–10):** independent of each other (disjoint packages), may run in parallel after Group S. Each commits only its own package's paths.
- **Task 11 — verification:** after all groups land.

**Source of truth for the default window:** a single shared constant `DEFAULT_REPORT_CONFIRM_HOURS = 24` (Task 3). The SQL in Task 4 interpolates this numeric constant so the literal can't drift.

---

## Task 1: Schema columns + migration test

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (after line 256, the `completed_announced_at` add)
- Test: `packages/bot/tests/db/shared-db.test.ts` (column-presence assertions)

- [ ] **Step 1: Write the failing test**

In `packages/bot/tests/db/shared-db.test.ts`, find the test that inspects the `tournaments` table columns (search for `table_info(tournaments)` or an existing tournaments column assertion). Add assertions that the two new columns exist. If there is no such test, add this one:

```ts
it("adds tournament timing columns", () => {
  const db = new Database(":memory:");
  migrate(db);
  const cols = (db.pragma("table_info(tournaments)") as Array<{ name: string }>).map((c) => c.name);
  expect(cols).toContain("deadline_at");
  expect(cols).toContain("report_confirm_window_hours");
  db.close();
});
```

(Reuse the file's existing `Database` import and `migrate` import; mirror an existing test's setup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/bot/tests/db/shared-db.test.ts`
Expected: FAIL — `cols` does not contain `deadline_at`.

- [ ] **Step 3: Add the migration columns**

In `packages/shared/src/db/schema.ts`, immediately after this existing line (256):

```ts
  addColumnIfMissing(db, "tournaments", "completed_announced_at", "text");
```

add:

```ts
  addColumnIfMissing(db, "tournaments", "deadline_at", "text");
  addColumnIfMissing(db, "tournaments", "report_confirm_window_hours", "integer");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/bot/tests/db/shared-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/bot/tests/db/shared-db.test.ts
git commit -m "feat(shared): add tournaments.deadline_at and report_confirm_window_hours columns"
```

---

## Task 2: Tournament type + mapTournament

**Files:**
- Modify: `packages/shared/src/types/index.ts` (Tournament interface, lines 66-74)
- Modify: `packages/shared/src/services/tournaments.ts` (`mapTournament`, lines 27-37)
- Test: covered by Task 3's service tests (no standalone test here — this is a type/mapper change exercised by Task 3).

- [ ] **Step 1: Extend the Tournament interface**

In `packages/shared/src/types/index.ts`, replace the `Tournament` interface (lines 66-74) with:

```ts
export interface Tournament {
  id: number;
  guildId: string;
  name: string;
  format: "round_robin" | "single_elim";
  status: "pending" | "active" | "cancelled" | "completed";
  createdByUserId: string;
  webSlug?: string;
  deadlineAt?: string; // ISO timestamp; undefined = no deadline
  reportConfirmWindowHours?: number; // undefined = use DEFAULT_REPORT_CONFIRM_HOURS
}
```

- [ ] **Step 2: Map the new columns**

In `packages/shared/src/services/tournaments.ts`, replace `mapTournament` (lines 27-37) with:

```ts
function mapTournament(row: any): Tournament {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    format: row.format,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    webSlug: row.web_slug ?? undefined,
    deadlineAt: row.deadline_at ?? undefined,
    reportConfirmWindowHours: row.report_confirm_window_hours ?? undefined,
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=packages/shared`
Expected: PASS (no consumers break — both fields optional).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/index.ts packages/shared/src/services/tournaments.ts
git commit -m "feat(shared): expose deadlineAt and reportConfirmWindowHours on Tournament"
```

---

## Task 3: Tournaments service — create options, updateSettings, closeForDeadline, findOverdueActive

**Files:**
- Create: `packages/shared/src/services/constants.ts`
- Modify: `packages/shared/src/services/tournaments.ts`
- Modify: `packages/shared/src/services/index.ts` (barrel — export the constant; verify the path first)
- Test: `packages/shared/tests/services/tournaments.test.ts` (create if absent; check `packages/shared/tests/` layout first)

- [ ] **Step 1: Create the shared constant**

Create `packages/shared/src/services/constants.ts`:

```ts
export const DEFAULT_REPORT_CONFIRM_HOURS = 24;

// Accepted bounds for a per-tournament confirm window (hours). 720h = 30 days.
export const MIN_REPORT_CONFIRM_HOURS = 1;
export const MAX_REPORT_CONFIRM_HOURS = 720;
```

Export it from the services barrel. Find the barrel (likely `packages/shared/src/services/index.ts`) and add:

```ts
export * from "./constants.js";
```

- [ ] **Step 2: Write the failing tests**

Create/extend `packages/shared/tests/services/tournaments.test.ts`. Use the in-memory DB pattern from existing shared tests (mirror `packages/bot/tests/services/draft-timer.test.ts`'s `setup()` for the `card_sets` pre-table + `migrate(db)`; tournaments need only `migrate(db)` plus players). Add:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createTournamentService } from "../../src/services/tournaments.js";
import { DEFAULT_REPORT_CONFIRM_HOURS } from "../../src/services/constants.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  // two players so create/join/start work
  const insertPlayer = db.prepare(
    "insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)",
  );
  const p1 = Number(insertPlayer.run("g1", "u1", "Yugi").lastInsertRowid);
  const p2 = Number(insertPlayer.run("g1", "u2", "Kaiba").lastInsertRowid);
  return { db, tournaments: createTournamentService(db), p1, p2 };
}

describe("tournaments timing settings", () => {
  it("create stores deadlineAt and reportConfirmWindowHours when provided", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1", {
      deadlineAt: "2099-01-01T00:00:00.000Z",
      reportConfirmWindowHours: 6,
    });
    expect(t.deadlineAt).toBe("2099-01-01T00:00:00.000Z");
    expect(t.reportConfirmWindowHours).toBe(6);
  });

  it("create leaves both null when options omitted", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    expect(t.deadlineAt).toBeUndefined();
    expect(t.reportConfirmWindowHours).toBeUndefined();
  });

  it("updateSettings patches only provided keys", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1", { reportConfirmWindowHours: 6 });
    const u = tournaments.updateSettings(t.id, { deadlineAt: "2099-02-02T00:00:00.000Z" });
    expect(u.deadlineAt).toBe("2099-02-02T00:00:00.000Z");
    expect(u.reportConfirmWindowHours).toBe(6); // untouched
    const cleared = tournaments.updateSettings(t.id, { deadlineAt: null });
    expect(cleared.deadlineAt).toBeUndefined();
  });

  it("updateSettings rejects an out-of-range window", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    expect(() => tournaments.updateSettings(t.id, { reportConfirmWindowHours: 0 })).toThrow();
    expect(() => tournaments.updateSettings(t.id, { reportConfirmWindowHours: 721 })).toThrow();
  });

  it("updateSettings throws when tournament is completed", () => {
    const { tournaments, db } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    db.prepare("update tournaments set status = 'completed' where id = ?").run(t.id);
    expect(() => tournaments.updateSettings(t.id, { reportConfirmWindowHours: 6 })).toThrow();
  });

  it("closeForDeadline completes an active tournament and is a no-op otherwise", () => {
    const { tournaments, db, p1, p2 } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    tournaments.join(t.id, p1);
    tournaments.join(t.id, p2);
    tournaments.start(t.id); // -> active
    const closed = tournaments.closeForDeadline(t.id);
    expect(closed.status).toBe("completed");
    const endedAt = db.prepare("select ended_at from tournaments where id = ?").get(t.id) as { ended_at: string | null };
    expect(endedAt.ended_at).not.toBeNull();
    // idempotent: second call no longer active -> returns completed, leaves it completed
    expect(tournaments.closeForDeadline(t.id).status).toBe("completed");
  });

  it("findOverdueActive returns only active tournaments with deadline_at <= now", () => {
    const { tournaments, db, p1, p2 } = setup();
    const overdue = tournaments.create("g1", "Past", "round_robin", "u1", { deadlineAt: "2000-01-01T00:00:00.000Z" });
    const future = tournaments.create("g1", "Future", "round_robin", "u1", { deadlineAt: "2999-01-01T00:00:00.000Z" });
    const noDeadline = tournaments.create("g1", "None", "round_robin", "u1");
    for (const t of [overdue, future, noDeadline]) {
      tournaments.join(t.id, p1);
      tournaments.join(t.id, p2);
      tournaments.start(t.id);
    }
    const found = tournaments.findOverdueActive("2026-05-20T00:00:00.000Z");
    expect(found.map((t) => t.id)).toEqual([overdue.id]);
  });

  it("DEFAULT_REPORT_CONFIRM_HOURS is 24", () => {
    expect(DEFAULT_REPORT_CONFIRM_HOURS).toBe(24);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/shared/tests/services/tournaments.test.ts`
Expected: FAIL — `create` ignores options / `updateSettings` etc. not defined.

- [ ] **Step 4: Implement the service changes**

In `packages/shared/src/services/tournaments.ts`:

(a) Add imports near the top (after existing imports):

```ts
import {
  DEFAULT_REPORT_CONFIRM_HOURS,
  MAX_REPORT_CONFIRM_HOURS,
  MIN_REPORT_CONFIRM_HOURS,
} from "./constants.js";
```

(b) Add a private validation helper inside `createTournamentService` (near `findById`, before the `return {`):

```ts
  const validateWindow = (hours: number | null | undefined) => {
    if (hours === null || hours === undefined) return;
    if (!Number.isInteger(hours) || hours < MIN_REPORT_CONFIRM_HOURS || hours > MAX_REPORT_CONFIRM_HOURS) {
      throw new Error(
        `Confirm window must be an integer between ${MIN_REPORT_CONFIRM_HOURS} and ${MAX_REPORT_CONFIRM_HOURS} hours`,
      );
    }
  };
```

(c) Replace the `create` method signature + INSERT (lines 136-178) to accept options and persist the columns. New version:

```ts
    create(
      guildId: string,
      name: string,
      format: TournamentFormat,
      createdByUserId: string,
      options?: { deadlineAt?: string | null; reportConfirmWindowHours?: number | null },
    ): Tournament {
      assertFormat(format);
      validateWindow(options?.reportConfirmWindowHours);

      const existingCurrent = db
        .prepare(
          `
          select id from tournaments
          where guild_id = ?
            and name = ?
            and status in ('pending', 'active')
          limit 1
        `,
        )
        .get(guildId, name);

      if (existingCurrent) {
        throw new Error("An active or pending tournament already uses that name");
      }

      const insert = db.prepare(
        `
          insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug, deadline_at, report_confirm_window_hours)
          values (?, ?, ?, 'pending', ?, ?, ?, ?)
        `,
      );

      let result;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          result = insert.run(
            guildId,
            name,
            format,
            createdByUserId,
            generateWebSlug(),
            options?.deadlineAt ?? null,
            options?.reportConfirmWindowHours ?? null,
          );
          break;
        } catch (err: any) {
          if (err?.code !== "SQLITE_CONSTRAINT_UNIQUE" || attempt === 4) throw err;
        }
      }

      return findById(Number(result!.lastInsertRowid));
    },
```

(d) Add three new methods (place them after `cancel`, before the closing `};` of the returned object):

```ts
    updateSettings(
      tournamentId: number,
      patch: { deadlineAt?: string | null; reportConfirmWindowHours?: number | null },
    ): Tournament {
      const tournament = findById(tournamentId);

      if (tournament.status === "completed" || tournament.status === "cancelled") {
        throw new Error(`Cannot edit settings of a ${tournament.status} tournament`);
      }

      if ("reportConfirmWindowHours" in patch) {
        validateWindow(patch.reportConfirmWindowHours);
      }

      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if ("deadlineAt" in patch) {
        sets.push("deadline_at = ?");
        params.push(patch.deadlineAt ?? null);
      }
      if ("reportConfirmWindowHours" in patch) {
        sets.push("report_confirm_window_hours = ?");
        params.push(patch.reportConfirmWindowHours ?? null);
      }

      if (sets.length > 0) {
        params.push(tournamentId);
        db.prepare(`update tournaments set ${sets.join(", ")} where id = ?`).run(...params);
      }

      return findById(tournamentId);
    },

    closeForDeadline(tournamentId: number): Tournament {
      db.prepare(
        "update tournaments set status = 'completed', ended_at = current_timestamp where id = ? and status = 'active'",
      ).run(tournamentId);
      return findById(tournamentId);
    },

    findOverdueActive(now: string): Tournament[] {
      return db
        .prepare(
          `
          select * from tournaments
          where status = 'active'
            and deadline_at is not null
            and deadline_at <= ?
          order by id asc
        `,
        )
        .all(now)
        .map(mapTournament);
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/shared/tests/services/tournaments.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/constants.ts packages/shared/src/services/index.ts packages/shared/src/services/tournaments.ts packages/shared/tests/services/tournaments.test.ts
git commit -m "feat(shared): tournament timing settings (create options, updateSettings, closeForDeadline, findOverdueActive)"
```

> Note: if `packages/shared/src/services/index.ts` does not exist, find the actual barrel that `@yugidraft/shared/services` resolves to (check `packages/shared/package.json` `exports`) and add the `export * from "./constants.js"` there instead.

---

## Task 4: Matches service — autoApprove + findOverduePendingConfirmations

**Files:**
- Modify: `packages/shared/src/services/matches.ts`
- Test: `packages/shared/tests/services/matches.test.ts` (create if absent; check layout first)

- [ ] **Step 1: Write the failing tests**

Create/extend `packages/shared/tests/services/matches.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const insertPlayer = db.prepare(
    "insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)",
  );
  const p1 = Number(insertPlayer.run("g1", "u1", "Yugi").lastInsertRowid);
  const p2 = Number(insertPlayer.run("g1", "u2", "Kaiba").lastInsertRowid);
  return {
    db,
    matches: createMatchService(db),
    tournaments: createTournamentService(db),
    p1,
    p2,
  };
}

// Reports a tournament match (winner = p1) and returns its match id, with a
// controllable created_at so the confirm window can be tested deterministically.
function seedPendingTournamentMatch(
  app: ReturnType<typeof setup>,
  opts: { windowHours?: number | null; createdAt: string },
) {
  const t = app.tournaments.create("g1", "Cup", "round_robin", "u1", {
    reportConfirmWindowHours: opts.windowHours ?? null,
  });
  app.tournaments.join(t.id, app.p1);
  app.tournaments.join(t.id, app.p2);
  app.tournaments.start(t.id);
  const match = app.tournaments.report(t.id, app.p1, app.p2, app.p1); // p1 reports a win
  app.db.prepare("update matches set created_at = ? where id = ?").run(opts.createdAt, match.id);
  return { tournamentId: t.id, matchId: match.id };
}

describe("matches.autoApprove", () => {
  it("approves a pending tournament match with a null approver and completes it", () => {
    const app = setup();
    const { matchId, tournamentId } = seedPendingTournamentMatch(app, {
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const result = app.matches.autoApprove(matchId);
    expect(result.status).toBe("approved");
    expect(result.approverId).toBeNull();
    const row = app.db.prepare("select resolved_at from matches where id = ?").get(matchId) as { resolved_at: string | null };
    expect(row.resolved_at).not.toBeNull();
    // round-robin with the single match resolved -> tournament completes
    const t = app.db.prepare("select status from tournaments where id = ?").get(tournamentId) as { status: string };
    expect(t.status).toBe("completed");
  });

  it("is a no-op on a non-pending match", () => {
    const app = setup();
    const { matchId } = seedPendingTournamentMatch(app, { createdAt: "2026-05-01T00:00:00.000Z" });
    app.matches.autoApprove(matchId);
    const again = app.matches.autoApprove(matchId);
    expect(again.status).toBe("approved");
  });
});

describe("matches.findOverduePendingConfirmations", () => {
  it("returns matches past created_at + per-tournament window", () => {
    const app = setup();
    const { matchId } = seedPendingTournamentMatch(app, {
      windowHours: 6,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    // 5h later -> not overdue
    expect(app.matches.findOverduePendingConfirmations("2026-05-20T05:00:00.000Z")).toEqual([]);
    // 7h later -> overdue
    const overdue = app.matches.findOverduePendingConfirmations("2026-05-20T07:00:00.000Z");
    expect(overdue.map((m) => m.id)).toEqual([matchId]);
  });

  it("uses the 24h default when window is null", () => {
    const app = setup();
    const { matchId } = seedPendingTournamentMatch(app, {
      windowHours: null,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    expect(app.matches.findOverduePendingConfirmations("2026-05-20T23:00:00.000Z")).toEqual([]);
    const overdue = app.matches.findOverduePendingConfirmations("2026-05-21T01:00:00.000Z");
    expect(overdue.map((m) => m.id)).toEqual([matchId]);
  });

  it("excludes matches in non-active tournaments", () => {
    const app = setup();
    const { matchId, tournamentId } = seedPendingTournamentMatch(app, {
      windowHours: 1,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    app.db.prepare("update tournaments set status = 'completed' where id = ?").run(tournamentId);
    expect(app.matches.findOverduePendingConfirmations("2026-05-21T00:00:00.000Z").map((m) => m.id)).not.toContain(matchId);
  });

  it("excludes casual matches", () => {
    const app = setup();
    const m = app.matches.report({ guildId: "g1", reporterId: app.p1, opponentId: app.p2, winnerId: app.p1, source: "casual" });
    app.db.prepare("update matches set created_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", m.id);
    expect(app.matches.findOverduePendingConfirmations("2026-05-21T00:00:00.000Z")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared/tests/services/matches.test.ts`
Expected: FAIL — `autoApprove` / `findOverduePendingConfirmations` not defined.

- [ ] **Step 3: Implement the service changes**

In `packages/shared/src/services/matches.ts`:

(a) Add the import at the top (after line 2):

```ts
import { DEFAULT_REPORT_CONFIRM_HOURS } from "./constants.js";
```

(b) Add two methods to the returned object (place after `deny`, before `stats`):

```ts
    autoApprove(matchId: number): Match {
      const match = findById(matchId);
      if (match.status !== "pending") {
        return match;
      }

      db.prepare(
        `
        update matches
        set status = 'approved', approver_id = null, resolved_at = current_timestamp
        where id = ?
      `,
      ).run(matchId);

      const approvedMatch = findById(matchId);
      completeTournamentMatch(approvedMatch);

      return findById(matchId);
    },

    findOverduePendingConfirmations(now: string): Match[] {
      return db
        .prepare(
          `
          select m.* from matches m
          join tournaments t on t.id = m.tournament_id
          where m.status = 'pending'
            and m.source = 'tournament'
            and m.tournament_id is not null
            and t.status = 'active'
            and datetime(m.created_at,
              '+' || coalesce(t.report_confirm_window_hours, ${DEFAULT_REPORT_CONFIRM_HOURS}) || ' hours') <= ?
          order by m.id asc
        `,
        )
        .all(now)
        .map(mapMatch);
    },
```

> The `${DEFAULT_REPORT_CONFIRM_HOURS}` interpolation is a numeric constant (safe, no injection) and keeps the SQL fallback in sync with the TS default.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/shared/tests/services/matches.test.ts`
Expected: PASS.

- [ ] **Step 5: Build shared so downstream packages see the changes**

Run: `npm run build --workspace=packages/shared`
Expected: clean build (bot/web import the compiled `@yugidraft/shared`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/matches.ts packages/shared/tests/services/matches.test.ts
git commit -m "feat(shared): add matches.autoApprove and findOverduePendingConfirmations"
```

---

## Task 5: Bot tournament-timer service

**Files:**
- Create: `packages/bot/src/services/tournament-timer.ts`
- Test: `packages/bot/tests/services/tournament-timer.test.ts`

**Depends on:** Tasks 3 & 4 (shared) committed and built.

- [ ] **Step 1: Write the failing test**

Create `packages/bot/tests/services/tournament-timer.test.ts`. Mirror the `draft-timer.test.ts` setup (in-memory DB, `card_sets` pre-table, `migrate`, fake timers). Seed two players via direct insert.

```ts
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createMatchService } from "@yugidraft/shared/services";
import { createTournamentService } from "@yugidraft/shared/services";
import { createTournamentTimerService } from "../../src/services/tournament-timer.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    create table if not exists card_sets (
      set_name text primary key not null,
      synced_at text not null,
      card_count integer,
      set_code text
    );
  `);
  migrate(db);
  const insertPlayer = db.prepare(
    "insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)",
  );
  const p1 = Number(insertPlayer.run("g1", "u1", "Yugi").lastInsertRowid);
  const p2 = Number(insertPlayer.run("g1", "u2", "Kaiba").lastInsertRowid);
  return { db, matches: createMatchService(db), tournaments: createTournamentService(db), p1, p2 };
}

describe("tournament timer service", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("auto-approves overdue pending confirmations and invokes the callback", async () => {
    const app = setup();
    const t = app.tournaments.create("g1", "Cup", "round_robin", "u1", { reportConfirmWindowHours: 1 });
    app.tournaments.join(t.id, app.p1);
    app.tournaments.join(t.id, app.p2);
    app.tournaments.start(t.id);
    const match = app.tournaments.report(t.id, app.p1, app.p2, app.p1);
    app.db.prepare("update matches set created_at = ? where id = ?").run("2026-05-20T00:00:00.000Z", match.id);

    const resolved: number[] = [];
    const closed: number[] = [];
    const timer = createTournamentTimerService({
      tournaments: app.tournaments,
      matches: app.matches,
      onMatchAutoResolved: async (m) => { resolved.push(m.id); },
      onTournamentClosed: async (tt) => { closed.push(tt.id); },
    });

    await timer.tick(new Date("2026-05-20T02:00:00.000Z"));

    const updated = app.db.prepare("select status, approver_id from matches where id = ?").get(match.id) as { status: string; approver_id: number | null };
    expect(updated.status).toBe("approved");
    expect(updated.approver_id).toBeNull();
    expect(resolved).toEqual([match.id]);
  });

  it("auto-closes tournaments past their deadline and invokes the callback", async () => {
    const app = setup();
    const t = app.tournaments.create("g1", "Cup", "round_robin", "u1", { deadlineAt: "2026-05-20T00:00:00.000Z" });
    app.tournaments.join(t.id, app.p1);
    app.tournaments.join(t.id, app.p2);
    app.tournaments.start(t.id);

    const closed: number[] = [];
    const timer = createTournamentTimerService({
      tournaments: app.tournaments,
      matches: app.matches,
      onMatchAutoResolved: async () => {},
      onTournamentClosed: async (tt) => { closed.push(tt.id); },
    });

    await timer.tick(new Date("2026-05-21T00:00:00.000Z"));

    const row = app.db.prepare("select status from tournaments where id = ?").get(t.id) as { status: string };
    expect(row.status).toBe("completed");
    expect(closed).toEqual([t.id]);
  });

  it("continues past a callback that throws", async () => {
    const app = setup();
    const mk = (name: string) => {
      const t = app.tournaments.create("g1", name, "round_robin", "u1", { deadlineAt: "2026-05-20T00:00:00.000Z" });
      app.tournaments.join(t.id, app.p1);
      app.tournaments.join(t.id, app.p2);
      app.tournaments.start(t.id);
      return t;
    };
    const t1 = mk("A");
    const t2 = mk("B");

    const closed: number[] = [];
    const timer = createTournamentTimerService({
      tournaments: app.tournaments,
      matches: app.matches,
      onMatchAutoResolved: async () => {},
      onTournamentClosed: async (tt) => {
        if (tt.id === t1.id) throw new Error("boom");
        closed.push(tt.id);
      },
    });

    await timer.tick(new Date("2026-05-21T00:00:00.000Z"));
    // both closed in DB; callback failure on t1 didn't stop t2's callback
    expect(closed).toContain(t2.id);
    expect((app.db.prepare("select status from tournaments where id = ?").get(t2.id) as { status: string }).status).toBe("completed");
  });

  it("polls every 60 seconds while running", () => {
    const app = setup();
    const spy = vi.spyOn(globalThis, "setInterval");
    const timer = createTournamentTimerService({
      tournaments: app.tournaments,
      matches: app.matches,
      onMatchAutoResolved: async () => {},
      onTournamentClosed: async () => {},
    });
    timer.start();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    timer.stop();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/bot/tests/services/tournament-timer.test.ts`
Expected: FAIL — module `tournament-timer.js` not found.

- [ ] **Step 3: Implement the timer**

Create `packages/bot/src/services/tournament-timer.ts`:

```ts
import type { MatchService, TournamentService, Match, Tournament } from "@yugidraft/shared/services";

export function createTournamentTimerService({
  tournaments,
  matches,
  onMatchAutoResolved,
  onTournamentClosed,
}: {
  tournaments: TournamentService;
  matches: MatchService;
  onMatchAutoResolved: (match: Match) => Promise<void>;
  onTournamentClosed: (tournament: Tournament) => Promise<void>;
}) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(now = new Date()) {
    const nowIso = now.toISOString();

    // 1. Auto-confirm overdue pending reports (before deadline sweep so a match
    //    whose window elapsed can complete its tournament naturally first).
    for (const overdue of matches.findOverduePendingConfirmations(nowIso)) {
      try {
        const resolved = matches.autoApprove(overdue.id);
        await onMatchAutoResolved(resolved);
      } catch (error) {
        console.warn(`[tournament-timer] auto-approve failed for match ${overdue.id}`, error);
      }
    }

    // 2. Auto-close tournaments past their deadline ("close as-is").
    for (const tournament of tournaments.findOverdueActive(nowIso)) {
      try {
        const closed = tournaments.closeForDeadline(tournament.id);
        await onTournamentClosed(closed);
      } catch (error) {
        console.warn(`[tournament-timer] close failed for tournament ${tournament.id}`, error);
      }
    }
  }

  return {
    start() {
      if (intervalId) return;
      intervalId = setInterval(() => tick(), 60_000);
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    tick,
  };
}

export type TournamentTimerService = ReturnType<typeof createTournamentTimerService>;
```

> If `Match` / `Tournament` are not re-exported from `@yugidraft/shared/services`, import the types from `@yugidraft/shared/types` (`Tournament`) and `@yugidraft/shared/services` (`Match` is exported from `matches.ts`). Verify the export surface; `tournaments.ts` already does `export type { Tournament } ...` and `matches.ts` exports `Match`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/bot/tests/services/tournament-timer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/services/tournament-timer.ts packages/bot/tests/services/tournament-timer.test.ts
git commit -m "feat(bot): add tournament-timer poller for report-confirm + deadline enforcement"
```

---

## Task 6: Wire the tournament timer in the bot entrypoint

**Files:**
- Modify: `packages/bot/src/index.ts`

**Depends on:** Task 5. No new test (entrypoint wiring; behavior is covered by Task 5's unit tests). Verified via build + manual reasoning.

- [ ] **Step 1: Import the timer factory**

In `packages/bot/src/index.ts`, after the draft-timer import (line 47) add:

```ts
import { createTournamentTimerService } from "./services/tournament-timer.js";
```

- [ ] **Step 2: Construct the timer with reuse callbacks**

After the `draftTimer` definition block (ends at line 211), add:

```ts
const tournamentTimer = createTournamentTimerService({
  tournaments: deps.tournaments,
  matches: deps.matches,
  onMatchAutoResolved: async (match) => {
    // Clean up the pending approval message (mirrors approve path).
    await deps.deleteNotifyMessage(match.id).catch((err) =>
      console.warn(`[tournament-timer] deleteNotifyMessage failed for ${match.id}:`, err),
    );

    if (match.tournamentId) {
      // Announce completion once if this auto-approval finished the tournament.
      if (deps.matches.claimTournamentCompletionAnnouncement(match.tournamentId)) {
        await deps.announceTournamentCompleted(match.tournamentId).catch((err) =>
          console.warn(`[tournament-timer] announce failed for ${match.tournamentId}:`, err),
        );
      }
      const row = deps.db
        .prepare("select web_slug from tournaments where id = ?")
        .get(match.tournamentId) as { web_slug: string | null } | undefined;
      if (row?.web_slug) {
        await notifyWsTournament(
          { url: process.env.WS_INTERNAL_URL ?? "", secret: process.env.WS_INTERNAL_SECRET ?? "" },
          { kind: "match-updated", slug: row.web_slug },
        );
      }
    }
  },
  onTournamentClosed: async (tournament) => {
    if (deps.matches.claimTournamentCompletionAnnouncement(tournament.id)) {
      await deps.announceTournamentCompleted(tournament.id).catch((err) =>
        console.warn(`[tournament-timer] announce failed for ${tournament.id}:`, err),
      );
    }
    if (tournament.webSlug) {
      await notifyWsTournament(
        { url: process.env.WS_INTERNAL_URL ?? "", secret: process.env.WS_INTERNAL_SECRET ?? "" },
        { kind: "match-updated", slug: tournament.webSlug },
      );
    }
  },
});
```

Add the `notifyWsTournament` import at the top if not present:

```ts
import { notifyWsTournament } from "./lib/notify-ws-tournament.js";
```

- [ ] **Step 3: Start the timer at ready**

In the `client.once("ready", ...)` block, right after the draft-timer start chain (lines 381-389), add:

```ts
  tournamentTimer
    .tick()
    .then(() => tournamentTimer.start())
    .catch((error) => {
      console.error("Failed to run initial tournament timer tick:", error);
      tournamentTimer.start();
    });
```

- [ ] **Step 4: Build the bot**

Run: `npm run build --workspace=packages/bot`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/index.ts
git commit -m "feat(bot): wire and start the tournament timer at ready"
```

---

## Task 7: `/event create` confirm_hours + deadline_days options

**Files:**
- Modify: `packages/bot/src/commands/definitions.ts` (the `/event create` subcommand, builder starting ~line 44)
- Modify: `packages/bot/src/commands/handlers.ts` (`handleEvent` `case "create"`, lines 453-475)
- Test: `packages/bot/tests/commands/handlers.test.ts` (extend the `/event create` test)

**Depends on:** Task 3 (create options).

- [ ] **Step 1: Write the failing test**

In `packages/bot/tests/commands/handlers.test.ts`, find the existing `/event create` test (search `event` + `create`). Add a test asserting the two options are passed through. The handler reads them via `interaction.options.getInteger`. The `CommandInteractionLike` options object currently exposes `getString`, `getRole`, `getUser` (see `index.ts` `toCommandInteraction`). It must also expose `getInteger`. Add to the test's fake interaction an `getInteger` and assert the created tournament row carries the converted values:

```ts
it("passes confirm_hours and deadline_days through /event create", async () => {
  const app = setupHandlersApp(); // reuse the file's existing harness
  await handleCommand(
    makeCommand(app, {
      commandName: "event",
      subcommand: "create",
      strings: { name: "Cup", format: "round_robin" },
      integers: { confirm_hours: 6, deadline_days: 3 },
    }),
    app.deps,
  );

  const row = app.db.prepare("select deadline_at, report_confirm_window_hours from tournaments where name = 'Cup'").get() as {
    deadline_at: string | null;
    report_confirm_window_hours: number | null;
  };
  expect(row.report_confirm_window_hours).toBe(6);
  expect(row.deadline_at).not.toBeNull(); // now + 3 days, ISO
  expect(new Date(row.deadline_at!).getTime()).toBeGreaterThan(Date.now());
});
```

> Adapt to the file's actual test helpers (`makeCommand`/`setupHandlersApp` names will differ — match the existing pattern). The key additions: the fake `options.getInteger(name)` returns the seeded integer or `null`, and the assertion reads the DB row.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/bot/tests/commands/handlers.test.ts`
Expected: FAIL — values not persisted (handler ignores them) and/or `getInteger` undefined.

- [ ] **Step 3: Add `getInteger` to the interaction wrapper + type**

In `packages/bot/src/commands/handlers.ts`, find the `CommandInteractionLike` `options` type (the interface that declares `getString`/`getUser`). Add:

```ts
    getInteger: (name: string, required?: boolean) => number | null;
```

In `packages/bot/src/index.ts` `toCommandInteraction` `options` object (lines 225-239), add:

```ts
      getInteger: (name, required = false) => interaction.options.getInteger(name, required),
```

- [ ] **Step 4: Add the command options**

In `packages/bot/src/commands/definitions.ts`, within the `/event create` subcommand builder (after the existing `format` string option / before or after the seed player options), add two optional integer options:

```ts
        .addIntegerOption((option) =>
          option
            .setName("confirm_hours")
            .setDescription("Hours an opponent has to confirm a report before it auto-approves")
            .setMinValue(1)
            .setMaxValue(720)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("deadline_days")
            .setDescription("Auto-close the event this many days from now")
            .setMinValue(1)
            .setRequired(false),
        )
```

- [ ] **Step 5: Convert + pass them in the handler**

In `packages/bot/src/commands/handlers.ts`, in `handleEvent` `case "create"` (lines 453-456), replace the `create` call with option reads + conversion:

```ts
    case "create": {
      const name = requireStringOption(interaction, "name");
      const format = requireStringOption(interaction, "format") as TournamentFormat;
      const confirmHours = interaction.options.getInteger("confirm_hours");
      const deadlineDays = interaction.options.getInteger("deadline_days");
      const deadlineAt =
        deadlineDays && deadlineDays > 0
          ? new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000).toISOString()
          : null;
      const tournament = deps.tournaments.create(guildId, name, format, interaction.user.id, {
        deadlineAt,
        reportConfirmWindowHours: confirmHours ?? null,
      });
```

(Leave the rest of the `case "create"` block — seed loop, reply — unchanged.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/bot/tests/commands/handlers.test.ts`
Expected: PASS.

- [ ] **Step 7: Build + commit**

```bash
npm run build --workspace=packages/bot
git add packages/bot/src/commands/definitions.ts packages/bot/src/commands/handlers.ts packages/bot/src/index.ts packages/bot/tests/commands/handlers.test.ts
git commit -m "feat(bot): add confirm_hours and deadline_days options to /event create"
```

---

## Task 8: Web POST /api/tournaments — accept + validate timing options

**Files:**
- Modify: `packages/web/app/api/tournaments/route.ts`
- Test: `packages/web/tests/tournaments-create-route.test.ts` (create; run web tests with `-c packages/web/vitest.config.ts`)

**Depends on:** Task 3.

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/tournaments-create-route.test.ts`. Follow an existing web route test for the auth/db mocking pattern (e.g. `packages/web/tests/cards-resolve-route.test.ts` for structure; find a tournament route test if one exists to copy the `auth`/`getDb` mocks). Cover: valid options persist; past deadline rejected (400); out-of-range window rejected (400).

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
// mock @/lib/auth -> session with user.id, @/lib/env -> discordGuildId, @/lib/db -> in-memory db
// (mirror the mocking already used by other web route tests in this folder)
```

Assert:
- POST with `{ name, format, deadlineAt: <future ISO>, reportConfirmWindowHours: 6 }` → 201, and DB row has both values.
- POST with `deadlineAt` in the past → 400.
- POST with `reportConfirmWindowHours: 0` or `721` → 400.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/tournaments-create-route.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — route ignores/doesn't validate the new fields.

- [ ] **Step 3: Implement validation + pass-through**

In `packages/web/app/api/tournaments/route.ts` `POST`, after the existing format validation (line 78) and before `const guildId`, add:

```ts
  const { deadlineAt, reportConfirmWindowHours } = body as {
    deadlineAt?: string | null;
    reportConfirmWindowHours?: number | null;
  };

  if (deadlineAt != null) {
    const ts = Date.parse(deadlineAt);
    if (Number.isNaN(ts) || ts <= Date.now()) {
      return NextResponse.json({ error: "deadline must be a valid future date" }, { status: 400 });
    }
  }

  if (reportConfirmWindowHours != null) {
    if (!Number.isInteger(reportConfirmWindowHours) || reportConfirmWindowHours < 1 || reportConfirmWindowHours > 720) {
      return NextResponse.json(
        { error: "confirm window must be an integer between 1 and 720 hours" },
        { status: 400 },
      );
    }
  }
```

Then change the `create` call (line 94) to pass options:

```ts
    const tournament = tournaments.create(
      guildId,
      name,
      format as "round_robin" | "single_elim",
      session.user.id,
      {
        deadlineAt: deadlineAt ?? null,
        reportConfirmWindowHours: reportConfirmWindowHours ?? null,
      },
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/tournaments-create-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/route.ts packages/web/tests/tournaments-create-route.test.ts
git commit -m "feat(web): accept and validate deadlineAt + reportConfirmWindowHours on tournament create"
```

---

## Task 9: Web PUT /api/tournaments/[slug] — edit settings; GET expose fields

**Files:**
- Modify: `packages/web/app/api/tournaments/[slug]/route.ts` (PUT at 177-239; GET at 25-134; the `TournamentRow` type at 11-19)
- Test: `packages/web/tests/tournaments-slug-route.test.ts` (create)

**Depends on:** Task 3.

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/tournaments-slug-route.test.ts` (mirror Task 8's mocking). Cover:
- PUT by creator on an **active** tournament with `{ reportConfirmWindowHours: 6, deadlineAt: <future> }` → 200, DB updated.
- PUT by a non-creator → 403.
- PUT on a **completed** tournament → 400.
- PUT clearing deadline with `{ deadlineAt: null }` → 200, column null.
- GET returns `deadlineAt` / `reportConfirmWindowHours` in the JSON.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/tournaments-slug-route.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — PUT only allows pending + name; GET omits fields.

- [ ] **Step 3: Implement PUT settings editing**

In `packages/web/app/api/tournaments/[slug]/route.ts`:

(a) Extend `TournamentRow` (lines 11-19) with:

```ts
  deadline_at: string | null;
  report_confirm_window_hours: number | null;
```

(b) Rework the PUT body handling (lines 200-224). Replace the pending-only guard + name-only block with: name edits stay pending-only, but timing edits are allowed while `pending` or `active`, via `tournaments.updateSettings`. New body:

```ts
    if (tournament.status === "completed" || tournament.status === "cancelled") {
      return NextResponse.json({ error: `Cannot edit a ${tournament.status} tournament` }, { status: 400 });
    }

    const tournamentId = tournament.id;
    const body = await request.json();
    const { name, deadlineAt, reportConfirmWindowHours } = body as {
      name?: string;
      deadlineAt?: string | null;
      reportConfirmWindowHours?: number | null;
    };

    if (name !== undefined) {
      if (tournament.status !== "pending") {
        return NextResponse.json({ error: "Name can only be changed before the tournament starts" }, { status: 400 });
      }
      if (!name.trim()) {
        return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      }
      const existing = db
        .prepare(
          "select id from tournaments where guild_id = ? and name = ? and status in ('pending', 'active') and id != ?",
        )
        .get(tournament.guild_id, name, tournamentId) as { id: number } | undefined;
      if (existing) {
        return NextResponse.json({ error: "A tournament with that name already exists" }, { status: 400 });
      }
      db.prepare("update tournaments set name = ? where id = ?").run(name, tournamentId);
    }

    if (deadlineAt !== undefined && deadlineAt !== null) {
      const ts = Date.parse(deadlineAt);
      if (Number.isNaN(ts) || ts <= Date.now()) {
        return NextResponse.json({ error: "deadline must be a valid future date" }, { status: 400 });
      }
    }

    const tournaments = createTournamentService(db);
    const patch: { deadlineAt?: string | null; reportConfirmWindowHours?: number | null } = {};
    if (deadlineAt !== undefined) patch.deadlineAt = deadlineAt;
    if (reportConfirmWindowHours !== undefined) patch.reportConfirmWindowHours = reportConfirmWindowHours;
    if (Object.keys(patch).length > 0) {
      try {
        tournaments.updateSettings(tournamentId, patch);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update settings";
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }
```

(c) Update the PUT response query (line 226) to include the new columns:

```ts
    const updated = db
      .prepare("select id, name, format, status, web_slug, deadline_at, report_confirm_window_hours from tournaments where id = ?")
      .get(tournamentId) as any;

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      format: updated.format,
      status: updated.status,
      webSlug: updated.web_slug ?? undefined,
      deadlineAt: updated.deadline_at ?? undefined,
      reportConfirmWindowHours: updated.report_confirm_window_hours ?? undefined,
    });
```

(d) In GET (the final `NextResponse.json` at lines 114-126), add the two fields from `tournament` (the row now carries them):

```ts
      deadlineAt: tournament.deadline_at ?? undefined,
      reportConfirmWindowHours: tournament.report_confirm_window_hours ?? undefined,
```

> Trigger a ws refresh after a settings edit so open clients update: after a successful `updateSettings`, add `void notifyWsTournament({ url: env.wsInternalUrl, secret: env.wsInternalSecret }, { kind: "match-updated", slug });` (import already present).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/tournaments-slug-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/[slug]/route.ts packages/web/tests/tournaments-slug-route.test.ts
git commit -m "feat(web): edit tournament timing settings via PUT; expose them on GET"
```

---

## Task 10: Web UI — create form fields + host settings editor

**Files:**
- Modify: `packages/web/src/components/tournament/create-tournament-form.tsx`
- Create: `packages/web/src/components/tournament/tournament-settings-form.tsx`
- Modify: `packages/web/src/components/tournament/types.ts` (`TournamentDetail` — add `deadlineAt?`, `reportConfirmWindowHours?`)
- Modify: `packages/web/src/components/tournament/tournament-lobby.tsx` (render settings editor for pending host)
- Modify: `packages/web/src/components/tournament/overview-tab.tsx` (render settings editor for active host)
- Test: `packages/web/tests/components/tournament-settings-form.test.tsx` (create; jsdom)

**Depends on:** Task 9 (PUT/GET shape).

- [ ] **Step 1: Write the failing component test**

Create `packages/web/tests/components/tournament-settings-form.test.tsx`. Render `TournamentSettingsForm` with initial values, edit the window number input, submit, and assert it issues a `PUT /api/tournaments/<slug>` with the new value (mock `fetch`). Assert clearing the deadline sends `deadlineAt: null`.

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TournamentSettingsForm } from "../../src/components/tournament/tournament-settings-form";

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any;
});

it("submits updated confirm window via PUT", async () => {
  render(
    <TournamentSettingsForm
      tournamentSlug="abc"
      initialDeadlineAt={undefined}
      initialReportConfirmWindowHours={24}
      onSaved={() => {}}
    />,
  );
  const hours = screen.getByLabelText(/confirm window/i);
  fireEvent.change(hours, { target: { value: "6" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/tournaments/abc",
      expect.objectContaining({ method: "PUT" }),
    );
  });
  const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
  expect(body.reportConfirmWindowHours).toBe(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/tournament-settings-form.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — component module not found.

- [ ] **Step 3: Build the settings form component**

Create `packages/web/src/components/tournament/tournament-settings-form.tsx`:

```tsx
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

// datetime-local needs "YYYY-MM-DDTHH:mm" (local time, no seconds/zone).
function isoToLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TournamentSettingsForm({
  tournamentSlug,
  initialDeadlineAt,
  initialReportConfirmWindowHours,
  onSaved,
}: {
  tournamentSlug: string;
  initialDeadlineAt?: string;
  initialReportConfirmWindowHours?: number;
  onSaved: () => void;
}) {
  const [deadline, setDeadline] = React.useState(isoToLocalInput(initialDeadlineAt));
  const [hours, setHours] = React.useState(
    initialReportConfirmWindowHours != null ? String(initialReportConfirmWindowHours) : "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body: { deadlineAt: string | null; reportConfirmWindowHours: number | null } = {
        deadlineAt: deadline ? new Date(deadline).toISOString() : null,
        reportConfirmWindowHours: hours.trim() ? Number(hours) : null,
      };
      const res = await fetch(`/api/tournaments/${tournamentSlug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save settings");
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <h3 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
        Tournament settings
      </h3>
      {error && <p className="text-sm text-accent-cta">{error}</p>}
      <div>
        <label htmlFor="settings-deadline" className="mb-1 block text-sm font-medium text-text-primary">
          Deadline (optional)
        </label>
        <input
          id="settings-deadline"
          type="datetime-local"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor="settings-hours" className="mb-1 block text-sm font-medium text-text-primary">
          Confirm window (hours, optional)
        </label>
        <input
          id="settings-hours"
          type="number"
          min={1}
          max={720}
          value={hours}
          placeholder="24"
          onChange={(e) => setHours(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
        />
      </div>
      <Button type="submit" loading={saving} size="sm">
        Save settings
      </Button>
    </form>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/tournament-settings-form.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Add optional fields to the create form**

In `packages/web/src/components/tournament/create-tournament-form.tsx`:
- Add state: `const [deadline, setDeadline] = React.useState("");` and `const [confirmHours, setConfirmHours] = React.useState("");`
- In `handleSubmit`, build the body conditionally:

```ts
        body: JSON.stringify({
          name: name.trim(),
          format,
          deadlineAt: deadline ? new Date(deadline).toISOString() : null,
          reportConfirmWindowHours: confirmHours.trim() ? Number(confirmHours) : null,
        }),
```

- Add two inputs (datetime-local for deadline, number for confirm hours min 1 max 720) in the form, mirroring the existing field markup, before the submit `Button`.

- [ ] **Step 6: Surface the editor for hosts + extend TournamentDetail**

- In `packages/web/src/components/tournament/types.ts`, add to `TournamentDetail`:

```ts
  deadlineAt?: string;
  reportConfirmWindowHours?: number;
```

- In `tournament-lobby.tsx` (pending view), when `isCreator`, render the editor (e.g. above the cancel footer):

```tsx
{isCreator && (
  <TournamentSettingsForm
    tournamentSlug={tournamentSlug}
    initialDeadlineAt={tournament.deadlineAt}
    initialReportConfirmWindowHours={tournament.reportConfirmWindowHours}
    onSaved={onChanged}
  />
)}
```

(import `TournamentSettingsForm`; the lobby already receives `tournament`, `tournamentSlug`, `isCreator`, `onChanged`).

- In `overview-tab.tsx` (active view), when `isHost`, render the same editor (e.g. after the standings section). It already receives `tournament`, `tournamentSlug`, `isHost`, `onChanged`.

- [ ] **Step 7: Run the web test suite + typecheck**

Run: `npx vitest run packages/web/tests/components/tournament-settings-form.test.tsx -c packages/web/vitest.config.ts`
Then: `npm run typecheck --workspace=packages/web`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/tournament/tournament-settings-form.tsx packages/web/src/components/tournament/create-tournament-form.tsx packages/web/src/components/tournament/types.ts packages/web/src/components/tournament/tournament-lobby.tsx packages/web/src/components/tournament/overview-tab.tsx packages/web/tests/components/tournament-settings-form.test.tsx
git commit -m "feat(web): tournament timing fields on create + host settings editor"
```

---

## Task 11: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all packages green (shared + bot + web).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. (Watch for any pre-existing `page.tsx` error noted in repo history — if present on `main`, it is out of scope.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Turbo builds all packages clean (shared first).

- [ ] **Step 4: Manual sanity reasoning**

Confirm against the spec's edge cases:
- A report just before deadline: once the tournament closes, `findOverduePendingConfirmations` filters on `t.status='active'`, so its pending matches are never auto-approved (close as-is). ✓
- Tick order: auto-confirm runs before deadline sweep. ✓
- Idempotency: `closeForDeadline` only acts on `active`; `autoApprove` only acts on `pending`. ✓

---

## Self-Review (plan author)

**Spec coverage:** data model (T1, T2) ✓; tournaments service create/updateSettings/closeForDeadline/findOverdueActive + DEFAULT const (T3) ✓; matches autoApprove/findOverduePendingConfirmations (T4) ✓; bot timer + wiring reusing announce/ws/cleanup (T5, T6) ✓; `/event create` options (T7) ✓; web create validation (T8); web edit + GET exposure (T9); web UI create + host editor (T10) ✓; tests across all three packages ✓; verification (T11) ✓.

**Type consistency:** `create(..., options?)`, `updateSettings(id, patch)`, `closeForDeadline(id)`, `findOverdueActive(now)`, `autoApprove(id)`, `findOverduePendingConfirmations(now)`, `createTournamentTimerService({ tournaments, matches, onMatchAutoResolved, onTournamentClosed })`, `tick(now)` — names used identically across tasks. ws kind `match-updated` is the existing tournament broadcast kind (no new kind needed).

**Open items to verify during execution (not blockers):** exact shared barrel path for the constants export (T3 note); shared test directory location (`packages/shared/tests/...`); the existing `/event create` test harness helper names (T7); the web route test mocking pattern to copy (T8/T9). These are mechanical lookups for the implementer; everything else is fully specified.
