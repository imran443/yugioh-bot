import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as ClientIO, type Socket as ClientSocket } from "socket.io-client";
import { DraftRoomManager } from "../src/rooms.js";
import {
  registerEventHandlers,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "../src/events.js";

type TestServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

type SetupTestServerResult = {
  io: TestServer;
  roomManager: DraftRoomManager;
  httpServer: ReturnType<typeof createServer>;
  url: string;
};

async function setupTestServer(): Promise<SetupTestServerResult> {
  const httpServer = createServer();
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
  );
  const roomManager = new DraftRoomManager();
  registerEventHandlers(io, roomManager);

  return new Promise<SetupTestServerResult>((resolve) => {
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

function waitForConnect(socket: TestClient): Promise<void> {
  return new Promise((resolve) => {
    socket.once("connect", resolve);
  });
}

function emitJoin(client: TestClient, slug: string): Promise<unknown> {
  return new Promise((resolve) => {
    client.emit("draft:join", { slug }, resolve);
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

  it("draft:join adds socket to the slug room", async () => {
    const clientA = addClient(server.url);
    const clientB = addClient(server.url);

    await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

    const ackA = await emitJoin(clientA, "draft-1");
    const ackB = await emitJoin(clientB, "draft-1");

    expect(ackA).toBeUndefined();
    expect(ackB).toBeUndefined();
    const room = server.roomManager.getRoom("draft-1");
    expect(room).toBeDefined();
    expect(room!.sockets.size).toBe(2);
  });

  it("draft:join rejects an empty slug", async () => {
    const client = addClient(server.url);
    await waitForConnect(client);

    const result = await emitJoin(client, "");

    expect(result).toEqual({ error: "slug required" });
  });

  it("disconnecting removes the socket from draft rooms", async () => {
    const clientA = addClient(server.url);
    const clientB = addClient(server.url);

    await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

    await emitJoin(clientA, "draft-1");
    await emitJoin(clientB, "draft-1");

    clientB.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const room = server.roomManager.getRoom("draft-1");
    expect(room).toBeDefined();
    expect(room!.sockets.size).toBe(1);
    expect([...room!.sockets][0]?.id).toBe(clientA.id);
  });
});
