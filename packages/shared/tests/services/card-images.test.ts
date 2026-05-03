import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createDraftImageService } from "../../src/services/card-images.js";

describe("shared card image service", () => {
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
});
