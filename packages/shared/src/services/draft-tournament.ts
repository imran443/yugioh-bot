import type Database from "better-sqlite3";
import type { TournamentFormat } from "./tournaments.js";
import { generateWebSlug } from "../util/web-slug.js";

export type CreateTournamentFromDraftInput = {
  draftId: number;
  format: TournamentFormat;
  createdByUserId: string;
};

export type CreateTournamentFromDraftResult = {
  tournamentId: number;
  tournamentName: string;
  webSlug: string | undefined;
};

function assertFormat(format: string): asserts format is TournamentFormat {
  if (format !== "round_robin" && format !== "single_elim") {
    throw new Error("Unsupported tournament format");
  }
}

export function createDraftTournamentService(db: Database.Database) {
  return {
    createTournamentFromDraft(
      input: CreateTournamentFromDraftInput,
    ): CreateTournamentFromDraftResult {
      assertFormat(input.format);

      const draft = db
        .prepare(
          "select id, guild_id, channel_id, name, status, created_by_user_id, tournament_id from drafts where id = ?",
        )
        .get(input.draftId) as
        | {
            id: number;
            guild_id: string;
            channel_id: string;
            name: string;
            status: string;
            created_by_user_id: string;
            tournament_id: number | null;
          }
        | undefined;

      if (!draft) throw new Error("Draft not found");
      if (draft.created_by_user_id !== input.createdByUserId) {
        throw new Error("Only the draft creator can create a tournament from this draft");
      }
      if (draft.status !== "completed") {
        throw new Error("Draft must be completed before creating a tournament");
      }
      if (draft.tournament_id !== null) {
        const existing = db
          .prepare("select id, web_slug, name from tournaments where id = ?")
          .get(draft.tournament_id) as
          | { id: number; web_slug: string | null; name: string }
          | undefined;
        if (existing) {
          return {
            tournamentId: existing.id,
            tournamentName: existing.name,
            webSlug: existing.web_slug ?? undefined,
          };
        }
      }

      const result = db.transaction(() => {
        const insertResult = db
          .prepare(
            `insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug)
             values (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(draft.guild_id, draft.name, input.format, input.createdByUserId, generateWebSlug());

        const tournamentId = Number(insertResult.lastInsertRowid);

        const players = db
          .prepare(
            "select player_id from draft_players where draft_id = ? order by joined_at asc, rowid asc",
          )
          .all(draft.id) as Array<{ player_id: number }>;

        const joinStmt = db.prepare(
          "insert into tournament_participants (tournament_id, player_id) values (?, ?)",
        );
        for (const { player_id } of players) {
          joinStmt.run(tournamentId, player_id);
        }

        db.prepare("update drafts set tournament_id = ? where id = ?").run(tournamentId, draft.id);

        const tournament = db
          .prepare("select id, name, web_slug from tournaments where id = ?")
          .get(tournamentId) as { id: number; name: string; web_slug: string | null };

        return {
          tournamentId: tournament.id,
          tournamentName: tournament.name,
          webSlug: tournament.web_slug ?? undefined,
        };
      })();

      return result;
    },
  };
}

export type DraftTournamentService = ReturnType<typeof createDraftTournamentService>;
