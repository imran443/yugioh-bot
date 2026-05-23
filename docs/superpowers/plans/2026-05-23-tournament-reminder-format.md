# Tournament Reminder Message Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single flat plain-text tournament reminder with one purple embed per tournament (matchups grouped by round) preceded by a deduped `Playing:` ping line that still notifies every player with an open match.

**Architecture:** A pure, framework-free formatter (`buildTournamentReminders`) in `packages/bot/src/reminders/tournament-reminders.ts` turns the existing flat target list into structured per-tournament messages (`{ content?, embed? }`). The discord.js wiring in `packages/bot/src/index.ts` maps each message to an `EmbedBuilder` and sends it. The SQL selector (`selectTournamentReminderTargets`) is unchanged. Mentions inside an embed render as names without pinging; only the `content` line pings — so no display-name lookup is needed.

**Tech Stack:** TypeScript, discord.js (`EmbedBuilder`), Vitest, better-sqlite3 (unchanged), node-cron (unchanged).

Spec: `docs/superpowers/specs/2026-05-23-tournament-reminder-format-design.md`

---

## File Structure

- **Modify** `packages/bot/src/reminders/tournament-reminders.ts` — keep `TournamentReminderTarget` + `selectTournamentReminderTargets`; remove `formatTournamentReminder`; add the `ReminderEmbedField` / `ReminderEmbed` / `TournamentReminderMessage` types, internal grouping/chunking helpers, and the exported `buildTournamentReminders`.
- **Modify** `packages/bot/src/index.ts` — swap the import and replace the single `channel.send(string)` with a loop that builds an `EmbedBuilder` per message and sends `{ content, embeds }`.
- **Modify** `packages/bot/tests/reminders/tournament-reminders.test.ts` — add unit tests for `buildTournamentReminders` (pure, hand-built target arrays; no DB). Existing `selectTournamentReminderTargets` tests stay untouched.

---

## Task 1: Core formatter (grouping, fields, ping line)

**Files:**
- Modify: `packages/bot/src/reminders/tournament-reminders.ts`
- Test: `packages/bot/tests/reminders/tournament-reminders.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the **top** of `packages/bot/tests/reminders/tournament-reminders.test.ts`, update the existing import line, and append a new `describe` block.

Change the existing import:

```ts
import {
  buildTournamentReminders,
  selectTournamentReminderTargets,
  type TournamentReminderTarget,
} from "../../src/reminders/tournament-reminders.js";
```

Add this helper just below the existing `setup()` function:

```ts
function target(
  tournamentName: string,
  roundNumber: number,
  playerOneDiscordUserId: string,
  playerTwoDiscordUserId: string,
): TournamentReminderTarget {
  return {
    guildId: "guild-1",
    tournamentName,
    roundNumber,
    playerOneDiscordUserId,
    playerTwoDiscordUserId,
  };
}
```

Append this new describe block at the end of the file:

```ts
describe("buildTournamentReminders", () => {
  it("returns an empty array when there are no targets", () => {
    expect(buildTournamentReminders([])).toEqual([]);
  });

  it("builds one message per tournament in input order", () => {
    const messages = buildTournamentReminders([
      target("Alpha Cup", 1, "a1", "a2"),
      target("Beta Cup", 1, "b1", "b2"),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0].embed?.title).toBe("🏆 Alpha Cup");
    expect(messages[1].embed?.title).toBe("🏆 Beta Cup");
  });

  it("groups matchups into one field per round and uses the brand color", () => {
    const [message] = buildTournamentReminders([
      target("Alpha Cup", 1, "a1", "a2"),
      target("Alpha Cup", 1, "a3", "a4"),
      target("Alpha Cup", 2, "a5", "a6"),
    ]);

    expect(message.embed?.color).toBe(0x9b59b6);
    expect(message.embed?.description).toBe("3 matches still to play");
    expect(message.embed?.fields).toEqual([
      { name: "Round 1", value: "<@a1> vs <@a2>\n<@a3> vs <@a4>" },
      { name: "Round 2", value: "<@a5> vs <@a6>" },
    ]);
  });

  it("uses the singular noun for a single match", () => {
    const [message] = buildTournamentReminders([target("Alpha Cup", 1, "a1", "a2")]);
    expect(message.embed?.description).toBe("1 match still to play");
  });

  it("pings each player once, in first-appearance order, as a lead-in on the first message", () => {
    const [message] = buildTournamentReminders([
      target("Alpha Cup", 1, "a1", "a2"),
      target("Alpha Cup", 2, "a1", "a3"),
    ]);

    expect(message.content).toBe("Playing: <@a1> <@a2> <@a3>");
    expect(message.embed).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/bot/tests/reminders/tournament-reminders.test.ts`
Expected: FAIL — `buildTournamentReminders` is not exported (import error / not a function).

- [ ] **Step 3: Implement the core formatter**

In `packages/bot/src/reminders/tournament-reminders.ts`, **delete** the existing `formatTournamentReminder` function (lines 45-56) and append the following. Leave `TournamentReminderTarget` and `selectTournamentReminderTargets` exactly as they are.

```ts
const REMINDER_COLOR = 0x9b59b6;

export interface ReminderEmbedField {
  name: string;
  value: string;
}

export interface ReminderEmbed {
  title: string;
  description: string;
  color: number;
  fields: ReminderEmbedField[];
}

export interface TournamentReminderMessage {
  content?: string;
  embed?: ReminderEmbed;
}

function groupByTournament(
  targets: TournamentReminderTarget[],
): TournamentReminderTarget[][] {
  const order: string[] = [];
  const groups = new Map<string, TournamentReminderTarget[]>();
  for (const t of targets) {
    let group = groups.get(t.tournamentName);
    if (!group) {
      group = [];
      groups.set(t.tournamentName, group);
      order.push(t.tournamentName);
    }
    group.push(t);
  }
  return order.map((name) => groups.get(name)!);
}

function groupByRound(
  targets: TournamentReminderTarget[],
): { round: number; matches: TournamentReminderTarget[] }[] {
  const order: number[] = [];
  const groups = new Map<number, TournamentReminderTarget[]>();
  for (const t of targets) {
    let group = groups.get(t.roundNumber);
    if (!group) {
      group = [];
      groups.set(t.roundNumber, group);
      order.push(t.roundNumber);
    }
    group.push(t);
  }
  return order.map((round) => ({ round, matches: groups.get(round)! }));
}

function matchLine(target: TournamentReminderTarget): string {
  return `<@${target.playerOneDiscordUserId}> vs <@${target.playerTwoDiscordUserId}>`;
}

function buildRoundFields(
  round: number,
  matches: TournamentReminderTarget[],
): ReminderEmbedField[] {
  const value = matches.map(matchLine).join("\n");
  return [{ name: `Round ${round}`, value }];
}

function buildPingLine(targets: TournamentReminderTarget[]): string {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const t of targets) {
    for (const id of [t.playerOneDiscordUserId, t.playerTwoDiscordUserId]) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return `Playing: ${ids.map((id) => `<@${id}>`).join(" ")}`;
}

export function buildTournamentReminders(
  targets: TournamentReminderTarget[],
): TournamentReminderMessage[] {
  const messages: TournamentReminderMessage[] = [];

  for (const tournamentTargets of groupByTournament(targets)) {
    const name = tournamentTargets[0].tournamentName;
    const count = tournamentTargets.length;
    const description = `${count} ${count === 1 ? "match" : "matches"} still to play`;

    const fields = groupByRound(tournamentTargets).flatMap(({ round, matches }) =>
      buildRoundFields(round, matches),
    );

    const embed: ReminderEmbed = {
      title: `🏆 ${name}`,
      description,
      color: REMINDER_COLOR,
      fields,
    };

    messages.push({ content: buildPingLine(tournamentTargets), embed });
  }

  return messages;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/bot/tests/reminders/tournament-reminders.test.ts`
Expected: PASS — all `buildTournamentReminders` tests plus the untouched `selectTournamentReminderTargets` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/reminders/tournament-reminders.ts packages/bot/tests/reminders/tournament-reminders.test.ts
git commit -m "feat(bot): build per-tournament reminder embeds with deduped ping line"
```

---

## Task 2: Discord length-limit handling (field chunk, embed spill, ping split)

**Files:**
- Modify: `packages/bot/src/reminders/tournament-reminders.ts`
- Test: `packages/bot/tests/reminders/tournament-reminders.test.ts`

Discord limits this enforces: embed field value ≤ 1024 chars, ≤ 25 fields per embed (with a char-budget safety margin), message `content` ≤ 2000 chars.

- [ ] **Step 1: Write the failing tests**

Append these tests inside the existing `describe("buildTournamentReminders", ...)` block. Add this generator helper just above the new tests (still inside the describe block is fine, or beside the `target` helper):

```ts
function manyMatches(
  tournamentName: string,
  round: number,
  count: number,
): TournamentReminderTarget[] {
  return Array.from({ length: count }, (_, i) =>
    target(
      tournamentName,
      round,
      `100000000000000${String(i * 2).padStart(3, "0")}`,
      `100000000000000${String(i * 2 + 1).padStart(3, "0")}`,
    ),
  );
}
```

```ts
it("splits a round's matches across continuation fields past the 1024-char limit", () => {
  const [message] = buildTournamentReminders(manyMatches("Big Cup", 1, 40));
  const fields = message.embed!.fields;

  expect(fields.length).toBeGreaterThan(1);
  expect(fields[0].name).toBe("Round 1");
  expect(fields[1].name).toBe("Round 1 (cont.)");
  for (const field of fields) {
    expect(field.value.length).toBeLessThanOrEqual(1024);
  }
});

it("spills past 25 fields into a continuation embed-only message", () => {
  const targets = Array.from({ length: 26 }, (_, i) =>
    target("Long Cup", i + 1, `p${i}a`, `p${i}b`),
  );
  const messages = buildTournamentReminders(targets);

  // First message: ping line + first embed (capped at 25 fields).
  expect(messages[0].content).toContain("Playing:");
  expect(messages[0].embed!.title).toBe("🏆 Long Cup");
  expect(messages[0].embed!.fields).toHaveLength(25);

  // A later message is embed-only and titled as a continuation.
  const continuation = messages.find((m) => m.embed?.title === "🏆 Long Cup (cont.)");
  expect(continuation).toBeDefined();
  expect(continuation!.content).toBeUndefined();
  expect(continuation!.embed!.fields).toHaveLength(1);
  expect(continuation!.embed!.description).toBe("");
});

it("splits the ping line into content-only messages past the 2000-char limit", () => {
  const messages = buildTournamentReminders(manyMatches("Huge Cup", 1, 60));

  const pingMessages = messages.filter((m) => m.content?.startsWith("Playing:"));
  expect(pingMessages.length).toBeGreaterThan(1);
  for (const m of pingMessages) {
    expect(m.content!.length).toBeLessThanOrEqual(2000);
  }
  // The first ping chunk shares the first embed; later ping chunks are content-only.
  expect(messages[0].embed).toBeDefined();
  const extraPing = pingMessages[1];
  expect(extraPing.embed).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/bot/tests/reminders/tournament-reminders.test.ts`
Expected: FAIL — current code emits a single field per round, single embed, single ping line (e.g. field value exceeds 1024; only 25-field assertion / continuation lookups fail).

- [ ] **Step 3: Implement the limit handling**

In `packages/bot/src/reminders/tournament-reminders.ts`, add the limit constants next to `REMINDER_COLOR`:

```ts
const FIELD_VALUE_MAX = 1024;
const EMBED_FIELDS_MAX = 25;
const EMBED_CHARS_MAX = 5500; // safety margin under Discord's 6000 embed total
const CONTENT_MAX = 2000;
```

Replace `buildRoundFields` with a chunking version:

```ts
function buildRoundFields(
  round: number,
  matches: TournamentReminderTarget[],
): ReminderEmbedField[] {
  const fields: ReminderEmbedField[] = [];
  let value = "";

  const pushField = () => {
    const name = fields.length === 0 ? `Round ${round}` : `Round ${round} (cont.)`;
    fields.push({ name, value });
    value = "";
  };

  for (const match of matches) {
    const line = matchLine(match);
    const candidate = value ? `${value}\n${line}` : line;
    if (candidate.length > FIELD_VALUE_MAX && value) {
      pushField();
      value = line;
    } else {
      value = candidate;
    }
  }
  if (value) {
    pushField();
  }
  return fields;
}
```

Add an embed packer and a ping-line chunker:

```ts
function packEmbeds(
  name: string,
  description: string,
  fields: ReminderEmbedField[],
): ReminderEmbed[] {
  const embeds: ReminderEmbed[] = [];
  let current: ReminderEmbedField[] = [];
  let chars = 0;

  const flush = () => {
    const first = embeds.length === 0;
    embeds.push({
      title: first ? `🏆 ${name}` : `🏆 ${name} (cont.)`,
      description: first ? description : "",
      color: REMINDER_COLOR,
      fields: current,
    });
    current = [];
    chars = 0;
  };

  for (const field of fields) {
    const fieldChars = field.name.length + field.value.length;
    const overflow =
      current.length >= EMBED_FIELDS_MAX || chars + fieldChars > EMBED_CHARS_MAX;
    if (overflow && current.length > 0) {
      flush();
    }
    current.push(field);
    chars += fieldChars;
  }
  if (current.length > 0) {
    flush();
  }
  return embeds;
}

function buildPingChunks(targets: TournamentReminderTarget[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const t of targets) {
    for (const id of [t.playerOneDiscordUserId, t.playerTwoDiscordUserId]) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

  const prefix = "Playing: ";
  const chunks: string[] = [];
  let current = prefix;
  for (const id of ids) {
    const mention = `<@${id}>`;
    const candidate = current === prefix ? `${current}${mention}` : `${current} ${mention}`;
    if (candidate.length > CONTENT_MAX && current !== prefix) {
      chunks.push(current);
      current = `${prefix}${mention}`;
    } else {
      current = candidate;
    }
  }
  if (current !== prefix) {
    chunks.push(current);
  }
  return chunks;
}
```

Delete the now-unused `buildPingLine` function. Replace the body of `buildTournamentReminders` with the assembled version:

```ts
export function buildTournamentReminders(
  targets: TournamentReminderTarget[],
): TournamentReminderMessage[] {
  const messages: TournamentReminderMessage[] = [];

  for (const tournamentTargets of groupByTournament(targets)) {
    const name = tournamentTargets[0].tournamentName;
    const count = tournamentTargets.length;
    const description = `${count} ${count === 1 ? "match" : "matches"} still to play`;

    const fields = groupByRound(tournamentTargets).flatMap(({ round, matches }) =>
      buildRoundFields(round, matches),
    );
    const embeds = packEmbeds(name, description, fields);
    const pingChunks = buildPingChunks(tournamentTargets);

    // First message: first ping chunk (renders above) + first embed.
    messages.push({ content: pingChunks[0], embed: embeds[0] });
    // Overflow ping chunks → content-only messages.
    for (let i = 1; i < pingChunks.length; i++) {
      messages.push({ content: pingChunks[i] });
    }
    // Overflow embeds → embed-only messages.
    for (let j = 1; j < embeds.length; j++) {
      messages.push({ embed: embeds[j] });
    }
  }

  return messages;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/bot/tests/reminders/tournament-reminders.test.ts`
Expected: PASS — Task 1 tests plus the three new limit tests.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/reminders/tournament-reminders.ts packages/bot/tests/reminders/tournament-reminders.test.ts
git commit -m "feat(bot): chunk reminder fields, embeds, and ping lines to Discord limits"
```

---

## Task 3: Wire the cron sender to the new formatter

**Files:**
- Modify: `packages/bot/src/index.ts` (import block lines 43-46; reminder cron body lines 481-489)

No unit test — this is the discord.js send loop (side-effectful). Verified via typecheck, build, and the full bot test suite.

- [ ] **Step 1: Swap the import**

In `packages/bot/src/index.ts`, change the import (currently lines 43-46):

```ts
import {
  buildTournamentReminders,
  selectTournamentReminderTargets,
} from "./reminders/tournament-reminders.js";
```

- [ ] **Step 2: Replace the send logic**

In the reminder cron callback, replace the block that currently reads (lines ~481-489):

```ts
      const reminder = formatTournamentReminder(
        selectTournamentReminderTargets(db, channel.guildId),
      );

      if (!reminder) {
        return;
      }

      await channel.send(reminder);
```

with:

```ts
      const reminders = buildTournamentReminders(
        selectTournamentReminderTargets(db, channel.guildId),
      );

      if (reminders.length === 0) {
        return;
      }

      for (const message of reminders) {
        const embeds = message.embed
          ? [
              new EmbedBuilder()
                .setTitle(message.embed.title)
                .setDescription(message.embed.description || null)
                .setColor(message.embed.color)
                .addFields(message.embed.fields),
            ]
          : [];

        await channel.send({ content: message.content, embeds });
      }
```

(`EmbedBuilder` is already imported at line 9 — no new import needed.)

- [ ] **Step 3: Typecheck the bot package**

Run: `npm run typecheck --workspace=packages/bot`
Expected: PASS — no references to the removed `formatTournamentReminder` remain; `addFields` accepts `{ name, value }[]`.

- [ ] **Step 4: Run the full bot test suite**

Run: `npm test --workspace=packages/bot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/index.ts
git commit -m "feat(bot): send per-tournament reminder embeds from the daily cron"
```

---

## Task 4: Final verification + simplify pass

**Files:** none (review only)

- [ ] **Step 1: Build the whole repo**

Run: `npm run build`
Expected: PASS (shared builds first, then bot/ws/web).

- [ ] **Step 2: Simplify pass**

Invoke the `simplify` skill over `packages/bot/src/reminders/tournament-reminders.ts` and the modified block of `packages/bot/src/index.ts`. Tighten naming/duplication only — do not change behavior. If it makes edits, re-run `npx vitest run packages/bot/tests/reminders/tournament-reminders.test.ts` and commit.

- [ ] **Step 3: Commit any simplify changes**

```bash
git add -A
git commit -m "refactor(bot): tidy tournament reminder formatter"
```

(Skip if the simplify pass made no changes.)

---

## Self-Review Notes

- **Spec coverage:** per-tournament embed (Task 1) ✓; purple `0x9B59B6` + 🏆 title + pluralized description + per-round fields (Task 1) ✓; deduped ping line as lead-in (Task 1) ✓; `<@id>` used everywhere, no display-name lookup, SQL unchanged (Task 1) ✓; one message per tournament, empty → nothing (Tasks 1 & 3) ✓; field 1024 chunking, 25-field/char embed spill, 2000 ping split (Task 2) ✓; `EmbedBuilder` wiring + send loop, old formatter removed (Task 3) ✓; simplify pass (Task 4) ✓.
- **Type consistency:** `TournamentReminderMessage { content?, embed? }`, `ReminderEmbed { title, description, color, fields }`, `ReminderEmbedField { name, value }` used identically across formatter, tests, and `index.ts` send loop. Helper names (`groupByTournament`, `groupByRound`, `matchLine`, `buildRoundFields`, `packEmbeds`, `buildPingChunks`, `buildTournamentReminders`) are consistent; `buildPingLine` from Task 1 is explicitly deleted in Task 2.
- **No placeholders:** every code/test/command step is concrete.
