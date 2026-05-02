import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createDraftImageService } from "../../src/services/draft-images.js";

describe("draft image service", () => {
  it("renders a numbered grid image", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "draft-images-"));
    try {
      const source = path.join(dir, "card.jpg");
      await sharp({ create: { width: 120, height: 176, channels: 3, background: "white" } }).jpeg().toFile(source);
      const images = createDraftImageService({
        cacheDir: dir,
        fetch: async () =>
          ({ ok: true, arrayBuffer: async () => (await readFile(source)).buffer }) as Response,
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

      expect(output.filename).toBe("draft-picks.png");
      expect(output.buffer.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-8 card grids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "draft-images-"));
    try {
      const images = createDraftImageService({ cacheDir: dir });

      await expect(
        images.renderNumberedGrid([
          { ygoprodeckId: 1, imageUrl: "https://example.com/1.jpg" },
        ]),
      ).rejects.toThrow("exactly 8 cards");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches downloaded images", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "draft-images-"));
    try {
      const source = path.join(dir, "card.jpg");
      await sharp({ create: { width: 120, height: 176, channels: 3, background: "white" } }).jpeg().toFile(source);

      let fetchCount = 0;
      const images = createDraftImageService({
        cacheDir: dir,
        fetch: async () => {
          fetchCount++;
          return { ok: true, arrayBuffer: async () => (await readFile(source)).buffer } as Response;
        },
      });

      const cards = Array.from({ length: 8 }, (_, i) => ({
        ygoprodeckId: i + 1,
        imageUrl: `https://example.com/${i + 1}.jpg`,
        imageUrlSmall: undefined,
      }));

      await images.renderNumberedGrid(cards);
      expect(fetchCount).toBe(8);

      await images.renderNumberedGrid(cards);
      expect(fetchCount).toBe(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders individual card images with labels", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "draft-images-"));
    try {
      const source = path.join(dir, "card.jpg");
      await sharp({ create: { width: 300, height: 400, channels: 3, background: "white" } }).jpeg().toFile(source);
      const images = createDraftImageService({
        cacheDir: dir,
        fetch: async () =>
          ({ ok: true, arrayBuffer: async () => (await readFile(source)).buffer }) as Response,
      });

      const output = await images.renderCardImages([
        { ygoprodeckId: 1, imageUrl: "https://example.com/1.jpg", label: "1" },
        { ygoprodeckId: 2, imageUrl: "https://example.com/2.jpg", label: "2" },
      ]);

      expect(output).toHaveLength(2);
      expect(output[0].filename).toBe("draft-card-1.png");
      expect(output[0].buffer.length).toBeGreaterThan(0);
      expect(output[1].filename).toBe("draft-card-2.png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders pool card images without labels", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "draft-images-"));
    try {
      const source = path.join(dir, "card.jpg");
      await sharp({ create: { width: 300, height: 400, channels: 3, background: "white" } }).jpeg().toFile(source);
      const images = createDraftImageService({
        cacheDir: dir,
        fetch: async () =>
          ({ ok: true, arrayBuffer: async () => (await readFile(source)).buffer }) as Response,
      });

      const output = await images.renderPoolCards([
        { ygoprodeckId: 1, imageUrl: "https://example.com/1.jpg" },
        { ygoprodeckId: 2, imageUrl: "https://example.com/2.jpg" },
      ]);

      expect(output).toHaveLength(2);
      expect(output[0].filename).toBe("draft-card-1.png");
      expect(output[0].buffer.length).toBeGreaterThan(0);
      expect(output[1].filename).toBe("draft-card-2.png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
