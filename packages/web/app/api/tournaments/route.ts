import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = getDb();
    const tournaments = db
      .prepare(
        `
        select
          t.id,
          t.guild_id,
          t.name,
          t.format,
          t.status,
          t.created_by_user_id,
          t.web_slug,
          count(tp.player_id) as participant_count
        from tournaments t
        left join tournament_participants tp on tp.tournament_id = t.id
        where t.status in ('pending', 'active')
        group by t.id
        order by
          case t.status when 'active' then 0 else 1 end,
          t.created_at desc
      `
      )
      .all()
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        format: row.format,
        status: row.status,
        createdByUserId: row.created_by_user_id,
        webSlug: row.web_slug ?? undefined,
        participantCount: row.participant_count,
      }));

    return NextResponse.json(tournaments);
  } catch (error) {
    console.error("[api/tournaments] error:", error);
    return NextResponse.json(
      { error: "Failed to load tournaments" },
      { status: 500 }
    );
  }
}
