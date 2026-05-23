import { redirect } from "next/navigation";
import { Trophy } from "lucide-react";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createScoringService } from "@yugidraft/shared/services";
import { LeaderboardClient } from "./leaderboard-client";

export default async function LeaderboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const db = getDb();
  const guildId = env.discordGuildId;

  // Resolve current player id (null if user has no player record in this guild)
  const playerRow = db
    .prepare("select id from players where discord_user_id = ? and guild_id = ?")
    .get(session.user.id, guildId) as { id: number } | undefined;
  const currentPlayerId = playerRow?.id ?? null;

  const scoring = createScoringService(db);
  const initialRows = scoring.getLeaderboard(guildId, "season");

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Trophy className="h-6 w-6 text-[#f5c451]" />
        <h1 className="font-display text-2xl text-[#E6E8F0] sm:text-3xl">Leaderboard</h1>
      </div>
      <LeaderboardClient initialRows={initialRows} currentPlayerId={currentPlayerId} />
    </div>
  );
}
