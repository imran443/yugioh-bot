# Gamification: Winnings, Skill Rating, Rank & Seasons — Design

**Date:** 2026-05-20
**Status:** Design for review
**Scope:** v1 = web-first. Discord command upgrades are an explicit v2 follow-up.

## Goal

Turn the app's bare win/loss tracking into a gamified progression system with:

1. **Winnings** — a single, climb-only points number per player (the "whole
   winnings" figure), weighted so big tournaments and upsets pay more.
2. **Skill rating** — a visible Elo rating that powers opponent-strength
   weighting, match projections, **rank**, and tournament seeding.
3. **Rank** — a Bronze→Diamond ladder tied to skill rating (promotes *and*
   demotes).
4. **Win streaks**, **achievements/badges**, and **admin-controlled seasons**.
5. Surfaced on the web via a **player profile** page, a **leaderboard** page,
   and additions to the existing dashboard, plus an **admin season control**.

## Background (current behavior)

- Only **wins/losses** are tracked. `matches.stats(playerId)` returns
  `{wins, losses}`; `matches.leaderboard(guildId)` ranks by wins desc
  (matches.ts:336, :400). Tournament-scoped W/L in `tournaments.stats`.
- A match is reported `status='pending'` with `winner_id` set
  (matches.ts:215). It becomes `status='approved'` only via `approve`
  (matches.ts:253), `autoApprove` (matches.ts:297), both of which call
  `completeTournamentMatch` (matches.ts:79). **These are the only paths to a
  resolved match with a winner — the scoring hook points.**
- `completeTournamentMatch` flips a tournament to `status='completed'` in three
  spots (round_robin all done :111; single_elim final :169; single_elim
  winners≤1 :171). **Tournament completion = placement-bonus hook point.**
- Idempotent post-completion work already uses a claim column
  (`matches.claimTournamentCompletionAnnouncement`, :390 /
  `tournaments.completed_announced_at`). We mirror this pattern.
- Match status enum is `pending | approved | denied` (no "completed").
- Services are factory functions in `packages/shared/src/services/`, consumed by
  both `bot` and `web`. Schema migrates at startup via `migrate(db)` using
  `addColumnIfMissing` (schema.ts).

## Decisions (locked via brainstorming + visual companion)

- **Scoring model:** one weighted **winnings** number, climb-only (Option A).
- **Loss stakes:** winnings never drop (`+0` on a loss). The **skill rating**
  swing is the real per-match stake and is shown in a projection.
- **Rating is visible** (not hidden) — it's a first-class stat called *skill
  rating*.
- **Rank** (renamed from "tiers") is **tied to skill rating**, so it can
  promote and demote.
- **Seasons:** admin-controlled per guild, **monthly default**. Reset model
  below. Auto-create "Season 1" on first scored event so it works out of the
  box.
- **v1 surfaces:** web (profile, leaderboard, dashboard cards, season admin).
  Discord `/stats`, `/rankings`, `/season` are **v2**.

### Season reset model

| Resets each season            | Persists across seasons                 |
|-------------------------------|-----------------------------------------|
| Season winnings → 0           | Career winnings (all-time total)        |
| Season win streak             | Skill rating + rank                     |
| Seasonal leaderboard ordering | Achievements / badges                   |
|                               | Past-season trophies (e.g. "S1 Champ")  |

The seasonal leaderboard race is ranked by **season winnings**. Rank shown on
it reflects (persistent) rating.

## Architecture

```
 match approved (approve / autoApprove)        tournament completed
   in matches.ts, after                          (inside completeTournamentMatch,
   completeTournamentMatch(...)                    when status flips to 'completed')
            │                                              │
            ▼                                              ▼
   scoring.recordMatchResult(matchId)         scoring.recordTournamentResult(tournamentId)
            │                                              │
            ├─ update Elo (both players)                   ├─ derive final placement from standings
            ├─ award match-win winnings (winner)          ├─ award placement bonus × sizeMultiplier
            ├─ update win streak                          └─ award past-season trophy / champion record
            └─ evaluate achievements                              │
                          │                                       │
                          ▼                                       ▼
                  append to point_awards ledger (idempotent), refresh season_standings cache
```

All new logic lives in `packages/shared/src/services/`:

- `createScoringService(db)` — Elo, winnings awards, streaks, achievement
  evaluation, standings-cache refresh. Entry points `recordMatchResult` and
  `recordTournamentResult`.
- `createSeasonService(db)` — `getActive`, `ensureActive` (auto-create S1),
  `start`, `end` (snapshot + champion record).
- `createLeaderboardService(db)` / `createProfileService(db)` — read models for
  the web (or read methods folded into scoring service; final split decided at
  implementation time, kept small and single-purpose).

Pure, unit-testable helpers (no DB) in `packages/shared/src/scoring/`:

- `elo.ts` — `expectedScore(a,b)`, `nextRating(rating, expected, actual, k)`.
- `winnings.ts` — `matchWinPoints(opts)`, `placementPoints(opts)`,
  `opponentStrength(myElo, oppElo)`, `seasonMultiplier()`, `sizeMultiplier(n)`.
- `rank.ts` — `rankForRating(rating)` → `{ tierName, division, nextAt }`.
- `projection.ts` — `projectMatch(myElo, oppElo, seasonMultiplier)` →
  `{ winWinnings, winRating, loseWinnings: 0, loseRating }`.
- `achievements.ts` — static registry `{ key, name, icon, predicate(ctx) }`.

Bot integration is a **two-line call** added after the existing
`completeTournamentMatch` calls in `approve`/`autoApprove`, and a placement call
where the tournament flips to completed. Scoring failures must never break match
resolution (see Error handling).

## Data model (new tables; migrate in schema.ts)

```sql
create table if not exists seasons (
  id integer primary key autoincrement,
  guild_id text not null,
  number integer not null,            -- 1, 2, 3...
  name text,                          -- optional label, defaults "Season N"
  status text not null,               -- 'active' | 'ended'
  started_at text not null default current_timestamp,
  ended_at text,
  created_by_user_id text
);
-- one active season per guild
create unique index if not exists seasons_one_active
  on seasons (guild_id) where status = 'active';

create table if not exists player_ratings (   -- persists across seasons
  guild_id text not null,
  player_id integer not null references players(id),
  elo integer not null default 1000,
  career_winnings integer not null default 0,
  best_streak_alltime integer not null default 0,
  primary key (guild_id, player_id)
);

create table if not exists point_awards (     -- append-only ledger = source of truth
  id integer primary key autoincrement,
  guild_id text not null,
  season_id integer not null references seasons(id),
  player_id integer not null references players(id),
  kind text not null,                 -- 'match_win' | 'placement'
  match_id integer references matches(id),
  tournament_id integer references tournaments(id),
  points integer not null,
  opponent_elo integer,
  size_multiplier real,
  created_at text not null default current_timestamp
);
-- idempotency: at most one award per match, and one placement per (tournament, player)
create unique index if not exists point_awards_match_unique
  on point_awards (match_id, kind) where match_id is not null;
create unique index if not exists point_awards_placement_unique
  on point_awards (tournament_id, player_id, kind) where kind = 'placement';

create table if not exists season_standings (  -- rebuildable cache for fast reads
  guild_id text not null,
  season_id integer not null references seasons(id),
  player_id integer not null references players(id),
  winnings integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  current_streak integer not null default 0,
  best_streak integer not null default 0,
  primary key (season_id, player_id)
);

create table if not exists player_achievements (
  guild_id text not null,
  player_id integer not null references players(id),
  achievement_key text not null,
  unlocked_at text not null default current_timestamp,
  primary key (guild_id, player_id, achievement_key)
);
```

- **Season winnings / streak / W-L** = `season_standings` row for the active
  season. **Career winnings** = `player_ratings.career_winnings`. **Rank** =
  `rankForRating(player_ratings.elo)`.
- The cache is derivable from `point_awards` + `matches`; a `rebuildStandings`
  method backstops any drift and supports tests.

## Scoring formulas (placeholders — tunable, centralized as constants)

- **Elo:** K = 32, default 1000. `expected = 1/(1+10^((opp-me)/400))`,
  `next = me + K*(actual - expected)`.
- **opponentStrength** (winnings multiplier from rating gap): clamp of
  `0.5 + (oppElo - myElo + 400)/800` into roughly `[0.5, 2.0]` (beating a
  stronger player pays up to ~2×, a much weaker one ~0.5×).
- **matchWinPoints** = `round(BASE_MATCH(=5) × seasonMultiplier ×
  opponentStrength)`. Loss = 0.
- **sizeMultiplier(n participants):** step buckets — 4–7:×1, 8–15:×1.5,
  16–31:×2, 32+:×3 (a smooth log curve is an alternative; exact mapping is
  tunable).
- **placementPoints:** champion BASE_CHAMP(=50), runner-up 30, top-4 15, each ×
  sizeMultiplier. Derived from final standings ordering at completion.
- **seasonMultiplier:** 1 by default (hook for future "double points weekend").

All constants live in one `scoring/constants.ts`; the numbers above are
placeholders to tune, not load-bearing.

## Rank ladder (rating-driven)

`rankForRating(elo)` maps rating → named rank with divisions, e.g. Bronze
(<900), Silver (900–1099), Gold (1100–1349, divisions III/II/I), Platinum
(1350–1599), Diamond (1600+). Pure function; thresholds tunable. Returns
`nextAt` so the profile can show "X rating to Platinum".

## Match projection

`projectMatch(myElo, oppElo, seasonMultiplier)` returns the at-stake preview
used on the match report/confirm UI and the player profile:

```
Win  → +<matchWinPoints> winnings, +<eloDelta if win> rating
Lose →  +0 winnings,            −<eloDelta if lose> rating
```

Reused verbatim by Discord in v2.

## Seasons lifecycle

- `ensureActive(guildId, userId)` — returns the active season; if none, creates
  "Season 1". Called at the top of every scoring entry point.
- `start(guildId, userId, name?)` — requires no active season (the partial
  unique index enforces it); creates next-numbered active season. New season
  starts everyone at 0 season-winnings (fresh `season_standings` rows created
  lazily on first award). Rating/rank/career untouched.
- `end(guildId, userId)` — sets `status='ended'`, `ended_at`; snapshots final
  standings; records champion (top season winnings) → grants a past-season
  trophy achievement (`season_N_champion`).
- Admin-only; permission check mirrors existing guild-admin gating used by other
  web admin actions.

## Web surfaces (v1)

- **API**
  - `GET /api/leaderboard?scope=season|all` → ranked rows
    `{playerId, displayName, rank, rating, winnings, currentStreak, wins, losses, winRate}`.
  - `GET /api/player/[id]?scope=season|all` → profile payload (header, hero
    cards, achievements, recent results from `point_awards` joined to
    matches/tournaments).
  - `POST /api/admin/season` `{action:'start'|'end'}` → admin-gated.
- **Pages** (follow approved mockups; dark + purple/gold, Lucide icons, no
  emoji in shipped UI)
  - `/leaderboard` — season/all toggle, your row highlighted + pinned-visible,
    sortable columns, **Rank** column (rating-driven), Rating, Winnings,
    Streak, W/L, Win %. Row click → profile.
  - `/player/[id]` — header with rank badge + "X rating to next rank", season/
    all toggle, hero cards (Season Winnings, Skill Rating, Win Streak, W/L,
    Tournaments/titles), achievements grid, recent-results feed with points per
    event.
  - **Dashboard** gains winnings / rank / streak cards + match projection on the
    report/confirm flow.
  - **Admin** season control (Start / End, current season, champion of last
    season).

## Error handling & idempotency

- Scoring is invoked **after** match/tournament state is already persisted.
  Wrap each scoring entry point so a thrown error is logged and swallowed —
  **never block match resolution or tournament completion.** A failed award can
  be recovered by `rebuildStandings`.
- Ledger unique indexes make re-runs safe: re-resolving or replaying a match/
  tournament cannot double-award.
- All multi-row writes per event run in a single transaction (better-sqlite3
  synchronous), consistent with existing services.

## Testing

- **Unit (TDD, pure fns):** `elo`, `opponentStrength`, `matchWinPoints`,
  `sizeMultiplier`, `placementPoints`, `rankForRating`, `projectMatch`,
  achievement predicates.
- **Integration (real SQLite, no mocks — per project preference):**
  - match approve → winner gets correct winnings + both ratings updated;
  - loss → +0 winnings, rating drops;
  - re-running approve does not double-award (idempotency index);
  - tournament completion → placement bonus scaled by participant count;
  - season `end`→`start` resets season winnings/streak but preserves rating/
    career/achievements;
  - `rebuildStandings` reproduces the cache from the ledger;
  - leaderboard ordering (season vs all-time).

## Phasing

- **v1 (this spec):** shared scoring/season services + schema + web profile,
  leaderboard, dashboard cards, match projection, admin season control.
- **v2 (separate spec):** Discord `/stats` (profile embed), `/rankings`
  (leaderboard embed), `/season` (admin) reading the same services.

## Out of scope (v1)

- Discord command upgrades (v2).
- Configurable per-guild point values / custom rank names (constants are global,
  tunable in code).
- Rating soft-reset per season (rating persists; revisit if desired later).
- Historical rating charts / graphs.
```
