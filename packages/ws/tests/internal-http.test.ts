import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInternalHttpHandler } from "../src/internal-http.js";
import type { TypedServer } from "../src/events.js";

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

describe("createInternalHttpHandler", () => {
  it("emits draft:status to the slug room", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/draft/status", { slug: "abc", status: "active" }));
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("draft:abc");
    expect(emit).toHaveBeenCalledWith("draft:status", { status: "active" });
  });

  it("emits draft:pick to the slug room", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/draft/pick", { slug: "abc", playerId: 7, packRound: 1, pickStep: 2 }));
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("draft:abc");
    expect(emit).toHaveBeenCalledWith("draft:pick", { playerId: 7, packRound: 1, pickStep: 2 });
  });

  it("emits draft:resync to the slug room", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/draft/resync", { slug: "abc", packRound: 1, pickStep: 2 }));
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("draft:abc");
    expect(emit).toHaveBeenCalledWith("draft:resync", { packRound: 1, pickStep: 2 });
  });

  it("emits draft:complete to the slug room", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/draft/complete", { slug: "abc" }));
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("draft:abc");
    expect(emit).toHaveBeenCalledWith("draft:complete", {});
  });

  it("emits draft:seats to the slug room", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/draft/seats", { slug: "test-slug" }));
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("draft:test-slug");
    expect(emit).toHaveBeenCalledWith("draft:seats", {});
  });

  it("rejects bad signature with 401", async () => {
    const { io, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/draft/status", { slug: "abc", status: "active" }, "sha256=bad"));
    expect(res.status).toBe(401);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects unknown route with 404", async () => {
    const { io } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/draft/unknown", { slug: "abc" }));
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON with 400", async () => {
    const { io } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const raw = "{not json";
    const req = new Request("http://x/internal/draft/status", {
      method: "POST",
      headers: { "x-announce-signature": sign(raw), "content-type": "application/json" },
      body: raw,
    });
    const res = await handle(req);
    expect(res.status).toBe(400);
  });

  it("rejects payload missing slug with 400", async () => {
    const { io } = makeIo();
    const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
    const res = await handle(makeRequest("/internal/draft/status", { status: "active" } as any));
    expect(res.status).toBe(400);
  });

  it("emits public duel:changed to the guild-scoped room", async () => {
    const { io, to, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as unknown as TypedServer, secret: SECRET, beforeDuelBroadcast: () => true });
    const res = await handle(
      makeRequest("/internal/duel/changed", {
        slug: "abc",
        guildId: "g1",
        prompt: "private",
        cards: [1],
      }),
    );
    expect(res.status).toBe(204);
    expect(to).toHaveBeenCalledWith("duel:g1:abc");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("duel:changed", { slug: "abc" });
  });

  it("rejects duel/changed missing guildId with 400", async () => {
    const { io, emit } = makeIo();
    const handle = createInternalHttpHandler({ io: io as unknown as TypedServer, secret: SECRET });
    const res = await handle(makeRequest("/internal/duel/changed", { slug: "abc" }));
    expect(res.status).toBe(400);
    expect(emit).not.toHaveBeenCalled();
  });

  describe("draft talk", () => {
    it("emits draft:talk to the slug room with the sender and the line id only", async () => {
      const { io, to, emit } = makeIo();
      const beforeDraftBroadcast = vi.fn();
      const handle = createInternalHttpHandler({ io: io as any, secret: SECRET, beforeDraftBroadcast });
      const res = await handle(makeRequest("/internal/draft/talk", { slug: "abc", playerId: 7, line: "hurry", extra: "ignored" }));
      expect(res.status).toBe(204);
      expect(beforeDraftBroadcast).toHaveBeenCalledWith("abc");
      expect(to).toHaveBeenCalledWith("draft:abc");
      expect(emit).toHaveBeenCalledWith("draft:talk", { playerId: 7, line: "hurry" });
    });

    it.each([
      ["free text", { slug: "abc", playerId: 7, line: "hello everyone" }],
      ["the words instead of the id", { slug: "abc", playerId: 7, line: "hurry up" }],
      ["a missing line", { slug: "abc", playerId: 7 }],
      ["a non-integer player", { slug: "abc", playerId: 7.5, line: "gg" }],
      ["a text player", { slug: "abc", playerId: "7", line: "gg" }],
      ["no slug", { playerId: 7, line: "gg" }],
    ])("refuses %s without emitting", async (_name, body) => {
      const { io, emit } = makeIo();
      const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
      const res = await handle(makeRequest("/internal/draft/talk", body));
      expect(res.status).toBe(400);
      expect(emit).not.toHaveBeenCalled();
    });

    it("refuses an unsigned request", async () => {
      const { io, emit } = makeIo();
      const handle = createInternalHttpHandler({ io: io as any, secret: SECRET });
      const res = await handle(makeRequest("/internal/draft/talk", { slug: "abc", playerId: 7, line: "gg" }, "sha256=bad"));
      expect(res.status).toBe(401);
      expect(emit).not.toHaveBeenCalled();
    });
  });
});

it("refuses duel broadcasts without a database guard or when the guard fails", async () => {
  const { io, emit } = makeIo();
  const request = () => makeRequest("/internal/duel/changed", { slug: "fork", guildId: "g" });
  expect((await createInternalHttpHandler({ io: io as any, secret: SECRET })(request())).status).toBe(503);
  expect((await createInternalHttpHandler({ io: io as any, secret: SECRET, beforeDuelBroadcast: () => false })(request())).status).toBe(404);
  expect((await createInternalHttpHandler({ io: io as any, secret: SECRET, beforeDuelBroadcast: () => { throw new Error("Unavailable"); } })(request())).status).toBe(503);
  expect(emit).not.toHaveBeenCalled();
});
