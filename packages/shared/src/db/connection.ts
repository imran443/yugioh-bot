import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./schema.js";

export function openDatabase(path = process.env.DATABASE_PATH ?? "./data/bot.sqlite"): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // bot and web are separate processes sharing this file. WAL lets readers and a
  // single writer proceed concurrently across processes; busy_timeout makes a
  // contended writer wait instead of throwing SQLITE_BUSY (which has no retry and
  // would silently fail picks / drop the step-completing resync broadcast).
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
