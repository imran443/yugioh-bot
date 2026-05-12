import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import type { DraftConfig } from "@yugidraft/shared/types";

export const runtime = "nodejs";

type DraftTemplateRow = {
  id: number;
  guild_id: string;
  name: string;
  config_json: string;
  created_by_user_id: string;
};

type DraftTemplate = {
  id: number;
  guildId: string;
  name: string;
  config: DraftConfig;
  setNames: string[];
  customCardIds: number[];
  createdByUserId: string;
};

function mapTemplate(row: DraftTemplateRow): DraftTemplate {
  const config = JSON.parse(row.config_json) as { setNames?: string[]; customCardIds?: number[] };
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    config: JSON.parse(row.config_json) as DraftConfig,
    setNames: Array.isArray(config.setNames) ? config.setNames : [],
    customCardIds: Array.isArray(config.customCardIds) ? config.customCardIds : [],
    createdByUserId: row.created_by_user_id,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for draft templates" }, { status: 500 });
  }

  const db = getDb();
  const rows = db
    .prepare("select * from draft_templates where guild_id = ? order by name asc")
    .all(env.discordGuildId) as DraftTemplateRow[];

  return NextResponse.json({ templates: rows.map(mapTemplate) });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for draft templates" }, { status: 500 });
  }

  const body = (await request.json()) as { name?: string; config?: DraftConfig };
  const name = body.name?.trim();
  const incoming = (body.config ?? {}) as { setNames?: unknown; customCardIds?: unknown };
  const setNames = Array.isArray(incoming.setNames) ? incoming.setNames.filter((s): s is string => typeof s === "string") : [];
  const customCardIds = Array.isArray(incoming.customCardIds) ? incoming.customCardIds.filter((n): n is number => Number.isInteger(n)) : [];

  if (!name || (setNames.length === 0 && customCardIds.length === 0)) {
    return NextResponse.json({ error: "name and a draft pool are required" }, { status: 400 });
  }

  const db = getDb();
  db
    .prepare(
      `
        insert into draft_templates (guild_id, name, config_json, created_by_user_id)
        values (?, ?, ?, ?)
        on conflict(guild_id, name) do update set
          config_json = excluded.config_json,
          created_by_user_id = excluded.created_by_user_id
      `,
    )
    .run(env.discordGuildId, name, JSON.stringify({ setNames, customCardIds }), session.user.id);

  const row = db
    .prepare("select * from draft_templates where guild_id = ? and name = ?")
    .get(env.discordGuildId, name) as DraftTemplateRow;

  return NextResponse.json({ template: mapTemplate(row) }, { status: 201 });
}
