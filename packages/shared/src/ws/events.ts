export type DraftStatusBroadcast = {
  kind: "status";
  slug: string;
  status: "active" | "cancelled" | "completed";
  /** Theme-draft phase, when applicable, so clients can render the phase indicator. */
  phase?: "main" | "extra";
};

export type DraftPickBroadcast = {
  kind: "pick";
  slug: string;
  playerId: number;
  packRound: number;
  pickStep: number;
};

export type DraftResyncBroadcast = {
  kind: "resync";
  slug: string;
  packRound: number;
  pickStep: number;
  /** Theme-draft phase, when applicable, so clients can render the phase indicator. */
  phase?: "main" | "extra";
};

export type DraftCompleteBroadcast = {
  kind: "complete";
  slug: string;
};

export type DraftSeatsBroadcast = {
  kind: "seats";
  slug: string;
};

export type DraftBroadcastPayload =
  | DraftStatusBroadcast
  | DraftPickBroadcast
  | DraftResyncBroadcast
  | DraftCompleteBroadcast
  | DraftSeatsBroadcast;

export const DRAFT_BROADCAST_KINDS = ["status", "pick", "resync", "complete", "seats"] as const;

export type TournamentParticipantJoinedBroadcast = {
  kind: "participant-joined";
  slug: string;
  playerId: number;
  displayName: string;
};

export type TournamentParticipantLeftBroadcast = {
  kind: "participant-left";
  slug: string;
  playerId: number;
};

export type TournamentStartedBroadcast = {
  kind: "started";
  slug: string;
};

export type TournamentCancelledBroadcast = {
  kind: "cancelled";
  slug: string;
};

export type TournamentCompletedBroadcast = {
  kind: "completed";
  slug: string;
};

export type TournamentMatchUpdatedBroadcast = {
  kind: "match-updated";
  slug: string;
};

export type TournamentBroadcastPayload =
  | TournamentParticipantJoinedBroadcast
  | TournamentParticipantLeftBroadcast
  | TournamentStartedBroadcast
  | TournamentCancelledBroadcast
  | TournamentCompletedBroadcast
  | TournamentMatchUpdatedBroadcast;

export const TOURNAMENT_BROADCAST_KINDS = [
  "participant-joined",
  "participant-left",
  "started",
  "cancelled",
  "completed",
  "match-updated",
] as const;
