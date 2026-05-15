# Tournament Live-Update Fixes + Draft Layout & Pool-Badge Pass

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Fix two live-update gaps on tournament pages (Discord-side participant changes never reach the web; match reports/approvals/denies never reach the web). (2) Improve the pending draft page layout — move the **Start/Join action to the top**, move the **Card Pool to the left column** as a sticky panel, and verify the per-card quantity badge appears wherever a card pool is shown. (3) Tighten the active draft header — remove the redundant "Live Draft Room" eyebrow and the draft-name `<h1>` so the player gets straight to the pack/pick UI.

**Tech Stack:** Discord.js, Socket.IO, Next.js 16 App Router, React, Vitest, SQLite/better-sqlite3, TypeScript.

**Design rationale (ui-ux-pro-max):**
- **Primary action visibility** — pending-draft Start/Join is the single primary CTA; moving it to the top removes the scroll-then-act friction (HIG `primary-action`).
- **Spatial continuity** — the existing `create-draft-form` already uses a *sticky left/main + sticky right pool* layout. Mirroring it on the pending draft page (pool on the left this time, content on the right) gives a consistent "your pool stays anchored while you tweak config" pattern.
- **Number tabular for counts** — the `×N` qty badge uses tabular numerals already; we extend it to the in-draft `PoolPanel` and the `CardHoverPopup` so duplicates are obvious everywhere.
- **Reduced visual noise** — the active draft page already shows pack/pick/timer/seats; the draft name + "Live Draft Room" eyebrow is decorative and competes with the timer bar above. Removing them sharpens focus on what changes (cards).

---

## File map

**Create:**
- `packages/bot/src/lib/notify-ws-tournament.ts` — bot-side helper paralleling the existing `packages/web/src/lib/notify-ws-tournament.ts`
- `packages/bot/tests/lib/notify-ws-tournament.test.ts`
- `packages/web/tests/api/tournaments-report-route-broadcast.test.ts` — covers the new match-updated broadcast on report
- `packages/web/tests/api/matches-approve-route-broadcast.test.ts` — covers broadcast on approve
- `packages/web/tests/api/matches-deny-route-broadcast.test.ts` — covers broadcast on deny

**Modify:**
- `packages/shared/src/ws/events.ts` — add `TournamentMatchUpdatedBroadcast` variant + extend `TOURNAMENT_BROADCAST_KINDS`
- `packages/ws/src/events.ts` — add `"tournament:match-updated"` to `ServerToClientEvents`
- `packages/ws/src/internal-http.ts` — add parser + `case "/internal/tournament/match-updated"`
- `packages/ws/tests/internal-http-tournament.test.ts` — extend with match-updated coverage
- `packages/bot/src/interactions/buttons.ts` — broadcast on `handleJoinTournament`, on `handleReportResult`, on any approve/deny equivalents (and any leave/kick equivalents)
- `packages/bot/src/commands/handlers.ts` — broadcast on `/event join` and any sibling Discord-driven participant mutations
- `packages/web/src/lib/notify-ws-tournament.ts` — extend `TournamentBroadcastPayload` re-export (lands automatically from shared)
- `packages/web/app/api/tournaments/[slug]/report/route.ts` — broadcast `match-updated`
- `packages/web/app/api/matches/[id]/approve/route.ts` — DB-join to load `web_slug` from `tournaments`; broadcast `match-updated` when `match.tournament_id` is set
- `packages/web/app/api/matches/[id]/deny/route.ts` — same as approve
- `packages/web/src/lib/hooks/use-tournament-websocket.ts` — add `onMatchUpdated`
- `packages/web/app/(app)/tournament/[slug]/page.tsx` — pass `onMatchUpdated: () => fetchTournament()`
- `packages/web/src/components/draft/draft-manage-view.tsx` — new two-column layout (pool left, content right), primary action lifted to the top, max-width widened
- `packages/web/src/components/draft/pool-panel.tsx` — render `×N` qty badge in the in-draft pool grid
- `packages/web/src/components/draft/card-hover-popup.tsx` — render `×N` qty badge in the hover preview
- `packages/web/app/(app)/draft/[slug]/page.tsx` — remove "Live Draft Room" eyebrow + `<h1>{draft.name}</h1>` block (keep the metadata row: pack/pick/cards/timer)

---

## Open assumptions (confirmed with user)

1. Approve/deny routes (`/api/matches/[id]/{approve,deny}`) will look up `tournaments.web_slug` via a join on `match.tournament_id`. If `tournament_id` is null (non-tournament match), the broadcast is skipped silently — no behavioral change.
2. Bot-side fix covers **join + leave + kick** from Discord (any path that mutates `tournament_participants`).
3. UI work is plan-only — author the doc, then stop. Implementation is a separate session.
4. Card pool moves to the **LEFT** column (not right) on the pending draft page, sticky.

---

## Task 1: Shared — add `match-updated` broadcast type

**Files:**
- Modify: `packages/shared/src/ws/events.ts`

- [ ] **Step 1: Extend the union**

Append before the existing `TournamentBroadcastPayload` union:

```typescript
export type TournamentMatchUpdatedBroadcast = {
  kind: "match-updated";
  slug: string;
};
```

Add it to the `TournamentBroadcastPayload` union and to `TOURNAMENT_BROADCAST_KINDS`:

```typescript
export type TournamentBroadcastPayload =
  | TournamentParticipantJoinedBroadcast
  | TournamentParticipantLeftBroadcast
  | TournamentStartedBroadcast
  | TournamentCancelledBroadcast
  | TournamentMatchUpdatedBroadcast;

export const TOURNAMENT_BROADCAST_KINDS = [
  "participant-joined",
  "participant-left",
  "started",
  "cancelled",
  "match-updated",
] as const;
```

- [ ] **Step 2: Rebuild shared so consumers see the type**

Run: `npm run build --workspace=packages/shared`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/ws/events.ts
git commit -m "feat(shared): add tournament match-updated broadcast type"
```

---

## Task 2: WS — accept the new internal broadcast route + emit to room

**Files:**
- Modify: `packages/ws/src/events.ts`
- Modify: `packages/ws/src/internal-http.ts`
- Modify: `packages/ws/tests/internal-http-tournament.test.ts`

- [ ] **Step 1: Add the server-to-client event type**

In `packages/ws/src/events.ts`, extend `ServerToClientEvents`:

```typescript
"tournament:match-updated": (data: Record<string, never>) => void;
```

- [ ] **Step 2: Add a failing test for the new route**

Append to `packages/ws/tests/internal-http-tournament.test.ts`:

```typescript
it("broadcasts match-updated to the tournament room", async () => {
  const { io, emits } = makeIo();
  const handle = createInternalHttpHandler({ io, secret });
  const body = JSON.stringify({ slug: "abc" });
  const res = await handle(
    new Request("http://x/internal/tournament/match-updated", {
      method: "POST",
      headers: { "x-announce-signature": sign(body, secret) },
      body,
    }),
  );
  expect(res.status).toBe(204);
  expect(emits[0]).toEqual({
    room: "tournament:abc",
    event: "tournament:match-updated",
    data: {},
  });
});
```

Run: `npx vitest run packages/ws/tests/internal-http-tournament.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Add the route**

In `packages/ws/src/internal-http.ts`, inside the switch, add:

```typescript
case "/internal/tournament/match-updated": {
  const data = parseTournamentSlugOnly(parsed);
  if (!data) return new Response("Bad payload", { status: 400 });
  opts.io.to(`tournament:${data.slug}`).emit("tournament:match-updated", {});
  return new Response(null, { status: 204 });
}
```

(`parseTournamentSlugOnly` already exists — no new parser needed.)

- [ ] **Step 4: Re-run tests**

Run: `npx vitest run packages/ws/tests/internal-http-tournament.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ws/src/events.ts packages/ws/src/internal-http.ts packages/ws/tests/internal-http-tournament.test.ts
git commit -m "feat(ws): tournament match-updated broadcast route"
```

---

## Task 3: Web — broadcast `match-updated` from `/api/tournaments/[slug]/report`

**Files:**
- Modify: `packages/web/app/api/tournaments/[slug]/report/route.ts`
- Create: `packages/web/tests/api/tournaments-report-route-broadcast.test.ts`

- [ ] **Step 1: Write the failing test**

The test seeds an active tournament + one open match for the caller, stubs `fetch`, calls POST, and asserts a `match-updated` fetch was sent to `WS_INTERNAL_URL`. Model after the existing `packages/web/tests/notify-ws-tournament.test.ts`.

Run: `npx vitest run packages/web/tests/api/tournaments-report-route-broadcast.test.ts`
Expected: FAIL — no fetch call.

- [ ] **Step 2: Add the broadcast call**

At the top of `packages/web/app/api/tournaments/[slug]/report/route.ts`:

```typescript
import { env } from "@/lib/env";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";
```

After the `update tournament_matches ...` statement, before `return NextResponse.json(...)`:

```typescript
void notifyWsTournament(
  { url: env.wsInternalUrl, secret: env.wsInternalSecret },
  { kind: "match-updated", slug },
);
```

- [ ] **Step 3: Re-run tests, commit**

```bash
git add packages/web/app/api/tournaments/[slug]/report/route.ts packages/web/tests/api/tournaments-report-route-broadcast.test.ts
git commit -m "feat(web): broadcast tournament match-updated on report"
```

---

## Task 4: Web — broadcast `match-updated` from approve/deny

**Files:**
- Modify: `packages/web/app/api/matches/[id]/approve/route.ts`
- Modify: `packages/web/app/api/matches/[id]/deny/route.ts`
- Create: `packages/web/tests/api/matches-approve-route-broadcast.test.ts`
- Create: `packages/web/tests/api/matches-deny-route-broadcast.test.ts`

These routes currently load only `match.guild_id`. We extend the lookup to also pull `match.tournament_id` and (when set) the tournament's `web_slug`.

- [ ] **Step 1: Write failing tests**

Seed: a tournament with a pending-approval match (i.e. `matches.tournament_id = tId`). After POST, assert a fetch to `/internal/tournament/match-updated` with that tournament's slug.

Also assert that for a non-tournament match (`tournament_id = null`) **no fetch** is made.

Run: both tests fail because no broadcast happens.

- [ ] **Step 2: Update approve route**

Replace the match lookup in `packages/web/app/api/matches/[id]/approve/route.ts`:

```typescript
const match = db
  .prepare(`
    select m.guild_id, m.tournament_id, t.web_slug as tournament_slug
    from matches m
    left join tournaments t on t.id = m.tournament_id
    where m.id = ?
  `)
  .get(matchId) as { guild_id: string; tournament_id: number | null; tournament_slug: string | null } | undefined;
```

After `matches.approve(...)`:

```typescript
if (match.tournament_slug) {
  void notifyWsTournament(
    { url: env.wsInternalUrl, secret: env.wsInternalSecret },
    { kind: "match-updated", slug: match.tournament_slug },
  );
}
```

Add the imports at the top (`env`, `notifyWsTournament`).

- [ ] **Step 3: Mirror the same change in `deny/route.ts`**

- [ ] **Step 4: Re-run tests, commit**

```bash
git add packages/web/app/api/matches/[id]/approve/route.ts \
        packages/web/app/api/matches/[id]/deny/route.ts \
        packages/web/tests/api/matches-approve-route-broadcast.test.ts \
        packages/web/tests/api/matches-deny-route-broadcast.test.ts
git commit -m "feat(web): broadcast tournament match-updated on approve/deny"
```

---

## Task 5: Web hook — accept and dispatch the new event

**Files:**
- Modify: `packages/web/src/lib/hooks/use-tournament-websocket.ts`
- Modify: `packages/web/app/(app)/tournament/[slug]/page.tsx`

- [ ] **Step 1: Extend the hook**

In `use-tournament-websocket.ts` add the option and the listener:

```typescript
interface UseTournamentWebsocketOptions {
  onParticipantJoined?: (data: { playerId: number; displayName: string }) => void;
  onParticipantLeft?: (data: { playerId: number }) => void;
  onStarted?: () => void;
  onCancelled?: () => void;
  onMatchUpdated?: () => void;
}
```

```typescript
socket.on("tournament:match-updated", () => {
  optionsRef.current.onMatchUpdated?.();
});
```

- [ ] **Step 2: Wire the page**

In `packages/web/app/(app)/tournament/[slug]/page.tsx`:

```typescript
useTournamentWebsocket(id, {
  onParticipantJoined: () => fetchTournament(),
  onParticipantLeft: () => fetchTournament(),
  onStarted: () => fetchTournament(),
  onCancelled: () => fetchTournament(),
  onMatchUpdated: () => fetchTournament(),
});
```

- [ ] **Step 3: Typecheck, commit**

```bash
npm run typecheck --workspace=packages/web
git add packages/web/src/lib/hooks/use-tournament-websocket.ts packages/web/app/\(app\)/tournament/\[slug\]/page.tsx
git commit -m "feat(web): tournament page live-refreshes on match-updated"
```

---

## Task 6: Bot — broadcast tournament participant changes from Discord

**Files:**
- Create: `packages/bot/src/lib/notify-ws-tournament.ts`
- Create: `packages/bot/tests/lib/notify-ws-tournament.test.ts`
- Modify: `packages/bot/src/interactions/buttons.ts`
- Modify: `packages/bot/src/commands/handlers.ts`

- [ ] **Step 1: Build the helper (TDD)**

Model after `packages/bot/src/lib/notify-ws.ts` (HMAC signing, env-driven URL/secret, silently noops if either is empty). Surface the typed `TournamentBroadcastPayload` from `@yugidraft/shared/ws`.

The test should:
- stub `fetch`
- call `notifyWsTournament(cfg, { kind: "participant-joined", slug: "x", playerId: 1, displayName: "A" })`
- assert URL is `http://ws:4002/internal/tournament/participant-joined` and the HMAC signature matches

- [ ] **Step 2: Locate the env config**

`packages/bot/src/lib/notify-ws.ts` already reads `WS_INTERNAL_URL` / `WS_INTERNAL_SECRET` from somewhere; reuse the same plumbing. (Read the file before adding the new helper — keep the env access consistent.)

- [ ] **Step 3: Call the helper from every Discord-driven mutation**

In `packages/bot/src/interactions/buttons.ts`:

- `handleJoinTournament` (line ~264) — after `deps.tournaments.join(...)`, fire `participant-joined` with `{ slug: tournament.webSlug, playerId: player.id, displayName: displayName(interaction.user) }`.
- Any handler that resolves to `tournaments.leave/kick` (grep `handleLeaveTournament`, `handleKickFromTournament` — they may or may not exist). For each, fire `participant-left`.

In `packages/bot/src/commands/handlers.ts`:

- Lines 463 and 476 (`/event join`) — same `participant-joined` call after `deps.tournaments.join(...)`.
- Any sibling leave/kick command — same treatment.

Inject the helper through `ButtonDependencies` / `CommandDependencies` if dependency injection is preferred (mirror how `notify-ws` is wired), or import directly if the existing code imports it directly — match local conventions.

- [ ] **Step 4: Verify by running the bot suite and the existing tournament WS test**

Run: `npm test --workspace=packages/bot && npx vitest run packages/ws/tests/internal-http-tournament.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/lib/notify-ws-tournament.ts \
        packages/bot/tests/lib/notify-ws-tournament.test.ts \
        packages/bot/src/interactions/buttons.ts \
        packages/bot/src/commands/handlers.ts
git commit -m "feat(bot): broadcast tournament participant-joined/left from Discord interactions"
```

---

## Task 7: Pending draft — two-column layout (pool left, action top)

**Files:**
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx`

The current layout is one column (`mx-auto max-w-3xl space-y-6`) with the order: Name card → Players → Configuration → Card Pool → Action. Target layout:

```
┌─────────────────────────────────────────────────────┐
│              Action bar (Start/Join CTA)            │  ← lifted to top
├──────────────────────┬──────────────────────────────┤
│ Card Pool            │ Name + Status                │
│ (sticky on desktop)  │ Players                      │
│                      │ Configuration                │
│                      │ Cancel link (organizer)      │
└──────────────────────┴──────────────────────────────┘
```

On mobile (<`lg`), it stacks: Action → Pool → Name → Players → Config.

- [ ] **Step 1: Lift the action section**

Pull `getActionSection()` out of the existing return-tree end position. Render it at the top of the page, wrapped in a sticky-on-mobile container if desired:

```tsx
<div className="mb-6">{getActionSection()}</div>
```

If `getActionSection` returns the "Ready to begin?" card (organizer), the "You have joined" card (participant), or the "Want to play?" join card (non-participant) — all three should appear at top. Visually the join CTA is the page's primary action; lift its visual weight (size="lg", min-width).

- [ ] **Step 2: Add the two-column wrapper**

Replace `<div className="mx-auto max-w-3xl space-y-6">` with a wider container and a grid:

```tsx
<div className="mx-auto max-w-7xl space-y-6">
  {/* Top action bar (full width) */}
  <div>{getActionSection()}</div>

  {error && (<div className="..." />)}

  <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
    {/* Left — sticky pool */}
    <aside className="lg:sticky lg:top-6 lg:self-start">
      {slug && (
        <div className="rounded-xl border border-border bg-surface p-6">
          {/* existing Card Pool block (heading + CardPoolGrid) */}
        </div>
      )}
    </aside>

    {/* Right — name, players, config */}
    <div className="space-y-6">
      {/* existing name card */}
      {/* existing players card */}
      {/* existing configuration card */}
    </div>
  </div>
</div>
```

- [ ] **Step 3: Tune the pool height for the new layout**

The current `heightClassName="h-[32rem]"` is fine for a wide row, but in a sticky narrow column we want it to fill viewport. Switch to:

```tsx
<CardPoolGrid
  cards={poolCards ?? []}
  loading={poolCards === null}
  heightClassName="h-[calc(100vh-16rem)]"
  emptyMessage="This draft's pool hasn't been resolved yet."
/>
```

- [ ] **Step 4: Visual QA**

Boot the dev stack (`npm run dev:web`) and verify at viewports 1440 / 1024 / 768 / 375:
- 1440/1024: two-column, pool sticky, action visible above the fold without scrolling.
- 768/375: single column, action still on top, pool below it, config last.
- Pool grid scrolls inside its own panel; outer page doesn't double-scroll.
- Sticky pool doesn't push under the app navbar (use `top-6` or whatever the existing offset is).

- [ ] **Step 5: Update the existing test if needed**

Run: `npx vitest run packages/web/tests/pages/draft-detail-page.test.ts -c packages/web/vitest.config.ts`
Expected: passes after layout reshuffle. If any test asserts DOM order (e.g. "configuration appears before card pool"), update the assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/draft/draft-manage-view.tsx packages/web/tests/pages/draft-detail-page.test.tsx
git commit -m "feat(web): pending draft — action on top, card pool sticky on left"
```

---

## Task 8: Card pool qty badge — extend wherever a pool is shown

`CardPoolGrid` already renders `×{card.qty}` when `qty > 1` (lines 192–196 of `card-pool-grid.tsx`). The `/api/drafts/[slug]/pool` route already populates `qty`. Two surfaces are missing it:

1. The in-draft **`PoolPanel`** (`packages/web/src/components/draft/pool-panel.tsx`) — used during an active draft for *your accumulated picks*. Each pick is a separate `draftCardId`, so qty needs to be computed client-side by grouping on `id` (catalog id).
2. The **`CardHoverPopup`** preview — currently shows one big card image; should display `×N` somewhere if the card is a duplicate the user is hovering.

- [ ] **Step 1: Group duplicates in `PoolPanel`**

Read `pool-panel.tsx`. The pool array comes from `useDraftStore().pool` (or similar — confirm by reading the file). Build a memoized grouped list:

```typescript
const groupedPool = useMemo(() => {
  const counts = new Map<number, number>();
  for (const c of pool) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
  const seen = new Set<number>();
  const result: Array<CardSummary & { qty: number }> = [];
  for (const c of pool) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    result.push({ ...c, qty: counts.get(c.id) ?? 1 });
  }
  return result;
}, [pool]);
```

Render `groupedPool` instead of `pool`. The `×N` badge in `CardPoolGrid` (if `PoolPanel` uses it) picks it up automatically; if `PoolPanel` renders cards itself rather than via `CardPoolGrid`, add the same absolute-positioned badge JSX (copy lines 192–196 from `card-pool-grid.tsx`).

- [ ] **Step 2: Add the qty badge to `CardHoverPopup`**

Read `card-hover-popup.tsx`. After the card image, before the type/effect text section, conditionally render:

```tsx
{(card.qty ?? 1) > 1 && (
  <div className="absolute right-3 top-3 rounded-md bg-black/80 px-2 py-1 text-sm font-bold tabular-nums text-white">
    ×{card.qty}
  </div>
)}
```

Position it so it overlays the card art top-right; tune Tailwind classes to match the existing popup design language.

- [ ] **Step 3: Visual QA in the pending and active draft**

- Pending draft pool: a duplicate card should show `×2` (or higher) on its grid cell.
- Active draft `PoolPanel`: pick two copies of the same card — only one cell appears, with `×2`.
- Hover/tap-to-preview: the popup shows `×N` when the card is a duplicate.

- [ ] **Step 4: Tests**

Add unit coverage in `packages/web/tests/components/pool-panel.test.tsx` for the grouping — feed it a pool with three copies of card id 7, assert one rendered cell with `×3`.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/draft/pool-panel.tsx \
        packages/web/src/components/draft/card-hover-popup.tsx \
        packages/web/tests/components/pool-panel.test.tsx
git commit -m "feat(web): qty badge across PoolPanel + CardHoverPopup; group duplicates"
```

---

## Task 9: Active draft page — drop the title block

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`

The active-draft view currently shows (in order, lines ~309–328):

```
LIVE DRAFT ROOM      (eyebrow)
<draft name>         (h1)
[set badges]
Pack X · Pick Y · N cards in pack · M players · Ts timer
```

The user wants the eyebrow and the `<h1>` removed.

- [ ] **Step 1: Remove the eyebrow and heading**

In `page.tsx`, delete lines 310–315 (the `<p>Live Draft Room</p>` and the `<h1>{draft.name}</h1>` block). Keep:
- The set-name badge row (lines 317–328)
- The metadata row (Pack/Pick/etc., lines 330–338)
- The wrapping `<div className="mb-6">` becomes near-empty if the badge row is empty too — collapse the wrapper if so.

Result: the page goes from sticky timer bar directly to the badges + metadata row, then the seat list + pack grid. Tighter, action-focused.

- [ ] **Step 2: Update test if it asserts the title**

Run: `npx vitest run packages/web/tests/pages/draft-detail-page.test.ts -c packages/web/vitest.config.ts`
If a test asserts `getByText(/Live Draft Room/i)` or `getByRole("heading", { name: draftName })`, remove or update it.

- [ ] **Step 3: Visual QA**

- The timer bar still sits at the top.
- Set-name pills and the pack/pick metadata appear directly under it.
- No phantom empty space where the heading used to be.

- [ ] **Step 4: Commit**

```bash
git add packages/web/app/\(app\)/draft/\[slug\]/page.tsx packages/web/tests/pages/draft-detail-page.test.tsx
git commit -m "feat(web): drop redundant draft title + Live Draft Room eyebrow on active page"
```

---

## Task 10: End-to-end smoke

- [ ] **Step 1: Run the full suite**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all green.

- [ ] **Step 2: Live-update manual smoke (tournament)**

1. Boot `npm run dev:bot`, `npm run dev:ws`, `npm run dev:web`.
2. Open `http://localhost:3000/tournaments`, create a tournament — auto-joined as organizer.
3. In Discord, run `/event join` for that tournament from a second user → the web page's participant chip appears within ~1s, no refresh.
4. Start the tournament → match cards appear live in both browsers.
5. As player A, click Report → "I won" → status switches to `Pending Approval` in both browsers within ~1s.
6. As player B, click Approve → both browsers' match card flips to `Completed` with the winner trophy live.

- [ ] **Step 3: Layout smoke (pending draft)**

Create a new draft, leave it pending, open `/draft/<slug>`:
- Top of page: Start/Join action card visible without scrolling.
- Left column: card pool grid, sticky.
- Right column: name, players, configuration.
- Resize browser to 768px → stacks; Start still at top.

- [ ] **Step 4: Active draft smoke**

Start the draft. On the active page:
- No "Live Draft Room" eyebrow.
- No `<h1>` with the draft name.
- Set badges + pack/pick metadata row still visible.
- Pick two copies of the same card → pool panel shows one card cell with `×2`.

---

## Verification checklist

- [ ] `npm test` green
- [ ] `npm run typecheck` green
- [ ] `npm run build` green
- [ ] Discord-driven tournament joins update the web detail page within 1s
- [ ] Discord-driven leave/kick update the web detail page within 1s
- [ ] Web-driven match reports/approves/denies update both browsers within 1s
- [ ] Pending draft page: Start/Join above the fold, card pool sticky on the left at ≥`lg`
- [ ] Active draft page: no draft-name heading, no "Live Draft Room" eyebrow
- [ ] Card pool grids and `CardHoverPopup` show `×N` for duplicates everywhere
