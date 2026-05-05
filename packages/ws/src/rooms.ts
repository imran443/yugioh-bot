import type { Socket } from "socket.io";

export interface DraftRoom {
  slug: string;
  draftId: string;
  sockets: Set<Socket>;
}

export class DraftRoomManager {
  private rooms = new Map<string, DraftRoom>();

  getOrCreateRoom(slug: string, draftId: string): DraftRoom {
    const existing = this.rooms.get(slug);
    if (existing) {
      return existing;
    }

    const room: DraftRoom = {
      slug,
      draftId,
      sockets: new Set(),
    };
    this.rooms.set(slug, room);
    return room;
  }

  getRoom(slug: string): DraftRoom | undefined {
    return this.rooms.get(slug);
  }

  removeRoom(slug: string): boolean {
    return this.rooms.delete(slug);
  }

  joinRoom(room: DraftRoom, socket: Socket): void {
    room.sockets.add(socket);
    socket.join(room.slug);
  }

  leaveRoom(room: DraftRoom, socket: Socket): void {
    room.sockets.delete(socket);
    socket.leave(room.slug);

    if (room.sockets.size === 0) {
      this.removeRoom(room.slug);
    }
  }
}
