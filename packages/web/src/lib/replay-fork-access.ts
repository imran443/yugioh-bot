import { NextResponse } from "next/server";
import {
  assertDuelForkAccess as assertStoredDuelForkAccess,
  assertOwnerReplaySourceAccess,
  resolveOwnerPlayer,
  ReplayAccessError,
  type ReplayDuelAccess,
} from "@yugidraft/shared/access/owner-access";
import { getDb } from "@/lib/db";
import { requireDuelActor, type DuelActor } from "@/lib/duel-host";
import { isOwnerUser } from "@/lib/owner-access";

type SignedInDuelActor = Extract<DuelActor, { ok: true }>;

function accessFailure(status: 401 | 404 | 503): Extract<DuelActor, { ok: false }> {
  return {
    ok: false,
    response: NextResponse.json({
      error: status === 503 ? "Replay access is unavailable" : status === 401 ? "Unauthorized" : "Not found",
      code: status === 503 ? "ACCESS_UNAVAILABLE" : "ACCESS_DENIED",
    }, { status, headers: { "cache-control": "private, no-store" } }),
  };
}

/** Main owner routes call this before any source lookup. Session identity comes from Clerk's server resolver. */
export async function requireReplayOwnerActor(): Promise<DuelActor> {
  try {
    const actor = await requireDuelActor();
    if (!actor.ok) {
      const status = actor.response.status;
      return status === 401 || status === 503 ? accessFailure(status) : actor;
    }
    if (!isOwnerUser(actor.userId) || !resolveOwnerPlayer(getDb(), actor)) return accessFailure(404);
    return actor;
  } catch {
    return accessFailure(503);
  }
}

/** Private bug-report sources need no source seat/grant. Use actor.guildId for all later source reads. */
export async function requireOwnerReplaySource(slug: string): Promise<
  | (SignedInDuelActor & { source: ReplayDuelAccess })
  | Extract<DuelActor, { ok: false }>
> {
  const actor = await requireReplayOwnerActor();
  if (!actor.ok) return actor;
  try {
    const source = assertOwnerReplaySourceAccess(getDb(), slug, actor);
    return { ...actor, source };
  } catch (error) {
    return accessFailure(error instanceof ReplayAccessError ? error.status : 503);
  }
}

/** Existing routes keep normal play access checks and call this before fork data, mutations or tokens. */
export function assertDuelForkAccess(slug: string, actor: SignedInDuelActor): ReplayDuelAccess {
  try {
    return assertStoredDuelForkAccess(getDb(), slug, actor);
  } catch (error) {
    if (error instanceof ReplayAccessError) throw error;
    throw new ReplayAccessError(503);
  }
}
