import type Database from "better-sqlite3";

export function createNotifyCleanupService(opts: {
  db: Database.Database;
  ttlMinutes: number;
  deleteNotifyMessage: (matchId: number) => Promise<void>;
}) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    const rows = opts.db
      .prepare(
        `select id from matches
         where notify_message_id is not null
           and (
             status != 'pending'
             or created_at < datetime('now', ?)
           )`,
      )
      .all(`-${opts.ttlMinutes} minutes`) as Array<{ id: number }>;

    for (const row of rows) {
      try {
        await opts.deleteNotifyMessage(row.id);
      } catch (error) {
        console.warn(`[notify-cleanup] failed for match ${row.id}`, error);
      }
    }
  }

  return {
    tick,
    start() {
      if (intervalId) return;
      intervalId = setInterval(() => {
        void tick();
      }, 60_000);
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
}

export type NotifyCleanupService = ReturnType<typeof createNotifyCleanupService>;
