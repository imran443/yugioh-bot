# Tournament UX Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three reported tournament/match bugs: (1) misleading "Round X of Y" indicator for round-robin, (2) public Approve/Deny buttons leaking cryptic errors to the wrong users, (3) no announcement when a tournament completes.

**Architecture:** Bug 1 is a web display change made format-aware (round numbers are real only for single-elim). Bug 2 encodes the expected approver in the button customId and translates raw service errors into one friendly, specific message in the bot handler. Bug 3 adds a new `tournament-completed` announcement, fired once (idempotent) from the bot when an approval transitions a tournament to `completed`.

**Tech Stack:** Next.js 16 / React (web), discord.js (bot), better-sqlite3 (shared), Vitest + Testing Library.

---

## Root Cause Summary (verified against code)

- **Bug 1** — `packages/web/src/components/tournament/overview-tab.tsx:45-48` computes `currentRound` as `tournament.matches.find((m) => m.status !== "completed")?.roundNumber` — the round of the *first non-completed match in DB array order*. For `round_robin`, all matches across all rounds are generated at `start()` and never advanced (`packages/shared/src/tournaments/formats.ts` `generateRoundRobin`); players play in any order, so this number is a meaningless scheduling artifact that jumps around. For `single_elim` round numbers are real (round N+1 is generated only after round N completes — `packages/shared/src/services/matches.ts:138`). `packages/web/src/components/tournament/your-action-card.tsx:36` shows the same artifact as `Your match — Round {n}`.
- **Bug 2** — The report-pending message is a **public** channel message (`packages/bot/src/announce/handlers.ts:66`) whose buttons carry only the match id (`packages/bot/src/announce/messages.ts:67,71` → `dashboard_approve:{matchId}`). The handler (`packages/bot/src/interactions/buttons.ts:685-729`) upserts a player for *any* clicker and calls `deps.matches.approve`, which throws raw strings: `"Match not found"` (`packages/shared/src/services/matches.ts:59`, fires for a stale button after the public message outlived its row — e.g. `deleteNotifyMessage` failed or a `reset:test-data` reseed), `"Match is not pending"` (`matches.ts:70`), or `"Only the opponent can approve this match"` (`matches.ts:74`, fires for a wrong user while still pending). Discord cannot hide a button per-user on a channel message, so the fix is server-side gating + friendly errors.
- **Bug 3** — `packages/bot/src/announce/server.ts:5-24` has no `tournament-completed` kind and no `onTournamentCompleted` handler. Tournament completion is marked silently at `packages/shared/src/services/matches.ts:112` and `:169`. The only "has completed" message users see is the stale **draft**-completed announcement (`packages/bot/src/announce/messages.ts:34-48`) pointing at `/draft/{slug}` with a "Create Tournament" button. (`createTournamentFromDraft` is already idempotent — `packages/shared/src/services/draft-tournament.ts:51-65` — so duplicate tournaments are NOT the bug; the missing completion announcement is.)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/web/src/components/tournament/overview-tab.tsx` | Active-tournament progress banner | Modify — format-aware round display |
| `packages/web/src/components/tournament/your-action-card.tsx` | "Your match" card title | Modify — drop round suffix for round-robin |
| `packages/web/tests/components/tournament-detail-page.test.tsx` | Overview banner behavior | Modify — add round-robin/single-elim cases |
| `packages/web/tests/components/your-action-card.test.tsx` | Card title behavior | Modify — reconcile round-robin expectation |
| `packages/bot/src/announce/messages.ts` | Discord message builders | Modify — encode approver in customId; add `tournamentCompletedAnnouncement` |
| `packages/bot/src/interactions/buttons.ts` | Approve/Deny button handler | Modify — gate by approver, friendly errors, fire completion announce |
| `packages/bot/src/index.ts` | Wires bot deps | Modify — inject `announceTournamentCompleted` callback |
| `packages/shared/src/db/schema.ts` | SQLite migrations | Modify — add `tournaments.completed_announced_at` |
| `packages/bot/tests/announce/messages.test.ts` | Message builder tests | Modify — new customId + completion message |
| `packages/bot/tests/interactions/buttons.test.ts` | Button handler tests | Modify — wrong-user gating + friendly errors |
| `packages/bot/tests/services/tournament-reporting.test.ts` | Completion → announce | Modify — completion fires announce once |

**Test commands:**
- Web: `npx vitest run packages/web/tests/<file> -c packages/web/vitest.config.ts`
- Bot/shared: `npx vitest run packages/<pkg>/tests/<file>`

---

## Phase 1 — Bug 1: Format-aware round indicator (web)

### Task 1: Overview banner is format-aware

**Files:**
- Modify: `packages/web/src/components/tournament/overview-tab.tsx:39-80`
- Test: `packages/web/tests/components/tournament-detail-page.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/tests/components/tournament-detail-page.test.tsx` (follow the existing mock pattern in that file — `next/navigation` + `@/lib/hooks/use-tournament-websocket`, `searchParams = new URLSearchParams()` for the default Overview tab). Use a tournament fixture with `format: "round_robin"`, 3 matches where 2 are `completed` and 1 (roundNumber 1) is `open`, plus `status: "active"`:

```tsx
it("round-robin overview shows match progress but NOT a round number", async () => {
  // fixture: format "round_robin", matches roundNumbers [1,2,3], statuses [open, completed, completed]
  renderPage(roundRobinTournament);
  expect(await screen.findByText(/2\/3 matches done/i)).toBeTruthy();
  expect(screen.queryByText(/round 1 of 3/i)).toBeNull();
  expect(screen.queryByText(/round \d+ of \d+/i)).toBeNull();
});

it("single-elim overview still shows the current round", async () => {
  // fixture: format "single_elim", matches roundNumbers [1,1,2], statuses [completed, completed, open]
  renderPage(singleElimTournament);
  expect(await screen.findByText(/round 2 of 2/i)).toBeTruthy();
  expect(screen.getByText(/2\/3 matches done/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/components/tournament-detail-page.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — round-robin case finds "Round 1 of 3" (current bug); single-elim case finds "Round 1 of 2" not "Round 2 of 2".

- [ ] **Step 3: Implement the format-aware banner**

In `packages/web/src/components/tournament/overview-tab.tsx`, replace the block at lines 39-48 with:

```tsx
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
```

Then replace the banner `<p>` (lines 64-70) with two clear branches (single, non-nested ternary):

```tsx
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/tournament-detail-page.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (both new cases + existing cases still green).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/overview-tab.tsx packages/web/tests/components/tournament-detail-page.test.tsx
git commit -m "fix(web): make tournament round indicator format-aware"
```

### Task 2: "Your match" card drops the round suffix for round-robin

**Files:**
- Modify: `packages/web/src/components/tournament/your-action-card.tsx:36`
- Test: `packages/web/tests/components/your-action-card.test.tsx`

- [ ] **Step 1: Write/modify the failing tests**

In `packages/web/tests/components/your-action-card.test.tsx`, change the first test's assertion (it currently asserts `/round 2/i` while `tournamentFormat="round_robin"`) and add a single-elim case:

```tsx
it("round-robin: prompts to report without a round number", () => {
  render(
    <YourActionCard actionMatch={openMine} tournamentSlug="s1" tournamentFormat="round_robin" currentUserPlayerId={10} onChanged={() => {}} />,
  );
  expect(screen.getByText(/your match/i)).toBeTruthy();
  expect(screen.queryByText(/round 2/i)).toBeNull();
});

it("single-elim: prompts to report with the round number", () => {
  render(
    <YourActionCard actionMatch={openMine} tournamentSlug="s1" tournamentFormat="single_elim" currentUserPlayerId={10} onChanged={() => {}} />,
  );
  expect(screen.getByText(/round 2/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/components/your-action-card.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — round-robin case still finds "Round 2".

- [ ] **Step 3: Implement the conditional suffix**

In `packages/web/src/components/tournament/your-action-card.tsx`, locate the title at line 36 (`Your match — Round {actionMatch.roundNumber}`). Derive the suffix once, then use it in the title:

```tsx
const roundLabel =
  tournamentFormat === "single_elim" ? ` — Round ${actionMatch.roundNumber}` : "";
```

```tsx
Your match{roundLabel}
```

(Confirm `tournamentFormat` is already a prop on this component — it is, per existing tests passing `tournamentFormat`. If the round text appears in more than one place in the file, apply the same conditional to each.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/your-action-card.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tournament/your-action-card.tsx packages/web/tests/components/your-action-card.test.tsx
git commit -m "fix(web): hide round suffix on action card for round-robin"
```

---

## Phase 2 — Bug 2: Authorize Approve/Deny + friendly errors (bot)

### Task 3: Encode the expected approver in the button customId

**Files:**
- Modify: `packages/bot/src/announce/messages.ts:51-77`
- Test: `packages/bot/tests/announce/messages.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/bot/tests/announce/messages.test.ts`:

```ts
import { reportPendingAnnouncement } from "../../src/announce/messages.js";

it("encodes the expected approver discord id in the approve/deny customIds", () => {
  const { components } = reportPendingAnnouncement({
    matchId: 42, tournamentName: "locals", roundNumber: 3,
    reporterName: "Alice", opponentDiscordId: "999", opponentLost: true,
  });
  const ids = components[0].components.map((c) => (c.toJSON() as { custom_id: string }).custom_id);
  expect(ids).toEqual(["dashboard_approve:42:999", "dashboard_deny:42:999"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/bot/tests/announce/messages.test.ts`
Expected: FAIL — ids are `dashboard_approve:42` / `dashboard_deny:42`.

- [ ] **Step 3: Implement the customId change**

In `packages/bot/src/announce/messages.ts`, in `reportPendingAnnouncement`, change lines 67 and 71:

```ts
.setCustomId(`dashboard_approve:${input.matchId}:${input.opponentDiscordId}`)
// ...
.setCustomId(`dashboard_deny:${input.matchId}:${input.opponentDiscordId}`)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/bot/tests/announce/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/announce/messages.ts packages/bot/tests/announce/messages.test.ts
git commit -m "feat(bot): encode expected approver in match report buttons"
```

### Task 4: Gate the handler by approver and translate errors

**Files:**
- Modify: `packages/bot/src/interactions/buttons.ts:685-729`
- Test: `packages/bot/tests/interactions/buttons.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/bot/tests/interactions/buttons.test.ts` (use the existing harness in that file for constructing a `ButtonInteractionLike` and `deps`; reuse its tournament/match seed helpers):

```ts
it("blocks a non-approver with a clear message and does not touch the match", () => {
  // seed a pending tournament match; opponent discord id = "OPP"
  const interaction = makeButton("dashboard_approve:" + matchId + ":OPP", { userId: "SOMEONE_ELSE" });
  await handleButton(interaction, deps);
  expect(interaction.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringMatching(/only <@OPP> can respond/i), ephemeral: true }),
  );
  expect(matches.findById(matchId).status).toBe("pending"); // untouched
});

it("gives a friendly message for a stale button (match no longer exists)", () => {
  const interaction = makeButton("dashboard_approve:999999:OPP", { userId: "OPP" });
  await handleButton(interaction, deps);
  expect(interaction.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringMatching(/no longer available/i), ephemeral: true }),
  );
});

it("gives a friendly message when the report was already resolved", () => {
  // approve once as OPP, then a second approve attempt as OPP
  await handleButton(makeButton(`dashboard_approve:${matchId}:OPP`, { userId: "OPP" }), deps);
  const second = makeButton(`dashboard_approve:${matchId}:OPP`, { userId: "OPP" });
  await handleButton(second, deps);
  expect(second.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringMatching(/already been resolved/i), ephemeral: true }),
  );
});

it("still lets the legitimate opponent approve (backward-compatible with id-only customId)", () => {
  const interaction = makeButton(`dashboard_approve:${matchId}`, { userId: "OPP" }); // legacy form, no :discordId
  await handleButton(interaction, deps);
  expect(interaction.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringMatching(/approved match #/i), ephemeral: true }),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/bot/tests/interactions/buttons.test.ts`
Expected: FAIL — wrong user currently gets `"Only the opponent can approve this match"`; stale button gets raw `"Match not found"`; double-approve gets raw `"Match is not pending"`.

- [ ] **Step 3: Implement gating + error translation**

In `packages/bot/src/interactions/buttons.ts`, replace the approve regex/handler (lines 685-706) and the deny regex/handler (lines 708-729). The regex must accept an optional `:discordId` suffix and stay backward-compatible:

```ts
const RESOLVE_RE = /^dashboard_(approve|deny):(\d+)(?::(\d+))?$/;
const resolveMatch = RESOLVE_RE.exec(interaction.customId);

if (resolveMatch) {
  const action = resolveMatch[1] as "approve" | "deny";
  const matchId = Number(resolveMatch[2]);
  const expectedApproverDiscordId = resolveMatch[3];

  if (expectedApproverDiscordId && interaction.user.id !== expectedApproverDiscordId) {
    await interaction.reply({
      content: `Only <@${expectedApproverDiscordId}> can respond to this match report.`,
      ephemeral: true,
    });
    return;
  }

  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));

  // Map raw service errors to one friendly message (no nested ternaries — lookup table).
  const FRIENDLY_ERRORS: Record<string, string> = {
    "Match not found":
      "This match report is no longer available — it may have been resolved or the data was reset.",
    "Match is not pending": "This match report has already been resolved.",
    "Only the opponent can approve this match":
      "Only your opponent can respond to this match report.",
  };

  let match;
  try {
    match =
      action === "approve"
        ? deps.matches.approve(matchId, player.id)
        : deps.matches.deny(matchId, player.id);
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    await interaction.reply({
      content: FRIENDLY_ERRORS[raw] ?? "Could not process this match report.",
      ephemeral: true,
    });
    return;
  }

  const tournamentRow = match.tournamentId
    ? deps.db.prepare("select web_slug from tournaments where id = ?").get(match.tournamentId) as { web_slug: string | null } | undefined
    : undefined;
  if (tournamentRow?.web_slug) {
    void notifyWsTournament(
      { url: process.env.WS_INTERNAL_URL ?? "", secret: process.env.WS_INTERNAL_SECRET ?? "" },
      { kind: "match-updated", slug: tournamentRow.web_slug },
    );
  }
  if (deps.deleteNotifyMessage) {
    await deps.deleteNotifyMessage(match.id);
  }
  await interaction.reply({
    content: `${action === "approve" ? "Approved" : "Denied"} match #${match.id}.`,
    ephemeral: true,
  });
  return;
}
```

Delete the now-replaced separate `approveMatch` and `denyMatch` blocks. (The other customId producer at `buttons.ts:672-676` uses the legacy `dashboard_approve:${match.id}` form with no discord id — the optional-group regex keeps it working; no change needed there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/bot/tests/interactions/buttons.test.ts`
Expected: PASS (including any pre-existing approve/deny tests in that file — they use the legacy id-only form and remain green).

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/interactions/buttons.ts packages/bot/tests/interactions/buttons.test.ts
git commit -m "fix(bot): gate match approve/deny by approver with friendly errors"
```

---

## Phase 3 — Bug 3: Tournament-completed announcement (bot + shared)

### Task 5: Add `completed_announced_at` migration column

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (alongside the other `addColumnIfMissing` calls, ~line 254)
- Test: `packages/shared/tests/db/schema.test.ts` (if absent, add the assertion to the nearest existing schema/migration test; otherwise create this file with the single test below)

- [ ] **Step 1: Write the failing test**

```ts
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { describe, expect, it } from "vitest";

it("adds tournaments.completed_announced_at", () => {
  const db = new Database(":memory:");
  migrate(db);
  const cols = db.prepare("pragma table_info(tournaments)").all() as { name: string }[];
  expect(cols.map((c) => c.name)).toContain("completed_announced_at");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts`
Expected: FAIL — column missing.

- [ ] **Step 3: Add the migration**

In `packages/shared/src/db/schema.ts`, next to the existing `addColumnIfMissing(db, "matches", "notify_message_id", "text");`:

```ts
addColumnIfMissing(db, "tournaments", "completed_announced_at", "text");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/tests/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/tests/db/schema.test.ts
git commit -m "feat(shared): add tournaments.completed_announced_at column"
```

### Task 6: Add the `tournamentCompletedAnnouncement` message builder

**Files:**
- Modify: `packages/bot/src/announce/messages.ts`
- Test: `packages/bot/tests/announce/messages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { tournamentCompletedAnnouncement } from "../../src/announce/messages.js";

it("formats the tournament-completed announcement to the tournament results page", () => {
  expect(
    tournamentCompletedAnnouncement({ name: "locals", webSlug: "abc", webUrl: "https://app.test" }),
  ).toBe("🏆 **locals** has completed! Final standings: https://app.test/tournament/abc");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/bot/tests/announce/messages.test.ts`
Expected: FAIL — `tournamentCompletedAnnouncement` is not exported.

- [ ] **Step 3: Implement the builder**

In `packages/bot/src/announce/messages.ts`, add (mirroring `tournamentStartedAnnouncement` at line 31, using the existing `webBaseUrl` helper):

```ts
export function tournamentCompletedAnnouncement(input: {
  name: string;
  webSlug: string;
  webUrl?: string;
}): string {
  return `🏆 **${input.name}** has completed! Final standings: ${webBaseUrl(input.webUrl)}/tournament/${input.webSlug}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/bot/tests/announce/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/announce/messages.ts packages/bot/tests/announce/messages.test.ts
git commit -m "feat(bot): add tournament-completed announcement message"
```

### Task 7: Fire the completion announcement once, from the approve path

**Files:**
- Modify: `packages/bot/src/interactions/buttons.ts` (declare `deps.announceTournamentCompleted?`, call it after approve)
- Modify: `packages/bot/src/index.ts` (implement and inject the callback)
- Test: `packages/bot/tests/services/tournament-reporting.test.ts`

- [ ] **Step 0: Verify the integration point**

Run: `grep -rn "\.approve(" packages/bot/src packages/web/app packages/web/src | grep -vi test`
Expected: the only caller that can transition a tournament to `completed` is the bot button handler (`buttons.ts`). If a web-side approve exists, add the same guarded call there too (same code as Step 3). Document what you found in the commit body.

- [ ] **Step 1: Write the failing test**

Add to `packages/bot/tests/services/tournament-reporting.test.ts` (this suite already starts tournaments and approves matches via `app.matches.approve`; use a 2-player `single_elim` or a minimal `round_robin` so one approval completes it):

```ts
it("fires the tournament-completed announcement exactly once when the final match is approved", () => {
  const announced: number[] = [];
  const deps = makeButtonDeps({ announceTournamentCompleted: async (id: number) => { announced.push(id); } });
  // seed: tournament with a single pending match whose approval completes it
  await handleButton(makeButton(`dashboard_approve:${matchId}:OPP`, { userId: "OPP" }), deps);
  expect(announced).toEqual([tournamentId]);

  // a second, unrelated approve in the now-completed tournament must NOT re-announce
  // (or: re-running the guard for the same tournament is a no-op)
  await handleButton(makeButton(`dashboard_approve:${otherMatchId}:OPP2`, { userId: "OPP2" }), deps).catch(() => {});
  expect(announced).toEqual([tournamentId]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/bot/tests/services/tournament-reporting.test.ts`
Expected: FAIL — `announced` stays empty (no completion hook).

- [ ] **Step 3: Implement the guarded call in `buttons.ts`**

Add to the button `deps` type (near `deleteNotifyMessage?` at `buttons.ts:40`):

```ts
announceTournamentCompleted?: (tournamentId: number) => Promise<void>;
```

In the resolve handler from Task 4, immediately after a successful `approve` (only for `action === "approve"`, before the `interaction.reply` success line), add:

```ts
if (action === "approve" && match.tournamentId && deps.announceTournamentCompleted) {
  // Race-safe one-shot: only the approval that flips status to completed wins this update.
  const claimed = deps.db
    .prepare(
      "update tournaments set completed_announced_at = current_timestamp " +
      "where id = ? and status = 'completed' and completed_announced_at is null",
    )
    .run(match.tournamentId);
  if (claimed.changes === 1) {
    await deps.announceTournamentCompleted(match.tournamentId);
  }
}
```

- [ ] **Step 4: Implement the callback in `index.ts`**

In `packages/bot/src/index.ts`, where button `deps` is assembled (same place `deleteNotifyMessage` is wired, see import at `index.ts:53`), add `import { tournamentCompletedAnnouncement } from "./announce/messages.js";` and inject:

```ts
announceTournamentCompleted: async (tournamentId: number) => {
  const t = db
    .prepare("select name, web_slug, guild_id from tournaments where id = ?")
    .get(tournamentId) as { name: string; web_slug: string | null; guild_id: string } | undefined;
  if (!t?.web_slug) return;
  const channelId = guildSettings.get(t.guild_id).announceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !("send" in channel) || !channel.isTextBased()) return;
  await channel.send(tournamentCompletedAnnouncement({ name: t.name, webSlug: t.web_slug }));
},
```

(Use the same `guildSettings` / `client` references already used to build the announce handlers in this file. If `guildSettings` is not in scope here, reuse the same accessor the announce handler factory uses — `packages/bot/src/announce/handlers.ts:62` does `guildSettings.get(p.guildId).announceChannelId`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/bot/tests/services/tournament-reporting.test.ts packages/bot/tests/interactions/buttons.test.ts`
Expected: PASS — announce fires once; second approve is a no-op (`changes === 0`).

- [ ] **Step 6: Commit**

```bash
git add packages/bot/src/interactions/buttons.ts packages/bot/src/index.ts packages/bot/tests/services/tournament-reporting.test.ts
git commit -m "feat(bot): announce tournament completion once when final match is approved"
```

---

## Phase 4 — Full verification

### Task 8: Whole-suite green + typecheck + build

- [ ] **Step 1:** Run `npm run typecheck` — Expected: 4/4 packages clean.
- [ ] **Step 2:** Run `npm test` — Expected: all packages pass; no new failures vs. the 639-passing baseline (ws/shared/bot/web).
- [ ] **Step 3:** Run `npm run build` — Expected: 4/4 build success.
- [ ] **Step 4:** Manual smoke (optional, dev:web running): open a round-robin tournament Overview — banner shows only "N/M matches done", no "Round X of Y"; open a single-elim — "Round X of Y" still present.
- [ ] **Step 5: Commit** any incidental fixes:

```bash
git add -A && git commit -m "test: green suite + typecheck + build for tournament UX fixes"
```

---

## Self-Review

**Spec coverage:**
- Bug 1 (rounds incorrect / "perhaps we remove this") → Tasks 1–2 (format-aware: removed for round-robin, kept & corrected to min-incomplete for single-elim). ✓
- Bug 2 (buttons clickable by anyone, "match not found") → Tasks 3–4 (approver encoded in customId, server-side gate, all three raw errors → friendly specific messages, backward-compatible with legacy customId). ✓
- Bug 3 (no tournament-completed announcement; stale draft message) → Tasks 5–7 (new message to `/tournament/` results, fired once via race-safe column guard). ✓

**Placeholder scan:** No TBD/"handle edge cases"/"write tests for the above" — every code step has concrete code; every test step has concrete assertions. ✓

**Type consistency:** `deps.announceTournamentCompleted?: (tournamentId: number) => Promise<void>` declared in Task 7 Step 3 and implemented identically in Step 4. `tournamentCompletedAnnouncement({ name, webSlug, webUrl? })` defined in Task 6 and called (2-arg form) in Task 7. `RESOLVE_RE` capture groups (`approve|deny`, matchId, optional discordId) consistent between Task 3's customId format and Task 4's regex. ✓

**Open assumptions to confirm during execution (not blockers):**
- Task 7 Step 0 explicitly verifies there is no second `.approve(` caller before relying on the single bot integration point.
- `your-action-card.tsx` round text is assumed to appear once; Task 2 Step 3 instructs applying the conditional to each occurrence if more exist.
