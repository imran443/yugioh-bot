export function formatMatchTime(
  iso: string | null | undefined,
  opts?: { locale?: string; timeZone?: string },
): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(opts?.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: opts?.timeZone,
  });
}
