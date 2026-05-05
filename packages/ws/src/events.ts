import type { Server, Socket } from "socket.io";
import type { DraftRoomManager } from "./rooms.js";

export interface DraftJoinPayload {
  slug: string;
  draftId: string;
}

export interface PickCardPayload {
  slug: string;
  cardId: number;
}

export interface RefreshStatePayload {
  slug: string;
}

/* ------------------------------------------------------------------ */
/* Typed event contracts                                               */
/* ------------------------------------------------------------------ */

export interface ServerToClientEvents {
  "player:joined": (data: { socketId: string }) => void;
  "player:left": (data: { socketId: string }) => void;
  "pick:made": (data: { socketId: string; cardId: number }) => void;
}

export interface ClientToServerEvents {
  "draft:join": (
    payload: DraftJoinPayload,
    ack?: (result?: { error?: string }) => void,
  ) => void;
  "pick:card": (
    payload: PickCardPayload,
    ack?: (result?: { error?: string }) => void,
  ) => void;
  "refresh:state": (
    payload: RefreshStatePayload,
    ack?: (result?: unknown | { error: string }) => void,
  ) => void;
}

export interface InterServerEvents {
  // reserved for future use
}

export interface SocketData {
  // reserved for future use
}

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function safeAck(
  ack: ((result?: { error?: string }) => void) | undefined,
  error: Error | unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  ack?.({ error: message });
}

/* ------------------------------------------------------------------ */
/* Event handlers                                                      */
/* ------------------------------------------------------------------ */

export function registerEventHandlers(
  io: TypedServer,
  roomManager: DraftRoomManager,
) {
  io.on("connection", (socket: TypedSocket) => {
    console.log(`[ws] client connected: ${socket.id}`);

    /* ---------- draft:join ---------- */
    socket.on(
      "draft:join",
      (payload: DraftJoinPayload, ack?: (result?: { error?: string }) => void) => {
        try {
          const { slug, draftId } = payload;
          console.log(`[ws] draft:join — ${socket.id} joining ${slug}`);

          const room = roomManager.getOrCreateRoom(slug, draftId);
          roomManager.joinRoom(room, socket);

          socket.to(slug).emit("player:joined", { socketId: socket.id });
          ack?.();
        } catch (err) {
          console.error(`[ws] draft:join error for ${socket.id}`);
          safeAck(ack, err);
        }
      },
    );

    /* ---------- pick:card ---------- */
    socket.on(
      "pick:card",
      (payload: PickCardPayload, ack?: (result?: { error?: string }) => void) => {
        try {
          const { slug, cardId } = payload;

          if (!socket.rooms.has(slug)) {
            ack?.({ error: "Not in room" });
            return;
          }

          console.log(
            `[ws] pick:card — ${socket.id} picked card ${cardId} in ${slug}`,
          );

          // Placeholder: will wire to draft engine later
          socket.to(slug).emit("pick:made", { socketId: socket.id, cardId });
          ack?.();
        } catch (err) {
          console.error(`[ws] pick:card error for ${socket.id}`);
          safeAck(ack, err);
        }
      },
    );

    /* ---------- refresh:state ---------- */
    socket.on(
      "refresh:state",
      (
        payload: RefreshStatePayload,
        ack?: (result?: unknown | { error: string }) => void,
      ) => {
        try {
          const { slug } = payload;

          if (!socket.rooms.has(slug)) {
            ack?.({ error: "Not in room" });
            return;
          }

          console.log(
            `[ws] refresh:state — ${socket.id} requested resync for ${slug}`,
          );

          // Placeholder: will return full draft state from engine later
          const placeholderState = { slug, status: "placeholder" };
          ack?.(placeholderState);
        } catch (err) {
          console.error(`[ws] refresh:state error for ${socket.id}`);
          safeAck(ack as (result?: { error?: string }) => void, err);
        }
      },
    );

    /* ---------- disconnecting ---------- */
    socket.on("disconnecting", () => {
      console.log(`[ws] client disconnecting: ${socket.id}`);

      // socket.rooms is still populated here; iterate only the socket's own
      // rooms for O(user_rooms) cleanup instead of O(total_rooms).
      for (const roomSlug of socket.rooms) {
        if (roomSlug === socket.id) continue;

        const draftRoom = roomManager.getRoom(roomSlug);
        if (draftRoom) {
          roomManager.leaveRoom(draftRoom, socket);
          socket.to(roomSlug).emit("player:left", { socketId: socket.id });
        }
      }
    });
  });
}
