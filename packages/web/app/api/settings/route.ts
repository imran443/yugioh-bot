import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createGuildSettingsService } from "@yugidraft/shared/services";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const guildId = env.discordGuildId;
  const db = getDb();
  const settings = createGuildSettingsService(db);
  const guildSettings = settings.get(guildId);

  return NextResponse.json(guildSettings);
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const guildId = env.discordGuildId;
  const body = await request.json();
  const db = getDb();
  const settings = createGuildSettingsService(db);
  const updated = settings.update(guildId, body);

  return NextResponse.json(updated);
}