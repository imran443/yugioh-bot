import { createServer, type Server } from "node:http";
import type { AnnouncePayload } from "@yugidraft/shared/notify";
import { verifyAnnounceSignature } from "./auth.js";

export type { AnnouncePayload };

type OmitKind<T extends { kind: string }> = Omit<T, "kind">;

export interface AnnounceHandlers {
  onDraftCreated(payload: OmitKind<Extract<AnnouncePayload, { kind: "draft-created" }>>): Promise<void>;
  onDraftStarted(payload: OmitKind<Extract<AnnouncePayload, { kind: "draft-started" }>>): Promise<void>;
  onDraftCompleted(payload: OmitKind<Extract<AnnouncePayload, { kind: "draft-completed" }>>): Promise<void>;
  onTournamentCreated(payload: OmitKind<Extract<AnnouncePayload, { kind: "tournament-created" }>>): Promise<void>;
  onTournamentStarted(payload: OmitKind<Extract<AnnouncePayload, { kind: "tournament-started" }>>): Promise<void>;
  onMatchReportPending(payload: OmitKind<Extract<AnnouncePayload, { kind: "match-report-pending" }>>): Promise<void>;
  onMatchResolved(payload: OmitKind<Extract<AnnouncePayload, { kind: "match-resolved" }>>): Promise<void>;
  onTournamentCompleted(payload: OmitKind<Extract<AnnouncePayload, { kind: "tournament-completed" }>>): Promise<void>;
}

export function createAnnounceServer(opts: {
  secret: string;
  handlers: AnnounceHandlers;
}) {
  const routes: Record<string, (data: any) => Promise<void>> = {
    "/internal/announce/draft-created": (d) => opts.handlers.onDraftCreated(d),
    "/internal/announce/draft-started": (d) => opts.handlers.onDraftStarted(d),
    "/internal/announce/draft-completed": (d) => opts.handlers.onDraftCompleted(d),
    "/internal/announce/tournament-created": (d) => opts.handlers.onTournamentCreated(d),
    "/internal/announce/tournament-started": (d) => opts.handlers.onTournamentStarted(d),
    "/internal/announce/match-report-pending": (d) => opts.handlers.onMatchReportPending(d),
    "/internal/announce/match-resolved": (d) => opts.handlers.onMatchResolved(d),
    "/internal/announce/tournament-completed": (d) => opts.handlers.onTournamentCompleted(d),
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || !routes[url.pathname]) {
      return new Response("Not found", { status: 404 });
    }
    const body = await req.text();
    if (!verifyAnnounceSignature(body, req.headers.get("x-announce-signature") ?? undefined, opts.secret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }
    try {
      await routes[url.pathname](parsed);
      return new Response(null, { status: 204 });
    } catch (err) {
      console.error(`[announce] handler failed for ${url.pathname}:`, err);
      return new Response("Handler error", { status: 500 });
    }
  }

  function listen(port: number): Server {
    const server = createServer(async (nodeReq, nodeRes) => {
      const chunks: Buffer[] = [];
      for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      const url = `http://${nodeReq.headers.host ?? "localhost"}${nodeReq.url ?? "/"}`;
      const res = await handle(new Request(url, {
        method: nodeReq.method,
        headers: nodeReq.headers as any,
        body: buf.length ? buf : undefined,
      }));
      nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
      const text = await res.text();
      nodeRes.end(text);
    });
    server.listen(port, () => console.log(`[announce] listening on :${port}`));
    return server;
  }

  return { handle, listen };
}
