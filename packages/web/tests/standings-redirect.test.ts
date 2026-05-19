import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect }));

describe("old standings route", () => {
  it("redirects to the standings tab", async () => {
    const mod = await import("../app/(app)/tournament/[slug]/standings/page");
    await mod.default({ params: Promise.resolve({ slug: "slug1" }) } as any);
    expect(redirect).toHaveBeenCalledWith("/tournament/slug1?tab=standings");
  });
});
