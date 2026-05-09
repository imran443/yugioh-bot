# Pool Panel Timer Warning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the draft pool panel more useful during active picks by showing more cards, surfacing monster subtypes, and playing a one-time warning sound at 10 seconds remaining.

**Architecture:** Keep the existing `PoolPanel` and `TimerBar` surfaces. Add small pure helpers for pool row metadata, and add timer sound behavior in the countdown hook so the warning is tied to shared timer state instead of a single visual component.

**Tech Stack:** Next.js app router, React client components, Zustand draft store, Vitest, React Testing Library, Web Audio API.

---

## Design

Use the recommended approach: make the existing pool list taller and denser without widening the right column. Keep the current dark competitive draft-room style, visible focus states, Lucide icons, and compact card rows. The desktop/tablet list should show more drafted cards before scrolling; the mobile bottom trigger still opens the sheet.

Each monster row should show monster subtype text extracted from `card.type`, such as `Dragon`, `Fiend`, or `Spellcaster`. Spell and trap rows keep their current broad type label without extra subtype noise.

The timer should play a single short browser-generated beep when the visible countdown reaches `10`. It should reset for each new pack/pick so the warning can fire again next pick. If browser autoplay policy blocks audio, the hook should silently no-op.

## Task 1: Pool Panel Metadata

**Files:**
- Modify: `packages/web/tests/components/pool-panel.test.tsx`
- Modify: `packages/web/src/components/draft/pool-panel.tsx`

**Step 1: Write failing tests**

Add assertions that a monster card row renders its subtype text and that spell/trap cards do not create misleading monster subtype labels.

Use the existing `draftedPool` data:
- `Blue-Eyes White Dragon` should show `Dragon`.
- `Summoned Skull` should show `Fiend`.
- `Mystical Space Typhoon` should still show `Spell`.

**Step 2: Verify red**

Run: `npm run test --workspace=@yugioh-discord-bot/web -- tests/components/pool-panel.test.tsx`

Expected: FAIL because `Dragon` and `Fiend` are not rendered in pool rows yet.

**Step 3: Implement minimal code**

In `pool-panel.tsx`, add a pure helper:

```ts
function getMonsterSubtype(type: string) {
  if (!isMonster(type)) {
    return null;
  }

  const [subtype] = type.split("/").map((part) => part.trim()).filter(Boolean);
  return subtype || null;
}
```

Render the subtype in the existing row metadata line when present.

**Step 4: Make list taller**

Change the card list container from `h-72` to a taller responsive class, for example `h-[26rem] xl:h-[34rem]`, preserving `overflow-y-auto`.

**Step 5: Verify green**

Run: `npm run test --workspace=@yugioh-discord-bot/web -- tests/components/pool-panel.test.tsx`

Expected: PASS.

## Task 2: 10-Second Timer Sound

**Files:**
- Modify: `packages/web/tests/components/use-draft-countdown.test.tsx`
- Modify: `packages/web/src/lib/hooks/use-draft-countdown.ts`

**Step 1: Write failing tests**

Mock `window.AudioContext` with fake oscillator/gain nodes. Add tests that:
- The sound plays once when `timerSeconds` reaches `10`.
- The sound does not repeat while the timer remains in the same pick.
- The warning can play again after `packRound` or `pickStep` changes.

**Step 2: Verify red**

Run: `npm run test --workspace=@yugioh-discord-bot/web -- tests/components/use-draft-countdown.test.tsx`

Expected: FAIL because no audio behavior exists yet.

**Step 3: Implement minimal code**

In `use-draft-countdown.ts`, track the last warned pick key with a `useRef`. When `timerSeconds === 10`, `completed` is false, and the current `packRound:pickStep` key has not warned, call a small `playTimerWarning()` helper.

Use Web Audio API with a short oscillator beep:

```ts
const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
if (!AudioContextCtor) return;
const audioContext = new AudioContextCtor();
const oscillator = audioContext.createOscillator();
const gain = audioContext.createGain();
oscillator.frequency.value = 880;
gain.gain.value = 0.06;
oscillator.connect(gain);
gain.connect(audioContext.destination);
oscillator.start();
oscillator.stop(audioContext.currentTime + 0.12);
```

Wrap this in `try/catch` so blocked audio does not break the draft room.

**Step 4: Verify green**

Run: `npm run test --workspace=@yugioh-discord-bot/web -- tests/components/use-draft-countdown.test.tsx`

Expected: PASS.

## Task 3: Final Verification

**Files:**
- All modified files.

**Step 1: Run focused tests**

Run: `npm run test --workspace=@yugioh-discord-bot/web -- tests/components/pool-panel.test.tsx tests/components/use-draft-countdown.test.tsx`

Expected: PASS.

**Step 2: Run full checks**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test`

Expected: PASS.

**Step 3: Inspect git status**

Run: `git status --short --branch`

Expected: only intended files changed plus any pre-existing untracked plan docs.
