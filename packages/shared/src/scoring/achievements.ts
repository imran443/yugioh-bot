export type AchievementContext = {
  tournamentTitles: number;
  bestStreak: number;
  careerWinnings: number;
  beatTopRanked: boolean; // beat the current #1-rated player this event
};

export type Achievement = {
  key: string;
  name: string;
  icon: string; // Lucide icon name
  predicate: (ctx: AchievementContext) => boolean;
};

export const ACHIEVEMENTS: Achievement[] = [
  { key: "first_tournament_win", name: "First Tournament Win", icon: "trophy", predicate: (c) => c.tournamentTitles >= 1 },
  { key: "streak_10", name: "10-Win Streak", icon: "flame", predicate: (c) => c.bestStreak >= 10 },
  { key: "giant_slayer", name: "Giant Slayer", icon: "swords", predicate: (c) => c.beatTopRanked },
  { key: "winnings_1000", name: "High Roller", icon: "coins", predicate: (c) => c.careerWinnings >= 1000 },
  { key: "winnings_5000", name: "Legend", icon: "crown", predicate: (c) => c.careerWinnings >= 5000 },
  { key: "champion_x3", name: "Three-Time Champion", icon: "medal", predicate: (c) => c.tournamentTitles >= 3 },
];

export function evaluateAchievements(ctx: AchievementContext): string[] {
  return ACHIEVEMENTS.filter((a) => a.predicate(ctx)).map((a) => a.key);
}
