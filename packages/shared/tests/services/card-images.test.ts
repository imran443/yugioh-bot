import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createDraftImageService, validateCardImage } from "../../src/services/card-images.js";

describe("card image validation", () => {
  it.each(["jpeg", "png", "webp"] as const)("accepts decoded %s images", async format => {
    const buffer = await sharp({ create: { width: 16, height: 24, channels: 3, background: "white" } }).toFormat(format).toBuffer();
    expect(await validateCardImage(buffer)).toEqual(buffer);
  });

  it.each(["gif", "tiff", "svg"] as const)("rejects decodable %s images", async format => {
    const buffer = format === "svg" ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="24"><rect width="16" height="24" fill="white"/></svg>')
      : await sharp({ create: { width: 16, height: 24, channels: 3, background: "white" } }).toFormat(format).toBuffer();
    expect(await validateCardImage(buffer).then(() => false, () => true)).toBe(true);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["unknown", Buffer.from("not an image")],
    ["GIF", Buffer.from("GIF89a")],
    ["TIFF", Buffer.from([0x49, 0x49, 0x2a, 0x00])],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="24"/>')],
    ["short JPEG", Buffer.from([0xff, 0xd8])],
    ["incorrect JPEG", Buffer.from([0xff, 0xd8, 0x00])],
    ["short PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["incorrect PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a])],
    ["short WebP", Buffer.from("RIFF\0\0\0\0WEB")],
    ["other RIFF", Buffer.from("RIFF\0\0\0\0WAVE")],
    ["incorrect WebP", Buffer.from("NOPE\0\0\0\0WEBP")],
  ] as const)("rejects %s signatures before decoding", async (_name, buffer) => {
    vi.resetModules();
    const decode = vi.fn(sharp);
    vi.doMock("sharp", () => ({ default: decode }));
    try {
      const { validateCardImage: validate, CardImageValidationError } = await import("../../src/services/card-images.js");
      await expect(validate(buffer)).rejects.toBeInstanceOf(CardImageValidationError);
      expect(decode).not.toHaveBeenCalled();
    } finally { vi.doUnmock("sharp"); vi.resetModules(); }
  });

  it.each([
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff])],
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["WebP", Buffer.from("RIFF\0\0\0\0WEBP")],
  ] as const)("rejects incomplete %s images with valid signatures", async (_name, buffer) => {
    await expect(validateCardImage(buffer)).rejects.toThrow("Invalid card image");
  });

  it("rejects a valid image padded beyond 5 MiB", async () => {
    const jpeg = await sharp({ create: { width: 16, height: 24, channels: 3, background: "white" } }).jpeg().toBuffer();
    expect(await validateCardImage(Buffer.concat([jpeg, Buffer.alloc(5 * 1024 * 1024)])).then(() => false, () => true)).toBe(true);
  });

  it.each(["header", "stream"])("bounds the draft image response by its %s", async mode => {
    vi.resetModules();
    const { createDraftImageService: create } = await import("../../src/services/card-images.js");
    const { CARD_BACK_SVG } = await import("../../src/services/card-fetch.js");
    const jpeg = await sharp({ create: { width: 16, height: 24, channels: 3, background: "white" } }).jpeg().toBuffer();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(jpeg));
        if (mode === "stream") controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.enqueue(new Uint8Array([0]));
        controller.close();
      },
      cancel,
    });
    const dir = await mkdtemp(path.join(tmpdir(), "bounded-images-"));
    try {
      const service = create({ cacheDir: dir, fetch: async () => new Response(body, { headers: mode === "header" ? { "Content-Length": String(5 * 1024 * 1024 + 1) } : {} }) });
      expect((await service.renderPoolCards([{ ygoprodeckId: 1, imageUrl: "" }]))[0].buffer
        .equals(await sharp(Buffer.from(CARD_BACK_SVG)).resize(240, 350).png().toBuffer())).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("shared card image service", () => {
  it.each(["full", "small"])("caches Ignis art in the existing %s format after a primary 404", async variant => {
    vi.resetModules();
    const { createDraftImageService: create } = await import("../../src/services/card-images.js");
    const dir = await mkdtemp(path.join(tmpdir(), "ignis-images-"));
    const jpeg = await sharp({ create: { width: 120, height: 176, channels: 3, background: "white" } }).jpeg().toBuffer();
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).startsWith("https://images.ygoprodeck.com/")
      ? new Response("missing", { status: 404 }) : new Response(new Uint8Array(jpeg)));
    try {
      const service = create({ cacheDir: dir, fetch });
      const cards = Array.from({ length: variant === "full" ? 1 : 8 }, (_, index) => ({
        ygoprodeckId: 89631133 + index, imageUrl: "", imageUrlSmall: "",
      }));
      const render = () => variant === "full" ? service.renderPoolCards(cards) : service.renderNumberedGrid(cards);
      await render();
      expect(fetch.mock.calls.map(([url]) => String(url))).toContain(`https://images.ygoprodeck.com/images/${variant === "full" ? "cards" : "cards_small"}/89631133.jpg`);
      expect(fetch.mock.calls.map(([url]) => String(url))).toContain("https://pics.projectignis.org:2096/pics/89631133.jpg");
      const cached = await readFile(path.join(dir, `89631133${variant === "full" ? "-full" : ""}.png`));
      expect(cached).toEqual(await sharp(jpeg).resize(variant === "full" ? 240 : 100, variant === "full" ? 350 : 145, { fit: "cover", position: "center" }).png().toBuffer());
      const calls = fetch.mock.calls.length;
      await render();
      expect(fetch).toHaveBeenCalledTimes(calls);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("renders an uncached card back after both sources miss and recovers later", async () => {
    vi.resetModules();
    const { createDraftImageService: create } = await import("../../src/services/card-images.js");
    const { CARD_BACK_SVG } = await import("../../src/services/card-fetch.js");
    const dir = await mkdtemp(path.join(tmpdir(), "missing-images-"));
    const fetch = vi.fn(async () => new Response("missing", { status: 404 }));
    const card = { ygoprodeckId: 89631133, imageUrl: "" };
    try {
      const service = create({ cacheDir: dir, fetch });
      expect((await service.renderPoolCards([card]))[0].buffer).toEqual(await sharp(Buffer.from(CARD_BACK_SVG)).resize(240, 350).png().toBuffer());
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await readdir(dir)).toEqual([]);
      const jpeg = await sharp({ create: { width: 120, height: 176, channels: 3, background: "white" } }).jpeg().toBuffer();
      fetch.mockResolvedValueOnce(new Response("missing", { status: 404 })).mockResolvedValueOnce(new Response(new Uint8Array(jpeg)));
      await service.renderPoolCards([card]);
      expect(await readdir(dir)).toEqual(["89631133-full.png"]);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("renders a numbered grid image", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "draft-images-"));
    const jpeg = await sharp({
      create: { width: 120, height: 176, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();

    try {
      const images = createDraftImageService({
        cacheDir: dir,
        fetch: async () => new Response(new Uint8Array(jpeg)),
      });

      const output = await images.renderNumberedGrid([
        { ygoprodeckId: 1, imageUrl: "https://example.com/1.jpg", imageUrlSmall: undefined },
        { ygoprodeckId: 2, imageUrl: "https://example.com/2.jpg", imageUrlSmall: undefined },
        { ygoprodeckId: 3, imageUrl: "https://example.com/3.jpg", imageUrlSmall: undefined },
        { ygoprodeckId: 4, imageUrl: "https://example.com/4.jpg", imageUrlSmall: undefined },
        { ygoprodeckId: 5, imageUrl: "https://example.com/5.jpg", imageUrlSmall: undefined },
        { ygoprodeckId: 6, imageUrl: "https://example.com/6.jpg", imageUrlSmall: undefined },
        { ygoprodeckId: 7, imageUrl: "https://example.com/7.jpg", imageUrlSmall: undefined },
        { ygoprodeckId: 8, imageUrl: "https://example.com/8.jpg", imageUrlSmall: undefined },
      ]);

      const meta = await sharp(output.buffer).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(4 * 100);
      expect(meta.height).toBe(2 * 145);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each(["network", "timeout", "429", "503", "invalid image"])("draft image %s failures", (failure) => {
  it.each(["grid", "labelled", "pool"])("renders %s cards with a card back and keeps cached images", async (mode) => {
    vi.resetModules();
    const { createDraftImageService: create } = await import("../../src/services/card-images.js");
    const dir = await mkdtemp(path.join(tmpdir(), "failed-images-"));
    const fetch = vi.fn(async () => {
      if (failure === "network") throw new TypeError("offline");
      if (failure === "timeout") throw new DOMException("timeout", "TimeoutError");
      return new Response("bad image", { status: failure === "invalid image" ? 200 : Number(failure), headers: { "Retry-After": "2" } });
    });
    try {
      const cards = Array.from({ length: 8 }, (_, i) => ({ ygoprodeckId: i + 1, label: String(i + 1), imageUrl: `https://images.ygoprodeck.com/images/cards/${i + 1}.jpg` }));
      const service = create({ cacheDir: dir, fetch });
      const result = mode === "grid" ? [await service.renderNumberedGrid(cards)]
        : mode === "labelled" ? await service.renderCardImages(cards) : await service.renderPoolCards(cards);
      for (const item of result) expect((await sharp(item.buffer).metadata()).format).toBe("png");
      const { readdir, writeFile } = await import("node:fs/promises");
      expect(await readdir(dir)).toEqual([]);
      const cached = await sharp({ create: { width: 240, height: 350, channels: 3, background: "white" } }).png().toBuffer();
      await writeFile(path.join(dir, "1-full.png"), cached);
      const calls = fetch.mock.calls.length;
      expect((await service.renderPoolCards([cards[0]]))[0].buffer).toEqual(cached);
      expect(fetch).toHaveBeenCalledTimes(calls);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
