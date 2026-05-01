import Database from "better-sqlite3";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createDraftCleanupService } from "../../src/services/draft-cleanup.js";
import { createDraftService } from "../../src/services/drafts.js";

describe("draft cleanup service", () => {
  it("reports draft storage usage", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const dir = await mkdtemp(path.join(tmpdir(), "draft-cleanup-"));
    try {
      await writeFile(path.join(dir, "1.png"), Buffer.alloc(10));
      const cleanup = createDraftCleanupService(db, { imageCacheDir: dir });

      await expect(cleanup.storageSummary()).resolves.toMatchObject({ imageCacheBytes: 10 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes cached images for cards no longer referenced by active or pending drafts", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const players = createPlayerRepository(db);
    const drafts = createDraftService(db);
    const dir = await mkdtemp(path.join(tmpdir(), "draft-cleanup-"));
    try {
      // Seed catalog
      for (let id = 1; id <= 5; id += 1) {
        db.prepare(
          `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
           values (?, 'Card', 'Effect Monster', 'effect', 'url', 'small', '[]', '2026-01-01')`,
        ).run(id);
      }

      const creator = players.upsert("guild-1", "user-1", "Yugi");
      const joiner = players.upsert("guild-1", "user-2", "Kaiba");
      const draft = drafts.create("guild-1", "channel-1", "cube", {}, "user-1", creator.id);
      drafts.join(draft.id, joiner.id);
      drafts.start(draft.id);

      // Create cache files for catalog cards used in the draft + one extra
      const waveCards = drafts.currentWaveCards(draft.id);
      const referencedIds = new Set(waveCards.map((c) => c.catalogCardId));

      for (let id = 1; id <= 5; id += 1) {
        await writeFile(path.join(dir, `${id}.png`), Buffer.alloc(10));
      }

      const cleanup = createDraftCleanupService(db, { imageCacheDir: dir });
      await cleanup.removeUnreferencedImages();

      const remaining = await readdir(dir);
      expect(remaining).toEqual(
        expect.arrayContaining([...referencedIds].map((id) => `${id}.png`)),
      );
      expect(remaining).toHaveLength(referencedIds.size);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports image cache byte size", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const dir = await mkdtemp(path.join(tmpdir(), "draft-cleanup-"));
    try {
      await writeFile(path.join(dir, "1.png"), Buffer.alloc(100));
      await writeFile(path.join(dir, "2.png"), Buffer.alloc(200));
      const cleanup = createDraftCleanupService(db, { imageCacheDir: dir });

      const bytes = await cleanup.imageCacheBytes();

      expect(bytes).toBe(300);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not remove images when cache is under the max bytes limit", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const dir = await mkdtemp(path.join(tmpdir(), "draft-cleanup-"));
    try {
      await writeFile(path.join(dir, "1.png"), Buffer.alloc(100));
      const cleanup = createDraftCleanupService(db, { imageCacheDir: dir });

      const deleted = await cleanup.removeOldestImages(500);

      expect(deleted).toBe(0);
      expect(await readdir(dir)).toEqual(["1.png"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes oldest images when cache exceeds the max bytes limit", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const dir = await mkdtemp(path.join(tmpdir(), "draft-cleanup-"));
    try {
      await writeFile(path.join(dir, "1.png"), Buffer.alloc(100));
      await writeFile(path.join(dir, "2.png"), Buffer.alloc(200));
      await writeFile(path.join(dir, "3.png"), Buffer.alloc(300));
      const cleanup = createDraftCleanupService(db, { imageCacheDir: dir });

      const deleted = await cleanup.removeOldestImages(350);

      expect(deleted).toBe(2);
      const remaining = await readdir(dir);
      expect(remaining).toEqual(["3.png"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
