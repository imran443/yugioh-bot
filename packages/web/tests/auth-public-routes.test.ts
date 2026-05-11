import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
}));

vi.mock("next-auth", () => ({
  default: vi.fn((config: Record<string, unknown>) => {
    authState.config = config;
    return {
      handlers: { GET: vi.fn(), POST: vi.fn() },
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  }),
}));

vi.mock("next-auth/providers/discord", () => ({
  default: vi.fn(() => ({})),
}));

async function loadAuthorizedCallback() {
  authState.config = null;
  vi.resetModules();
  await import("../src/lib/auth");
  return (authState.config as {
    callbacks: {
      authorized: (args: {
        auth: { user?: unknown } | null;
        request: { nextUrl: URL };
      }) => Response | boolean | Promise<Response | boolean>;
    };
  }).callbacks.authorized;
}

describe("auth public routes", () => {
  beforeEach(() => {
    process.env.DISCORD_CLIENT_ID = "discord-client-id";
    process.env.DISCORD_CLIENT_SECRET = "discord-client-secret";
    process.env.NEXTAUTH_SECRET = "nextauth-secret";
  });

  afterEach(() => {
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.NEXTAUTH_SECRET;
  });

  it("allows public icon asset requests without auth", async () => {
    const authorized = await loadAuthorizedCallback();

    const result = await authorized({
      auth: null,
      request: { nextUrl: new URL("http://localhost/icons/spell.svg") },
    });

    expect(result).toBe(true);
  });

  it("redirects unauthenticated draft pages to login", async () => {
    const authorized = await loadAuthorizedCallback();

    const result = await authorized({
      auth: null,
      request: { nextUrl: new URL("http://localhost/draft/example") },
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toBe("http://localhost/login");
  });

  it("keeps dotted app routes protected", async () => {
    const authorized = await loadAuthorizedCallback();

    const result = await authorized({
      auth: null,
      request: { nextUrl: new URL("http://localhost/draft/export.csv") },
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toBe("http://localhost/login");
  });
});
