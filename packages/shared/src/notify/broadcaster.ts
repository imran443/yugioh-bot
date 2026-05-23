import type { SignedPostTransport } from "./signed-post.js";
import type { DraftBroadcastPayload, TournamentBroadcastPayload } from "../ws/events.js";

export type Broadcaster = {
  draft(payload: DraftBroadcastPayload): Promise<void>;
  tournament(payload: TournamentBroadcastPayload): Promise<void>;
};

export function createBroadcaster(transport: SignedPostTransport): Broadcaster {
  async function send(prefix: "draft" | "tournament", payload: { kind: string }): Promise<void> {
    const { kind, ...data } = payload;
    const res = await transport.post(`/internal/${prefix}/${kind}`, JSON.stringify(data));
    if (!res.ok) console.warn(`[broadcaster] ${prefix}/${kind} -> ${res.status}${res.text ? ` ${res.text}` : ""}`);
  }
  return {
    draft: (payload) => send("draft", payload),
    tournament: (payload) => send("tournament", payload),
  };
}
