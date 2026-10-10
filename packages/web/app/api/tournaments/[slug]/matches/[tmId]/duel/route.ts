import { requireWebAccess } from "@/lib/web-access";
import { NextResponse } from "next/server";
import { assertDuelInviteTarget, createDuelSeriesService, findTournamentReadAccess } from "@yugidraft/shared/services";
import { env } from "@/lib/env";
import { duelUrl, announceDuelInvite } from "@/lib/announce-bot";
import { getDb } from "@/lib/db";
import { mapDraftTournamentDecks } from "@/lib/draft-deck-codes";
import { linkDraftDeck } from "@/lib/draft-decks";
import { duelErrorResponse, requireDuelActor } from "@/lib/duel-host";
import { broadcaster } from "@/lib/notify";
import { notifyDuelChange } from "@/lib/notify-duel";
import { playerIdentity } from "@/lib/player-lookup";

export const runtime = "nodejs";

/** Starts (or returns) the online series of a bracket slot, and DMs the other player. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; tmId: string }> },
) {
  const session = await requireWebAccess();
  if (!session.ok) return session.response;
  const { slug, tmId } = await params;
  const tournamentMatchId = Number(tmId);

  try {
    const db = getDb();
    const access = findTournamentReadAccess(db, slug, env.discordGuildId, session.userId);
    if (!access?.canRead) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    const actor = await requireDuelActor();
    if (!actor.ok) return actor.response;
    const tournament = db
      .prepare("select id, name, status, created_by_user_id from tournaments where web_slug = ? and guild_id = ?")
      .get(slug, actor.guildId) as
      | { id: number; name: string; status: string; created_by_user_id: number }
      | undefined;
    if (!tournament) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    const slot = Number.isInteger(tournamentMatchId)
      ? (db
          .prepare("select tournament_id, player_one_id, player_two_id from tournament_matches where id = ?")
          .get(tournamentMatchId) as
          | { tournament_id: number; player_one_id: number; player_two_id: number | null }
          | undefined)
      : undefined;
    if (!slot || slot.tournament_id !== tournament.id) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    // The same checks the series start makes, before any deck is read or written: a bystander
    // must not make the server link or map the players' decks.
    if (slot.player_two_id === null) return NextResponse.json({ error: "A bye has no duel to play" }, { status: 400 });
    const isPlayer = actor.playerId === slot.player_one_id || actor.playerId === slot.player_two_id;
    const actorRow = db.prepare("select user_id from players where id = ? and guild_id = ?").get(actor.playerId, actor.guildId) as
      | { user_id: number }
      | undefined;
    if (!isPlayer && actorRow?.user_id !== tournament.created_by_user_id) {
      return NextResponse.json({ error: "Only a match player or the tournament organizer can start this duel" }, { status: 403 });
    }
    if (tournament.status !== "active") {
      return NextResponse.json({ error: "Tournament is not active" }, { status: 409 });
    }

    const playerIds = [slot.player_one_id, slot.player_two_id];
    // A player who joined from the Discord button and never opened the page has no deck on the
    // entry yet: register their draft deck first.
    for (const playerId of playerIds) linkDraftDeck(tournament.id, playerId, db);
    // A draft tournament's auto-registered decks hold catalog ids: map both seats' decks to engine
    // codes before the series copies and locks them. If that cannot be done, nothing is started.
    const mapped = await mapDraftTournamentDecks(db, { tournamentId: tournament.id, guildId: actor.guildId, playerIds });
    if (!mapped.ok) {
      return NextResponse.json(mapped.report ? { error: mapped.error, report: mapped.report } : { error: mapped.error }, {
        status: mapped.status,
      });
    }

    const { series, duel, created } = createDuelSeriesService(db).startTournamentMatch({
      guildId: actor.guildId,
      tournamentMatchId,
      actorPlayerId: actor.playerId,
    });

    assertDuelInviteTarget(db, { duelId: duel.id, slug: duel.slug, guildId: actor.guildId, url: duelUrl(duel.slug, request) });
    await notifyDuelChange(duel.slug, actor.guildId);
    void broadcaster.tournament({ kind: "match-updated", slug });

    // An open series returned as-is was announced when it started.
    if (env.discordBotEnabled && created) {
      const challenger = playerIdentity(db, actor.playerId);
      for (const playerId of series.playerIds) {
        if (playerId === actor.playerId) continue;
        const recipient = playerIdentity(db, playerId);
        if (!recipient?.discordUserId) continue;
        announceDuelInvite(
          {
            slug: duel.slug,
            guildId: actor.guildId,
            opponentDiscordUserId: recipient.discordUserId,
            challengerName: challenger?.displayName ?? "The organizer",
            duelName: duel.name,
            bestOf: series.bestOf,
            ranked: series.ranked,
            tournamentName: tournament.name,
          },
          request,
        );
      }
    }

    return NextResponse.json({ series, duel, created, shareUrl: duelUrl(duel.slug, request) }, { status: created ? 201 : 200 });
  } catch (error) {
    return duelErrorResponse(error);
  }
}
