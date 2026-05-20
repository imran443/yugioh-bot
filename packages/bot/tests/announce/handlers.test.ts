import { describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import { createAnnounceHandlers } from "../../src/announce/handlers.js";

describe("announce handlers", () => {
  it("does not post draft status messages when a web-started draft announces start", async () => {
    const drafts = { findById: vi.fn() };
    const messenger = { postStatus: vi.fn(), updateStatus: vi.fn() };
    const handlers = createAnnounceHandlers({
      client: { channels: { fetch: vi.fn() } } as any,
      db: { prepare: vi.fn() } as any,
      guildSettings: {} as any,
      drafts: drafts as any,
      messenger,
    });

    await handlers.onDraftStarted({ draftId: 1, channelId: "c1", name: "test1", webSlug: "1d4wjhls" });

    expect(drafts.findById).not.toHaveBeenCalled();
    expect(messenger.postStatus).not.toHaveBeenCalled();
    expect(messenger.updateStatus).not.toHaveBeenCalled();
  });

  it("posts signup announcements to text channels", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const handlers = createAnnounceHandlers({
      client: { channels: { fetch: vi.fn().mockResolvedValue({ type: ChannelType.GuildText, send }) } } as any,
      db: { prepare: vi.fn() } as any,
      guildSettings: {} as any,
      drafts: {} as any,
      messenger: {} as any,
    });

    await handlers.onDraftCreated({ draftId: 1, channelId: "c1", name: "test1", webSlug: "1d4wjhls" });

    expect(send).toHaveBeenCalledWith("Signups are open for **test1**. Pick cards: http://localhost:3000/draft/1d4wjhls");
  });

  it("posts tournament-completed announcement to the announce channel", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = { isTextBased: () => true, send };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ name: "Test Cup", web_slug: "test-cup", guild_id: "g1" }),
      }),
    };
    const handlers = createAnnounceHandlers({
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any,
      db: db as any,
      guildSettings: { get: vi.fn().mockReturnValue({ announceChannelId: "ch1" }) } as any,
      drafts: {} as any,
      messenger: {} as any,
    });

    await handlers.onTournamentCompleted({ tournamentId: 7 });

    expect(send).toHaveBeenCalledWith(
      "🏆 **Test Cup** has completed! Final standings: http://localhost:3000/tournament/test-cup",
    );
  });
});
