import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createScoringService } from "@yugidraft/shared/services";
import { ProfileView } from "@/components/player/profile-view";

export default async function PlayerProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const playerId = Number(id);

  if (!Number.isFinite(playerId) || playerId <= 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center text-[#9aa0b8]">
        Player not found.
      </div>
    );
  }

  const db = getDb();
  const guildId = env.discordGuildId;
  const scoring = createScoringService(db);

  // Check if player exists
  const playerRow = db.prepare("select id from players where id = ? and guild_id = ?").get(playerId, guildId) as
    | { id: number }
    | undefined;

  if (!playerRow) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center text-[#9aa0b8]">
        Player not found.
      </div>
    );
  }

  const profile = scoring.getProfile(guildId, playerId, "season");
  const leaderboard = scoring.getLeaderboard(guildId, "season");
  const posIdx = leaderboard.findIndex((r) => r.playerId === playerId);
  const leaderboardRank = posIdx >= 0 ? posIdx + 1 : null;

  return (
    <div>
      <ProfileView profile={profile} leaderboardRank={leaderboardRank} />
    </div>
  );
}
