import { MULTI_CORE_UNAVAILABLE_MESSAGE, multiplayerSeatsBlockReason, multiplayerTablesEnabled, seatCountFor, type DuelTableCapabilities } from "@yugidraft/shared/duels";
import { NextResponse } from "next/server";
import { assertNormalDuelRequest, callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";
import { notifyDuelChange } from "@/lib/notify-duel";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;
  try { assertNormalDuelRequest(request, actor.duels.room(slug, actor.guildId, actor.playerId)); }
  catch (error) { return duelErrorResponse(error); }

  let body: { seat?: unknown };
  try {
    body = await request.json() as { seat?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.seat !== "number" || !Number.isInteger(body.seat) || body.seat < 0) {
    return NextResponse.json({ error: "Seat must be a whole number from 0" }, { status: 400 });
  }

  try {
    const { session: { format } } = actor.duels.room(slug, actor.guildId, actor.playerId);
    const blocked = multiplayerSeatsBlockReason(seatCountFor(format), multiplayerTablesEnabled());
    if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
    if (format !== "1v1") {
      const result = await callDuelHost({ op: "capabilities", guildId: actor.guildId, playerId: actor.playerId });
      if (!result.ok) return result.response;
      const data = result.data as Partial<DuelTableCapabilities> | null;
      if (data?.multiCoreReady !== true) return NextResponse.json({ error: MULTI_CORE_UNAVAILABLE_MESSAGE }, { status: 409 });
    }
    const session = actor.duels.takeSeat(slug, actor.guildId, actor.playerId, body.seat);
    try {
      await notifyDuelChange(session.slug, actor.guildId);
    } catch {
      // The seat claim already committed.
    }
    return NextResponse.json({ session });
  } catch (error) {
    return duelErrorResponse(error);
  }
}
