import { verifyDuelConnectionToken, type DuelConnectionTokenClaims } from "@yugidraft/shared/ws";
import type { TypedServer, TypedSocket } from "./events.js";

type Occupant = { socket: TypedSocket; observe: boolean; visible: boolean };

export function registerDuelEventHandlers(io: TypedServer, opts: { secret: string; canReadDuel: (claims: DuelConnectionTokenClaims) => boolean }) {
  const occupancy = new Map<string, Map<string, Occupant>>();
  const expiryTimers = new Map<string, NodeJS.Timeout>();

  function presenceSnapshot(roomKey: string): { onlineSeats: number[]; spectatorCount: number } {
    const seats = new Set<number>();
    const spectators = new Set<number>();
    const members = occupancy.get(roomKey);
    if (members) {
      for (const member of members.values()) {
        const claims = member.socket.data.duel;
        if (!claims || member.observe || !member.visible) continue;
        if (claims.seat === null) spectators.add(claims.playerId);
        else seats.add(claims.seat);
      }
    }
    return { onlineSeats: [...seats].sort((a, b) => a - b), spectatorCount: spectators.size };
  }

  function emitPresence(roomKey: string, slug: string, guildId: string): void {
    pruneDuelRoom(slug, guildId);
    const snapshot = presenceSnapshot(roomKey);
    io.to(roomKey).emit("duel:presence", {
      slug,
      onlineSeats: snapshot.onlineSeats,
      spectatorCount: snapshot.spectatorCount,
    });
  }

  function detachSocket(socket: TypedSocket, reason: "leave" | "expired", announce = true): void {
    const timer = expiryTimers.get(socket.id);
    if (timer) {
      clearTimeout(timer);
      expiryTimers.delete(socket.id);
    }
    const membership = socket.data.duel;
    if (!membership) return;
    const roomKey = `duel:${membership.guildId}:${membership.slug}`;
    socket.leave(roomKey);
    const members = occupancy.get(roomKey);
    members?.delete(socket.id);
    if (members && members.size === 0) occupancy.delete(roomKey);
    socket.data.duel = undefined;
    if (reason === "expired") {
      socket.emit("duel:subscription-expired", { slug: membership.slug });
    }
    if (announce) emitPresence(roomKey, membership.slug, membership.guildId);
  }

  function authorized(claims: DuelConnectionTokenClaims): boolean {
    try { return claims.expiresAt > Date.now() && opts.canReadDuel(claims); } catch { return false; }
  }

  /** Remove revoked or expired identities before any room event can reach them. */
  function pruneDuelRoom(slug: string, guildId: string): void {
    const members = occupancy.get(`duel:${guildId}:${slug}`);
    if (!members) return;
    for (const member of [...members.values()]) {
      const claims = member.socket.data.duel;
      if (!claims || !authorized(claims)) detachSocket(member.socket, "expired", false);
    }
  }

  io.on("connection", (socket: TypedSocket) => {
    socket.on("duel:join", (payload, ack) => {
      try {
        const token = payload && typeof payload === "object" ? payload.token : undefined;
        if (typeof token !== "string" || token.length === 0) {
          ack?.({ ok: false, error: "token required" });
          return;
        }
        const claims = verifyDuelConnectionToken(token, opts.secret);
        if (!claims) {
          ack?.({ ok: false, error: "invalid token" });
          return;
        }
        if (!authorized(claims)) {
          const previous = socket.data.duel;
          if (previous) pruneDuelRoom(previous.slug, previous.guildId);
          ack?.({ ok: false, error: "access denied" });
          return;
        }
        // Renew in place: briefly detaching would emit a false "away" on every renewal.
        const previous = socket.data.duel;
        if (previous && (previous.guildId !== claims.guildId || previous.slug !== claims.slug)) detachSocket(socket, "leave");
        const previousTimer = expiryTimers.get(socket.id);
        if (previousTimer) clearTimeout(previousTimer);
        const roomKey = `duel:${claims.guildId}:${claims.slug}`;
        let members = occupancy.get(roomKey);
        if (!members) {
          members = new Map();
          occupancy.set(roomKey, members);
        }
        members.set(socket.id, { socket,
          observe: payload.observe === true, visible: payload.visible !== false });
        socket.data.duel = {
          slug: claims.slug,
          guildId: claims.guildId,
          playerId: claims.playerId,
          seat: claims.seat,
          expiresAt: claims.expiresAt,
        };
        void socket.join(roomKey);
        const delay = Math.max(0, claims.expiresAt - Date.now());
        expiryTimers.set(
          socket.id,
          setTimeout(() => {
            expiryTimers.delete(socket.id);
            const current = socket.data.duel;
            if (!current || current.expiresAt !== claims.expiresAt) return;
            detachSocket(socket, "expired");
          }, delay),
        );
        pruneDuelRoom(claims.slug, claims.guildId);
        const snapshot = presenceSnapshot(roomKey);
        ack?.({ ok: true, onlineSeats: snapshot.onlineSeats, spectatorCount: snapshot.spectatorCount });
        emitPresence(roomKey, claims.slug, claims.guildId);
      } catch (err) {
        console.error(`[ws] duel:join error for ${socket.id}`, err);
        ack?.({ ok: false, error: "join failed" });
      }
    });

    socket.on("duel:leave", (payload) => {
      const membership = socket.data.duel;
      if (!membership || !payload || typeof payload !== "object") return;
      if (payload.slug !== membership.slug || payload.guildId !== membership.guildId) return;
      detachSocket(socket, "leave");
    });

    socket.on("duel:visibility", (payload) => {
      const membership = socket.data.duel;
      if (!membership || typeof payload?.visible !== "boolean") return;
      const roomKey = `duel:${membership.guildId}:${membership.slug}`;
      const member = occupancy.get(roomKey)?.get(socket.id);
      if (!member || member.observe || member.visible === payload.visible) return;
      member.visible = payload.visible;
      emitPresence(roomKey, membership.slug, membership.guildId);
    });

    socket.on("disconnecting", () => {
      if (socket.data.duel) detachSocket(socket, "leave");
    });
  });
  return { pruneDuelRoom };
}
