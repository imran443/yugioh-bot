import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const discordUserId = session.user.id;
    const db = getDb();

    // Find all player records for this Discord user across all guilds
    const playerRows = db
      .prepare("select id, guild_id from players where discord_user_id = ?")
      .all(discordUserId) as Array<{ id: number; guild_id: string }>;

    const playerIds = playerRows.map((r) => r.id);

    if (playerIds.length === 0) {
      return NextResponse.json({
        tournaments: [],
        drafts: [],
        stats: { wins: 0, losses: 0 },
      });
    }

    // Active tournaments the user is in
    const tournaments = db
      .prepare(
        `
        select
          t.id,
          t.guild_id,
          t.name,
          t.format,
          t.status,
          t.web_slug,
          count(tp2.player_id) as participant_count
        from tournaments t
        inner join tournament_participants tp on tp.tournament_id = t.id
        left join tournament_participants tp2 on tp2.tournament_id = t.id
        where tp.player_id in (${playerIds.map(() => "?").join(",")})
          and t.status in ('pending', 'active')
        group by t.id
        order by case t.status when 'active' then 0 else 1 end, t.created_at desc
      `
      )
      .all(...playerIds)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        format: row.format,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        participantCount: row.participant_count,
      }));

    // Active/pending drafts the user is in
    const drafts = db
      .prepare(
        `
        select
          d.id,
          d.guild_id,
          d.name,
          d.status,
          d.web_slug,
          d.current_wave_number,
          d.current_pick_step,
          count(dp2.player_id) as player_count
        from drafts d
        inner join draft_players dp on dp.draft_id = d.id
        left join draft_players dp2 on dp2.draft_id = d.id
        where dp.player_id in (${playerIds.map(() => "?").join(",")})
          and d.status in ('pending', 'active')
        group by d.id
        order by case d.status when 'active' then 0 else 1 end, d.created_at desc
      `
      )
      .all(...playerIds)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        currentPackRound: row.current_wave_number,
        currentPickStep: row.current_pick_step,
        playerCount: row.player_count,
      }));

    // Lifetime stats
    const statsRow = db
      .prepare(
        `
        select
          sum(case when winner_id in (${playerIds.map(() => "?").join(",")}) then 1 else 0 end) as wins,
          sum(case
            when (player_one_id in (${playerIds.map(() => "?").join(",")}) or player_two_id in (${playerIds.map(() => "?").join(",")}))
              and winner_id is not null
              and winner_id not in (${playerIds.map(() => "?").join(",")})
            then 1 else 0 end) as losses
        from matches
        where status = 'completed'
          and (player_one_id in (${playerIds.map(() => "?").join(",")}) or player_two_id in (${playerIds.map(() => "?").join(",")}))
      `
      )
      .get(
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds
      ) as { wins: number | null; losses: number | null } | undefined;

    const stats = {
      wins: statsRow?.wins ?? 0,
      losses: statsRow?.losses ?? 0,
    };

    return NextResponse.json({ tournaments, drafts, stats });
  } catch (error) {
    console.error("[api/dashboard] error:", error);
    return NextResponse.json(
      { error: "Failed to load dashboard" },
      { status: 500 }
    );
  }
}
