import { redirect } from "next/navigation";
import Link from "next/link";
import { Trophy, Layers, Swords, TrendingUp, ArrowRight, Target, Flame, Star, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TournamentCard, type TournamentCardProps } from "@/components/tournament/tournament-card";
import { DraftCard, type DraftCardProps } from "@/components/draft/draft-card";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createScoringService } from "@yugidraft/shared/services";
import { RankBadge } from "@/components/rank/rank-badge";

interface Stats {
  wins: number;
  losses: number;
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const discordUserId = session.user.id;
  const db = getDb();

  const playerRows = db
    .prepare("select id, guild_id from players where discord_user_id = ?")
    .all(discordUserId) as Array<{ id: number; guild_id: string }>;
  const playerIds = playerRows.map((r) => r.id);

  let tournaments: TournamentCardProps[] = [];
  let drafts: DraftCardProps[] = [];
  let stats: Stats = { wins: 0, losses: 0 };

  // Profile stats (winnings / rank / streak) — only if this user has a player row
  let seasonWinnings: number | null = null;
  let rankName: string | null = null;
  let currentStreak: number | null = null;

  if (playerIds.length > 0) {
    // Use first player row (single-guild assumption on dashboard)
    const firstPlayer = playerRows[0];
    if (firstPlayer) {
      try {
        const scoring = createScoringService(db);
        const profile = scoring.getProfile(firstPlayer.guild_id, firstPlayer.id, "season");
        seasonWinnings = profile.winnings;
        rankName = profile.rank.name;
        currentStreak = profile.currentStreak;
      } catch {
        // No player_ratings row yet — leave nulls, show dashes
      }
    }

    const ph = playerIds.map(() => "?").join(",");

    tournaments = db
      .prepare(
        `select t.id, t.guild_id, t.name, t.format, t.status, t.web_slug,
           count(tp2.player_id) as participant_count
         from tournaments t
         inner join tournament_participants tp on tp.tournament_id = t.id
         left join tournament_participants tp2 on tp2.tournament_id = t.id
         where tp.player_id in (${ph}) and t.status in ('pending', 'active')
         group by t.id
         order by case t.status when 'active' then 0 else 1 end, t.created_at desc`
      )
      .all(...playerIds)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        format: row.format,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        participantCount: row.participant_count,
      }));

    drafts = db
      .prepare(
        `select d.id, d.guild_id, d.name, d.status, d.web_slug,
           d.current_wave_number, d.current_pick_step,
           count(dp2.player_id) as player_count
         from drafts d
         inner join draft_players dp on dp.draft_id = d.id
         left join draft_players dp2 on dp2.draft_id = d.id
         where dp.player_id in (${ph}) and d.status in ('pending', 'active')
         group by d.id
         order by case d.status when 'active' then 0 else 1 end, d.created_at desc`
      )
      .all(...playerIds)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        currentPackRound: row.current_wave_number,
        currentPickStep: row.current_pick_step,
        playerCount: row.player_count,
      }));

    const statsRow = db
      .prepare(
        `select
           sum(case when winner_id in (${ph}) then 1 else 0 end) as wins,
           sum(case
             when (player_one_id in (${ph}) or player_two_id in (${ph}))
               and winner_id is not null
               and winner_id not in (${ph})
             then 1 else 0 end) as losses
         from matches
         where status = 'completed'
           and (player_one_id in (${ph}) or player_two_id in (${ph}))`
      )
      .get(
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds,
        ...playerIds
      ) as { wins: number | null; losses: number | null } | undefined;

    stats = { wins: statsRow?.wins ?? 0, losses: statsRow?.losses ?? 0 };
  }

  const totalGames = stats.wins + stats.losses;
  const winRate = totalGames > 0 ? Math.round((stats.wins / totalGames) * 100) : 0;

  return (
    <div>
      <h1 className="mb-8 font-display text-2xl text-text-primary sm:text-3xl">Dashboard</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard icon={<Trophy className="h-5 w-5 text-accent-gold" />} label="Wins" value={stats.wins} />
        <StatCard icon={<Target className="h-5 w-5 text-accent-cta" />} label="Losses" value={stats.losses} />
        <StatCard icon={<Swords className="h-5 w-5 text-accent-primary" />} label="Matches" value={totalGames} />
        <StatCard icon={<TrendingUp className="h-5 w-5 text-accent-success" />} label="Win Rate" value={`${winRate}%`} />
        <StatCard
          icon={<Coins className="h-5 w-5 text-accent-gold" />}
          label="Season Winnings"
          value={seasonWinnings !== null ? seasonWinnings : "—"}
        />
        <StatCard
          icon={<Star className="h-5 w-5 text-accent-primary" />}
          label="Rank"
          value={rankName !== null ? <RankBadge rank={rankName} /> : "—"}
        />
        <StatCard
          icon={
            currentStreak !== null && currentStreak > 0
              ? <Flame className="h-5 w-5 text-accent-cta" />
              : <TrendingUp className="h-5 w-5 text-text-muted" />
          }
          label="Win Streak"
          value={currentStreak !== null ? currentStreak : "—"}
        />
      </div>

      <section className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
            <Trophy className="h-5 w-5 text-accent-gold" />
            Your Tournaments
          </h2>
          <Link href="/tournaments">
            <Button variant="ghost" size="sm">
              View All
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
        {tournaments.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center">
            <p className="text-text-secondary">No active tournaments. Join one from Discord!</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {tournaments.map((t) => (
              <TournamentCard key={t.id} tournament={t} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
            <Layers className="h-5 w-5 text-accent-primary" />
            Your Drafts
          </h2>
          <Link href="/drafts">
            <Button variant="ghost" size="sm">
              View All
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
        {drafts.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center">
            <p className="text-text-secondary">No active drafts. Join one from Discord!</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {drafts.map((d) => (
              <DraftCard key={d.id} draft={d} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      </div>
      <div className="font-display text-2xl text-text-primary">{value}</div>
    </div>
  );
}
