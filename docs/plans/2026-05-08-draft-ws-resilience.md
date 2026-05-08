# Draft WebSocket Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the slow-start UX caused by sequentially awaited webhook calls, document and assert the internal-broadcast env contract, and harden the draft realtime path against drift, races, and silent connection failures.

**Architecture:** The draft realtime path follows an "invalidation + refetch" model: web is the source of truth, ws fans out small "something changed" pings to a Socket.IO room keyed by draft `slug`, browsers refetch their per-user state from REST. The internal channel between web and ws is HMAC-signed HTTP on a docker-internal port. This plan keeps that architecture and reinforces it: callers stop blocking on the broadcast HTTP, missing config becomes loud at boot, the timer becomes server-authoritative to remove client drift, on-join state replay removes the "refresh between events" stale window, and the engine pick-step transition is audited for transactional correctness so broadcasts cannot describe state the DB never reached.

**Tech Stack:** Next.js 16 App Router (web), Socket.IO 4.8 (ws + browser), Node `http` (web→ws internal), better-sqlite3 (engine), zustand (client store), Caddy 2 (reverse proxy), Vitest.

**Non-goals:** Persistent presence (e.g. who's currently watching), reconnect-with-resume on the socket itself, switching off polling/long-poll fallback. Those are larger projects.

---

## Phase 1: Finish the broadcast-config fix PR

In-progress on branch `fix/ws-internal-broadcast-config`. Already committed locally: `.env.example` documenting `WS_INTERNAL_*` and `BOT_ANNOUNCE_*`; `packages/web/instrumentation.ts` warning at boot when those four are empty in production.

Remaining work below. Phase 1 ships as one PR. Phases 2–7 each ship as their own PR off `main` after Phase 1 lands.

### Task 1.1: Make broadcast calls non-blocking at all 9 call sites

**Files:**
- Modify: `packages/web/app/api/drafts/[slug]/route.ts` (lines 85, 217, 228 — DELETE cancel and POST start)
- Modify: `packages/web/app/api/drafts/[slug]/pick/route.ts` (lines 93, 103, 108 — pick + complete-or-resync)
- Modify: `packages/web/app/api/drafts/route.ts` (line 135 — POST create)
- Modify: `packages/web/app/api/tournaments/route.ts` (line 97 — POST create)
- Modify: `packages/web/app/api/tournaments/[slug]/route.ts` (line 261 — POST start)

**Background:** `notifyWs` awaits its inner `fetch`, so `await notifyWs(...)` blocks the response. `announceToBot` is internally fire-and-forget, so `await announceToBot(...)` is misleading but not slow. We standardise both at call sites with `void`.

- [ ] **Step 1: Replace `await notifyWs(` with `void notifyWs(`** at every match in the five files above. The function returns `Promise<void>` and swallows its own errors, so `void` is the correct discard.

- [ ] **Step 2: Replace `await announceToBot(` with `void announceToBot(`** at every match. Consistency with the contract — already fire-and-forget internally.

- [ ] **Step 3: Run `npm test --workspace=packages/web`**

Expected: existing `notify-ws.test.ts` and `announce-bot.test.ts` still pass — they call the functions directly with `await`, and that contract is unchanged. Route-level tests should also still pass.

- [ ] **Step 4: Commit**

```bash
git add packages/web/app/api/drafts/[slug]/route.ts \
        packages/web/app/api/drafts/[slug]/pick/route.ts \
        packages/web/app/api/drafts/route.ts \
        packages/web/app/api/tournaments/route.ts \
        packages/web/app/api/tournaments/[slug]/route.ts
git commit -m "fix(web): fire-and-forget bot announce + ws notify in route handlers"
```

### Task 1.2: Push and open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin fix/ws-internal-broadcast-config
```

- [ ] **Step 2: Open PR via gh**

```bash
gh pr create --title "fix: stop blocking responses on bot/ws broadcast calls + document internal env" --body "$(cat <<'EOF'
## Summary
- Document `WS_INTERNAL_SECRET`, `WS_INTERNAL_URL`, `BOT_ANNOUNCE_SECRET`, `BOT_ANNOUNCE_URL` in `.env.example` (root cause of the broken-prod-broadcast incident).
- Add `packages/web/instrumentation.ts` so the web container loudly warns at boot when any of those four are empty in production, instead of silently no-opping every call.
- Stop awaiting `notifyWs` and `announceToBot` in route handlers. `notifyWs` was the slow-start culprit on draft start; the response now returns as soon as the engine has transitioned, broadcasts go out in the background.

## Test plan
- [ ] `npm test --workspace=packages/web` (notify-ws, announce-bot, drafts-route, matches-approve-deny, draft-detail-page tests pass)
- [ ] Manual: start a draft as one user with a second browser open as another participant — second browser should switch from pending to active without refresh
- [ ] Manual: each pick reflects in the other browser's seat list within ~1s; round advance happens automatically
EOF
)"
```

---

## Phase 2: Server-authoritative timer (Smell #1)

**Problem:** `useDraftCountdown` ticks each browser's local clock independently. After ~30s of pack picks, clients drift. When local clocks expire at slightly different times, each client fires its own `useDraftExpiryResync` REST call, producing N redundant refetches and a noticeable jitter in the timer bar.

**Approach:** Make the WS server the timer authority. On `draft:status { active }`, the WS server starts a tick interval keyed by `slug`. Every second it emits `draft:timer { remainingMs }` to the room. The interval resets on `draft:resync` (engine advanced the step). Clients display whatever the last `draft:timer` said and stop ticking locally. Expiry is also server-authoritative: when `remainingMs` hits 0, ws POSTs an internal `expire` ping back to web (or web cron-checks) — but the simpler path for v1 is to keep the existing `useDraftExpiryResync` per-client but throttle to the leader (lowest socket id in the room) to remove the N-fold thunder.

### Task 2.1: Decide leader-throttle vs full server-clock

**Files:** none yet — design decision.

- [ ] **Step 1: Pick approach**

Two viable shapes:

(a) **Leader-throttle (small change).** Keep the local clock in `useDraftCountdown`. In `useDraftExpiryResync`, only the socket whose `socket.id` sorts lowest in the current room fires the resync REST. Remove redundant fan-in. Drift between displayed timers remains.

(b) **Server clock (bigger change).** WS server holds the per-slug deadline, ticks 1Hz, broadcasts `draft:timer`. Clients become passive readers. Drift solved structurally; client clock sets are gone.

Recommend (b) — drift is the visible UX issue. Document choice in this file before proceeding.

### Task 2.2: Add `draft:timer` event to the WS contracts

**Files:**
- Modify: `packages/shared/src/ws/events.ts`
- Modify: `packages/ws/src/events.ts` (`ServerToClientEvents`)

- [ ] **Step 1: Write the failing test for the shared event type**

```ts
// packages/shared/tests/ws-events.test.ts (extend if exists)
it("DraftTimerBroadcast has remainingMs and slug", () => {
  const t: DraftTimerBroadcast = { kind: "timer", slug: "x", remainingMs: 30000 };
  expect(t.remainingMs).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Add `DraftTimerBroadcast` to the union in `packages/shared/src/ws/events.ts`**

```ts
export type DraftTimerBroadcast = {
  kind: "timer";
  slug: string;
  remainingMs: number;
};
// add to DraftBroadcastPayload union
// add "timer" to DRAFT_BROADCAST_KINDS
```

- [ ] **Step 3: Add `draft:timer` to `ServerToClientEvents` in `packages/ws/src/events.ts`**

```ts
"draft:timer": (data: { remainingMs: number }) => void;
```

- [ ] **Step 4: Run `npm test --workspace=packages/shared`** — expect green.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(shared): add draft:timer broadcast event type"
```

### Task 2.3: WS server holds per-slug deadlines and ticks

**Files:**
- Create: `packages/ws/src/timer-manager.ts`
- Modify: `packages/ws/src/server.ts` (instantiate manager, pass to handlers and to internal-http)
- Modify: `packages/ws/src/events.ts` (`registerEventHandlers` accepts `timerManager`)
- Modify: `packages/ws/src/internal-http.ts` (handlers call `timerManager.start/reset/clear`)
- Test: `packages/ws/tests/timer-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimerManager } from "../src/timer-manager.js";

describe("TimerManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits draft:timer once per second until cleared", () => {
    const emit = vi.fn();
    const tm = new TimerManager({ emit });
    tm.start("slug-a", 3000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000); // past zero - should not over-emit
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenNthCalledWith(1, "slug-a", 2000);
    expect(emit).toHaveBeenNthCalledWith(3, "slug-a", 0);
  });

  it("reset() restarts the deadline", () => {
    const emit = vi.fn();
    const tm = new TimerManager({ emit });
    tm.start("slug-a", 5000);
    vi.advanceTimersByTime(2000);
    tm.reset("slug-a", 5000);
    vi.advanceTimersByTime(1000);
    const lastCall = emit.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(4000);
  });

  it("clear() stops further emits", () => {
    const emit = vi.fn();
    const tm = new TimerManager({ emit });
    tm.start("slug-a", 3000);
    tm.clear("slug-a");
    vi.advanceTimersByTime(5000);
    expect(emit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL with "TimerManager not defined"**

- [ ] **Step 3: Implement `packages/ws/src/timer-manager.ts`**

```ts
type Emit = (slug: string, remainingMs: number) => void;

interface SlugTimer {
  deadline: number;
  interval: NodeJS.Timeout;
}

export class TimerManager {
  private timers = new Map<string, SlugTimer>();
  private emit: Emit;

  constructor(opts: { emit: Emit }) {
    this.emit = opts.emit;
  }

  start(slug: string, durationMs: number): void {
    this.clear(slug);
    const deadline = Date.now() + durationMs;
    const interval = setInterval(() => {
      const remaining = Math.max(0, deadline - Date.now());
      this.emit(slug, remaining);
      if (remaining <= 0) this.clear(slug);
    }, 1000);
    this.timers.set(slug, { deadline, interval });
  }

  reset(slug: string, durationMs: number): void {
    this.start(slug, durationMs);
  }

  clear(slug: string): void {
    const t = this.timers.get(slug);
    if (t) {
      clearInterval(t.interval);
      this.timers.delete(slug);
    }
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Wire manager into `server.ts` and `internal-http.ts`**

In `server.ts`:

```ts
import { TimerManager } from "./timer-manager.js";
const timerManager = new TimerManager({
  emit: (slug, remainingMs) => io.to(slug).emit("draft:timer", { remainingMs }),
});
listenInternalHttp({ io, timerManager, secret: WS_INTERNAL_SECRET, port: WS_INTERNAL_PORT });
```

In `internal-http.ts`, accept `timerManager` in opts and:
- on `status: active` → `timerManager.start(slug, pickSeconds * 1000)` (pickSeconds added to status payload — see Task 2.4)
- on `status: cancelled` or `status: completed` or `complete` route → `timerManager.clear(slug)`
- on `resync` → `timerManager.reset(slug, pickSeconds * 1000)` (pickSeconds added — see Task 2.4)

- [ ] **Step 6: Run `npm test --workspace=packages/ws`**

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(ws): server-authoritative draft timer with per-slug TimerManager"
```

### Task 2.4: Web sends `pickSeconds` to ws so the server knows the deadline

**Files:**
- Modify: `packages/shared/src/ws/events.ts` (`DraftStatusBroadcast` and `DraftResyncBroadcast` gain `pickSeconds: number`)
- Modify: `packages/ws/src/internal-http.ts` (`parseStatus`, `parseResync` validate the new field)
- Modify: `packages/web/app/api/drafts/[slug]/route.ts` POST start (pass `pickSeconds`)
- Modify: `packages/web/app/api/drafts/[slug]/pick/route.ts` (pass `pickSeconds` on resync)
- Test: `packages/web/tests/notify-ws.test.ts` (add cases asserting pickSeconds is forwarded)
- Test: `packages/ws/tests/internal-http.test.ts` (add cases asserting timer is started/reset)

- [ ] **Step 1: Write failing tests for the new field on both sides** (sample below)

```ts
it("status broadcast forwards pickSeconds and starts the timer", async () => {
  // ws/tests/internal-http.test.ts
  const tm = { start: vi.fn(), reset: vi.fn(), clear: vi.fn() };
  // ... post signed status with pickSeconds: 60
  expect(tm.start).toHaveBeenCalledWith("abc", 60_000);
});
```

- [ ] **Step 2: Add `pickSeconds: number` to `DraftStatusBroadcast` and `DraftResyncBroadcast`**

- [ ] **Step 3: Update `parseStatus` / `parseResync` to require and forward `pickSeconds`**

- [ ] **Step 4: Update web call sites to include `pickSeconds: started.config.pickSeconds ?? 60`**

- [ ] **Step 5: Run web + ws + shared tests — expect green**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ws): wire pickSeconds through status/resync broadcasts to drive server timer"
```

### Task 2.5: Browser becomes a passive timer reader

**Files:**
- Modify: `packages/web/src/lib/hooks/use-draft-websocket.ts` (handle `draft:timer`, set `timerSeconds` from server)
- Modify: `packages/web/src/lib/hooks/use-draft-countdown.ts` (delete OR neuter — see Step 1)
- Modify: `packages/web/src/lib/hooks/use-draft-expiry-resync.ts` (delete — server now drives expiry via `draft:resync`)
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx` (remove `useDraftCountdown()` and `useDraftExpiryResync()` calls)
- Test: `packages/web/tests/components/use-draft-websocket.test.tsx` (assert `draft:timer` updates the store)

- [ ] **Step 1: Decide deletion vs neuter for `useDraftCountdown`**

If anything else (e.g. summary view) uses `useDraftCountdown`, neuter it to a no-op for active drafts and keep it only as a setter for snapshot displays. Otherwise delete the file. `git grep useDraftCountdown` to confirm scope.

- [ ] **Step 2: Add `draft:timer` listener to the hook**

```ts
socket.on("draft:timer", (payload: { remainingMs: number }) => {
  setFromServer({ timerSeconds: Math.ceil(payload.remainingMs / 1000) });
});
```

- [ ] **Step 3: Remove client-side ticking from the page**

- [ ] **Step 4: Run web tests — expect green**

- [ ] **Step 5: Manual verification**

Open two browsers in the same active draft. Both timer bars should tick in lockstep.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(web): consume server-authoritative draft:timer, drop client-side countdown"
```

---

## Phase 3: Replay state on join (Smell #2)

**Problem:** When a player refreshes the page mid-draft, `fetchDraft()` runs once on mount. If they refresh between two events, they sit on stale store state until the next state-changing event broadcasts. In practice the REST mount fetch hides this, but it's a sharp edge — any client whose REST 200 races the pick that happened during the request will be off by one step until the next pick.

**Approach:** ws keeps an in-memory cache of the most recent `draft:status` and `draft:resync` broadcast for each slug. On `draft:join`, if a cached entry exists, ws replays it to the joining socket only. Browsers already react to those events by refetching from REST, so this becomes a "kick the new joiner to refetch" without any new client logic. Trade-off accepted: the cache may be older than the DB if ws restarted, but the page's REST-mount-fetch is still the source of truth — replay just closes the race window.

### Task 3.1: In-memory last-broadcast cache + replay on `draft:join`

**Files:**
- Modify: `packages/ws/src/rooms.ts` (or add `packages/ws/src/last-broadcast.ts` — store last `pick`/`resync`/`status` per slug)
- Modify: `packages/ws/src/internal-http.ts` (write to the cache before emit)
- Modify: `packages/ws/src/events.ts` (on `draft:join`, replay last `status`/`resync` to the joining socket)
- Test: `packages/ws/tests/events.test.ts` (assert replay-on-join behaviour)

- [ ] **Step 1: Write failing test for replay on join**

```ts
it("emits the most recent draft:resync to a newly joining socket", async () => {
  // 1. seed a slug with a prior resync via internal-http
  // 2. connect a fresh socket and emit draft:join { slug }
  // 3. assert it received draft:resync { packRound, pickStep } matching the seed
});
```

- [ ] **Step 2: Implement a `LastBroadcastCache` keyed by slug** (in-memory `Map<string, {status?, resync?}>`)

- [ ] **Step 3: Update `internal-http.ts` to record on every emit, and `events.ts` to replay on `draft:join` ack**

- [ ] **Step 4: Run ws tests — expect green**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ws): replay last status/resync to newly joining sockets"
```

---

## Phase 4: Make `onStatusChange("completed")` non-brittle (Smell #3)

**Problem:** `page.tsx:140` returns early on `"completed"` and relies on a separate `useEffect` (line 163) keyed off `storeCompleted` to call `fetchDraft()`. Two paths to one outcome — easy to break with a future refactor.

**Approach:** Always call `fetchDraft()` from `onStatusChange`. Remove the second-effect path. Document the contract in a one-line comment on the hook prop.

### Task 4.1: Single-source the completed-status fetch

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`
- Test: `packages/web/tests/pages/draft-detail-page.test.tsx` (extend to assert `onStatusChange("completed")` triggers a fetch)

- [ ] **Step 1: Write a failing test asserting the fetch is called when `draft:complete` arrives**

- [ ] **Step 2: In `page.tsx`, drop the `if (status === "completed") return;` early return**

```ts
useDraftWebsocket(slug, {
  onStatusChange: () => { void fetchDraft(); },
  onResync: () => { void fetchDraft(); },
});
```

- [ ] **Step 3: Delete the `useEffect` at lines 163-167** (`storeCompleted && draft?.status === "active"` → fetch). Keep the store's own `completed: true` set inside `useDraftWebsocket` for any other consumer.

- [ ] **Step 4: Run web tests — expect green**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(web): always refetch on draft status change, drop two-step completed handler"
```

---

## Phase 5: Surface WS connect failures in the UI (Smell #4)

**Problem:** `useDraftWebsocket` `console.warn`s on `connect_error`. If `NEXT_PUBLIC_WS_URL` is wrong or Caddy doesn't proxy `/socket.io/`, every browser fails silently.

**Approach:** Track connection health in a small store slice; render a non-blocking banner when not connected for >3s.

### Task 5.1: Connection-health store and listener

**Files:**
- Create: `packages/web/src/lib/stores/ws-status-store.ts`
- Modify: `packages/web/src/lib/hooks/use-draft-websocket.ts` (write to the store on `connect`/`disconnect`/`connect_error`)
- Test: `packages/web/tests/components/use-draft-websocket.test.tsx`

- [ ] **Step 1: Write failing test asserting connect → status="connected", connect_error → status="error" with last error message**

- [ ] **Step 2: Implement the zustand slice**

```ts
// ws-status-store.ts
export type WsStatus = "idle" | "connecting" | "connected" | "error" | "disconnected";
export interface WsStatusState {
  status: WsStatus;
  errorMessage: string | null;
  setStatus: (s: WsStatus, errorMessage?: string | null) => void;
}
```

- [ ] **Step 3: Wire from the hook**

- [ ] **Step 4: Run web tests — expect green**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(web): track ws connection health in store"
```

### Task 5.2: Banner component

**Files:**
- Create: `packages/web/src/components/draft/ws-connection-banner.tsx`
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx` (render banner above active view)
- Test: `packages/web/tests/components/ws-connection-banner.test.tsx`

- [ ] **Step 1: Write failing test — banner hidden when status="connected", visible after 3s in "error" or "disconnected"**

- [ ] **Step 2: Implement banner with a 3s grace timer (avoids flash on initial connect race)**

- [ ] **Step 3: Mount in active-draft view only**

- [ ] **Step 4: Run web tests — expect green**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(web): show banner when draft websocket is disconnected"
```

---

## Phase 6: Verify Caddy WebSocket upgrade (Smell #5)

**Problem:** If `Caddyfile` doesn't allow the WebSocket upgrade for `/socket.io/`, Socket.IO falls back to HTTP long-polling — works but slow and chatty.

**Approach:** Read `Caddyfile`, confirm `reverse_proxy /socket.io/* ws:3001` (or equivalent) is present and that no `header_up` strips the `Upgrade`/`Connection` headers. Fix if needed.

### Task 6.1: Audit and patch Caddyfile

**Files:**
- Read: `Caddyfile` (root)
- Modify: `Caddyfile` if upgrade not configured
- Test: `packages/web/tests/dockerfile.test.ts` (extend or add a parallel `caddyfile.test.ts` that asserts the file contains a `/socket.io/` reverse_proxy entry)

- [ ] **Step 1: Cat `Caddyfile`. Document current `/socket.io/` handling at top of this task**

- [ ] **Step 2: If missing or proxying to web instead of ws, write a failing config-shape test**

```ts
import { readFileSync } from "node:fs";
it("Caddyfile proxies /socket.io/ to ws:3001 with upgrade allowed", () => {
  const cfg = readFileSync(`${process.cwd()}/../../Caddyfile`, "utf8");
  expect(cfg).toMatch(/handle\s+\/socket\.io\/\*/);
  expect(cfg).toMatch(/reverse_proxy\s+ws:3001/);
});
```

- [ ] **Step 3: Patch Caddyfile**

Typical block:

```
handle /socket.io/* {
  reverse_proxy ws:3001
}
```

(Caddy v2 enables WebSocket upgrade by default; only need to ensure the upstream is the ws service.)

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Manual verification on prod after deploy**

```bash
ssh -i ~/.ssh/hetzner_deploy root@178.105.36.104 'docker exec yugioh-bot-ws-1 sh -c "wc -l < /dev/null"; docker logs --tail 20 yugioh-bot-ws-1 | grep -E "client connected"'
```

Open browser devtools Network tab; filter for `/socket.io/`; the initial polling request should be followed by a 101 Switching Protocols upgrade.

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(infra): proxy /socket.io/* to ws:3001 in Caddyfile"
```

---

## Phase 7: Audit `expireCurrentPickStep` for races (Smell #6)

**Problem:** `pick/route.ts:58` calls `drafts.expireCurrentPickStep(draft.id)` then `drafts.findById` then `drafts.pickCard`. If two players click pick within milliseconds, both requests can interleave: A reads step=2, expires step=2 (auto-fills B), B's request arrives still with step=2 in scope, expires step=2 again (no-op or worse, double-expires). Whichever request wins last sets the engine state, and the broadcast emitted by the loser describes a step that never existed.

**Approach:** Audit the engine. Two outcomes possible:
(a) `expireCurrentPickStep` and `pickCard` are already inside a single transaction with read-then-write under `BEGIN IMMEDIATE` (sqlite better-sqlite3 supports this) — then we're fine and Phase 7 is a confirming test.
(b) They're not — wrap the entire route handler's engine sequence in a transaction OR move the orchestration into the engine itself as `pickCardWithExpiry`.

### Task 7.1: Read and document current transactionality

**Files:** read-only

- Read: `packages/shared/src/services/drafts.ts` (the createDraftService factory and these methods)
- Read: any helper called by `expireCurrentPickStep` and `pickCard`

- [ ] **Step 1: Trace the call chain**

For `expireCurrentPickStep` and `pickCard`, document at the top of this task:
- Does the method open `db.transaction(() => { ... })()`?
- Does it use `BEGIN IMMEDIATE` (better-sqlite3 default for transactions is `DEFERRED`)?
- Are reads inside the same transaction as writes?

- [ ] **Step 2: Write a failing test that simulates two concurrent picks and asserts no double-expiry**

```ts
// packages/web/tests/api/draft-pick-concurrency.test.ts
it("two simultaneous picks for the same step produce one expiry and one pick each", async () => {
  // arrange: active draft, two real players, both have current pack
  // act: fire two pick requests in parallel via Promise.all
  // assert: draft_picks has exactly one row per (player_id, step) with source='manual' for both;
  //         draft state advanced exactly one pick step.
});
```

This test should fail in the current arrangement if there's a race (it may also pass intermittently — flaky failure is the signal).

- [ ] **Step 3: Run test — expect FAIL or flake under repeat (`vitest --repeat=20`)**

### Task 7.2: Wrap orchestration in a single transaction

**Files:**
- Modify: `packages/shared/src/services/drafts.ts` (add `expireAndPick(draftId, playerId, cardId)` method that wraps both calls in `db.transaction`)
- Modify: `packages/web/app/api/drafts/[slug]/pick/route.ts` (call the new combined method)

- [ ] **Step 1: Implement `expireAndPick` calling `expireCurrentPickStep` then `pickCard` inside one transaction**

```ts
expireAndPick(draftId: number, playerId: number, cardId: number) {
  return db.transaction(() => {
    expireCurrentPickStep(draftId);
    return pickCard(draftId, playerId, cardId, "manual");
  })();
}
```

(better-sqlite3 transactions are synchronous and serialised — even if two route handlers race, one waits for the other.)

- [ ] **Step 2: Replace the two-call sequence in the route**

- [ ] **Step 3: Re-run the concurrency test from Task 7.1 — expect green and stable across `--repeat=20`**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(drafts): wrap expire+pick in single transaction to prevent step race"
```

---

## Self-review checklist for the implementer

Before opening the PR for each phase:

- All tests in the affected packages run green: `npm test --workspace=packages/<pkg>`
- No `console.error`/`console.warn` regressions in dev startup
- `git diff --stat origin/main` is bounded — phases are scoped, no drift into adjacent files
- For Phases 2 and 7, manually exercise two-browser flows on a local stack before pushing

## Order, branching, and review

Each phase is independent after Phase 1 lands. Recommended order: Phase 1 → 7 → 4 → 5 → 6 → 3 → 2.

Phase 7 first after Phase 1 because it removes a class of intermittent bugs that would otherwise show up as flaky test runs in later phases. Phase 2 last because it's the largest surface change.
