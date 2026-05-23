import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createScoringService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const scope = new URL(request.url).searchParams.get("scope") === "all" ? "all" : "season";
  const scoring = createScoringService(getDb());
  return NextResponse.json({ rows: scoring.getLeaderboard(env.discordGuildId, scope) });
}
