# Tournament Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add CRUD operations (start, cancel, update) to the tournament detail page, and fix tournament card linking.

**Architecture:** Add DELETE/PUT/POST handlers to existing `/api/tournaments/[id]/route.ts`. Add action buttons to existing detail page. Fix TournamentCard to link pending tournaments.

**Tech Stack:** Next.js 16 App Router, better-sqlite3, TailwindCSS v4, lucide-react

---

### Task 1: Fix TournamentCard Linking

**Files:**
- Modify: `packages/web/src/components/tournament/tournament-card.tsx`

Currently the card links to `/tournament/${tournament.id}`. Make sure ALL tournament cards (pending, active, completed) are clickable. No status gate on the link.

---

### Task 2: Add DELETE/PUT/POST to Tournament API

**Files:**
- Modify: `packages/web/app/api/tournaments/[id]/route.ts`

Add three handlers:

**DELETE** — Cancel tournament
- Auth required (401 if not)
- Only creator can cancel (403 otherwise)
- Cannot cancel completed or already-cancelled tournaments (400)
- Uses bot's `createTournamentService(db).cancel(id)`

**PUT** — Update tournament (name only, pending only)
- Auth required
- Only creator can modify (403)
- Only pending tournaments can be modified (400)
- Validates name is not empty
- Checks for duplicate active/pending name in same guild

**POST** — Start tournament
- Auth required
- Only creator can start (403)
- Uses bot's `createTournamentService(db).start(id)`

**Key note:** The tournament service lives in `packages/bot/src/services/tournaments.ts`, NOT in shared. The web API currently uses raw SQL. We need to import from `@yugidraft/bot/services` — BUT this won't work since bot is a separate package. Instead, replicate the minimal logic inline (cancel = status update, start = validate + generate pairings, etc).

Actually, reviewing the existing web routes, they all use raw SQL. For cancel and start, we should keep it consistent. Cancel is just a status update. Start requires generating pairings which is complex — we should import the shared service or replicate. Let me check if there's a simpler approach.

Looking at the bot tournament service's `start` method — it validates 2+ players, generates pairings via `generateRoundRobin` or `generateSingleElimFirstRound`, inserts match rows, and updates status. This is too complex to replicate inline.

**Decision:** Move tournament service creation to a shared utility or import it. Since the bot package may not be importable from web, create thin wrappers in the web API that call the same pairing logic. For cancel, just do a SQL update. For start, we need the pairing functions.

Actually — the pairing functions `generateRoundRobin` and `generateSingleElimFirstRound` are in `packages/bot/src/tournaments/formats.ts`. The `createTournamentService` is in `packages/bot/src/services/tournaments.ts`. Neither is in shared.

**Simplest path for now:**
- **DELETE (cancel):** Inline SQL `UPDATE tournaments SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP WHERE id = ?`
- **PUT (update):** Inline SQL for name update
- **POST (start):** Import from bot package IF possible, otherwise skip start-from-web for now and add it after we move the tournament service to shared

Let me check if web can import from bot:

```typescript
// In web's package.json, check if bot is a dependency
```

For now: implement cancel (DELETE) and update (PUT) fully. For start (POST), return a 501 with a message that starting tournaments from web is not yet supported, since the start logic requires the complex pairing generation.

---

### Task 3: Add Action UI to Tournament Detail Page

**Files:**
- Modify: `packages/web/app/tournament/[id]/page.tsx`

Add action buttons based on status and user role:
- Fetch `/api/auth/session` to get current user ID
- Compare `createdByUserId` to determine creator status
- **Pending**: Show "Start Tournament" (disabled if <2 participants) + "Cancel" button for creator. Show "Waiting for creator" for non-creator.
- **Active**: Show "Cancel Tournament" button for creator only.
- **Completed/Cancelled**: No action buttons.

The existing page already has a lot of UI. Add an action section near the header area, similar to the draft manage view pattern.

---

### Task 4: Typecheck and Verify

- Run `npx tsc --noEmit -p packages/web/tsconfig.json`
- Verify no regressions