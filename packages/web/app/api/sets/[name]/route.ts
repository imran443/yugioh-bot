import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createCardCatalogService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);
  const db = getDb();
  const catalog = createCardCatalogService(db);

  try {
    const preview = await catalog.getSetPreview(decodedName);
    return NextResponse.json(preview);
  } catch (error) {
    console.error("[api/sets/preview] error:", error);
    return NextResponse.json({ error: "Failed to load set preview" }, { status: 500 });
  }
}