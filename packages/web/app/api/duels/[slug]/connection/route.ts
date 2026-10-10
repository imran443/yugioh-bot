import { NextResponse } from "next/server";
import { createDuelConnectionToken, DUEL_CONNECTION_TTL_MS } from "@yugidraft/shared/ws";
import { callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";
import { env } from "@/lib/env";
import { isReplayFork, type DuelRoom } from "@yugidraft/shared/duels";
import { canReadDuel } from "@yugidraft/shared/services";
import { ReplayAccessError } from "@yugidraft/shared/access/owner-access";
import { assertDuelForkAccess } from "@/lib/replay-fork-access";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;

  try {
    const target = assertDuelForkAccess(slug, actor);
    const fork = isReplayFork(target);
    const query = new URL(request.url).searchParams;
    if (query.has("as") || (fork && query.has("spectate"))) {
      return NextResponse.json({ error: "Connection identity cannot be changed" }, { status: 400, headers: { "cache-control": "private, no-store" } });
    }
    if (fork && !canReadDuel(getDb(), { slug, guildId: actor.guildId, playerId: actor.playerId, seat: 0 })) {
      throw new ReplayAccessError();
    }
    let room = actor.duels.room(slug, actor.guildId, actor.playerId);
    if (query.get("spectate") === "1") {
      const result = await callDuelHost({ op: "view", slug, guildId: actor.guildId, playerId: actor.playerId, spectate: true });
      if (!result.ok) return result.response;
      room = result.data as DuelRoom;
    }
    if (!env.wsInternalSecret) {
      return NextResponse.json({ error: "Realtime is unavailable" }, { status: 503 });
    }
    const expiresAt = Date.now() + DUEL_CONNECTION_TTL_MS;
    const token = createDuelConnectionToken(
      {
        slug,
        guildId: actor.guildId,
        playerId: actor.playerId,
        seat: fork ? 0 : room.mySeat,
        expiresAt,
      },
      env.wsInternalSecret,
    );
    return NextResponse.json({ token, guildId: actor.guildId, expiresAt }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return duelErrorResponse(error);
  }
}
