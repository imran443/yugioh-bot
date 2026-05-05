import { describe, expect, it } from "vitest";
import { DraftRoomManager } from "../src/rooms.js";

function createMockSocket(id: string) {
  return {
    id,
    join: () => {},
    leave: () => {},
  } as unknown as import("socket.io").Socket;
}

describe("DraftRoomManager", () => {
  it("creates a new room when getOrCreateRoom is called", () => {
    const manager = new DraftRoomManager();
    const room = manager.getOrCreateRoom("draft-abc", "draft-id-1");

    expect(room.slug).toBe("draft-abc");
    expect(room.draftId).toBe("draft-id-1");
    expect(room.sockets.size).toBe(0);
  });

  it("returns an existing room instead of creating a duplicate", () => {
    const manager = new DraftRoomManager();
    const room1 = manager.getOrCreateRoom("draft-abc", "draft-id-1");
    const room2 = manager.getOrCreateRoom("draft-abc", "draft-id-2");

    expect(room1).toBe(room2);
    expect(room2.draftId).toBe("draft-id-1"); // original draftId retained
  });

  it("getRoom returns undefined for unknown slug", () => {
    const manager = new DraftRoomManager();
    expect(manager.getRoom("unknown")).toBeUndefined();
  });

  it("getRoom returns the room for known slug", () => {
    const manager = new DraftRoomManager();
    const room = manager.getOrCreateRoom("draft-abc", "draft-id-1");

    expect(manager.getRoom("draft-abc")).toBe(room);
  });

  it("joinRoom adds socket to room", () => {
    const manager = new DraftRoomManager();
    const room = manager.getOrCreateRoom("draft-abc", "draft-id-1");
    const socket = createMockSocket("socket-1");

    manager.joinRoom(room, socket);

    expect(room.sockets.size).toBe(1);
    expect(room.sockets.has(socket)).toBe(true);
  });

  it("leaveRoom removes socket from room", () => {
    const manager = new DraftRoomManager();
    const room = manager.getOrCreateRoom("draft-abc", "draft-id-1");
    const socket = createMockSocket("socket-1");

    manager.joinRoom(room, socket);
    manager.leaveRoom(room, socket);

    expect(room.sockets.size).toBe(0);
    expect(room.sockets.has(socket)).toBe(false);
  });

  it("leaveRoom removes the room when it becomes empty", () => {
    const manager = new DraftRoomManager();
    const room = manager.getOrCreateRoom("draft-abc", "draft-id-1");
    const socket = createMockSocket("socket-1");

    manager.joinRoom(room, socket);
    manager.leaveRoom(room, socket);

    expect(manager.getRoom("draft-abc")).toBeUndefined();
  });

  it("removeRoom deletes a room explicitly", () => {
    const manager = new DraftRoomManager();
    manager.getOrCreateRoom("draft-abc", "draft-id-1");

    expect(manager.removeRoom("draft-abc")).toBe(true);
    expect(manager.getRoom("draft-abc")).toBeUndefined();
  });

  it("removeRoom returns false for unknown slug", () => {
    const manager = new DraftRoomManager();
    expect(manager.removeRoom("unknown")).toBe(false);
  });

  it("tracks multiple sockets in the same room independently", () => {
    const manager = new DraftRoomManager();
    const room = manager.getOrCreateRoom("draft-abc", "draft-id-1");
    const socketA = createMockSocket("socket-a");
    const socketB = createMockSocket("socket-b");

    manager.joinRoom(room, socketA);
    manager.joinRoom(room, socketB);

    expect(room.sockets.size).toBe(2);

    manager.leaveRoom(room, socketA);

    expect(room.sockets.size).toBe(1);
    expect(room.sockets.has(socketB)).toBe(true);
    expect(manager.getRoom("draft-abc")).toBeDefined();
  });
});
