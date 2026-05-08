export type DraftStatusBroadcast = {
  kind: "status";
  slug: string;
  status: "active" | "cancelled" | "completed";
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
};

export type DraftCompleteBroadcast = {
  kind: "complete";
  slug: string;
};

export type DraftBroadcastPayload =
  | DraftStatusBroadcast
  | DraftPickBroadcast
  | DraftResyncBroadcast
  | DraftCompleteBroadcast;

export const DRAFT_BROADCAST_KINDS = ["status", "pick", "resync", "complete"] as const;
