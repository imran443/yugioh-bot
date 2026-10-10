import { NextRequest, NextResponse } from "next/server";
import type { DuelDeck } from "@yugidraft/shared/duels";
import { assertNormalDuelRequest, callDuelHost, duelErrorResponse, requireDuelActor, sessionFromHost } from "@/lib/duel-host";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;
  try { assertNormalDuelRequest(request, actor.duels.room(slug, actor.guildId, actor.playerId)); }
  catch (error) { return duelErrorResponse(error); }

  try {
    actor.duels.room(slug, actor.guildId, actor.playerId);
  } catch (error) {
    return duelErrorResponse(error);
  }

  let deck: DuelDeck;
  try {
    deck = (await request.json()) as DuelDeck;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await callDuelHost({
    op: "deck",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}),
    deck,
  });
  if (!result.ok) return result.response;
  return NextResponse.json(sessionFromHost(result.data));
}
