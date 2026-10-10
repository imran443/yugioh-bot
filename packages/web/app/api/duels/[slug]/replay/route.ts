import { NextResponse } from "next/server";
import { callDuelHost, duelErrorResponse, readReplayQuery, requireDuelActor } from "@/lib/duel-host";
import { assertDuelForkAccess } from "@/lib/replay-fork-access";

export const runtime = "nodejs";

const noStore = (response: NextResponse) => { response.headers.set("cache-control", "private, no-store"); return response; };
function accessError(error: unknown) {
  const response = duelErrorResponse(error);
  if (response.status === 403 || response.status === 404) {
    return noStore(NextResponse.json({ error: response.status === 404 ? "Not found" : "You cannot view this duel", code: "ACCESS_DENIED" }, { status: response.status }));
  }
  return noStore(response);
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) {
    const status = actor.response.status === 401 ? 401 : actor.response.status === 403 ? 403 : 503;
    return noStore(NextResponse.json({ error: status === 503 ? "Replay access is unavailable" : "Unauthorized",
      code: status === 503 ? "ACCESS_UNAVAILABLE" : "ACCESS_DENIED" }, { status }));
  }
  const query = readReplayQuery(request);
  if (!query.ok) return query.response;
  const { slug } = await params;

  try {
    assertDuelForkAccess(slug, actor);
    actor.duels.room(slug, actor.guildId, actor.playerId);
  } catch (error) {
    return accessError(error);
  }

  const result = await callDuelHost({
    op: "replay",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId,
    userId: actor.userId,
    ...query.input,
  });
  if (!result.ok) return noStore(result.response);
  // Recheck after the host wait, including allowlist changes for a marked fork.
  try { assertDuelForkAccess(slug, actor); actor.duels.room(slug, actor.guildId, actor.playerId); }
  catch (error) { return accessError(error); }
  return noStore(NextResponse.json(result.data));
}
