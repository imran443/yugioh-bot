import { NextResponse } from "next/server";
import { createDraftService, DraftTerminalError } from "@yugidraft/shared/services";
import { getDb } from "./db";
import { env } from "./env";
import { requireWebAccess } from "./web-access";
import { draftReadAccess } from "./draft-access";
import { isOwnerUser } from "./owner-access";
import { announcer, broadcaster } from "./notify";

/** Host or owner cancellation retains the draft record on retries. */
export async function finishDraft(
  params: Promise<{ slug: string }>,
): Promise<NextResponse> {
  try {
    const actor = await requireWebAccess();
    if (!actor.ok) return actor.response;
    const { slug } = await params;
    const db = getDb();
    const find = db.prepare("select id, created_by_user_id from drafts where web_slug = ? and guild_id = ?");
    const draft = find.get(slug, env.discordGuildId) as { id: number; created_by_user_id: number } | undefined;
    if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

    if (draft.created_by_user_id !== actor.userId && !isOwnerUser(actor.userId)) {
      const denied = draftReadAccess(db, slug, env.discordGuildId, actor.userId);
      if (denied) return denied;
      return NextResponse.json({ error: "Only the host or owner can cancel a draft" }, { status: 403 });
    }

    const result = db.transaction(() => {
      // Re-read the guild-scoped draft under the write lock; authorization above is synchronous.
      const current = find.get(slug, env.discordGuildId) as typeof draft;
      if (!current) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      const drafts = createDraftService(db);
      const before = drafts.findById(current.id);
      const finished = drafts.cancel(current.id);
      return { draft: finished, changed: before.status !== finished.status };
    }).immediate();
    if (result instanceof NextResponse) return result;

    const finished = result.draft;
    // Notify only committed state changes. Transport failures cannot turn a committed change into an error.
    if (result.changed) {
      const notifications: Promise<unknown>[] = [
        broadcaster.draft({ kind: "status", slug, status: finished.status as "cancelled" }),
        // Lobby clients also need a full fetch: their status effect only watches active drafts.
        broadcaster.draft({ kind: "resync", slug, packRound: finished.currentPackRound, pickStep: finished.currentPickStep }),
      ];
      if (finished.channelId) {
        notifications.push(announcer.announce({ kind: "draft-status", draftId: finished.id }));
      }
      for (const notification of await Promise.allSettled(notifications)) {
        if (notification.status === "rejected") console.warn("[draft-terminal] notification failed:", notification.reason);
      }
    }
    return NextResponse.json({
      id: finished.id, name: finished.name, webSlug: slug, status: finished.status,
      changed: result.changed, pickDeadlineAt: finished.pickDeadlineAt, tournamentId: finished.tournamentId ?? null,
    });
  } catch (error) {
    if (error instanceof DraftTerminalError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    console.error("[draft-terminal] failed:", error);
    return NextResponse.json({ error: "Failed to finish draft" }, { status: 500 });
  }
}
