import { redirect } from "next/navigation";
import Link from "next/link";
import { Layers, Plus } from "lucide-react";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { DraftCard, type DraftCardProps } from "@/components/draft/draft-card";

interface DraftsData {
  active: DraftCardProps[];
  pending: DraftCardProps[];
  completed: DraftCardProps[];
  cancelled: DraftCardProps[];
}

export default async function DraftsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const discordUserId = session.user.id;
  const db = getDb();

  const playerRows = db
    .prepare("select id from players where discord_user_id = ?")
    .all(discordUserId) as Array<{ id: number }>;
  const playerIds = playerRows.map((r) => r.id);

  let data: DraftsData = { active: [], pending: [], completed: [], cancelled: [] };

  if (playerIds.length > 0) {
    const ph = playerIds.map(() => "?").join(",");

    const drafts = db
      .prepare(
        `select d.id, d.guild_id, d.name, d.status, d.web_slug, d.config_json,
                d.current_wave_number, d.current_pick_step,
                d.created_at, d.ended_at,
                count(dp.player_id) as player_count
         from drafts d
         inner join draft_players dp_me on dp_me.draft_id = d.id
         left join draft_players dp on dp.draft_id = d.id
         where dp_me.player_id in (${ph})
         group by d.id
         order by
           case d.status
             when 'active' then 0
             when 'pending' then 1
             when 'completed' then 2
             when 'cancelled' then 3
           end,
           d.created_at desc`
      )
      .all(...playerIds)
      .map((row: any) => {
        let mode: "booster" | "theme" = "booster";
        try {
          if ((JSON.parse(row.config_json ?? "{}") as { mode?: string }).mode === "theme") {
            mode = "theme";
          }
        } catch {
          // malformed config_json — default to booster
        }
        return {
          id: row.id,
          guildId: row.guild_id,
          name: row.name,
          status: row.status,
          mode,
          webSlug: row.web_slug ?? undefined,
          currentPackRound: row.current_wave_number ?? 0,
          currentPickStep: row.current_pick_step ?? 0,
          playerCount: row.player_count,
          createdAt: row.created_at,
          endedAt: row.ended_at ?? undefined,
        };
      });

    data = {
      active: drafts.filter((d: any) => d.status === "active"),
      pending: drafts.filter((d: any) => d.status === "pending"),
      completed: drafts.filter((d: any) => d.status === "completed"),
      cancelled: drafts.filter((d: any) => d.status === "cancelled"),
    };
  }

  const totalDrafts =
    data.active.length + data.pending.length + data.completed.length + data.cancelled.length;

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <h1 className="font-display text-2xl text-text-primary sm:text-3xl">Drafts</h1>
        <Link
          href="/drafts/new"
          className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:bg-accent-secondary"
        >
          <Plus className="h-4 w-4" />
          New Draft
        </Link>
      </div>

      {totalDrafts === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <Layers className="mx-auto mb-4 h-12 w-12 text-text-muted" />
          <p className="text-lg text-text-secondary">No drafts yet</p>
          <p className="mt-2 text-sm text-text-muted">Drafts created in Discord will appear here</p>
        </div>
      ) : (
        <div className="space-y-8">
          {data.active.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-accent-success">Active</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.active.map((d) => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            </section>
          )}
          {data.pending.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-accent-gold">Pending</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.pending.map((d) => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            </section>
          )}
          {data.completed.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-text-secondary">Completed</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.completed.map((d) => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            </section>
          )}
          {data.cancelled.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-text-muted">Cancelled</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.cancelled.map((d) => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}