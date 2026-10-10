import { NextResponse } from "next/server";
import { readDuelControl, callDuelHost, duelErrorResponse, requireDuelActor, scenariosEnabled, scenariosOffResponse } from "@/lib/duel-host";

export const runtime = "nodejs";

/**
 * Dev only (DUEL_SCENARIOS=1). The host's debug trace of one duel: every seat view, the bot rule trace and the worker state.
 * The host answers it even when the core is stuck. 404 when scenarios are off.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!scenariosEnabled()) return scenariosOffResponse();
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;

  let fork = false;
  try {
    // Same access rule as the room: throws when this player may not see the duel.
    const room = actor.duels.room(slug, actor.guildId, actor.playerId);
    readDuelControl(request, room);
    fork = room?.session.kind === "replay-fork";
  } catch (error) {
    return duelErrorResponse(error);
  }

  const result = await callDuelHost({ op: "debug-trace", slug, guildId: actor.guildId, playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}) });
  if (!result.ok) return result.response;
  if (fork) {
    try { actor.duels.room(slug, actor.guildId, actor.playerId); }
    catch (error) { return duelErrorResponse(error); }
  }
  return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
}
