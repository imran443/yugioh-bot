import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createCardCatalogService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? undefined;

  const db = getDb();
  const catalog = createCardCatalogService(db);
  const archetypes = await catalog.listArchetypes(query);

  return NextResponse.json({ archetypes });
}
