import "dotenv/config";
import { createServer } from "http";
import { Server } from "socket.io";
import { DraftRoomManager } from "./rooms.js";
import { registerEventHandlers } from "./events.js";
import { listenInternalHttp } from "./internal-http.js";
import type { TypedServer } from "./events.js";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const WS_PORT = Number(process.env.WS_PORT ?? 3001);
const WS_INTERNAL_PORT = Number(process.env.WS_INTERNAL_PORT ?? 4002);
const WS_INTERNAL_SECRET = process.env.WS_INTERNAL_SECRET ?? "";

const httpServer = createServer();
const io: TypedServer = new Server(httpServer, {
  cors: { origin: WEB_URL, methods: ["GET", "POST"], credentials: true },
});

const roomManager = new DraftRoomManager();
registerEventHandlers(io, roomManager);

httpServer.listen(WS_PORT, () => {
  console.log(`[ws] Socket.IO server listening on port ${WS_PORT}`);
  console.log(`[ws] CORS configured for origin: ${WEB_URL}`);
});

if (WS_INTERNAL_SECRET) {
  listenInternalHttp({ io, secret: WS_INTERNAL_SECRET, port: WS_INTERNAL_PORT });
} else {
  console.warn("[ws] WS_INTERNAL_SECRET not set - broadcast endpoint disabled");
}

export { io, roomManager };
