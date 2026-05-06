import { redirect } from "next/navigation";
import Link from "next/link";
import { Trophy, Plus } from "lucide-react";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { TournamentCard, type TournamentCardProps } from "@/components/tournament/tournament-card";

export default async function TournamentsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const db = getDb();
  const tournaments: TournamentCardProps[] = db
    .prepare(
      `select t.id, t.guild_id, t.name, t.format, t.status, t.created_by_user_id,
              t.web_slug, count(tp.player_id) as participant_count
       from tournaments t
       left join tournament_participants tp on tp.tournament_id = t.id
       where t.status in ('pending', 'active')
       group by t.id
       order by case t.status when 'active' then 0 else 1 end, t.created_at desc`
    )
    .all()
    .map((row: any) => ({
      id: row.id,
      guildId: row.guild_id,
      name: row.name,
      format: row.format,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      webSlug: row.web_slug ?? undefined,
      participantCount: row.participant_count,
    }));

  const active = tournaments.filter((t) => t.status === "active");
  const pending = tournaments.filter((t) => t.status === "pending");

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <h1 className="font-display text-2xl text-text-primary sm:text-3xl">Tournaments</h1>
        <Link
          href="/tournaments/new"
          className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:bg-accent-secondary"
        >
          <Plus className="h-4 w-4" />
          New Tournament
        </Link>
      </div>

      {tournaments.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <Trophy className="mx-auto mb-4 h-12 w-12 text-text-muted" />
          <p className="text-lg text-text-secondary">No active tournaments</p>
          <p className="mt-2 text-sm text-text-muted">Tournaments created in Discord will appear here</p>
        </div>
      ) : (
        <div className="space-y-8">
          {active.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-accent-gold">Active</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {active.map((t) => (
                  <TournamentCard key={t.id} tournament={t} />
                ))}
              </div>
            </section>
          )}
          {pending.length > 0 && (
            <section>
              <h2 className="mb-4 font-body text-lg font-semibold text-text-secondary">Pending</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {pending.map((t) => (
                  <TournamentCard key={t.id} tournament={t} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}