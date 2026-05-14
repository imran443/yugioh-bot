import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInternalHttpHandler } from "../src/internal-http.js";

const SECRET = "shh";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

function makeIo() {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  return { io: { to }, to, emit };
}

function makeRequest(path: string, body: object, sig?: string) {
  const raw = JSON.stringify(body);
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { "x-announce-signature": sig ?? sign(raw), "content-type": "application/json" },
    body: raw,
  });
}

describe("createInternalHttpHandler — tournament routes", () => {
  it("broadcasts participant-joined to the tournament room", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(
      makeRequest("/internal/tournament/participant-joined", { slug: "abc", playerId: 9, displayName: "Alice" }),
    );
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("tournament:abc");
    expect(emit).toHaveBeenCalledWith("tournament:participant-joined", { playerId: 9, displayName: "Alice" });
  });

  it("broadcasts participant-left", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(
      makeRequest("/internal/tournament/participant-left", { slug: "abc", playerId: 9 }),
    );
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("tournament:abc");
    expect(emit).toHaveBeenCalledWith("tournament:participant-left", { playerId: 9 });
  });

  it("broadcasts started", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/tournament/started", { slug: "abc" }));
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("tournament:abc");
    expect(emit).toHaveBeenCalledWith("tournament:started", {});
  });

  it("broadcasts cancelled", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/tournament/cancelled", { slug: "abc" }));
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("tournament:abc");
    expect(emit).toHaveBeenCalledWith("tournament:cancelled", {});
  });

  it("rejects participant-joined with bad payload (empty slug)", async () => {
    const { io } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(
      makeRequest("/internal/tournament/participant-joined", { slug: "", playerId: 9, displayName: "Alice" }),
    );
    expect(res.status).toBe(400);
  });
});
