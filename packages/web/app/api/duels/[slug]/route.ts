import { NextResponse } from "next/server";
import { readDuelControl, callDuelHost, duelErrorResponse, requireDuelActor, redactDuelResult } from "@/lib/duel-host";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;
  const spectate = new URL(request.url).searchParams.get("spectate") === "1";

  let fork = false;
  let control: ReturnType<typeof readDuelControl>;
  try {
    const room = actor.duels.room(slug, actor.guildId, actor.playerId);
    control = readDuelControl(request, room, "view");
    fork = room.session.kind === "replay-fork";
    // A lobby with a timed-out rock-paper-scissors opening goes to the host, which settles it.
    const openingDue = room.session.status === "lobby" && room.opening != null
      && Date.parse(room.opening.deadlineAt) <= Date.now();
    if (room.session.kind !== "replay-fork" && room.session.status !== "active" && !openingDue && !spectate) {
      return NextResponse.json(redactDuelResult(room, actor.guildId, actor.playerId));
    }
  } catch (error) {
    return duelErrorResponse(error);
  }

  const result = await callDuelHost({
    op: "view",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}), ...control,
    ...(spectate ? { spectate: true } : {}),
  });
  if (!result.ok) return result.response;
  if (fork) {
    try { actor.duels.room(slug, actor.guildId, actor.playerId); }
    catch (error) { return duelErrorResponse(error); }
  }
  return NextResponse.json(result.data, { headers: { "cache-control": "private, no-store" } });
}
