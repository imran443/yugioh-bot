import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "path";

const openDatabase = vi.fn(() => ({ mocked: true }));

vi.mock("@yugidraft/shared/db", () => ({
  openDatabase,
}));

describe("getDb path resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    openDatabase.mockClear();
    delete process.env.DATABASE_PATH;
  });

  it("resolves relative DATABASE_PATH from the repo root so seeded data is shared", async () => {
    process.env.DATABASE_PATH = "./data/bot.sqlite";

    const { getDb } = await import("../src/lib/db");

    getDb();

    const expectedPath = resolve(process.cwd(), "..", "..", "data", "bot.sqlite");
    expect(openDatabase).toHaveBeenCalledWith(expectedPath);
  });
});
