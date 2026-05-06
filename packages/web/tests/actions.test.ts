import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  signOut: vi.fn(),
}));

import { signOut } from "@/lib/auth";
import { handleSignOut } from "@/lib/actions";

const mockSignOut = vi.mocked(signOut);

describe("handleSignOut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls signOut with redirectTo /login", async () => {
    await handleSignOut();
    expect(mockSignOut).toHaveBeenCalledWith({ redirectTo: "/login" });
  });

  it("calls signOut exactly once", async () => {
    await handleSignOut();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
