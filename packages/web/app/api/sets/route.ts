import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createCardCatalogService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? undefined;
  const db = getDb();
  const catalog = createCardCatalogService(db);
  const sets = catalog.listSets(query);
  return NextResponse.json({ sets });
}