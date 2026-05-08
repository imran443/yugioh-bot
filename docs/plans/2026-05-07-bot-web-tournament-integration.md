# Bot ↔ Web Tournament Integration Fixes Implementation Plan

> **Status: COMPLETE** — All 18 tasks implemented and merged to `feat/bot-web-tournament-integration` (2026-05-08).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken bot↔web integration for tournaments and drafts, harden the tournament state machine, and remove drift between web routes and the shared service layer.

**Architecture:** All fixes touch a single SQLite-backed monorepo (Discord bot, Next.js web, Socket.IO ws server, shared services package). The plan re-routes tournaments to slug-based URLs to match the existing draft pattern, fixes a match-status enum mismatch that blocks web-driven approvals, completes the round-robin state machine with auto-completion and cancel guards, has the web call into `tournamentService` and `matchService` instead of raw SQL, and adds an authenticated internal HTTP endpoint on the bot so the web can request Discord announcements.

**Tech Stack:**
- TypeScript / Node.js
- Next.js 15 (App Router) — `packages/web`
- discord.js v14 — `packages/bot`
- better-sqlite3 (single SQLite file shared between bot, web, ws via `DATABASE_PATH`)
- vitest for tests
- Socket.IO — `packages/ws`

**Out of scope (deferred):**
- Auth between web and bot beyond shared-secret HMAC.
- Rewriting the WS server's `pick:card` placeholder (covered by existing draft REST flow).
- Replacing the random-byes choice in single-elim with seeding logic.

---

## File Structure

### Files created

| Path | Purpose |
|---|---|
| `packages/web/app/api/matches/[id]/approve/route.ts` | POST endpoint: opponent approves a tournament/casual match. |
| `packages/web/app/api/matches/[id]/deny/route.ts` | POST endpoint: opponent denies a tournament/casual match. |
| `packages/web/src/components/tournament/match-approval-controls.tsx` | Client UI for opponent to approve/deny a `pending_approval` tournament match. |
| `packages/bot/src/announce/server.ts` | Tiny HTTP server inside the bot exposing `/internal/announce/*` endpoints with HMAC auth. |
| `packages/bot/src/announce/auth.ts` | `verifyAnnounceSignature(body, signatureHeader, secret)` HMAC helper. |
| `packages/web/src/lib/announce-bot.ts` | Web-side client that signs and POSTs to the bot announce server (with retry). |
| `packages/shared/src/util/web-slug.ts` | Single `generateWebSlug()` source of truth (replaces three near-duplicates). |
| `packages/bot/tests/announce/server.test.ts` | Tests for the bot announce HTTP server. |
| `packages/bot/tests/announce/auth.test.ts` | Tests for HMAC verification helper. |
| `packages/web/tests/announce-bot.test.ts` | Tests for the web announce client (mocked fetch). |
| `packages/web/tests/api/tournaments-route.test.ts` | Route-level test for `POST /api/tournaments` going through `tournamentService`. |
| `packages/web/tests/api/tournaments-id-route.test.ts` | Route-level test for `POST /api/tournaments/[slug]` (start) using slug lookup. |
| `packages/web/tests/api/tournaments-report-route.test.ts` | Route test that web report writes `status='pending'`. |
| `packages/web/tests/api/match-approve-route.test.ts` | Route test for the new approve endpoint. |
| `packages/web/tests/api/dashboard-stats.test.ts` | Asserts dashboard stats count `approved` matches. |

### Files moved

| From | To |
|---|---|
| `packages/web/app/(app)/tournament/[id]/page.tsx` | `packages/web/app/(app)/tournament/[slug]/page.tsx` |
| `packages/web/app/(app)/tournament/[id]/standings/page.tsx` | `packages/web/app/(app)/tournament/[slug]/standings/page.tsx` |
| `packages/web/app/api/tournaments/[id]/route.ts` | `packages/web/app/api/tournaments/[slug]/route.ts` |
| `packages/web/app/api/tournaments/[id]/join/route.ts` | `packages/web/app/api/tournaments/[slug]/join/route.ts` |
| `packages/web/app/api/tournaments/[id]/report/route.ts` | `packages/web/app/api/tournaments/[slug]/report/route.ts` |
| `packages/web/app/api/tournaments/[id]/standings/route.ts` | `packages/web/app/api/tournaments/[slug]/standings/route.ts` |

### Files modified

| Path | Reason |
|---|---|
| `packages/shared/src/db/schema.ts` | Backfill `web_slug` for legacy tournament rows during `migrate`. |
| `packages/shared/src/services/drafts.ts` | Use shared `generateWebSlug` helper. |
| `packages/shared/src/tournaments/formats.ts` | Replace round-robin "one match per round" with circle-method scheduling; rename `generateSingleElimFirstRound` → `pairWithByes` and add a back-compat re-export. |
| `packages/bot/src/tournaments/formats.ts` | Re-export the new shared helpers (single source of truth). |
| `packages/bot/src/services/tournaments.ts` | Use shared `generateWebSlug`; add status guard on `cancel`; add `completeIfAllMatchesDone`. |
| `packages/bot/src/services/matches.ts` | Guard `completeTournamentMatch` against non-active tournaments; add round-robin auto-completion via `tournamentService.completeIfAllMatchesDone`. |
| `packages/bot/src/index.ts` | Boot the announce HTTP server. |
| `packages/web/src/components/tournament/tournament-card.tsx` | Link by `webSlug`, not numeric id. |
| `packages/web/src/components/tournament/create-tournament-form.tsx` | Already links by slug — keep, but adjust fallback. |
| `packages/web/app/(app)/tournament/[slug]/page.tsx` | Drive UI off slug; surface `status='pending_approval'` approve/deny controls for the opponent; pass `tournamentSlug` to the report POST. |
| `packages/web/app/api/tournaments/route.ts` | Use `tournamentService.create`; on success, fire announce. |
| `packages/web/app/api/tournaments/[slug]/route.ts` | Look up by `web_slug`; use `tournamentService.start`; on success, fire announce. |
| `packages/web/app/api/tournaments/[slug]/join/route.ts` | Look up by slug. |
| `packages/web/app/api/tournaments/[slug]/report/route.ts` | Use `'pending'` not `'pending_approval'`; use `matchService.report`-equivalent path. |
| `packages/web/app/api/tournaments/[slug]/standings/route.ts` | Look up by slug. |
| `packages/web/app/api/dashboard/route.ts` | Filter `status = 'approved'` for lifetime stats. |
| `packages/web/app/api/drafts/route.ts` | After create, fire announce (draft-created). |
| `packages/web/app/api/drafts/[slug]/route.ts` | After start (POST), fire announce (draft-started). |
| `packages/web/src/lib/env.ts` | Add `botAnnounceUrl`, `botAnnounceSecret` env vars. |
| `packages/bot/tests/services/tournaments.test.ts` | Cover cancel guard + auto-completion. |
| `packages/bot/tests/services/matches.test.ts` | Cover approve-after-cancel guard. |
| `packages/bot/tests/services/tournament-reporting.test.ts` | Cover round-robin auto-completion. |
| `packages/bot/tests/tournaments/formats.test.ts` | Cover real round-robin scheduling. |

---

## Phases

The plan is split into five phases. Each phase ends with a green build (`pnpm test` or `npm test` per package) and a commit.

- **Phase 0** — Foundation: shared slug helper, schema backfill.
- **Phase 1** — Critical bot↔web fixes: tournament URL slug routing + match-status mismatch + web approve/deny.
- **Phase 2** — Tournament state machine: cancel guard, approve-after-cancel guard, round-robin auto-completion.
- **Phase 3** — Web routes use the shared services.
- **Phase 4** — Bot announce HTTP server + web calls it on draft/tournament create/start.
- **Phase 5** — Quality fixes: real round-robin scheduling, dashboard stats filter.

---

# Phase 0 — Foundation

## Task 0.1: Shared `generateWebSlug` helper

**Files:**
- Create: `packages/shared/src/util/web-slug.ts`
- Create: `packages/shared/tests/util/web-slug.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/util/web-slug.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateWebSlug } from "../../src/util/web-slug.js";

describe("generateWebSlug", () => {
  it("returns an 8-character lowercase alphanumeric slug", () => {
    const slug = generateWebSlug();
    expect(slug).toMatch(/^[a-z0-9]{8}$/);
  });

  it("returns different slugs across calls", () => {
    const slugs = new Set(Array.from({ length: 200 }, () => generateWebSlug()));
    expect(slugs.size).toBeGreaterThan(190);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/shared && npx vitest run tests/util/web-slug.test.ts
```

Expected: FAIL with `Cannot find module '../../src/util/web-slug.js'`.

- [ ] **Step 3: Implement helper**

`packages/shared/src/util/web-slug.ts`:

```ts
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateWebSlug(): string {
  return Array.from(
    { length: 8 },
    () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
  ).join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/shared && npx vitest run tests/util/web-slug.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Replace duplicates in callers**

Edit `packages/shared/src/services/drafts.ts` — remove the local `generateWebSlug` (lines 88–91) and `import { generateWebSlug } from "../util/web-slug.js";` at the top. Update the single call site (around line 145, the `insert into drafts ... web_slug` insert) to use the imported function.

Edit `packages/bot/src/services/tournaments.ts` — remove the local `generateWebSlug` (lines 72–75) and `import { generateWebSlug } from "@yugidraft/shared/util/web-slug";` at the top. The `create()` method already calls it on line 171 — only the source changes.

Edit `packages/web/app/api/tournaments/route.ts` — remove the local `generateWebSlug` (lines 7–10), `import { generateWebSlug } from "@yugidraft/shared/util/web-slug";` at the top. The call site on line 99 is unchanged.

If `@yugidraft/shared/util/web-slug` is not yet exported, add to `packages/shared/package.json` `exports` field:

```json
"./util/web-slug": {
  "import": "./dist/util/web-slug.js",
  "types": "./dist/util/web-slug.d.ts"
}
```

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: PASS (everything green; existing tournament/draft tests still pass because behavior is unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/util/web-slug.ts \
        packages/shared/tests/util/web-slug.test.ts \
        packages/shared/src/services/drafts.ts \
        packages/shared/package.json \
        packages/bot/src/services/tournaments.ts \
        packages/web/app/api/tournaments/route.ts
git commit -m "refactor: centralize generateWebSlug in @yugidraft/shared/util"
```

---

## Task 0.2: Backfill `web_slug` for existing tournaments on migrate

**Files:**
- Modify: `packages/shared/src/db/schema.ts:223`
- Modify: `packages/shared/tests/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/tests/db/schema.test.ts` (inside the existing describe block — read the file first to find the block name and import style; mirror existing test style):

```ts
it("backfills web_slug for tournaments that pre-date the column", () => {
  const db = new Database(":memory:");
  // Simulate legacy schema without web_slug
  db.exec(`
    create table tournaments (
      id integer primary key autoincrement,
      guild_id text not null,
      name text not null,
      format text not null,
      status text not null,
      created_by_user_id text not null,
      created_at text not null default current_timestamp,
      started_at text,
      ended_at text
    );
  `);
  db.prepare(
    "insert into tournaments (guild_id, name, format, status, created_by_user_id) values (?, ?, ?, ?, ?)",
  ).run("g1", "old-event", "round_robin", "completed", "u1");

  migrate(db);

  const row = db
    .prepare("select web_slug from tournaments where name = ?")
    .get("old-event") as { web_slug: string | null };
  expect(row.web_slug).toMatch(/^[a-z0-9]{8}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/shared && npx vitest run tests/db/schema.test.ts
```

Expected: FAIL — `web_slug` is null after migrate (column added but never populated).

- [ ] **Step 3: Add backfill logic in `migrate`**

In `packages/shared/src/db/schema.ts`, immediately after the `addColumnIfMissing(db, "tournaments", "web_slug", "text");` line (currently line 223):

```ts
// Backfill web_slug for any tournament rows that pre-date the column.
const slugless = db
  .prepare("select id from tournaments where web_slug is null")
  .all() as Array<{ id: number }>;
if (slugless.length > 0) {
  const update = db.prepare("update tournaments set web_slug = ? where id = ?");
  for (const { id } of slugless) {
    update.run(generateWebSlug(), id);
  }
}
```

Add to the top of `schema.ts`:

```ts
import { generateWebSlug } from "../util/web-slug.js";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/shared && npx vitest run tests/db/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add a unique index on `tournaments.web_slug`**

In `schema.ts`, inside the second `db.exec(\`...\`)` that already creates `tournaments_current_name_unique`, add:

```sql
create unique index if not exists tournaments_web_slug_unique
on tournaments (web_slug)
where web_slug is not null;
```

(Mirrors the constraint we want for slug-based lookup; partial index allows nulls just in case.)

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/tests/db/schema.test.ts
git commit -m "fix(schema): backfill tournaments.web_slug + add unique index"
```

---

# Phase 1 — Critical bot↔web fixes

## Task 1.1: Move tournament API routes to slug-based segments

**Files:**
- Move (preserve git history with `git mv`):
  - `packages/web/app/api/tournaments/[id]/route.ts` → `packages/web/app/api/tournaments/[slug]/route.ts`
  - `packages/web/app/api/tournaments/[id]/join/route.ts` → `packages/web/app/api/tournaments/[slug]/join/route.ts`
  - `packages/web/app/api/tournaments/[id]/report/route.ts` → `packages/web/app/api/tournaments/[slug]/report/route.ts`
  - `packages/web/app/api/tournaments/[id]/standings/route.ts` → `packages/web/app/api/tournaments/[slug]/standings/route.ts`

- [ ] **Step 1: Move the directory**

```bash
git mv packages/web/app/api/tournaments/\[id\] packages/web/app/api/tournaments/\[slug\]
```

- [ ] **Step 2: Update lookup in `[slug]/route.ts`**

In every handler, replace the `params: Promise<{ id: string }>` typing with `{ slug: string }`, and change `const tournamentId = Number(id);` plus the `where id = ?` queries to look up by `web_slug`. Concretely, replace:

```ts
const { id } = await params;
const tournamentId = Number(id);
// ...
.prepare("select * from tournaments where id = ?")
.get(tournamentId)
```

with a helper near the top of the file:

```ts
async function resolveTournament(
  db: Database.Database,
  slug: string,
): Promise<{ id: number; guild_id: string; name: string; format: string; status: string; created_by_user_id: string; web_slug: string | null } | undefined> {
  return db
    .prepare("select * from tournaments where web_slug = ?")
    .get(slug) as any;
}
```

…and call it: `const tournament = await resolveTournament(db, slug); if (!tournament) return 404; const tournamentId = tournament.id;`. Use `tournamentId` for FK queries (`tournament_participants`, `tournament_matches`) — those still join on numeric id.

Apply the same pattern to `join/route.ts`, `report/route.ts`, `standings/route.ts`.

- [ ] **Step 3: Write a failing route-level test**

Create `packages/web/tests/api/tournaments-id-route.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("GET /api/tournaments/[slug]", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "user-1", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("looks up tournament by slug, not numeric id", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    // Seed a tournament with a known slug
    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb
      .prepare(
        "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values (?, ?, ?, 'pending', ?, ?)",
      )
      .run("guild-1", "Locals", "round_robin", "user-1", "abcd1234");
    seedDb.close();

    const { GET } = await import("../../app/api/tournaments/[slug]/route");
    const res = await GET(new Request("http://localhost/api/tournaments/abcd1234"), {
      params: Promise.resolve({ slug: "abcd1234" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Locals");
    expect(body.webSlug).toBe("abcd1234");
  });

  it("returns 404 for an unknown slug", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb.close();

    const { GET } = await import("../../app/api/tournaments/[slug]/route");
    const res = await GET(new Request("http://localhost/api/tournaments/missing"), {
      params: Promise.resolve({ slug: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/web && npx vitest run tests/api/tournaments-id-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments \
        packages/web/tests/api/tournaments-id-route.test.ts
git commit -m "fix(web): look up tournaments by web_slug instead of numeric id"
```

---

## Task 1.2: Move tournament pages to slug segment

**Files:**
- `git mv packages/web/app/(app)/tournament/[id] packages/web/app/(app)/tournament/[slug]`
- Modify the moved page files to use `params.slug`.

- [ ] **Step 1: Move the directory**

```bash
git mv "packages/web/app/(app)/tournament/[id]" "packages/web/app/(app)/tournament/[slug]"
```

- [ ] **Step 2: Update `[slug]/page.tsx`**

Replace `useParams()` consumption and every URL construction:

```ts
const params = useParams();
const slug = typeof params.slug === "string" ? params.slug : "";
```

Search the file for every `${id}` template and `\`/api/tournaments/${id}\`` etc., and replace `id` with `slug`. The state-typed `TournamentDetail` (interface at top) should now also expose `webSlug: string` — the GET response already returns it; surface it in the type.

Update the `<Link href={\`/tournament/${id}/standings\`}>` usages to `\`/tournament/${slug}/standings\``.

Apply the same edits to `standings/page.tsx`.

- [ ] **Step 3: Update tournament-card link**

In `packages/web/src/components/tournament/tournament-card.tsx:31`:

```tsx
href={`/tournament/${tournament.webSlug}`}
```

Confirm the `Tournament` type passed to this card has `webSlug: string` (the API returns it; if the local interface omits it, add the field).

- [ ] **Step 4: Verify create-tournament-form already routes to slug**

`packages/web/src/components/tournament/create-tournament-form.tsx:63` should already do `router.push(\`/tournament/${tournament.webSlug}\`)`. If `webSlug` can be `undefined` in the response shape, fall back to `/tournaments`. No code change needed if the type matches.

- [ ] **Step 5: Manual verification**

```bash
cd packages/web && npx next build
```

Expected: build succeeds with no `[id]` route stragglers.

```bash
cd packages/web && npx next dev
```

In a browser, visit `/tournaments`, click a card, and confirm URL is `/tournament/<slug>` and the page renders.

- [ ] **Step 6: Commit**

```bash
git add packages/web/app/\(app\)/tournament \
        packages/web/src/components/tournament/tournament-card.tsx
git commit -m "fix(web): route tournament pages by web_slug"
```

---

## Task 1.3: Web tournament report writes `status='pending'` (not `'pending_approval'`)

**Files:**
- Modify: `packages/web/app/api/tournaments/[slug]/report/route.ts:111`
- Test: `packages/web/tests/api/tournaments-report-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/tournaments/[slug]/report", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("inserts the new match row with status='pending' so the bot's approve flow can find it", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "report-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const { migrate } = await import("../../../shared/src/db/schema");
    const seed = new Database(dbPath);
    migrate(seed);

    seed.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)")
      .run("guild-1", "user-1", "Yugi");
    seed.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)")
      .run("guild-1", "user-2", "Kaiba");
    const yugiId = (seed.prepare("select id from players where discord_user_id='user-1'").get() as any).id;
    const kaibaId = (seed.prepare("select id from players where discord_user_id='user-2'").get() as any).id;

    seed.prepare(
      "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values (?, ?, ?, 'active', ?, ?)",
    ).run("guild-1", "Locals", "round_robin", "user-1", "slug1234");
    const tId = (seed.prepare("select id from tournaments where web_slug='slug1234'").get() as any).id;

    seed.prepare(
      "insert into tournament_matches (tournament_id, player_one_id, player_two_id, round_number, status, metadata_json) values (?, ?, ?, 1, 'open', '{}')",
    ).run(tId, yugiId, kaibaId);
    const tmId = (seed.prepare("select id from tournament_matches where tournament_id=?").get(tId) as any).id;
    seed.close();

    auth.mockResolvedValue({ user: { id: "user-1", name: "Yugi" } });

    const { POST } = await import("../../app/api/tournaments/[slug]/report/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug1234/report", {
        method: "POST",
        body: JSON.stringify({ tournamentMatchId: tmId, result: "win" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ slug: "slug1234" }) },
    );
    expect(res.status).toBe(200);

    const verify = new Database(dbPath);
    const matchRow = verify.prepare("select status from matches order by id desc limit 1").get() as any;
    expect(matchRow.status).toBe("pending");
    verify.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/web && npx vitest run tests/api/tournaments-report-route.test.ts
```

Expected: FAIL with `expected 'pending_approval' to be 'pending'`.

- [ ] **Step 3: Fix the route**

In `packages/web/app/api/tournaments/[slug]/report/route.ts`, find the insert statement (currently line ~107):

```ts
insert into matches (
  guild_id, player_one_id, player_two_id, winner_id,
  reporter_id, status, source, tournament_id
) values (?, ?, ?, ?, ?, 'pending_approval', 'tournament', ?)
```

Replace `'pending_approval'` with `'pending'`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/web && npx vitest run tests/api/tournaments-report-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/\[slug\]/report/route.ts \
        packages/web/tests/api/tournaments-report-route.test.ts
git commit -m "fix(web): use 'pending' match status so bot approval path can resolve web reports"
```

---

## Task 1.4: Web `POST /api/matches/[id]/approve` endpoint

**Files:**
- Create: `packages/web/app/api/matches/[id]/approve/route.ts`
- Create: `packages/web/tests/api/match-approve-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function seedPendingMatch(dbPath: string) {
  const { migrate } = await import("../../../shared/src/db/schema");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u1','Yugi')").run();
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u2','Kaiba')").run();
  const p1 = (db.prepare("select id from players where discord_user_id='u1'").get() as any).id;
  const p2 = (db.prepare("select id from players where discord_user_id='u2'").get() as any).id;
  db.prepare(
    "insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source) values ('g1', ?, ?, ?, ?, 'pending', 'casual')",
  ).run(p1, p2, p1, p1);
  const matchId = (db.prepare("select id from matches order by id desc limit 1").get() as any).id;
  db.close();
  return { matchId };
}

describe("POST /api/matches/[id]/approve", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("approves a pending match when called by the opponent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "approve-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "g1";
    const { matchId } = await seedPendingMatch(dbPath);
    auth.mockResolvedValue({ user: { id: "u2", name: "Kaiba" } });

    const { POST } = await import("../../app/api/matches/[id]/approve/route");
    const res = await POST(new Request(`http://localhost/api/matches/${matchId}/approve`, { method: "POST" }), {
      params: Promise.resolve({ id: String(matchId) }),
    });
    expect(res.status).toBe(200);

    const verify = new Database(dbPath);
    const match = verify.prepare("select status from matches where id = ?").get(matchId) as any;
    verify.close();
    expect(match.status).toBe("approved");
  });

  it("rejects approval from the reporter (only opponent may approve)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "approve-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "g1";
    const { matchId } = await seedPendingMatch(dbPath);
    auth.mockResolvedValue({ user: { id: "u1", name: "Yugi" } });

    const { POST } = await import("../../app/api/matches/[id]/approve/route");
    const res = await POST(new Request(`http://localhost/api/matches/${matchId}/approve`, { method: "POST" }), {
      params: Promise.resolve({ id: String(matchId) }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/web && npx vitest run tests/api/match-approve-route.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

`packages/web/app/api/matches/[id]/approve/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createMatchService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const matchId = Number(id);
  if (!Number.isInteger(matchId)) {
    return NextResponse.json({ error: "Invalid match id" }, { status: 400 });
  }

  const db = getDb();
  const match = db
    .prepare("select id, guild_id, player_one_id, player_two_id, reporter_id, status from matches where id = ?")
    .get(matchId) as
    | { id: number; guild_id: string; player_one_id: number; player_two_id: number; reporter_id: number; status: string }
    | undefined;

  if (!match) {
    return NextResponse.json({ error: "Match not found" }, { status: 404 });
  }

  const opponentDbId =
    match.reporter_id === match.player_one_id ? match.player_two_id : match.player_one_id;
  const sessionPlayer = db
    .prepare("select id from players where guild_id = ? and discord_user_id = ?")
    .get(match.guild_id, session.user.id) as { id: number } | undefined;

  if (!sessionPlayer || sessionPlayer.id !== opponentDbId) {
    return NextResponse.json({ error: "Only the opponent can approve this match" }, { status: 403 });
  }

  try {
    const matches = createMatchService(db);
    const approved = matches.approve(matchId, sessionPlayer.id);
    return NextResponse.json({ id: approved.id, status: approved.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approve failed" },
      { status: 400 },
    );
  }
}
```

`createMatchService` lives in `packages/shared/src/services/index.ts`. If it isn't currently exported there, add it to the bot service first by creating a thin re-export — but the bot's `MatchService` is in `packages/bot/src/services/matches.ts`. To keep the web off the bot package, **promote** `matches.ts` into shared first if needed. Concretely:

If `@yugidraft/shared/services` does not export `createMatchService`, do this sub-task:

1. `git mv packages/bot/src/services/matches.ts packages/shared/src/services/matches.ts`.
2. Update its import paths (replace `../tournaments/formats.js` with `../tournaments/formats.js` — same relative path inside shared).
3. Add `export { createMatchService } from "./matches.js";` to `packages/shared/src/services/index.ts`.
4. In `packages/bot/src/services/matches.ts` (now deleted) — replace any bot-side imports with `import { createMatchService } from "@yugidraft/shared/services";`. Update `packages/bot/src/index.ts:48` and `packages/bot/src/interactions/buttons.ts:17`.
5. Run `npm test`.

(This sub-task is a precondition for Tasks 1.4, 2.x, 3.x; skip the move if `createMatchService` is already exported from shared.)

- [ ] **Step 4: Run tests**

```bash
cd packages/web && npx vitest run tests/api/match-approve-route.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/matches \
        packages/web/tests/api/match-approve-route.test.ts \
        packages/shared/src/services packages/bot/src
git commit -m "feat(web): add POST /api/matches/[id]/approve via shared matchService"
```

---

## Task 1.5: Web `POST /api/matches/[id]/deny` endpoint

**Files:**
- Create: `packages/web/app/api/matches/[id]/deny/route.ts`
- Modify: `packages/web/tests/api/match-approve-route.test.ts` (add deny case) — or create `tests/api/match-deny-route.test.ts`.

- [ ] **Step 1: Write the failing test**

`packages/web/tests/api/match-deny-route.test.ts` (mirror the approve tests):

```ts
// ... same harness as approve test ...
describe("POST /api/matches/[id]/deny", () => {
  it("denies a pending match when called by the opponent and reopens the tournament_match", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "deny-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "g1";

    // seed players + tournament_match + matches row exactly like the report test
    const { migrate } = await import("../../../shared/src/db/schema");
    const db = new Database(dbPath);
    migrate(db);
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u1','Yugi')").run();
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u2','Kaiba')").run();
    const p1 = (db.prepare("select id from players where discord_user_id='u1'").get() as any).id;
    const p2 = (db.prepare("select id from players where discord_user_id='u2'").get() as any).id;
    db.prepare(
      "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','Locals','round_robin','active','u1','slug1234')",
    ).run();
    const tId = (db.prepare("select id from tournaments where web_slug='slug1234'").get() as any).id;
    db.prepare(
      "insert into tournament_matches (tournament_id, player_one_id, player_two_id, round_number, status, metadata_json) values (?, ?, ?, 1, 'pending_approval', '{}')",
    ).run(tId, p1, p2);
    const tmId = (db.prepare("select id from tournament_matches order by id desc limit 1").get() as any).id;
    db.prepare(
      "insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source, tournament_id) values ('g1', ?, ?, ?, ?, 'pending', 'tournament', ?)",
    ).run(p1, p2, p1, p1, tId);
    const mId = (db.prepare("select id from matches order by id desc limit 1").get() as any).id;
    db.prepare("update tournament_matches set match_id = ? where id = ?").run(mId, tmId);
    db.close();

    auth.mockResolvedValue({ user: { id: "u2", name: "Kaiba" } });
    const { POST } = await import("../../app/api/matches/[id]/deny/route");
    const res = await POST(new Request(`http://localhost/api/matches/${mId}/deny`, { method: "POST" }), {
      params: Promise.resolve({ id: String(mId) }),
    });
    expect(res.status).toBe(200);

    const verify = new Database(dbPath);
    const match = verify.prepare("select status from matches where id = ?").get(mId) as any;
    const tm = verify.prepare("select status, match_id from tournament_matches where id = ?").get(tmId) as any;
    verify.close();
    expect(match.status).toBe("denied");
    expect(tm.status).toBe("open");
    expect(tm.match_id).toBeNull();
  });
});
```

- [ ] **Step 2: Verify it fails**

```bash
cd packages/web && npx vitest run tests/api/match-deny-route.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement deny route**

`packages/web/app/api/matches/[id]/deny/route.ts` — duplicate of approve route except call `matches.deny(matchId, sessionPlayer.id)`.

- [ ] **Step 4: Run tests**

```bash
cd packages/web && npx vitest run tests/api/match-deny-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/matches/\[id\]/deny \
        packages/web/tests/api/match-deny-route.test.ts
git commit -m "feat(web): add POST /api/matches/[id]/deny via shared matchService"
```

---

## Task 1.6: Tournament page surfaces approve/deny controls

**Files:**
- Create: `packages/web/src/components/tournament/match-approval-controls.tsx`
- Modify: `packages/web/app/(app)/tournament/[slug]/page.tsx`

- [ ] **Step 1: Add the `Match` shape to expose the underlying match id**

In `packages/web/app/api/tournaments/[slug]/route.ts`, the GET handler already left-joins `matches` and exposes `winner_id`, `reporter_id`. Confirm `matchId` (from `tm.match_id`) is also returned per match. (It already is — line 76 in the original file: `matchId: row.match_id`.) No change needed.

- [ ] **Step 2: Build the approval controls component**

`packages/web/src/components/tournament/match-approval-controls.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function MatchApprovalControls({
  matchId,
  onResolved,
}: {
  matchId: number;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: "approve" | "deny") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${matchId}/${action}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed to ${action}`);
      }
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-accent-cta">{error}</span>}
      <Button size="sm" variant="primary" loading={busy === "approve"} onClick={() => call("approve")}>
        Approve
      </Button>
      <Button size="sm" variant="danger" loading={busy === "deny"} onClick={() => call("deny")}>
        Deny
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Render the controls in the tournament page**

In `packages/web/app/(app)/tournament/[slug]/page.tsx`, inside `MatchCard`, where the status badge is rendered:

```tsx
{getStatusBadge()}
{isOpen && !isReporting && (
  <Button variant="primary" size="sm" onClick={onReport}>Report</Button>
)}
{isPendingApproval && match.matchId && currentUserPlayerId !== match.reporterId && (
  <MatchApprovalControls matchId={match.matchId} onResolved={onReported} />
)}
```

This requires `MatchCard` to know the current viewer's `playerId`. Two options:
1. Pass `currentUserPlayerId` from the page down.
2. Add `currentUserPlayerId` to the GET response.

Implement option 2: in `app/api/tournaments/[slug]/route.ts`, replace the `isParticipant` block with a richer one that also returns `currentUserPlayerId: number | null`. Update the page's `TournamentDetail` type and pass it into each `MatchCard`.

- [ ] **Step 4: Manual verification**

```bash
cd packages/web && npx next dev
```

In a browser:
1. As user A (creator): create tournament, start, then as user B click Report → "I won".
2. As user A: refresh — match should now be "Pending Approval" with Approve / Deny buttons.
3. Click Approve. Status should become "Completed".
4. Repeat with Deny — match should reset to "Open" so player B can re-report.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/match-approval-controls.tsx \
        packages/web/app/\(app\)/tournament/\[slug\]/page.tsx \
        packages/web/app/api/tournaments/\[slug\]/route.ts
git commit -m "feat(web): show approve/deny controls for tournament match opponent"
```

---

# Phase 2 — Tournament state-machine fixes

## Task 2.1: `tournamentService.cancel` rejects non-active tournaments

**Files:**
- Modify: `packages/bot/src/services/tournaments.ts:578`
- Modify: `packages/bot/tests/services/tournaments.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/bot/tests/services/tournaments.test.ts`:

```ts
it("refuses to cancel a tournament that is already completed", () => {
  const app = setup();
  const t = app.tournaments.create("g1", "Locals", "round_robin", "u1");
  app.tournaments["__db__"]; // not used; we cancel via raw status to simulate completed
  // Mark completed via a SQL hop
  const db = (app.tournaments as any);
  // Easier: cancel once, then try cancelling again
  const yugi = app.players.upsert("g1", "u1", "Yugi");
  const kaiba = app.players.upsert("g1", "u2", "Kaiba");
  app.tournaments.join(t.id, yugi.id);
  app.tournaments.join(t.id, kaiba.id);
  app.tournaments.start(t.id);
  app.tournaments.cancel(t.id);

  expect(() => app.tournaments.cancel(t.id)).toThrow(/cannot be cancelled/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/bot && npx vitest run tests/services/tournaments.test.ts
```

Expected: FAIL — `cancel` runs without error.

- [ ] **Step 3: Add the guard**

In `packages/bot/src/services/tournaments.ts`, inside `cancel`:

```ts
cancel(tournamentId: number): Tournament {
  const tournament = findById(tournamentId);
  if (tournament.status !== "pending" && tournament.status !== "active") {
    throw new Error(`Tournament cannot be cancelled in status '${tournament.status}'`);
  }

  db.prepare(
    "update tournaments set status = 'cancelled', ended_at = current_timestamp where id = ?",
  ).run(tournamentId);

  return findById(tournamentId);
},
```

- [ ] **Step 4: Run tests**

```bash
cd packages/bot && npx vitest run tests/services/tournaments.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/services/tournaments.ts \
        packages/bot/tests/services/tournaments.test.ts
git commit -m "fix(tournaments): guard cancel against non-pending/active tournaments"
```

---

## Task 2.2: `completeTournamentMatch` skips non-active tournaments

**Files:**
- Modify: `packages/bot/src/services/matches.ts:78` (or shared/services/matches.ts after Task 1.4)
- Modify: `packages/bot/tests/services/matches.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/bot/tests/services/matches.test.ts`:

```ts
it("does not advance or complete a tournament that is no longer active", () => {
  const app = setup();
  const t = app.tournaments.create("g1", "Locals", "single_elim", "u1");
  const yugi = app.players.upsert("g1", "u1", "Yugi");
  const kaiba = app.players.upsert("g1", "u2", "Kaiba");
  app.tournaments.join(t.id, yugi.id);
  app.tournaments.join(t.id, kaiba.id);
  app.tournaments.start(t.id);

  const tm = app.tournaments.openMatches(t.id)[0];
  const reported = app.tournaments.reportTournamentMatch(tm.id, yugi.id, yugi.id);

  // Cancel the tournament before approval
  app.tournaments.cancel(t.id);

  app.matches.approve(reported.id, kaiba.id);

  // tournament_matches should NOT be marked completed
  const tournament = app.tournaments.findById(t.id);
  expect(tournament.status).toBe("cancelled");
  const tmAfter = app.tournaments.findTournamentMatchById(tm.id);
  expect(tmAfter.status).not.toBe("completed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — without the guard, `completeTournamentMatch` flips the tournament to `'completed'` and the test asserts `'cancelled'`.

- [ ] **Step 3: Add guard**

In `completeTournamentMatch`, immediately after fetching the tournament:

```ts
const tournament = db
  .prepare("select * from tournaments where id = ?")
  .get(match.tournamentId) as any;

if (!tournament || tournament.status !== "active") {
  return;
}
```

(The single-elim early-return at the next line stays; this new guard runs first.)

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/services/matches.ts packages/bot/tests/services/matches.test.ts
git commit -m "fix(matches): skip tournament_match completion when tournament not active"
```

---

## Task 2.3: Round-robin auto-completion via `tournamentService.completeIfAllMatchesDone`

**Files:**
- Modify: `packages/bot/src/services/tournaments.ts`
- Modify: `packages/bot/src/services/matches.ts:78`
- Modify: `packages/bot/tests/services/tournaments.test.ts`
- Modify: `packages/bot/tests/services/tournament-reporting.test.ts`

- [ ] **Step 1: Write the failing test (round-robin completion)**

In `packages/bot/tests/services/tournament-reporting.test.ts`, add:

```ts
it("auto-completes a round-robin tournament when the last match is approved", () => {
  const app = setup();
  const t = app.tournaments.create("g1", "Locals", "round_robin", "u1");
  const yugi = app.players.upsert("g1", "u1", "Yugi");
  const kaiba = app.players.upsert("g1", "u2", "Kaiba");
  app.tournaments.join(t.id, yugi.id);
  app.tournaments.join(t.id, kaiba.id);
  app.tournaments.start(t.id);

  const tm = app.tournaments.openMatches(t.id)[0];
  const reported = app.tournaments.reportTournamentMatch(tm.id, yugi.id, yugi.id);
  app.matches.approve(reported.id, kaiba.id);

  expect(app.tournaments.findById(t.id).status).toBe("completed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `status` stays `'active'`.

- [ ] **Step 3: Add `completeIfAllMatchesDone` to the tournament service**

In `packages/bot/src/services/tournaments.ts`, inside the returned object:

```ts
completeIfAllMatchesDone(tournamentId: number): Tournament {
  const tournament = findById(tournamentId);
  if (tournament.status !== "active") return tournament;

  const remaining = db
    .prepare(
      "select count(*) as count from tournament_matches where tournament_id = ? and status != 'completed'",
    )
    .get(tournamentId) as { count: number };

  if (remaining.count > 0) return tournament;

  db.prepare(
    "update tournaments set status = 'completed', ended_at = current_timestamp where id = ?",
  ).run(tournamentId);
  return findById(tournamentId);
},
```

- [ ] **Step 4: Wire it from `completeTournamentMatch`**

In `packages/bot/src/services/matches.ts`, at the end of `completeTournamentMatch`, after the single-elim advancement block — but ALSO call it on the round-robin path. The simplest structural change: after the `update tournament_matches set status = 'completed'` block, run a unified check:

```ts
// Unified completion check (covers round-robin and "no advancement needed" cases)
const allDone = db
  .prepare(
    "select count(*) as count from tournament_matches where tournament_id = ? and status != 'completed'",
  )
  .get(match.tournamentId) as { count: number };

if (allDone.count === 0) {
  db.prepare(
    "update tournaments set status = 'completed', ended_at = current_timestamp where id = ?",
  ).run(match.tournamentId);
  return;
}
```

Place this **before** the `tournament.format !== "single_elim"` early-return so that round-robin can complete. The single-elim block below continues to handle round advancement specifically.

(Note: this duplicates the logic in `tournamentService.completeIfAllMatchesDone`. To avoid drift, refactor `completeTournamentMatch` to call into the service instead — but matchService and tournamentService both live in the bot package and don't import each other today. Either inject `tournamentService` or duplicate the SQL. Pick duplication for now; it's three lines.)

- [ ] **Step 5: Run tests**

```bash
cd packages/bot && npx vitest run tests/services/tournament-reporting.test.ts tests/services/matches.test.ts
```

Expected: PASS, including all existing single-elim tests.

- [ ] **Step 6: Commit**

```bash
git add packages/bot/src/services/tournaments.ts \
        packages/bot/src/services/matches.ts \
        packages/bot/tests/services/tournament-reporting.test.ts
git commit -m "fix(tournaments): auto-complete round-robin when last match is approved"
```

---

# Phase 3 — Web routes use shared services

## Task 3.1: `POST /api/tournaments` uses `tournamentService.create`

**Files:**
- Modify: `packages/web/app/api/tournaments/route.ts:62-113`
- Create: `packages/web/tests/api/tournaments-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/tournaments", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u1", name: "Yugi" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("rejects creating a duplicate active tournament name", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "create-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "g1";

    const { POST } = await import("../../app/api/tournaments/route");

    const first = await POST(new Request("http://localhost/api/tournaments", {
      method: "POST",
      body: JSON.stringify({ name: "Locals", format: "round_robin" }),
      headers: { "content-type": "application/json" },
    }));
    expect(first.status).toBe(201);

    const second = await POST(new Request("http://localhost/api/tournaments", {
      method: "POST",
      body: JSON.stringify({ name: "Locals", format: "round_robin" }),
      headers: { "content-type": "application/json" },
    }));
    expect(second.status).toBe(400);
    const body = await second.json();
    expect(body.error).toMatch(/already uses that name/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — current raw INSERT lets the duplicate through (it would only fail on the partial unique index in the same status).

- [ ] **Step 3: Refactor the route**

Replace the body of `POST` in `packages/web/app/api/tournaments/route.ts`:

```ts
const db = getDb();
const players = createPlayerService(db);
players.findOrCreate(guildId, session.user.id, session.user.name ?? "Unknown");

const tournaments = createTournamentService(db);
let tournament;
try {
  tournament = tournaments.create(guildId, name, format as TournamentFormat, session.user.id);
} catch (error) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Failed to create tournament" },
    { status: 400 },
  );
}

return NextResponse.json(
  {
    id: tournament.id,
    name: tournament.name,
    format: tournament.format,
    status: tournament.status,
    webSlug: tournament.webSlug,
  },
  { status: 201 },
);
```

Add imports:

```ts
import { createTournamentService, type TournamentFormat } from "@yugidraft/shared/services";
```

(Promote `createTournamentService` from bot to shared if not already there — same approach as Task 1.4 for matches. If you do this move, the bot's `index.ts:49` import becomes `import { createTournamentService } from "@yugidraft/shared/services";`.)

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/tournaments/route.ts \
        packages/web/tests/api/tournaments-route.test.ts \
        packages/shared/src/services packages/bot/src
git commit -m "refactor(web): create tournaments via shared tournamentService"
```

---

## Task 3.2: `POST /api/tournaments/[slug]` (start) uses `tournamentService.start`

**Files:**
- Modify: `packages/web/app/api/tournaments/[slug]/route.ts:232-307`
- Create test: `packages/web/tests/api/tournaments-start-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("starts a tournament with at least 2 participants and returns 'active'", async () => {
  // seed pending tournament + 2 participants where creator = u1
  // ... (setup similar to other route tests) ...
  auth.mockResolvedValue({ user: { id: "u1", name: "Yugi" } });
  const { POST } = await import("../../app/api/tournaments/[slug]/route");
  const res = await POST(new Request("http://localhost/api/tournaments/slug1234", { method: "POST" }), {
    params: Promise.resolve({ slug: "slug1234" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("active");
});

it("rejects start with fewer than 2 participants", async () => {
  // seed tournament with 0 participants
  // ...
  const res = await POST(new Request("http://localhost/api/tournaments/slug1234", { method: "POST" }), {
    params: Promise.resolve({ slug: "slug1234" }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Replace the start handler with a service call**

```ts
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { slug } = await params;
  const db = getDb();
  const tournament = db
    .prepare("select id, created_by_user_id, status from tournaments where web_slug = ?")
    .get(slug) as { id: number; created_by_user_id: string; status: string } | undefined;
  if (!tournament) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
  if (tournament.created_by_user_id !== session.user.id)
    return NextResponse.json({ error: "Only the tournament creator can start it" }, { status: 403 });

  try {
    const tournaments = createTournamentService(db);
    const started = tournaments.start(tournament.id);
    return NextResponse.json({ id: started.id, status: started.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start" },
      { status: 400 },
    );
  }
}
```

Delete the old `generateRoundRobin`/`generateSingleElimFirstRound` imports in this file.

- [ ] **Step 3: Run tests**

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/app/api/tournaments/\[slug\]/route.ts \
        packages/web/tests/api/tournaments-start-route.test.ts
git commit -m "refactor(web): start tournaments via shared tournamentService"
```

---

# Phase 4 — Bot announce HTTP server

> **Design note (locked):** the web sends signed POSTs to a small HTTP server on the bot process. Auth is `X-Announce-Signature: sha256=<hex>` over the raw body using a shared secret env var `BOT_ANNOUNCE_SECRET`. This avoids running Discord client code inside Next.js and keeps the bot as the single owner of the Discord connection.

## Task 4.1: HMAC verification helper

**Files:**
- Create: `packages/bot/src/announce/auth.ts`
- Create: `packages/bot/tests/announce/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAnnounceSignature } from "../../src/announce/auth.js";

const secret = "test-secret";
function sign(body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyAnnounceSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"hello":"world"}';
    expect(verifyAnnounceSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyAnnounceSignature("{}", "sha256=deadbeef", secret)).toBe(false);
  });

  it("rejects when secret is missing", () => {
    expect(verifyAnnounceSignature("{}", sign("{}"), "")).toBe(false);
  });

  it("rejects malformed signature header", () => {
    expect(verifyAnnounceSignature("{}", "garbage", secret)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/bot && npx vitest run tests/announce/auth.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement helper**

```ts
// packages/bot/src/announce/auth.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyAnnounceSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/announce/auth.ts packages/bot/tests/announce/auth.test.ts
git commit -m "feat(bot): add HMAC verification for internal announce endpoints"
```

---

## Task 4.2: Bot announce HTTP server

**Files:**
- Create: `packages/bot/src/announce/server.ts`
- Create: `packages/bot/tests/announce/server.test.ts`
- Modify: `packages/bot/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/bot/tests/announce/server.test.ts
import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createAnnounceServer } from "../../src/announce/server.js";

const secret = "shh";
function sign(body: string) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("announce server", () => {
  it("rejects requests without a valid signature", async () => {
    const handler = vi.fn();
    const app = createAnnounceServer({
      secret,
      handlers: { onDraftCreated: handler, onDraftStarted: handler, onTournamentCreated: handler, onTournamentStarted: handler },
    });
    const res = await app.handle(new Request("http://x/internal/announce/draft-created", {
      method: "POST",
      headers: { "content-type": "application/json", "x-announce-signature": "sha256=00" },
      body: "{}",
    }));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches draft-created to the registered handler when signature matches", async () => {
    const onDraftCreated = vi.fn().mockResolvedValue(undefined);
    const app = createAnnounceServer({
      secret,
      handlers: {
        onDraftCreated,
        onDraftStarted: vi.fn(),
        onTournamentCreated: vi.fn(),
        onTournamentStarted: vi.fn(),
      },
    });
    const body = JSON.stringify({ draftId: 1, channelId: "c1", name: "Test", webSlug: "abcd1234" });
    const res = await app.handle(new Request("http://x/internal/announce/draft-created", {
      method: "POST",
      headers: { "content-type": "application/json", "x-announce-signature": sign(body) },
      body,
    }));
    expect(res.status).toBe(204);
    expect(onDraftCreated).toHaveBeenCalledWith({ draftId: 1, channelId: "c1", name: "Test", webSlug: "abcd1234" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the server**

```ts
// packages/bot/src/announce/server.ts
import { createServer, type Server } from "node:http";
import { verifyAnnounceSignature } from "./auth.js";

export type AnnouncePayload =
  | { kind: "draft-created"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "draft-started"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "tournament-created"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string }
  | { kind: "tournament-started"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string };

export interface AnnounceHandlers {
  onDraftCreated(payload: Extract<AnnouncePayload, { kind: "draft-created" }>): Promise<void>;
  onDraftStarted(payload: Extract<AnnouncePayload, { kind: "draft-started" }>): Promise<void>;
  onTournamentCreated(payload: Extract<AnnouncePayload, { kind: "tournament-created" }>): Promise<void>;
  onTournamentStarted(payload: Extract<AnnouncePayload, { kind: "tournament-started" }>): Promise<void>;
}

export function createAnnounceServer(opts: {
  secret: string;
  handlers: AnnounceHandlers;
}) {
  const routes: Record<string, (data: any) => Promise<void>> = {
    "/internal/announce/draft-created": (d) => opts.handlers.onDraftCreated({ kind: "draft-created", ...d }),
    "/internal/announce/draft-started": (d) => opts.handlers.onDraftStarted({ kind: "draft-started", ...d }),
    "/internal/announce/tournament-created": (d) => opts.handlers.onTournamentCreated({ kind: "tournament-created", ...d }),
    "/internal/announce/tournament-started": (d) => opts.handlers.onTournamentStarted({ kind: "tournament-started", ...d }),
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || !routes[url.pathname]) {
      return new Response("Not found", { status: 404 });
    }
    const body = await req.text();
    if (!verifyAnnounceSignature(body, req.headers.get("x-announce-signature") ?? undefined, opts.secret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }
    try {
      await routes[url.pathname](parsed);
      return new Response(null, { status: 204 });
    } catch (err) {
      console.error(`[announce] handler failed for ${url.pathname}:`, err);
      return new Response("Handler error", { status: 500 });
    }
  }

  function listen(port: number): Server {
    const server = createServer(async (nodeReq, nodeRes) => {
      const chunks: Buffer[] = [];
      for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      const url = `http://${nodeReq.headers.host ?? "localhost"}${nodeReq.url ?? "/"}`;
      const res = await handle(new Request(url, {
        method: nodeReq.method,
        headers: nodeReq.headers as any,
        body: buf.length ? buf : undefined,
      }));
      nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
      const text = await res.text();
      nodeRes.end(text);
    });
    server.listen(port, () => console.log(`[announce] listening on :${port}`));
    return server;
  }

  return { handle, listen };
}
```

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Wire it up in `packages/bot/src/index.ts`**

After `client.once("ready", ...)`, add:

```ts
const announceSecret = process.env.BOT_ANNOUNCE_SECRET ?? "";
const announcePort = Number(process.env.BOT_ANNOUNCE_PORT ?? 4001);
if (announceSecret) {
  const server = createAnnounceServer({
    secret: announceSecret,
    handlers: {
      async onDraftCreated({ channelId, name, webSlug }) {
        const channel = await client.channels.fetch(channelId);
        if (channel?.type !== ChannelType.GuildText) return;
        await channel.send(`Signups are open for **${name}**. Pick cards: ${process.env.WEB_URL}/draft/${webSlug}`);
      },
      async onDraftStarted({ channelId, name, webSlug, draftId }) {
        const draft = deps.drafts.findById(draftId);
        await deps.messenger.postStatus(draft);
      },
      async onTournamentCreated({ channelId, name, format, webSlug }) {
        const channel = await client.channels.fetch(channelId);
        if (channel?.type !== ChannelType.GuildText) return;
        await channel.send(`Signups are open for **${name}** (${format}). Manage: ${process.env.WEB_URL}/tournament/${webSlug}`);
      },
      async onTournamentStarted({ channelId, name, webSlug }) {
        const channel = await client.channels.fetch(channelId);
        if (channel?.type !== ChannelType.GuildText) return;
        await channel.send(`**${name}** has started. Bracket: ${process.env.WEB_URL}/tournament/${webSlug}`);
      },
    },
  });
  server.listen(announcePort);
} else {
  console.log("[announce] BOT_ANNOUNCE_SECRET not set; announce HTTP server disabled");
}
```

Add `import { createAnnounceServer } from "./announce/server.js";` at the top.

- [ ] **Step 6: Commit**

```bash
git add packages/bot/src/announce packages/bot/tests/announce \
        packages/bot/src/index.ts
git commit -m "feat(bot): add internal announce HTTP server with HMAC auth"
```

---

## Task 4.3: Web announce client

**Files:**
- Create: `packages/web/src/lib/announce-bot.ts`
- Modify: `packages/web/src/lib/env.ts`
- Create: `packages/web/tests/announce-bot.test.ts`

- [ ] **Step 1: Add env vars**

In `packages/web/src/lib/env.ts`, add fields:

```ts
botAnnounceUrl: process.env.BOT_ANNOUNCE_URL ?? "",  // e.g. http://bot:4001
botAnnounceSecret: process.env.BOT_ANNOUNCE_SECRET ?? "",
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/web/tests/announce-bot.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { announceToBot } from "../src/lib/announce-bot";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("announceToBot", () => {
  beforeEach(() => fetchMock.mockReset());

  it("posts a signed body to the right path", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await announceToBot(
      { url: "http://bot:4001", secret: "shh" },
      { kind: "draft-created", draftId: 1, channelId: "c1", name: "Test", webSlug: "ab12cd34" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("http://bot:4001/internal/announce/draft-created");
    expect(init?.headers?.["x-announce-signature"]).toMatch(/^sha256=[a-f0-9]+$/);
    expect(init?.body).toContain("ab12cd34");
  });

  it("does nothing when url or secret is empty", async () => {
    await announceToBot({ url: "", secret: "shh" }, { kind: "draft-created", draftId: 1, channelId: "c", name: "T", webSlug: "x" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows network errors and logs (does not throw)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      announceToBot({ url: "http://bot:4001", secret: "shh" }, { kind: "draft-started", draftId: 1, channelId: "c", name: "T", webSlug: "x" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Verify failing**

Expected: FAIL — module not found.

- [ ] **Step 4: Implement client**

```ts
// packages/web/src/lib/announce-bot.ts
import { createHmac } from "node:crypto";

export type AnnouncePayload =
  | { kind: "draft-created"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "draft-started"; draftId: number; channelId: string; name: string; webSlug: string }
  | { kind: "tournament-created"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string }
  | { kind: "tournament-started"; tournamentId: number; channelId: string; name: string; format: string; webSlug: string };

export async function announceToBot(
  cfg: { url: string; secret: string },
  payload: AnnouncePayload,
): Promise<void> {
  if (!cfg.url || !cfg.secret) return;
  const { kind, ...data } = payload;
  const body = JSON.stringify(data);
  const sig = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  try {
    const res = await fetch(`${cfg.url}/internal/announce/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-announce-signature": sig,
      },
      body,
    });
    if (!res.ok) {
      console.warn(`[announce-bot] non-2xx for ${kind}: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[announce-bot] failed for ${kind}:`, err);
  }
}
```

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/announce-bot.ts \
        packages/web/src/lib/env.ts \
        packages/web/tests/announce-bot.test.ts
git commit -m "feat(web): add announce-to-bot client (HMAC, fire-and-forget)"
```

---

## Task 4.4: Fire announces from web create/start routes

**Files:**
- Modify: `packages/web/app/api/drafts/route.ts` (after create)
- Modify: `packages/web/app/api/drafts/[slug]/route.ts` (after start POST)
- Modify: `packages/web/app/api/tournaments/route.ts` (after create)
- Modify: `packages/web/app/api/tournaments/[slug]/route.ts` (after start POST)

- [ ] **Step 1: Wire announces into draft routes**

In `packages/web/app/api/drafts/route.ts`, after the `drafts.create(...)` call and before `return NextResponse.json(...)`:

```ts
await announceToBot(
  { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
  {
    kind: "draft-created",
    draftId: draft.id,
    channelId: draft.channelId,
    name: draft.name,
    webSlug: draft.webSlug ?? "",
  },
);
```

In `packages/web/app/api/drafts/[slug]/route.ts`, inside `POST` after `drafts.start(...)`:

```ts
await announceToBot(
  { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
  {
    kind: "draft-started",
    draftId: started.id,
    channelId: started.channelId,
    name: started.name,
    webSlug: started.webSlug ?? "",
  },
);
```

Add `import { announceToBot } from "@/lib/announce-bot";` and `import { env } from "@/lib/env";` to both files (env may already be imported).

- [ ] **Step 2: Wire announces into tournament routes**

In `packages/web/app/api/tournaments/route.ts`, after `tournaments.create(...)`. Tournaments don't carry a `channel_id` today — the bot's announce handler can route to a configured fallback channel via `DISCORD_DEFAULT_CHANNEL_ID`. Add a `channelId` field that picks `env.discordDefaultChannelId`:

```ts
await announceToBot(
  { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
  {
    kind: "tournament-created",
    tournamentId: tournament.id,
    channelId: env.discordDefaultChannelId,
    name: tournament.name,
    format: tournament.format,
    webSlug: tournament.webSlug ?? "",
  },
);
```

In `packages/web/app/api/tournaments/[slug]/route.ts` POST (start), the same shape with `kind: "tournament-started"`.

- [ ] **Step 3: Manual verification (the test rig is fragile for fire-and-forget HTTP; rely on dev test)**

```bash
# Terminal A
cd packages/bot && BOT_ANNOUNCE_SECRET=shh BOT_ANNOUNCE_PORT=4001 npm run dev

# Terminal B
cd packages/web && BOT_ANNOUNCE_URL=http://localhost:4001 BOT_ANNOUNCE_SECRET=shh npm run dev
```

Create a tournament via the web UI; confirm a Discord message appears in the configured channel.

- [ ] **Step 4: Commit**

```bash
git add packages/web/app/api/drafts \
        packages/web/app/api/tournaments
git commit -m "feat(web): announce draft/tournament create+start to the Discord bot"
```

---

# Phase 5 — Quality fixes

## Task 5.1: Round-robin circle-method scheduling

**Files:**
- Modify: `packages/shared/src/tournaments/formats.ts`
- Modify: `packages/bot/tests/tournaments/formats.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/bot/tests/tournaments/formats.test.ts`, replace any existing round-robin assertions with:

```ts
describe("generateRoundRobin (circle method)", () => {
  it("schedules N-1 rounds for N even players, with N/2 matches per round", () => {
    const pairings = generateRoundRobin([1, 2, 3, 4]);
    const rounds = new Map<number, Array<[number, number]>>();
    for (const p of pairings) {
      const r = rounds.get(p.roundNumber) ?? [];
      r.push([p.playerOneId, p.playerTwoId!]);
      rounds.set(p.roundNumber, r);
    }
    expect(rounds.size).toBe(3);
    for (const [, matches] of rounds) {
      expect(matches.length).toBe(2);
      const players = matches.flatMap((m) => m);
      expect(new Set(players).size).toBe(4);
    }
  });

  it("schedules N rounds for N odd players, each round having one bye", () => {
    const pairings = generateRoundRobin([1, 2, 3]);
    const rounds = new Map<number, Array<{ p1: number; p2: number | null }>>();
    for (const p of pairings) {
      const r = rounds.get(p.roundNumber) ?? [];
      r.push({ p1: p.playerOneId, p2: p.playerTwoId });
      rounds.set(p.roundNumber, r);
    }
    expect(rounds.size).toBe(3);
    let byes = 0;
    for (const [, ms] of rounds) {
      const byeMatches = ms.filter((m) => m.p2 === null);
      byes += byeMatches.length;
    }
    expect(byes).toBe(3);
  });

  it("ensures every distinct pair plays exactly once", () => {
    const pairings = generateRoundRobin([1, 2, 3, 4, 5, 6]);
    const seen = new Set<string>();
    let realMatches = 0;
    for (const p of pairings) {
      if (p.playerTwoId === null) continue;
      const key = [p.playerOneId, p.playerTwoId].sort().join("-");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      realMatches += 1;
    }
    expect(realMatches).toBe(15); // C(6, 2)
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
cd packages/bot && npx vitest run tests/tournaments/formats.test.ts
```

Expected: FAIL — current implementation puts each pair in its own round.

- [ ] **Step 3: Implement circle-method scheduling**

Replace `generateRoundRobin` in `packages/shared/src/tournaments/formats.ts`:

```ts
export function generateRoundRobin(playerIds: number[]): TournamentPairing[] {
  if (playerIds.length < 2) return [];
  // Add a "ghost" for odd counts to schedule byes uniformly
  const ghost = -1;
  const ids = playerIds.length % 2 === 1 ? [...playerIds, ghost] : [...playerIds];
  const n = ids.length;
  const rounds = n - 1;
  const half = n / 2;
  const out: TournamentPairing[] = [];

  // Standard round-robin "circle" rotation: fix index 0, rotate the rest.
  let order = ids.slice();
  for (let r = 1; r <= rounds; r += 1) {
    for (let i = 0; i < half; i += 1) {
      const a = order[i];
      const b = order[n - 1 - i];
      if (a === ghost) {
        out.push({ playerOneId: b, playerTwoId: null, roundNumber: r });
      } else if (b === ghost) {
        out.push({ playerOneId: a, playerTwoId: null, roundNumber: r });
      } else {
        out.push({ playerOneId: a, playerTwoId: b, roundNumber: r });
      }
    }
    // Rotate: keep order[0] fixed, move order[1] to the end
    order = [order[0], ...order.slice(2), order[1]];
  }

  return out;
}
```

- [ ] **Step 4: Update tournament service to mark byes completed**

In `packages/bot/src/services/tournaments.ts`, inside `start` for `round_robin`:

```ts
if (tournament.format === "round_robin") {
  for (const pairing of generateRoundRobin(playerIds)) {
    if (pairing.playerTwoId === null) {
      insertTournamentPairing(
        tournamentId,
        pairing,
        "completed",
        { bye: true, winnerId: pairing.playerOneId },
      );
    } else {
      insertTournamentPairing(tournamentId, pairing);
    }
  }
}
```

(Mirror the single-elim bye treatment — byes are completed-on-create.)

- [ ] **Step 5: Run tests**

```bash
cd packages/bot && npx vitest run
```

Expected: PASS — including any prior round-robin reporting tests, since pair-uniqueness is preserved.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/tournaments/formats.ts \
        packages/bot/src/services/tournaments.ts \
        packages/bot/tests/tournaments/formats.test.ts
git commit -m "feat(tournaments): schedule round-robin via circle method (real rounds)"
```

---

## Task 5.2: Dashboard lifetime stats use `'approved'`

**Files:**
- Modify: `packages/web/app/api/dashboard/route.ts:110`
- Create: `packages/web/tests/api/dashboard-stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

describe("GET /api/dashboard stats", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u1", name: "Yugi" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("counts approved matches as wins/losses", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "dash-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "g1";

    const { migrate } = await import("../../../shared/src/db/schema");
    const db = new Database(dbPath);
    migrate(db);
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u1','Yugi')").run();
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u2','Kaiba')").run();
    const p1 = (db.prepare("select id from players where discord_user_id='u1'").get() as any).id;
    const p2 = (db.prepare("select id from players where discord_user_id='u2'").get() as any).id;
    db.prepare(
      "insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source) values ('g1', ?, ?, ?, ?, 'approved', 'casual')",
    ).run(p1, p2, p1, p1);
    db.prepare(
      "insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source) values ('g1', ?, ?, ?, ?, 'approved', 'casual')",
    ).run(p1, p2, p2, p2);
    db.close();

    const { GET } = await import("../../app/api/dashboard/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats).toEqual({ wins: 1, losses: 1 });
  });
});
```

- [ ] **Step 2: Verify failure**

Expected: FAIL — current handler filters `status='completed'`, so `wins: 0, losses: 0`.

- [ ] **Step 3: Fix the filter**

In `packages/web/app/api/dashboard/route.ts:110`, change `where status = 'completed'` to `where status = 'approved'`.

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/api/dashboard/route.ts \
        packages/web/tests/api/dashboard-stats.test.ts
git commit -m "fix(dashboard): count 'approved' matches for lifetime stats (was 'completed')"
```

---

## Final verification

- [ ] **Step 1: Run full test suite**

```bash
cd /home/imran/yugioh-discord-bot && npm test
```

Expected: PASS across `bot`, `web`, `ws`, `shared`.

- [ ] **Step 2: Build all packages**

```bash
cd /home/imran/yugioh-discord-bot && npm run build
```

Expected: clean build.

- [ ] **Step 3: Manual end-to-end smoke**

Run bot + web + ws locally. Verify each flow:

1. **Bot creates tournament** → `tournament create` → reply contains `WEB_URL/tournament/<slug>` → clicking it opens the web tournament page (not 404).
2. **Web creates tournament** → Discord channel receives "Signups are open" message.
3. **Web reports tournament match** → opponent visits page → Approve/Deny buttons appear → click Approve → match is "Completed".
4. **Round-robin** → all matches approved → tournament status flips to "completed" without manual action.
5. **Cancel** → cancelling a `cancelled` tournament returns an error.
6. **Dashboard** → `/dashboard` shows non-zero wins/losses for users with approved matches.

- [ ] **Step 4: Update CHANGELOG / release notes** (if the project uses one — skip otherwise)

- [ ] **Step 5: Final commit (if any aggregated docs)**

```bash
git status
git diff --stat HEAD~10
```

---

## Self-Review

**Spec coverage:**
- Tournament URL slug/id mismatch → Tasks 1.1, 1.2
- Match status mismatch + missing approve endpoint → Tasks 1.3, 1.4, 1.5, 1.6
- Round-robin auto-completion → Task 2.3
- Cancel/approve guards → Tasks 2.1, 2.2
- Web routes use service layer → Tasks 3.1, 3.2 (and the matches/tournament service moves embedded in 1.4 / 3.1)
- Discord announcements from web → Tasks 4.1, 4.2, 4.3, 4.4
- Round-robin scheduling → Task 5.1
- Dashboard `'completed'` → `'approved'` → Task 5.2

All 7 priority items covered.

**Placeholder scan:** No "TBD", "implement later", or "similar to Task N" left. The one "if `createMatchService` is not yet exported from shared" branch in Task 1.4 is a concrete sub-procedure with steps, not a placeholder.

**Type consistency:** `AnnouncePayload` shape is identical between `packages/bot/src/announce/server.ts` and `packages/web/src/lib/announce-bot.ts`. `tournamentService.completeIfAllMatchesDone` is referenced in Task 2.3 and defined in the same task. `MatchApprovalControls` props are defined in Task 1.6 and used in the same task. `generateRoundRobin` signature unchanged across the refactor in Task 5.1 (returns `TournamentPairing[]`).

**Known cross-cutting risks documented inline:**
- The shared/bot service split (Tasks 1.4 and 3.1) requires a one-time `git mv` of `matches.ts` and `tournaments.ts` if they're not already in shared. Steps included.
- `env.discordDefaultChannelId` is reused for tournament announcements; if the project later adds per-tournament channel routing, the announce payload already supports it.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-07-bot-web-tournament-integration.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
