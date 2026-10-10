import { NextResponse } from "next/server";
import { assertNormalDuelRequest, callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
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

  const result = await callDuelHost({
    op: "series-ready",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}),
  });
  if (!result.ok) return result.response;
  return NextResponse.json(result.data);
}
