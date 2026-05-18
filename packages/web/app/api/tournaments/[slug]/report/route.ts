import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";
import { announceToBot } from "@/lib/announce-bot";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const discordUserId = session.user.id;
    const { slug } = await params;
    const db = getDb();

    const body = (await request.json()) as {
      tournamentMatchId: number;
      result: "win" | "loss";
    };

    if (!body.tournamentMatchId || !body.result) {
      return NextResponse.json(
        { error: "Missing tournamentMatchId or result" },
        { status: 400 }
      );
    }

    // Resolve tournament by slug
    const tournament = db
      .prepare("select id, guild_id, status from tournaments where web_slug = ?")
      .get(slug) as { id: number; guild_id: string; status: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    const tournamentId = tournament.id;

    // Find the tournament match
    const tournamentMatch = db
      .prepare("select * from tournament_matches where id = ? and tournament_id = ?")
      .get(body.tournamentMatchId, tournamentId) as
      | {
          id: number;
          player_one_id: number;
          player_two_id: number | null;
          status: string;
        }
      | undefined;

    if (!tournamentMatch) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    if (tournamentMatch.status !== "open") {
      return NextResponse.json(
        { error: "Match is not open for reporting" },
        { status: 400 }
      );
    }

    // Find the reporter's player record
    const reporter = db
      .prepare(
        "select id from players where guild_id = ? and discord_user_id = ?"
      )
      .get(tournament.guild_id, discordUserId) as { id: number } | undefined;

    if (!reporter) {
      return NextResponse.json(
        { error: "You are not a player in this tournament" },
        { status: 403 }
      );
    }

    // Determine opponent and winner
    const reporterId = reporter.id;
    let opponentId: number | null = null;

    if (tournamentMatch.player_one_id === reporterId) {
      opponentId = tournamentMatch.player_two_id;
    } else if (tournamentMatch.player_two_id === reporterId) {
      opponentId = tournamentMatch.player_one_id;
    } else {
      return NextResponse.json(
        { error: "You are not in this match" },
        { status: 403 }
      );
    }

    if (!opponentId) {
      return NextResponse.json(
        { error: "Cannot report a bye match" },
        { status: 400 }
      );
    }

    const winnerId = body.result === "win" ? reporterId : opponentId;

    // Insert the match report with status='pending' so the bot's approve flow can resolve it
    const matchResult = db
      .prepare(
        `
        insert into matches (
          guild_id, player_one_id, player_two_id, winner_id,
          reporter_id, status, source, tournament_id
        ) values (?, ?, ?, ?, ?, 'pending', 'tournament', ?)
      `
      )
      .run(
        tournament.guild_id,
        reporterId,
        opponentId,
        winnerId,
        reporterId,
        tournamentId
      );

    const matchId = Number(matchResult.lastInsertRowid);

    // Update tournament match
    db.prepare(
      "update tournament_matches set match_id = ?, status = 'pending_approval' where id = ?"
    ).run(matchId, tournamentMatch.id);

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "match-updated", slug },
    );

    const meta = db
      .prepare(
        `
        select
          t.name as tournament_name,
          tm.round_number as round_number,
          rp.discord_user_id as reporter_discord_id,
          rp.display_name as reporter_name,
          op.discord_user_id as opponent_discord_id,
          op.display_name as opponent_name
        from tournament_matches tm
        join tournaments t on t.id = tm.tournament_id
        join players rp on rp.id = ?
        join players op on op.id = ?
        where tm.id = ?
      `,
      )
      .get(reporterId, opponentId, tournamentMatch.id) as
      | {
          tournament_name: string;
          round_number: number;
          reporter_discord_id: string;
          reporter_name: string;
          opponent_discord_id: string;
          opponent_name: string;
        }
      | undefined;

    if (meta) {
      void announceToBot(
        { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
        {
          kind: "match-report-pending",
          guildId: tournament.guild_id,
          slug,
          matchId,
          tournamentMatchId: tournamentMatch.id,
          tournamentName: meta.tournament_name,
          roundNumber: meta.round_number,
          reporterDiscordId: meta.reporter_discord_id,
          opponentDiscordId: meta.opponent_discord_id,
          reporterName: meta.reporter_name,
          opponentName: meta.opponent_name,
          opponentLost: winnerId === reporterId,
        },
      );
    }

    return NextResponse.json({ success: true, matchId });
  } catch (error) {
    console.error("[api/tournaments/[slug]/report] error:", error);
    return NextResponse.json(
      { error: "Failed to report match" },
      { status: 500 }
    );
  }
}
