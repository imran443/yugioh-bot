import { NextResponse } from "next/server";
import { callDuelHost, readReplayQuery } from "@/lib/duel-host";
import { requireOwnerReplaySource } from "@/lib/replay-fork-access";

export const runtime = "nodejs";
const noStore = (response: NextResponse) => { response.headers.set("cache-control", "private, no-store"); return response; };

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const actor = await requireOwnerReplaySource(slug);
  if (!actor.ok) return actor.response;
  const query = readReplayQuery(request, true);
  if (!query.ok) return query.response;
  const result = await callDuelHost({ op: "owner-replay", slug, guildId: actor.guildId,
    playerId: actor.playerId, userId: actor.userId, ...query.input });
  if (!result.ok) return noStore(result.response);
  // A long engine build must not return private cards after access is revoked.
  const current = await requireOwnerReplaySource(slug);
  if (!current.ok) return current.response;
  if (current.userId !== actor.userId || current.playerId !== actor.playerId || current.guildId !== actor.guildId) {
    return noStore(NextResponse.json({ error: "Replay access changed. Reload the replay.", code: "ACCESS_DENIED" }, { status: 404 }));
  }
  return noStore(NextResponse.json(result.data));
}
