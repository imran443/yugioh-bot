import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as ClientIO, Socket as ClientSocket } from "socket.io-client";
import { DraftRoomManager } from "../src/rooms.js";
import {
  registerEventHandlers,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "../src/events.js";

type TestServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

async function setupTestServer() {
  const httpServer = createServer();
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
  );
  const roomManager = new DraftRoomManager();
  registerEventHandlers(io, roomManager);

  return new Promise<{
    io: TestServer;
    roomManager: DraftRoomManager;
    httpServer: ReturnType<typeof createServer>;
    url: string;
  }>((resolve) => {
    httpServer.listen(() => {
      const address = httpServer.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({ io, roomManager, httpServer, url: `http://localhost:${port}` });
    });
  });
}

function createClient(url: string): TestClient {
  return ClientIO(url, { transports: ["websocket"] });
}

function waitForEvent<T>(socket: TestClient, event: string): Promise<T> {
  return new Promise((resolve) => {
    (socket as any).once(event, resolve);
  });
}

function waitForConnect(socket: TestClient): Promise<void> {
  return new Promise((resolve) => {
    socket.once("connect", resolve);
  });
}

describe("registerEventHandlers", () => {
  let server: Awaited<ReturnType<typeof setupTestServer>>;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    server = await setupTestServer();
    clients.length = 0;
  });

  afterEach(() => {
    for (const client of clients) {
      if (client.connected) client.disconnect();
    }
    server.io.close();
    server.httpServer.close();
  });

  function addClient(url: string): TestClient {
    const client = createClient(url);
    clients.push(client);
    return client;
  }

  /* ------------------------------------------------------------------ */
  /* draft:join                                                         */
  /* ------------------------------------------------------------------ */

  it("draft:join adds socket to room and emits player:joined to others", async () => {
    const clientA = addClient(server.url);
    const clientB = addClient(server.url);

    await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

    // Client A joins
    const ackA = await new Promise<unknown>((resolve) => {
      clientA.emit("draft:join", { slug: "draft-1", draftId: "id-1" }, resolve);
    });
    expect(ackA).toBeUndefined();

    // Client B joins — A should receive player:joined
    const [joinedEvent] = await Promise.all([
      waitForEvent<{ socketId: string }>(clientA, "player:joined"),
      new Promise<unknown>((resolve) => {
        clientB.emit(
          "draft:join",
          { slug: "draft-1", draftId: "id-1" },
          resolve,
        );
      }),
    ]);

    expect(joinedEvent.socketId).toBe(clientB.id);

    const room = server.roomManager.getRoom("draft-1");
    expect(room).toBeDefined();
    expect(room!.sockets.size).toBe(2);
  });

  /* ------------------------------------------------------------------ */
  /* pick:card + room auth                                              */
  /* ------------------------------------------------------------------ */

  it("pick:card rejects when socket is not in the room", async () => {
    const client = addClient(server.url);
    await waitForConnect(client);

    const result = await new Promise<unknown>((resolve) => {
      client.emit("pick:card", { slug: "draft-1", cardId: 1 }, resolve);
    });
    expect(result).toEqual({ error: "Not in room" });
  });

  it("pick:card broadcasts pick:made when socket is in the room", async () => {
    const clientA = addClient(server.url);
    const clientB = addClient(server.url);

    await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

    await new Promise<void>((resolve) => {
      clientA.emit("draft:join", { slug: "draft-1", draftId: "id-1" }, () =>
        resolve(),
      );
    });

    await new Promise<void>((resolve) => {
      clientB.emit("draft:join", { slug: "draft-1", draftId: "id-1" }, () =>
        resolve(),
      );
    });

    const [pickEvent, ackResult] = await Promise.all([
      waitForEvent<{ socketId: string; cardId: number }>(clientA, "pick:made"),
      new Promise<unknown>((resolve) => {
        clientB.emit("pick:card", { slug: "draft-1", cardId: 42 }, resolve);
      }),
    ]);

    expect(pickEvent).toEqual({ socketId: clientB.id, cardId: 42 });
    expect(ackResult).toBeUndefined();
  });

  /* ------------------------------------------------------------------ */
  /* refresh:state + room auth                                          */
  /* ------------------------------------------------------------------ */

  it("refresh:state rejects when socket is not in the room", async () => {
    const client = addClient(server.url);
    await waitForConnect(client);

    const result = await new Promise<unknown>((resolve) => {
      client.emit("refresh:state", { slug: "draft-1" }, resolve);
    });
    expect(result).toEqual({ error: "Not in room" });
  });

  it("refresh:state returns placeholder state when socket is in the room", async () => {
    const client = addClient(server.url);
    await waitForConnect(client);

    await new Promise<void>((resolve) => {
      client.emit("draft:join", { slug: "draft-1", draftId: "id-1" }, () =>
        resolve(),
      );
    });

    const result = await new Promise<unknown>((resolve) => {
      client.emit("refresh:state", { slug: "draft-1" }, resolve);
    });
    expect(result).toEqual({ slug: "draft-1", status: "placeholder" });
  });

  /* ------------------------------------------------------------------ */
  /* disconnect cleanup                                                 */
  /* ------------------------------------------------------------------ */

  it("disconnect cleanup removes socket from rooms and emits player:left", async () => {
    const clientA = addClient(server.url);
    const clientB = addClient(server.url);

    await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

    await new Promise<void>((resolve) => {
      clientA.emit("draft:join", { slug: "draft-1", draftId: "id-1" }, () =>
        resolve(),
      );
    });

    await new Promise<void>((resolve) => {
      clientB.emit("draft:join", { slug: "draft-1", draftId: "id-1" }, () =>
        resolve(),
      );
    });

    const leftPromise = waitForEvent<{ socketId: string }>(
      clientA,
      "player:left",
    );
    const clientBId = clientB.id;
    clientB.disconnect();
    const leftEvent = await leftPromise;

    expect(leftEvent.socketId).toBe(clientBId);

    // Give the server a tick to finish cleanup
    await new Promise((resolve) => setTimeout(resolve, 50));

    const room = server.roomManager.getRoom("draft-1");
    expect(room).toBeDefined();
    expect(room!.sockets.size).toBe(1);
  });

  /* ------------------------------------------------------------------ */
  /* ack safety + error handling                                        */
  /* ------------------------------------------------------------------ */

  it("calls ack with error when handler throws", async () => {
    const httpServer = createServer();
    const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(
      httpServer,
    );
    const badRoomManager = new DraftRoomManager();

    badRoomManager.joinRoom = () => {
      throw new Error("join boom");
    };

    registerEventHandlers(io, badRoomManager);

    const { url } = await new Promise<{ url: string }>((resolve) => {
      httpServer.listen(() => {
        const address = httpServer.address();
        const port =
          typeof address === "object" && address !== null ? address.port : 0;
        resolve({ url: `http://localhost:${port}` });
      });
    });

    const client = createClient(url);
    clients.push(client);
    await waitForConnect(client);

    const result = await new Promise<unknown>((resolve) => {
      client.emit("draft:join", { slug: "draft-1", draftId: "id-1" }, resolve);
    });

    expect(result).toEqual({ error: "join boom" });

    client.disconnect();
    io.close();
    httpServer.close();
  });
});
