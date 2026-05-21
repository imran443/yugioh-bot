import type Database from "better-sqlite3";
import { ELO_DEFAULT, SEASON_MULTIPLIER_DEFAULT } from "../scoring/constants.js";
import { nextRating } from "../scoring/elo.js";
import { matchWinPoints, placementPoints, sizeMultiplier } from "../scoring/winnings.js";
import { evaluateAchievements } from "../scoring/achievements.js";
import { createSeasonService } from "./seasons.js";

function ratingOf(db: Database.Database, guildId: string, playerId: number): number {
  const row = db
    .prepare("select elo from player_ratings where guild_id = ? and player_id = ?")
    .get(guildId, playerId) as { elo: number } | undefined;
  return row?.elo ?? ELO_DEFAULT;
}

function upsertRating(
  db: Database.Database,
  guildId: string,
  playerId: number,
  patch: { elo?: number; addWinnings?: number; bestStreak?: number },
) {
  db.prepare(
    `insert into player_ratings (guild_id, player_id, elo, career_winnings, best_streak_alltime)
     values (?, ?, ?, ?, ?)
     on conflict(guild_id, player_id) do update set
       elo = coalesce(?, player_ratings.elo),
       career_winnings = player_ratings.career_winnings + ?,
       best_streak_alltime = max(player_ratings.best_streak_alltime, ?)`,
  ).run(
    guildId,
    playerId,
    patch.elo ?? ELO_DEFAULT,
    patch.addWinnings ?? 0,
    patch.bestStreak ?? 0,
    patch.elo ?? null,
    patch.addWinnings ?? 0,
    patch.bestStreak ?? 0,
  );
}

function bumpStanding(
  db: Database.Database,
  guildId: string,
  seasonId: number,
  playerId: number,
  patch: { addWinnings?: number; win?: boolean; loss?: boolean },
) {
  db.prepare(
    `insert into season_standings (guild_id, season_id, player_id, winnings, wins, losses, current_streak, best_streak)
     values (?, ?, ?, 0, 0, 0, 0, 0)
     on conflict(season_id, player_id) do nothing`,
  ).run(guildId, seasonId, playerId);

  if (patch.addWinnings) {
    db.prepare("update season_standings set winnings = winnings + ? where season_id = ? and player_id = ?")
      .run(patch.addWinnings, seasonId, playerId);
  }
  if (patch.win) {
    db.prepare(
      `update season_standings
       set wins = wins + 1,
           current_streak = current_streak + 1,
           best_streak = max(best_streak, current_streak + 1)
       where season_id = ? and player_id = ?`,
    ).run(seasonId, playerId);
  }
  if (patch.loss) {
    db.prepare(
      "update season_standings set losses = losses + 1, current_streak = 0 where season_id = ? and player_id = ?",
    ).run(seasonId, playerId);
  }
}

export function createScoringService(db: Database.Database) {
  const seasons = createSeasonService(db);

  const refreshAchievements = (guildId: string, playerId: number) => {
    const rating = db
      .prepare("select career_winnings from player_ratings where guild_id=? and player_id=?")
      .get(guildId, playerId) as { career_winnings: number } | undefined;
    const best = db
      .prepare(
        "select coalesce(max(best_streak),0) as b from season_standings where guild_id=? and player_id=?",
      )
      .get(guildId, playerId) as { b: number };
    const titles = db
      .prepare(
        `select count(*) as c from point_awards where guild_id=? and player_id=? and placement='champion'`,
      )
      .get(guildId, playerId) as { c: number };
    const beatTop = db
      .prepare(
        "select coalesce(max(unlocked_at),'') as u from player_achievements where guild_id=? and player_id=? and achievement_key='giant_slayer'",
      )
      .get(guildId, playerId) as { u: string };

    const keys = evaluateAchievements({
      careerWinnings: rating?.career_winnings ?? 0,
      bestStreak: best.b,
      tournamentTitles: titles.c,
      beatTopRanked: beatTop.u !== "",
    });
    const ins = db.prepare(
      "insert or ignore into player_achievements (guild_id, player_id, achievement_key) values (?, ?, ?)",
    );
    for (const k of keys) ins.run(guildId, playerId, k);
  };

  const recordMatchResult = (matchId: number): void => {
    const match = db.prepare("select * from matches where id = ?").get(matchId) as any;
    if (!match || match.status !== "approved" || match.winner_id == null) return;

    // idempotency — if a match_win award already exists, do nothing
    const existing = db
      .prepare("select 1 from point_awards where match_id = ? and kind='match_win'")
      .get(matchId);
    if (existing) return;

    const guildId = match.guild_id as string;
    const season = seasons.ensureActive(guildId);
    const winnerId = match.winner_id as number;
    const loserId = winnerId === match.player_one_id ? match.player_two_id : match.player_one_id;

    const tx = db.transaction(() => {
      const winnerElo = ratingOf(db, guildId, winnerId);
      const loserElo = ratingOf(db, guildId, loserId);

      const points = matchWinPoints({
        myElo: winnerElo,
        oppElo: loserElo,
        seasonMultiplier: SEASON_MULTIPLIER_DEFAULT,
      });

      // detect top-ranked upset for giant_slayer achievement
      const top = db
        .prepare("select player_id from player_ratings where guild_id=? order by elo desc limit 1")
        .get(guildId) as { player_id: number } | undefined;
      const beatTop = top && top.player_id === loserId && loserElo > winnerElo;

      upsertRating(db, guildId, winnerId, { elo: nextRating(winnerElo, loserElo, 1), addWinnings: points });
      upsertRating(db, guildId, loserId, { elo: nextRating(loserElo, winnerElo, 0) });

      db.prepare(
        `insert into point_awards (guild_id, season_id, player_id, kind, match_id, points, opponent_elo)
         values (?, ?, ?, 'match_win', ?, ?, ?)`,
      ).run(guildId, season.id, winnerId, matchId, points, loserElo);

      bumpStanding(db, guildId, season.id, winnerId, { addWinnings: points, win: true });
      bumpStanding(db, guildId, season.id, loserId, { loss: true });

      if (beatTop) {
        db.prepare(
          "insert or ignore into player_achievements (guild_id, player_id, achievement_key) values (?, ?, 'giant_slayer')",
        ).run(guildId, winnerId);
      }
      refreshAchievements(guildId, winnerId);
    });
    tx();
  };

  const participantCount = (tournamentId: number): number => {
    const row = db.prepare("select count(*) as c from tournament_participants where tournament_id = ?").get(tournamentId) as { c: number };
    return row.c;
  };

  // placement may be provided by the caller (it knows the bracket) or derived from tournament_matches wins
  const derivePlacement = (tournamentId: number): { champion?: number; runnerUp?: number; top4: number[] } => {
    const rows = db.prepare(
      `select m.winner_id as pid, count(*) as wins
       from tournament_matches tm join matches m on m.id = tm.match_id
       where tm.tournament_id = ? and tm.status='completed' and m.winner_id is not null
       group by m.winner_id order by wins desc`,
    ).all(tournamentId) as Array<{ pid: number; wins: number }>;
    return {
      champion: rows[0]?.pid,
      runnerUp: rows[1]?.pid,
      top4: rows.slice(2, 4).map((r) => r.pid),
    };
  };

  const recordTournamentResult = (
    tournamentId: number,
    placement?: { champion?: number; runnerUp?: number; top4: number[] },
  ): void => {
    const tournament = db.prepare("select * from tournaments where id = ?").get(tournamentId) as any;
    if (!tournament) return;
    const guildId = tournament.guild_id as string;
    const season = seasons.ensureActive(guildId);
    const place = placement ?? derivePlacement(tournamentId);
    const n = participantCount(tournamentId);

    const award = (playerId: number | undefined, tier: "champion" | "runnerUp" | "top4") => {
      if (playerId == null) return;
      const points = placementPoints(tier, n);
      const inserted = db.prepare(
        `insert or ignore into point_awards (guild_id, season_id, player_id, kind, placement, tournament_id, points, size_multiplier)
         values (?, ?, ?, 'placement', ?, ?, ?, ?)`,
      ).run(guildId, season.id, playerId, tier, tournamentId, points, sizeMultiplier(n));
      if (inserted.changes === 1) {
        upsertRating(db, guildId, playerId, { addWinnings: points });
        bumpStanding(db, guildId, season.id, playerId, { addWinnings: points });
        refreshAchievements(guildId, playerId);
      }
    };

    const tx = db.transaction(() => {
      award(place.champion, "champion");
      award(place.runnerUp, "runnerUp");
      for (const p of place.top4) award(p, "top4");
    });
    tx();
  };

  return { recordMatchResult, recordTournamentResult };
}

export type ScoringService = ReturnType<typeof createScoringService>;
