export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const db = getDb();
  const row = db
    .prepare("select id from players where discord_user_id = ? limit 1")
    .get(session.user.id) as { id: number } | undefined;

  if (!row) return NextResponse.json(null, { status: 404 });
  return NextResponse.json({ playerId: row.id });
}
