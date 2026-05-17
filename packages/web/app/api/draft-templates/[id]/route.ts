import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";

type TemplateRow = { id: number; guild_id: string; name: string; config_json: string; created_by_user_id: string };

function poolFromRow(row: TemplateRow) {
  const cfg = JSON.parse(row.config_json) as { setNames?: string[]; customCardIds?: number[] };
  return {
    id: row.id,
    name: row.name,
    setNames: Array.isArray(cfg.setNames) ? cfg.setNames : [],
    customCardIds: Array.isArray(cfg.customCardIds) ? cfg.customCardIds : [],
  };
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const templateId = Number.parseInt(id, 10);
  if (!Number.isInteger(templateId)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { name?: string; setNames?: string[]; customCardIds?: number[] };
  const name = body.name?.trim();
  const setNames = Array.isArray(body.setNames) ? body.setNames.filter((s): s is string => typeof s === "string") : [];
  const customCardIds = Array.isArray(body.customCardIds) ? body.customCardIds.filter((n): n is number => Number.isInteger(n)) : [];
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare("select * from draft_templates where id = ? and guild_id = ?").get(templateId, env.discordGuildId) as TemplateRow | undefined;
  if (!existing) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const collision = db.prepare("select id from draft_templates where guild_id = ? and name = ? and id != ?").get(env.discordGuildId, name, templateId) as { id: number } | undefined;
  if (collision) return NextResponse.json({ error: `A pool named "${name}" already exists` }, { status: 409 });

  db.prepare("update draft_templates set name = ?, config_json = ? where id = ?")
    .run(name, JSON.stringify({ setNames, customCardIds }), templateId);

  const updated = db.prepare("select * from draft_templates where id = ?").get(templateId) as TemplateRow;
  return NextResponse.json({ template: poolFromRow(updated) });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const templateId = Number.parseInt(id, 10);
  if (!Number.isInteger(templateId)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const db = getDb();
  const result = db.prepare("delete from draft_templates where id = ? and guild_id = ?").run(templateId, env.discordGuildId);
  if (result.changes === 0) return NextResponse.json({ error: "Template not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
