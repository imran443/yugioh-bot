import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";

describe("openDatabase concurrency configuration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "yugidraft-conn-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("opens a file-backed database in WAL mode with a busy timeout", () => {
    // bot and web are separate processes sharing one SQLite file; the bot's
    // draft timer writes every second. Without WAL + busy_timeout a concurrent
    // web pick throws SQLITE_BUSY (no retry), silently failing the pick and
    // killing the step-completing request before it can emit its resync.
    const db = openDatabase(join(tempDir, "bot.sqlite"));

    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });
});
