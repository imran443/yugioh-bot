import type { Client } from "discord.js";
import type Database from "better-sqlite3";

export async function deleteNotifyMessage(
  client: Pick<Client, "channels">,
  db: Database.Database,
  matchId: number,
): Promise<void> {
  const row = db
    .prepare("select notify_channel_id, notify_message_id from matches where id = ?")
    .get(matchId) as { notify_channel_id: string | null; notify_message_id: string | null } | undefined;

  if (!row?.notify_channel_id || !row.notify_message_id) {
    return;
  }

  try {
    const channel = await client.channels.fetch(row.notify_channel_id);
    if (channel && "messages" in channel && channel.isTextBased()) {
      await channel.messages.delete(row.notify_message_id);
    }
  } catch {
    // message already gone / no access — fall through and clear columns
  }

  db.prepare(
    "update matches set notify_channel_id = null, notify_message_id = null where id = ?",
  ).run(matchId);
}
