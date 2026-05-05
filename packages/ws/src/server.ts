import "dotenv/config";
import { createServer } from "http";
import { Server } from "socket.io";
import { DraftRoomManager } from "./rooms.js";
import { registerEventHandlers } from "./events.js";
import type { TypedServer } from "./events.js";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const WS_PORT = Number(process.env.WS_PORT ?? 3001);

const httpServer = createServer();
const io: TypedServer = new Server(httpServer, {
  cors: {
    origin: WEB_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const roomManager = new DraftRoomManager();
registerEventHandlers(io, roomManager);

httpServer.listen(WS_PORT, () => {
  console.log(`[ws] Socket.IO server listening on port ${WS_PORT}`);
  console.log(`[ws] CORS configured for origin: ${WEB_URL}`);
});

export { io, roomManager };
