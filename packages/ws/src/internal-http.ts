import { createServer, type Server } from "node:http";
import type { TypedServer } from "./events.js";
import { verifyBroadcastSignature } from "./auth.js";

type StatusBody = { slug: string; status: "active" | "cancelled" | "completed" };
type PickBody = { slug: string; playerId: number; packRound: number; pickStep: number };
type ResyncBody = { slug: string; packRound: number; pickStep: number };
type CompleteBody = { slug: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function parseStatus(v: unknown): StatusBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  if (o.status !== "active" && o.status !== "cancelled" && o.status !== "completed") return null;
  return { slug: o.slug, status: o.status };
}

function parsePick(v: unknown): PickBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  if (typeof o.playerId !== "number" || typeof o.packRound !== "number" || typeof o.pickStep !== "number") return null;
  return { slug: o.slug, playerId: o.playerId, packRound: o.packRound, pickStep: o.pickStep };
}

function parseResync(v: unknown): ResyncBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  if (typeof o.packRound !== "number" || typeof o.pickStep !== "number") return null;
  return { slug: o.slug, packRound: o.packRound, pickStep: o.pickStep };
}

function parseComplete(v: unknown): CompleteBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  return { slug: o.slug };
}

function parseSeats(v: unknown): { slug: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  return { slug: o.slug };
}

type TournamentJoinedBody = { slug: string; playerId: number; displayName: string };
type TournamentLeftBody = { slug: string; playerId: number };
type TournamentSlugOnlyBody = { slug: string };

function parseTournamentJoined(v: unknown): TournamentJoinedBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  if (typeof o.playerId !== "number") return null;
  if (!isNonEmptyString(o.displayName)) return null;
  return { slug: o.slug, playerId: o.playerId, displayName: o.displayName };
}

function parseTournamentLeft(v: unknown): TournamentLeftBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  if (typeof o.playerId !== "number") return null;
  return { slug: o.slug, playerId: o.playerId };
}

function parseTournamentSlugOnly(v: unknown): TournamentSlugOnlyBody | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.slug)) return null;
  return { slug: o.slug };
}

export function createInternalHttpHandler(opts: { io: TypedServer; secret: string }) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST") return new Response("Not found", { status: 404 });

    const body = await req.text();
    if (!verifyBroadcastSignature(body, req.headers.get("x-announce-signature") ?? undefined, opts.secret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }

    switch (url.pathname) {
      case "/internal/draft/status": {
        const data = parseStatus(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(data.slug).emit("draft:status", { status: data.status });
        return new Response(null, { status: 204 });
      }
      case "/internal/draft/pick": {
        const data = parsePick(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(data.slug).emit("draft:pick", {
          playerId: data.playerId,
          packRound: data.packRound,
          pickStep: data.pickStep,
        });
        return new Response(null, { status: 204 });
      }
      case "/internal/draft/resync": {
        const data = parseResync(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(data.slug).emit("draft:resync", {
          packRound: data.packRound,
          pickStep: data.pickStep,
        });
        return new Response(null, { status: 204 });
      }
      case "/internal/draft/complete": {
        const data = parseComplete(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(data.slug).emit("draft:complete", {});
        return new Response(null, { status: 204 });
      }
      case "/internal/draft/seats": {
        const data = parseSeats(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(data.slug).emit("draft:seats", {});
        return new Response(null, { status: 204 });
      }
      case "/internal/tournament/participant-joined": {
        const data = parseTournamentJoined(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io
          .to(`tournament:${data.slug}`)
          .emit("tournament:participant-joined", { playerId: data.playerId, displayName: data.displayName });
        return new Response(null, { status: 204 });
      }
      case "/internal/tournament/participant-left": {
        const data = parseTournamentLeft(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io
          .to(`tournament:${data.slug}`)
          .emit("tournament:participant-left", { playerId: data.playerId });
        return new Response(null, { status: 204 });
      }
      case "/internal/tournament/started": {
        const data = parseTournamentSlugOnly(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(`tournament:${data.slug}`).emit("tournament:started", {});
        return new Response(null, { status: 204 });
      }
      case "/internal/tournament/cancelled": {
        const data = parseTournamentSlugOnly(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(`tournament:${data.slug}`).emit("tournament:cancelled", {});
        return new Response(null, { status: 204 });
      }
      case "/internal/tournament/match-updated": {
        const data = parseTournamentSlugOnly(parsed);
        if (!data) return new Response("Bad payload", { status: 400 });
        opts.io.to(`tournament:${data.slug}`).emit("tournament:match-updated", {});
        return new Response(null, { status: 204 });
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  };
}

export function listenInternalHttp(opts: { io: TypedServer; secret: string; port: number }): Server {
  const handle = createInternalHttpHandler({ io: opts.io, secret: opts.secret });
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
  server.listen(opts.port, () => console.log(`[ws-internal] listening on :${opts.port}`));
  return server;
}
