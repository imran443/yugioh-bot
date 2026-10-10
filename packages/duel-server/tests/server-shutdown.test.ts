import { once } from "node:events";
import { Agent, IncomingMessage, request, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  host: { handle: vi.fn(), close: vi.fn() },
  cards: { search: vi.fn(), close: vi.fn() },
  db: { close: vi.fn() },
  server: null as Server | null,
  closeServer: null as (() => Promise<void>) | null,
}));

// Exercise the entry point without opening production data or binding its configured port.
vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("@yugidraft/shared/db", () => ({ openDatabase: () => state.db, applyEngineCardRemaps: () => ({ skipped: true }) }));
vi.mock("@yugidraft/shared/notify", () => ({ createBroadcaster: vi.fn(), httpTransport: vi.fn() }));
vi.mock("../src/cards.js", () => ({ loadCardDatabase: () => state.cards }));
vi.mock("../src/engine-bundle.js", () => ({ verifyEngineBundle: vi.fn() }));
vi.mock("../src/host.js", () => ({ createDuelHost: () => state.host }));
vi.mock("../src/presets/issue-source.js", () => ({ createIssueSource: vi.fn() }));
vi.mock("node:http", async () => {
  const http = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...http,
    createServer: (...args: Parameters<typeof http.createServer>) => {
      const server = http.createServer(...args);
      const listen = server.listen.bind(server);
      const close = server.close.bind(server);
      server.listen = ((_port: number, _bind: string, callback: () => void) => listen(0, "127.0.0.1", callback)) as typeof server.listen;
      state.server = server;
      state.closeServer = () => new Promise<void>(resolve => close(() => resolve()));
      return server;
    },
  };
});

const signals = ["SIGTERM", "SIGINT"] as const;
let previousListeners: Map<string, Function[]>;
const agents: Agent[] = [];
const releasePending: (() => void)[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function start() {
  await import("../src/server.js");
  const server = state.server!;
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  return { server, port: address.port };
}

function post(port: number, agent?: Agent) {
  const req = request({ host: "127.0.0.1", port, path: "/internal/duel", method: "POST", agent });
  const result = new Promise<{ status: number; body: unknown; connection?: string; retryAfter?: string }>((resolve, reject) => {
    req.once("error", reject);
    req.once("response", response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), connection: response.headers.connection,
        ...(response.headers["retry-after"] ? { retryAfter: response.headers["retry-after"] } : {}) }));
    });
  });
  // Cleanup can disconnect a request when an earlier assertion fails.
  void result.catch(() => {});
  return { req, result };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  state.server = null;
  state.host.handle.mockResolvedValue(Response.json({ ok: true }));
  state.host.close.mockResolvedValue(undefined);
  previousListeners = new Map(signals.map(signal => [signal, process.rawListeners(signal)]));
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("DUEL_1V1_ENGINE", "");
  vi.stubEnv("DUEL_STANDARD_1V1_ENGINE", "");
});

afterEach(async () => {
  vi.useRealTimers();
  for (const release of releasePending.splice(0)) release();
  for (const agent of agents.splice(0)) agent.destroy();
  state.server?.closeAllConnections();
  await state.closeServer?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const signal of signals) {
    for (const listener of process.rawListeners(signal)) {
      if (!previousListeners.get(signal)!.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("duel server startup", () => {
  it.each([
    ["", "", "legacy", "legacy"],
    ["legacy", "pinned", "pinned", "legacy"],
    ["pinned", "legacy", "legacy", "pinned"],
    [" PINNED ", " Legacy ", "legacy", "pinned"],
  ])("logs the active engines with global=%j and Standard=%j", async (global, override, standard, domain) => {
    vi.stubEnv("DUEL_1V1_ENGINE", global);
    vi.stubEnv("DUEL_STANDARD_1V1_ENGINE", override);
    await start();
    expect(console.log).toHaveBeenCalledWith(`[duel] 1v1 engines: Standard=${standard}, Domain=${domain}`);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["DUEL_1V1_ENGINE", "pinnned", "legacy", "legacy"],
    ["DUEL_STANDARD_1V1_ENGINE", "pinnned", "pinned", "pinned"],
  ])("warns about invalid %s and logs the fallback engines", async (key, value, standard, domain) => {
    vi.stubEnv("DUEL_1V1_ENGINE", "pinned");
    vi.stubEnv(key, value);
    await start();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      `[duel] Invalid ${key}=${JSON.stringify(value)}; expected legacy or pinned. Using the fallback.`,
    );
    expect(console.log).toHaveBeenCalledWith(`[duel] 1v1 engines: Standard=${standard}, Domain=${domain}`);
  });
});

describe("duel server shutdown", () => {
  it("answers new requests with a closing 503 before reading the body or calling the host", async () => {
    const { server } = await start();
    const closingHost = deferred<void>();
    releasePending.push(() => closingHost.resolve());
    state.host.close.mockReturnValue(closingHost.promise);
    process.emit("SIGTERM");

    const incoming = new IncomingMessage(new Socket());
    const response = new ServerResponse(incoming);
    const writeHead = vi.spyOn(response, "writeHead");
    const end = vi.spyOn(response, "end");
    server.emit("request", incoming, response);

    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({ "connection": "close", "Retry-After": "2" }));
    expect(end).toHaveBeenCalledWith(JSON.stringify({ error: "restarting" }));
    expect(state.host.handle).not.toHaveBeenCalled();
    expect(state.db.close).not.toHaveBeenCalled();
  });

  it("rejects an upload that started before shutdown instead of reaching the closed DB", async () => {
    const { server, port } = await start();
    const received = once(server, "request");
    const { req, result } = post(port);
    req.write("{");
    await received;
    process.emit("SIGTERM");
    req.end("}");

    expect(await result).toEqual({ status: 503, body: { error: "restarting" }, connection: "close", retryAfter: "2" });
    expect(state.host.handle).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  });

  it("drains in-flight requests and closes workers, cards, then DB after HTTP stops accepting", async () => {
    const { server, port } = await start();
    const answer = deferred<Response>();
    releasePending.push(() => answer.resolve(Response.json({ ok: true })));
    state.host.handle.mockReturnValue(answer.promise);
    const order: string[] = [];
    state.host.close.mockImplementation(async () => { expect(server.listening).toBe(false); order.push("host"); });
    state.cards.close.mockImplementation(() => order.push("cards"));
    state.db.close.mockImplementation(() => order.push("db"));
    const { req, result } = post(port);
    req.end("{}");
    await vi.waitFor(() => expect(state.host.handle).toHaveBeenCalledOnce());
    process.emit("SIGINT");

    expect(server.listening).toBe(false);
    expect(order).toEqual([]);
    answer.resolve(Response.json({ ok: true }));
    expect(await result).toEqual({ status: 200, body: { ok: true }, connection: "close" });
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(["host", "cards", "db"]);
  });

  it("closes an idle keep-alive socket and exits promptly", async () => {
    const { server, port } = await start();
    const idle = vi.spyOn(server, "closeIdleConnections");
    const all = vi.spyOn(server, "closeAllConnections");
    const agent = new Agent({ keepAlive: true });
    agents.push(agent);
    const { req, result } = post(port, agent);
    const connected = once(req, "socket");
    req.end("{}");
    const [socket] = await connected as [Socket];
    await result;
    expect(socket.destroyed).toBe(false);
    const disconnected = once(socket, "close");
    process.emit("SIGTERM");

    await disconnected;
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0), { timeout: 1000 });
    expect(idle).toHaveBeenCalled();
    expect(all).toHaveBeenCalled();
  });

  it.each(["host", "cards", "db"] as const)("logs only the error name and exits with code 1 when %s cleanup fails", async resource => {
    await start();
    state[resource].close.mockImplementation(() => { throw new TypeError("private-shutdown-message"); });
    process.emit("SIGTERM");

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(process.exit).not.toHaveBeenCalledWith(0);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("[duel] Shutdown failed", "TypeError");
  });

  it("force-closes a stuck request after the short grace and exits within five seconds", async () => {
    const { server, port } = await start();
    const answer = deferred<Response>();
    releasePending.push(() => answer.resolve(Response.json({ ok: true })));
    state.host.handle.mockReturnValue(answer.promise);
    // A stuck host queue must not defeat the independent exit deadline.
    const closingHost = deferred<void>();
    releasePending.push(() => closingHost.resolve());
    state.host.close.mockReturnValue(closingHost.promise);
    const { req, result } = post(port);
    const disconnected = result.catch(error => error);
    req.end("{}");
    await vi.waitFor(() => expect(state.host.handle).toHaveBeenCalledOnce());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const all = vi.spyOn(server, "closeAllConnections");
    process.emit("SIGTERM");

    await vi.advanceTimersByTimeAsync(2000);
    expect(all).not.toHaveBeenCalled();
    expect(state.db.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(all).toHaveBeenCalled();
    expect(await disconnected).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(state.db.close).not.toHaveBeenCalled();
  });

  it("exits within five seconds even if the HTTP close callback never arrives", async () => {
    const { server } = await start();
    let resumeClose!: () => void;
    vi.spyOn(server, "close").mockImplementation(callback => {
      resumeClose = () => callback?.();
      return server;
    });
    releasePending.push(() => resumeClose());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(4999);
    expect(process.exit).not.toHaveBeenCalled();
    expect(state.host.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it.each([["SIGTERM", "SIGTERM"], ["SIGINT", "SIGINT"], ["SIGTERM", "SIGINT"], ["SIGINT", "SIGTERM"]] as const)("exits immediately on %s followed by %s", async (first, second) => {
    await start();
    const closingHost = deferred<void>();
    releasePending.push(() => closingHost.resolve());
    state.host.close.mockReturnValue(closingHost.promise);
    process.emit(first);
    process.emit(second);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(state.db.close).not.toHaveBeenCalled();
  });
});
