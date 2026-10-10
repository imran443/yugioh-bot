import { NextRequest, NextResponse } from "next/server";
import { isDuelChainMode, isReplayFork } from "@yugidraft/shared/duels";
import { readDuelControl, callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";

export const runtime = "nodejs";

/**
 * The chain response switch (Auto, Always, Off) for the caller's own seat. The duel host applies it, journals it and,
 * when it passes a window that is open now, pushes the change. No other seat is told.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const { slug } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const mode = body && typeof body === "object" ? (body as { mode?: unknown }).mode : undefined;
  if (!isDuelChainMode(mode)) {
    return NextResponse.json({ error: "Choose Auto, Always or Off" }, { status: 400 });
  }

  let fork = false;
  let control: ReturnType<typeof readDuelControl>;
  let binding: { revision?: number; promptId?: string } = {};
  try {
    const room = actor.duels.room(slug, actor.guildId, actor.playerId);
    control = readDuelControl(request, room, "action");
    fork = room && isReplayFork(room.session);
    if (fork) {
      const supplied = body as { revision?: unknown; promptId?: unknown };
      if (!Number.isSafeInteger(supplied.revision) || (supplied.revision as number) < 0
        || (supplied.promptId !== undefined && (typeof supplied.promptId !== "string" || !supplied.promptId || supplied.promptId.length > 200))) {
        return NextResponse.json({ error: "Fork response changes require a valid revision and prompt" }, { status: 400 });
      }
      binding = { revision: supplied.revision as number, ...(supplied.promptId !== undefined ? { promptId: supplied.promptId as string } : {}) };
    }
  } catch (error) {
    return duelErrorResponse(error);
  }

  const result = await callDuelHost({
    op: "chain-mode",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}), ...control, ...binding,
    chainMode: mode,
  });
  if (!result.ok) return result.response;
  if (fork) {
    try { actor.duels.room(slug, actor.guildId, actor.playerId); }
    catch (error) { return duelErrorResponse(error); }
  }
  return NextResponse.json(result.data, { headers: { "cache-control": "private, no-store" } });
}
