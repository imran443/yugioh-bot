import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";

const CARD_IMAGE_FILENAME = /^(\d+)\.png$/;

async function listDirectoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

type FileEntry = {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};

export function createDraftCleanupService(
  db: Database.Database,
  { imageCacheDir }: { imageCacheDir: string },
) {
  return {
    async storageSummary() {
      const entries = await listDirectoryEntries(imageCacheDir);
      let imageCacheBytes = 0;

      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const file = await stat(join(imageCacheDir, entry.name));
        imageCacheBytes += file.size;
      }

      const cardCatalogCount = Number(
        (db.prepare("select count(*) as count from card_catalog").get() as { count: number }).count,
      );
      const draftCount = Number((db.prepare("select count(*) as count from drafts").get() as { count: number }).count);
      const draftCardCount = Number(
        (db.prepare("select count(*) as count from draft_cards").get() as { count: number }).count,
      );

      return {
        imageCacheBytes,
        cardCatalogCount,
        draftCount,
        draftCardCount,
      };
    },

    async removeUnreferencedImages() {
      const referencedCardIds = new Set<number>(
        db
          .prepare(
            `
              select distinct dc.catalog_card_id
              from draft_cards dc
              inner join drafts d on d.id = dc.draft_id
              where d.status in ('pending', 'active')
            `,
          )
          .all()
          .map((row: any) => Number(row.catalog_card_id)),
      );

      const entries = await listDirectoryEntries(imageCacheDir);

      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isFile()) {
            return;
          }

          const match = CARD_IMAGE_FILENAME.exec(entry.name);

          if (!match) {
            return;
          }

          const cardId = Number(match[1]);

          if (referencedCardIds.has(cardId)) {
            return;
          }

          await unlink(join(imageCacheDir, entry.name));
        }),
      );
    },

    async imageCacheBytes(): Promise<number> {
      const entries = await listDirectoryEntries(imageCacheDir);
      let total = 0;

      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const file = await stat(join(imageCacheDir, entry.name));
        total += file.size;
      }

      return total;
    },

    async removeOldestImages(maxBytes: number): Promise<number> {
      const entries = await listDirectoryEntries(imageCacheDir);
      const files: FileEntry[] = [];

      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const filePath = join(imageCacheDir, entry.name);
        const fileStat = await stat(filePath);

        files.push({
          name: entry.name,
          path: filePath,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      }

      const currentBytes = files.reduce((sum, f) => sum + f.size, 0);

      if (currentBytes <= maxBytes) {
        return 0;
      }

      const sorted = files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let deletedCount = 0;
      let bytesFreed = 0;

      for (const file of sorted) {
        if (currentBytes - bytesFreed <= maxBytes) {
          break;
        }

        await unlink(file.path);
        bytesFreed += file.size;
        deletedCount += 1;
      }

      return deletedCount;
    },
  };
}

export type DraftCleanupService = ReturnType<typeof createDraftCleanupService>;
