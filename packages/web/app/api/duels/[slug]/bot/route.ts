import { NextResponse } from "next/server";
import { seatCountFor } from "@yugidraft/shared/duels";
import { assertNormalDuelRequest, callDuelHost, duelErrorResponse, requireDuelActor, sessionFromHost } from "@/lib/duel-host";
import { notifyDuelChange } from "@/lib/notify-duel";

export const runtime = "nodejs";

/** Body is optional. `{ seat }` picks the empty 0-based seat for the bot; with no body the first empty seat is used. */
async function readSeat(request: Request): Promise<{ ok: true; seat: number | undefined } | { ok: false; response: NextResponse }> {
  const text = await request.text();
  if (!text.trim()) return { ok: true, seat: undefined };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: NextResponse.json({ error: "Expected an object" }, { status: 400 }) };
  }
  const seat = (body as { seat?: unknown }).seat;
  if (seat === undefined || seat === null) return { ok: true, seat: undefined };
  if (typeof seat !== "number" || !Number.isInteger(seat) || seat < 0) {
    return { ok: false, response: NextResponse.json({ error: "Seat must be a whole number from 0" }, { status: 400 }) };
  }
  return { ok: true, seat };
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;
  try { assertNormalDuelRequest(request, actor.duels.room(slug, actor.guildId, actor.playerId)); }
  catch (error) { return duelErrorResponse(error); }

  const parsed = await readSeat(request);
  if (!parsed.ok) return parsed.response;

  try {
    const room = actor.duels.room(slug, actor.guildId, actor.playerId);
    if (parsed.seat !== undefined) {
      const { format, seats } = room.session;
      if (parsed.seat >= seatCountFor(format ?? "1v1")) {
        return NextResponse.json({ error: "That seat is not at this table" }, { status: 400 });
      }
      if (seats.some((entry) => entry.seat === parsed.seat)) {
        return NextResponse.json({ error: "That seat is already taken" }, { status: 409 });
      }
    }
  } catch (error) {
    return duelErrorResponse(error);
  }

  const result = await callDuelHost({
    op: "add-bot",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}),
    seat: parsed.seat,
  });
  if (!result.ok) return result.response;
  return NextResponse.json(sessionFromHost(result.data));
}

/** Takes the practice bot out of its seat. A lobby-only seat change, so it needs no duel engine (like taking and leaving seats). */
export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;
  try { assertNormalDuelRequest(request, actor.duels.room(slug, actor.guildId, actor.playerId)); }
  catch (error) { return duelErrorResponse(error); }

  // Body is optional: `{ seat }` removes the bot in that seat (a table can hold several bots); with no body every bot goes.
  const parsed = await readSeat(request);
  if (!parsed.ok) return parsed.response;

  try {
    const session = actor.duels.removePracticeBot(slug, actor.guildId, actor.playerId, parsed.seat);
    await notifyDuelChange(session.slug, actor.guildId);
    return NextResponse.json({ session });
  } catch (error) {
    return duelErrorResponse(error);
  }
}
