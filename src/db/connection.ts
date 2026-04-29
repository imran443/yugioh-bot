import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./schema.js";

export function openDatabase(path = process.env.DATABASE_PATH ?? "./data/bot.sqlite") {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  migrate(db);
  return db;
}
