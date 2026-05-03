import Database from "better-sqlite3";
import { openDatabase } from "@yugidraft/shared/db";
import { join } from "path";

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = process.env.DATABASE_PATH ?? join(process.cwd(), "..", "..", "data", "bot.sqlite");
  dbInstance = openDatabase(dbPath);
  return dbInstance;
}
