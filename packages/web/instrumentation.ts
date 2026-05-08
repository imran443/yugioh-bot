export function register() {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const checks: Array<[string, string | undefined]> = [
    ["WS_INTERNAL_URL", process.env.WS_INTERNAL_URL],
    ["WS_INTERNAL_SECRET", process.env.WS_INTERNAL_SECRET],
    ["BOT_ANNOUNCE_URL", process.env.BOT_ANNOUNCE_URL],
    ["BOT_ANNOUNCE_SECRET", process.env.BOT_ANNOUNCE_SECRET],
  ];

  for (const [name, value] of checks) {
    if (!value) {
      console.warn(`[startup] ${name} is empty — related broadcasts will silently no-op`);
    }
  }
}
