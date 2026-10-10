import { NextResponse } from "next/server";
import { callDuelHost } from "@/lib/duel-host";
import { requireReplayForkActor } from "@/lib/replay-fork-access";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const actor = await requireReplayForkActor(slug);
  if (!actor.ok) return actor.response;
  if (new URL(request.url).searchParams.size > 0) return NextResponse.json({ error: "Invalid fork cancel request", code: "INVALID_CURSOR" },
    { status: 400, headers: { "cache-control": "private, no-store" } });
  const result = await callDuelHost({ op: "fork-cancel", slug, guildId: actor.guildId, playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}) });
  if (!result.ok) return result.response;
  const current = await requireReplayForkActor(slug);
  if (!current.ok) return current.response;
  if (current.userId !== actor.userId) return NextResponse.json({ error: "Replay access changed", code: "ACCESS_DENIED" }, { status: 404 });
  return NextResponse.json(result.data, { headers: { "cache-control": "private, no-store" } });
}
