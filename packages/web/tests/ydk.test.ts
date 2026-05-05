import { describe, expect, it, vi } from "vitest";
import { generateYdk, downloadYdk } from "../src/lib/ydk.js";

describe("generateYdk", () => {
  it("generates YDK with main deck cards only", () => {
    const cards = [
      { id: 46986414, frameType: "normal" },
      { id: 53183600, frameType: "spell" },
      { id: 12580477, frameType: "trap" },
    ];

    const result = generateYdk(cards);

    expect(result).toBe(
      "#main\n46986414\n53183600\n12580477\n#extra\n#side\n",
    );
  });

  it("generates YDK with extra deck monsters", () => {
    const cards = [
      { id: 21123811, frameType: "fusion" },
      { id: 44508094, frameType: "synchro" },
      { id: 84013237, frameType: "xyz" },
      { id: 41420027, frameType: "link" },
    ];

    const result = generateYdk(cards);

    expect(result).toBe(
      "#main\n#extra\n21123811\n44508094\n84013237\n41420027\n#side\n",
    );
  });

  it("generates YDK with mixed main and extra deck cards", () => {
    const cards = [
      { id: 46986414, frameType: "normal" },
      { id: 21123811, frameType: "fusion" },
      { id: 53183600, frameType: "spell" },
      { id: 44508094, frameType: "synchro" },
      { id: 12580477, frameType: "trap" },
    ];

    const result = generateYdk(cards);

    expect(result).toBe(
      "#main\n46986414\n53183600\n12580477\n#extra\n21123811\n44508094\n#side\n",
    );
  });

  it("includes ritual monsters in main deck", () => {
    const cards = [{ id: 86327276, frameType: "ritual" }];

    const result = generateYdk(cards);

    expect(result).toBe("#main\n86327276\n#extra\n#side\n");
  });

  it("classifies pendulum extra deck variants as extra deck", () => {
    const cards = [
      { id: 10000000, frameType: "fusion_pendulum" },
      { id: 10000001, frameType: "synchro_pendulum" },
      { id: 10000002, frameType: "xyz_pendulum" },
    ];

    const result = generateYdk(cards);

    expect(result).toBe(
      "#main\n#extra\n10000000\n10000001\n10000002\n#side\n",
    );
  });

  it("preserves duplicate card quantities in output", () => {
    const cards = [
      { id: 46986414, frameType: "normal" },
      { id: 46986414, frameType: "normal" },
      { id: 21123811, frameType: "fusion" },
      { id: 21123811, frameType: "fusion" },
      { id: 21123811, frameType: "fusion" },
    ];

    const result = generateYdk(cards);

    expect(result).toBe(
      "#main\n46986414\n46986414\n#extra\n21123811\n21123811\n21123811\n#side\n",
    );
  });

  it("generates empty side section even with no cards", () => {
    const result = generateYdk([]);

    expect(result).toBe("#main\n#extra\n#side\n");
  });
});

describe("downloadYdk", () => {
  it("creates correct Blob and triggers download with given filename", () => {
    vi.useFakeTimers();

    const cards = [
      { id: 46986414, frameType: "normal" },
      { id: 21123811, frameType: "fusion" },
    ];

    const createObjectURLSpy = vi.fn((_: Blob) => "blob:test-url");
    const revokeObjectURLSpy = vi.fn();
    const clickSpy = vi.fn();

    vi.stubGlobal("URL", {
      createObjectURL: createObjectURLSpy,
      revokeObjectURL: revokeObjectURLSpy,
    });

    const mockAnchor = {
      href: "",
      download: "",
      click: clickSpy,
    };

    const appendChildSpy = vi.fn();
    const removeChildSpy = vi.fn();

    vi.stubGlobal("document", {
      createElement: vi.fn(() => mockAnchor),
      body: {
        appendChild: appendChildSpy,
        removeChild: removeChildSpy,
      },
    });

    downloadYdk(cards, "my-deck.ydk");

    expect(createObjectURLSpy).toHaveBeenCalledOnce();
    const blob = createObjectURLSpy.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain");

    expect(mockAnchor.download).toBe("my-deck.ydk");
    expect(mockAnchor.href).toBe("blob:test-url");
    expect(appendChildSpy).toHaveBeenCalledWith(mockAnchor);
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(removeChildSpy).toHaveBeenCalledWith(mockAnchor);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:test-url");

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
