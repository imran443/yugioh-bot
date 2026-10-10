import { NextRequest, NextResponse } from "next/server";
import type { DuelCommand } from "@yugidraft/shared/duels";
import { readDuelControl, callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;

  let fork = false;
  let control: ReturnType<typeof readDuelControl>;
  try {
    const room = actor.duels.room(slug, actor.guildId, actor.playerId);
    control = readDuelControl(request, room, "action");
    fork = room?.session.kind === "replay-fork";
  } catch (error) {
    return duelErrorResponse(error);
  }

  let command: DuelCommand;
  try {
    command = (await request.json()) as DuelCommand;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await callDuelHost({
    op: "respond",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}), ...control,
    command,
  });
  if (!result.ok) return result.response;
  if (fork) {
    try { actor.duels.room(slug, actor.guildId, actor.playerId); }
    catch (error) { return duelErrorResponse(error); }
  }
  return NextResponse.json(result.data, { headers: { "cache-control": "private, no-store" } });
}
