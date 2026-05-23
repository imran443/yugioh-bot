import type { SignedPostTransport } from "./signed-post.js";
import type { AnnouncePayload, AnnounceResult } from "./announce-payload.js";

export type Announcer = {
  announce(payload: AnnouncePayload): Promise<AnnounceResult>;
};

export function createAnnouncer(transport: SignedPostTransport): Announcer {
  return {
    async announce(payload) {
      const { kind, ...data } = payload;
      const res = await transport.post(`/internal/announce/${kind}`, JSON.stringify(data));
      if (res.ok) return { ok: true };
      const error = `Bot responded ${res.status}${res.text ? `: ${res.text}` : ""}`;
      console.warn(`[announcer] ${kind}: ${error}`);
      return { ok: false, error };
    },
  };
}
