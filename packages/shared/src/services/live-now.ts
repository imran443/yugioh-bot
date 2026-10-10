import type Database from "better-sqlite3";
import { DUEL_LIVE_IDLE_AFTER_MS } from "./duels.js";
import { duelSeriesTournamentReadScope } from "./tournament-read-scope.js";

export type LiveDuelState = "live" | "between" | "waiting";
export type LiveOpponent = { seat: number; name: string; isBot: boolean };

export interface LiveNow {
  /** The viewer's most urgent duel of their own, or null. `href` is the duel page. */
  yourDuel: { href: string; opponent: string; state: LiveDuelState; opponents?: LiveOpponent[] } | null;
  /** Duels in progress that the viewer is allowed to see (their own included). */
  liveCount: number;
}

export interface LiveNowService {
  /** Small database reads, no duel-host calls. Safe to poll. */
  forPlayer(guildId: string, playerId: number): LiveNow;
  /** Same visibility and idle rules as the lobby; application identity also supports viewers without players. */
  countInProgress(guildId: string, playerId: number | null, options?: { excludeSeated?: boolean; viewerUserId?: number }): number;
}

type OwnRow = {
  slug: string | null;
  state: LiveDuelState;
  /** 1 when the viewer still has to ready up in a waiting lobby. */
  needs_me: number;
  opponent: string | null;
  activity: string | null;
};

const PRACTICE_BOT_NAME = "Practice Bot";

/**
 * The viewer's own duels that are running, waiting in a lobby with both seats
 * taken, or sitting between games of a series.
 */
const OWN_SQL = `
  select d.web_slug as slug,
    case when d.status = 'active' then 'live' else 'waiting' end as state,
    case when d.status = 'lobby' and me.ready = 0 then 1 else 0 end as needs_me,
    (
      select case when x.is_bot = 1 then @bot else p.display_name end
      from duel_seats x left join players p on p.id = x.player_id
      where x.duel_id = d.id and x.seat != me.seat
      limit 1
    ) as opponent,
    coalesce(d.last_activity_at, d.created_at) as activity
  from duels d
  join duel_seats me on me.duel_id = d.id and me.player_id = @viewer
  where d.kind = 'play' and d.guild_id = @guild
    and ${duelSeriesTournamentReadScope("d.series_id")}
    and d.archived_at is null
    and (
      d.status = 'active'
      or (d.status = 'lobby' and (select count(*) from duel_seats c where c.duel_id = d.id) >= 2)
    )
  union all
  select (select g.web_slug from duels g where g.kind = 'play' and g.series_id = s.id order by g.game_number desc, g.id desc limit 1) as slug,
    'between' as state,
    0 as needs_me,
    case when s.vs_bot = 1 then @bot else op.display_name end as opponent,
    coalesce(s.next_game_at, s.created_at) as activity
  from duel_series s
  left join players op on op.id = case when s.player0_id = @viewer then s.player1_id else s.player0_id end
  where s.guild_id = @guild
    and not exists (select 1 from duels f where f.series_id = s.id and f.kind != 'play')
    and ${duelSeriesTournamentReadScope("s.id")}
    and s.status = 'between_games'
    and (s.player0_id = @viewer or s.player1_id = @viewer)
`;

/**
 * Same visibility and idle rules as the duel lists (duels.ts LIST_ACCESS_SQL and
 * the live list), counting only duels that are in progress.
 */
const COUNT_SQL = `
  select count(*) as n
  from duels
  where kind = 'play' and guild_id = @guild
    and ${duelSeriesTournamentReadScope("duels.series_id", "coalesce(@user, (select viewer.user_id from players viewer where viewer.id = @viewer and viewer.guild_id = @guild))")}
    and status = 'active'
    and archived_at is null
    and (
      @excludeSeated = 0
      or not exists (select 1 from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer)
    )
    and (
      organizer_player_id = @viewer
      or exists (select 1 from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer)
      or exists (select 1 from duel_invite_grants g where g.duel_id = duels.id and g.player_id = @viewer)
      or coalesce(json_extract(settings_json, '$.visibility'), 'public') != 'private'
    )
    and (
      organizer_player_id = @viewer
      or exists (select 1 from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer)
      or datetime(coalesce(last_activity_at, created_at)) >= datetime('now', @idle)
    )
`;

/** Lower is more urgent: a lobby that waits on the viewer, then a running duel, then a series break, then a lobby that waits on the opponent. */
function urgency(row: OwnRow): number {
  if (row.state === "waiting") return row.needs_me ? 0 : 3;
  return row.state === "live" ? 1 : 2;
}

export function createLiveNowService(db: Database.Database): LiveNowService {
  const own = db.prepare<Record<string, string | number>, OwnRow>(OWN_SQL);
  const count = db.prepare<Record<string, string | number | null>, { n: number }>(COUNT_SQL);
  const opponents = db.prepare<{ guild: string; slug: string; viewer: number; bot: string }, { seat: number; name: string; is_bot: number }>(`
    select x.seat, case when x.is_bot = 1 then @bot else p.display_name end as name, x.is_bot
    from duels d join duel_seats x on x.duel_id = d.id
    left join players p on p.id = x.player_id
    where d.kind = 'play' and d.guild_id = @guild and d.web_slug = @slug
      and (x.player_id is null or x.player_id != @viewer)
    order by x.seat
  `);
  const idle = `-${Math.ceil(DUEL_LIVE_IDLE_AFTER_MS / 1000)} seconds`;
  const countInProgress = (guildId: string, playerId: number | null, options: { excludeSeated?: boolean; viewerUserId?: number } = {}) =>
    count.get({ guild: guildId, viewer: playerId, user: options.viewerUserId ?? null, idle, excludeSeated: options.excludeSeated ? 1 : 0 })?.n ?? 0;

  return {
    countInProgress,
    forPlayer(guildId, playerId) {
      const rows = own
        .all({ guild: guildId, viewer: playerId, bot: PRACTICE_BOT_NAME })
        .filter((row) => row.slug !== null)
        .sort((a, b) => urgency(a) - urgency(b) || (b.activity ?? "").localeCompare(a.activity ?? ""));
      const top = rows[0];
      const liveCount = countInProgress(guildId, playerId);
      return {
        yourDuel: top
          ? { href: `/duels/${top.slug}`, opponent: top.opponent ?? "Opponent", state: top.state,
            opponents: opponents.all({ guild: guildId, slug: top.slug!, viewer: playerId, bot: PRACTICE_BOT_NAME })
              .map((seat) => ({ seat: seat.seat, name: seat.name ?? "Opponent", isBot: seat.is_bot === 1 })) }
          : null,
        liveCount,
      };
    },
  };
}
