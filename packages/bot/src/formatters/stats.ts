import type { LeaderboardRow, MatchStats } from "../services/matches.js";

export function formatStats(playerName: string, stats: MatchStats) {
  const total = stats.wins + stats.losses;
  const winRate = total === 0 ? 0 : Math.round((stats.wins / total) * 100);

  return `${playerName}: ${stats.wins}W - ${stats.losses}L (${winRate}% win rate)`;
}

export function formatLeaderboard(rows: LeaderboardRow[]) {
  if (rows.length === 0) {
    return "No players have been tracked yet.";
  }

  return rows
    .map((row, index) => `${index + 1}. ${row.displayName}: ${row.wins}W - ${row.losses}L`)
    .join("\n");
}
