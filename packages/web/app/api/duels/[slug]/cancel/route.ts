import { NextResponse } from "next/server";
import { readDuelControl, callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;

  let fork = false;
  try {
    const room = actor.duels.room(slug, actor.guildId, actor.playerId);
    readDuelControl(request, room);
    fork = room?.session.kind === "replay-fork";
  } catch (error) {
    return duelErrorResponse(error);
  }

  const result = await callDuelHost({
    op: "cancel",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}),
  });
  if (!result.ok) return result.response;
  if (fork) {
    try { actor.duels.room(slug, actor.guildId, actor.playerId); }
    catch (error) { return duelErrorResponse(error); }
  }
  return NextResponse.json(result.data);
}
