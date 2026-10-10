import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
beforeEach(() => {
  vi.resetModules(); auth.mockReset();
  auth.mockResolvedValue({ user: { id: "7", name: "Operator" } });
  vi.stubEnv("OWNER_USER_IDS", "3, 7");
});
afterEach(() => { vi.unstubAllEnvs(); });
async function get() { const { GET } = await import("../app/api/admin/access/route"); return GET(); }

it("rejects a request with no session", async () => {
  auth.mockResolvedValue(null);
  expect((await get()).status).toBe(401);
});
it("reports admin: true for a user listed in OWNER_USER_IDS", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ admin: true });
});
it("reports admin: false for anyone else", async () => {
  auth.mockResolvedValue({ user: { id: "8", name: "Member" } });
  expect(await (await get()).json()).toEqual({ admin: false });
});
it.each(["", "abc", "07", "-7", "7.0"])("reports admin: false when OWNER_USER_IDS is %j", async (value) => {
  vi.stubEnv("OWNER_USER_IDS", value);
  expect(await (await get()).json()).toEqual({ admin: false });
});
it("returns 503 when the session can't be read", async () => {
  auth.mockRejectedValue(new Error("down"));
  expect((await get()).status).toBe(503);
});

it("rejects owner IDs outside the safe integer range", async () => {
  vi.stubEnv("OWNER_USER_IDS", "7,9007199254740992,999999999999999999999999999999");
  const { ownerUserIds, isOwnerUser } = await import("../src/lib/owner-access");
  expect(ownerUserIds()).toEqual(new Set([7]));
  expect(isOwnerUser(9007199254740992)).toBe(false);
});

it("uses the current owner list without a module reload", async () => {
  expect(await (await get()).json()).toEqual({ admin: true });
  vi.stubEnv("OWNER_USER_IDS", "3");
  expect(await (await get()).json()).toEqual({ admin: false });
});
