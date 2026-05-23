# Tournament Reminder Message Format — Design

**Date:** 2026-05-23
**Status:** Approved (brainstorming complete, ready for implementation plan)
**Surface:** `packages/bot` only

## Goal

Replace the single flat wall-of-text tournament reminder with **one purple embed per
tournament** — matchups grouped by round — preceded by a deduped `Playing:` ping line that still
notifies every player who has an open match. The reminder should read like a sharp competitive
client (per `.impeccable.md`), not a dumped list, while preserving the notification that makes a
reminder useful.

## Background — current state

- `packages/bot/src/reminders/tournament-reminders.ts`:
  - `selectTournamentReminderTargets(db, guildId?)` — SQL that returns a **flat** list of open
    matches across all active tournaments, ordered by `t.name asc, tm.round_number asc, tm.id asc`.
    Each row carries `guildId`, `tournamentName`, `roundNumber`, `playerOneDiscordUserId`,
    `playerTwoDiscordUserId`. **No display names** are selected.
  - `formatTournamentReminder(targets)` — joins everything into ONE string:
    `"Tournament matches still need to be played:"` + one `- {name} round {n}: <@p1> vs <@p2>`
    bullet per match. Returns `null` when there are no targets.
- `packages/bot/src/index.ts` (~line 481): a daily cron (`REMINDER_CRON`, default `0 10 * * *`)
  fetches `DISCORD_REMINDER_CHANNEL_ID`, calls the formatter, and does a single
  `channel.send(reminder)`.
- The bot already uses `EmbedBuilder` elsewhere (`index.ts:86`) with a flat-UI color convention:
  active `0x3498db` (blue), completed `0x2ecc71` (green), cancelled `0xe74c3c` (red), and emoji in
  field names. This reminder is the only notification still sent as plain text.

## Key Discord behaviors this design relies on

1. A message's plain-text `content` always renders **above** its embeds. Text cannot be placed
   below an embed in the same message. → The ping line is a **lead-in above** each embed. (Getting
   it below would require two messages per tournament; not worth it.)
2. A `<@id>` mention placed **inside an embed** renders as the player's name but does **not** send a
   notification. A `<@id>` mention in the message `content` **does** notify. → We reuse `<@id>`
   everywhere; only the `content` ping line actually pings. **No display-name lookup needed**, so
   the SQL is unchanged.

## Design decisions (settled during brainstorming)

1. **One message per tournament** that has open matches — a purple embed + a `Playing:` ping line.
2. **Ping line:** one deduped line per tournament listing each unique player with any open match,
   once (a player in 3 matches is pinged once per tournament).
3. **Names in the embed do not ping; the lead-in line does** (relies on behaviors above).
4. **Accent color:** brand purple `0x9B59B6` (same flat-UI palette family as the existing embeds,
   honors the purple/gold accent in `.impeccable.md`).
5. **No global header** message — each embed is self-contained.

## What each tournament message looks like

```
Playing:  @Highest Win Rate  @Jurgenstein  @RIP SCAV  @ButtinShy  @Tim Cheese
┌─ (purple accent bar)
│ 🏆  King Of Fags
│ 3 matches still to play
│
│ Round 1
│   @Highest Win Rate  vs  @Jurgenstein
│   @RIP SCAV  vs  @ButtinShy
│ Round 2
│   @Tim Cheese  vs  @ButtinShy
└─
```

## Embed spec (per tournament)

- **Color:** `0x9B59B6`.
- **Title:** `🏆 {tournamentName}`.
- **Description:** `{n} match still to play` when `n === 1`, else `{n} matches still to play`.
- **Fields:** one field per round that has open matches (rounds ascending). Field name
  `Round {n}`; field value = one line per matchup, `<@p1> vs <@p2>`, in the existing `tm.id` order.
- **Ping line (message `content`):** `Playing: <@a> <@b> …` — every unique player with an open
  match in that tournament, each listed once. Dedup order = first appearance while walking the
  tournament's matches in `(round, id)` order.

## Behavior

- For each active tournament (in existing name order) that has ≥1 open match, send one
  `channel.send({ content: pingLine, embeds: [embed] })`.
- No open matches anywhere → send nothing (same as today; formatter returns an empty array).
- Tournament/round grouping is derived in the formatter from the already-sorted target list; the
  SQL ordering (`name asc, round asc, id asc`) is preserved and relied upon.

## Edge cases handled

- **Field value 1024-char limit:** a round with enough open matches to overflow one field value
  spills into additional fields named `Round {n} (cont.)`. (`<@id> vs <@id>` ≈ 50 chars, so ~20
  matchups per field.)
- **Embed limits (25 fields / 6000 chars):** if a single tournament exceeds these, its remaining
  rounds spill into a **second message** (a second embed with the same title, no ping line repeat).
- **Content 2000-char limit:** if a tournament's deduped ping line exceeds 2000 chars (~90+
  players), split it across follow-up messages (`content`-only, no embed).
- A player who left the guild still mentions correctly by ID.

## Code shape

- `packages/bot/src/reminders/tournament-reminders.ts`:
  - Keep `selectTournamentReminderTargets` and `TournamentReminderTarget` **unchanged**.
  - Replace `formatTournamentReminder(targets): string | null` with **pure, framework-free**
    `buildTournamentReminders(targets): TournamentReminderMessage[]`:
    ```ts
    interface ReminderEmbedField { name: string; value: string }
    interface ReminderEmbed {
      title: string;
      description: string;
      color: number;
      fields: ReminderEmbedField[];
    }
    interface TournamentReminderMessage {
      content?: string;      // the "Playing: …" ping line
      embed?: ReminderEmbed; // the per-tournament embed
    }
    ```
    At least one of `content` / `embed` is present on every message. The common case has both; an
    embed-limit spill is embed-only; a ping-line split is content-only. Returns `[]` when there are
    no targets. Returns plain data (no `EmbedBuilder`) so it stays unit testable without discord.js.
    Field chunking, embed-limit spill, and ping-line splitting all live here so they are testable.
- `packages/bot/src/index.ts` (~line 481):
  - Replace the single `formatTournamentReminder` + `channel.send(string)` with a loop over
    `buildTournamentReminders(...)`, building an `EmbedBuilder` from each entry's `embed` when
    present (`setTitle/setDescription/setColor/addFields`) and sending
    `channel.send({ content, embeds: embed ? [embed] : [] })` per entry. Empty array → send nothing.

## Testing

`packages/bot/tests/reminders/tournament-reminders.test.ts` — update for the new API:

- Multiple tournaments → one message per tournament, in name order.
- Within a tournament, matches grouped into one field per round, rounds ascending.
- Description pluralization: `1 match` vs `N matches`.
- Ping line dedup: a player in multiple matches appears once; order = first appearance.
- Embed color/title/emoji are as specified.
- Field chunking: a round large enough to overflow 1024 chars produces `Round n (cont.)` field(s).
- Empty targets → `[]`.
- (Limit-spill / ping-split paths covered with constructed oversized inputs.)

## Post-implementation

- Run the **`simplify`** skill over the modified formatter + caller before finishing.

## Out of scope

- No SQL/schema changes (display names are not fetched; `<@id>` renders names for free).
- No change to the cron schedule, channel selection, or env vars.
- No web/`packages/web` changes.
- No per-player DM reminders — reminders stay in the configured channel.
