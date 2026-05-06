import Database from "better-sqlite3";
import { openDatabase } from "@yugidraft/shared/db";
import { isAbsolute, join, resolve } from "path";

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = resolveDbPath();
  dbInstance = openDatabase(dbPath);
  return dbInstance;
}

function resolveDbPath(): string {
  const configuredPath = process.env.DATABASE_PATH;

  if (!configuredPath) {
    return join(process.cwd(), "..", "..", "data", "bot.sqlite");
  }

  if (isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return resolve(process.cwd(), "..", "..", configuredPath);
}
