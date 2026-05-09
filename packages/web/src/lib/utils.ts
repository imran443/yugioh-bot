import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// SQLite CURRENT_TIMESTAMP stores UTC as "YYYY-MM-DD HH:MM:SS" (no Z).
// new Date("YYYY-MM-DD HH:MM:SS") parses as local time in V8, not UTC.
// This converts to proper ISO 8601 so Date always parses correctly.
export function toUtcIso(ts: string): string;
export function toUtcIso(ts: string | null | undefined): string | undefined;
export function toUtcIso(ts: string | null | undefined): string | undefined {
  if (!ts) return undefined;
  return ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
}
