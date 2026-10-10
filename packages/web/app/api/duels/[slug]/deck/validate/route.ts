import { NextRequest, NextResponse } from "next/server";
import type { DuelDeck } from "@yugidraft/shared/duels";
import { assertNormalDuelRequest, callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;

  const inLobby = () => {
    const room = actor.duels.room(slug, actor.guildId, actor.playerId);
    assertNormalDuelRequest(request, room);
    return room.session.status === "lobby";
  };
  const skipped = () => NextResponse.json({ skipped: true });
  try {
    if (!inLobby()) return skipped();
  } catch (error) {
    return duelErrorResponse(error);
  }

  let deck: DuelDeck;
  try {
    deck = (await request.json()) as DuelDeck;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Parsing the request yields to Start in another window. Recheck before asking the host.
  try {
    if (!inLobby()) return skipped();
  } catch (error) {
    return duelErrorResponse(error);
  }

  const result = await callDuelHost({
    op: "validate-deck",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}),
    deck,
  });
  // A check can finish after the room moves on. Its result is then obsolete in every format.
  try {
    if (!inLobby()) return skipped();
  } catch (error) {
    return duelErrorResponse(error);
  }
  if (!result.ok) return result.response;
  return NextResponse.json(result.data);
}
