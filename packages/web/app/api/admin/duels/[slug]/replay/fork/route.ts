import { NextResponse } from "next/server";
import { isReplayForkRequest } from "@yugidraft/shared/duels";
import { callDuelHost } from "@/lib/duel-host";
import { requireReplayOwnerActor } from "@/lib/replay-fork-access";

export const runtime = "nodejs";
const noStore = (response: NextResponse) => { response.headers.set("cache-control", "private, no-store"); return response; };

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireReplayOwnerActor();
  if (!actor.ok) return actor.response;
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  if (!isReplayForkRequest(body) || new URL(request.url).searchParams.size > 0) {
    return noStore(NextResponse.json({ error: "Invalid replay fork request", code: "INVALID_CURSOR" }, { status: 400 }));
  }
  const { slug } = await params;
  // Host retries check the stored fork before source lookup. This also works after source deletion.
  const result = await callDuelHost({ op: "replay-fork", slug, guildId: actor.guildId, playerId: actor.playerId,
    userId: actor.userId, ...body });
  if (!result.ok) return noStore(result.response);
  const current = await requireReplayOwnerActor();
  if (!current.ok) return current.response;
  if (current.userId !== actor.userId || current.playerId !== actor.playerId || current.guildId !== actor.guildId) {
    return noStore(NextResponse.json({ error: "Replay access changed", code: "ACCESS_DENIED" }, { status: 404 }));
  }
  return noStore(NextResponse.json(result.data));
}
