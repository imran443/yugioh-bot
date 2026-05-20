export interface Participant {
  playerId: number;
  displayName: string;
}

export interface Match {
  id: number;
  matchId: number | null;
  roundNumber: number;
  playerOneId: number;
  playerTwoId: number | null;
  playerOneName: string;
  playerTwoName: string | null;
  status: string;
  winnerId: number | null;
  reporterId: number | null;
  metadata: Record<string, unknown>;
}

export interface TournamentDetail {
  id: number;
  name: string;
  format: string;
  status: string;
  createdByUserId: string;
  participants: Participant[];
  matches: Match[];
  isParticipant: boolean;
  currentUserPlayerId: number | null;
  deadlineAt?: string;
  reportConfirmWindowHours?: number;
}

export interface StandingsRow {
  playerId: number;
  displayName: string;
  wins: number;
  losses: number;
}
