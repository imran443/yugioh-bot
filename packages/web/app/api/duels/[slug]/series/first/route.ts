import { NextResponse } from "next/server";
import { isFirstChoice } from "@yugidraft/shared/duels";
import { assertNormalDuelRequest, callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";

export const runtime = "nodejs";

/** Between games, the loser of the last game chooses to go first or second. Body `{ choice }`. */
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

  let body: { choice?: unknown };
  try {
    body = (await request.json()) as { choice?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isFirstChoice(body?.choice)) {
    return NextResponse.json({ error: "Expected { choice } (first or second)" }, { status: 400 });
  }

  const result = await callDuelHost({
    op: "series-first",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}),
    choice: body.choice,
  });
  if (!result.ok) return result.response;
  return NextResponse.json(result.data);
}
