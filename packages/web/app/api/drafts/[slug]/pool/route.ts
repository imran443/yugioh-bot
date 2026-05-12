import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createDraftService, createCardCatalogService } from "@yugidraft/shared/services";
import type { DraftConfig } from "@yugidraft/shared/types";
import type { CardSummary } from "@/lib/card-types";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const db = getDb();
  const row = db
    .prepare("select config_json from drafts where web_slug = ? and guild_id = ?")
    .get(slug, env.discordGuildId) as { config_json: string } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }

  try {
    const config = JSON.parse(row.config_json) as DraftConfig;
    const drafts = createDraftService(db);
    const catalog = createCardCatalogService(db);

    const ids = config.poolCardIds && config.poolCardIds.length > 0
      ? config.poolCardIds
      : drafts.resolvePoolCardIds(config);

    const qtyCounts = new Map<number, number>();
    for (const id of ids) qtyCounts.set(id, (qtyCounts.get(id) ?? 0) + 1);

    const cards: CardSummary[] = catalog.findByIds([...qtyCounts.keys()]).map((c) => ({
      id: c.ygoprodeckId,
      name: c.name,
      type: c.type,
      frameType: c.frameType,
      attribute: c.attribute,
      level: c.level,
      effectText: c.effectText,
      atk: c.atk,
      def: c.def,
      imageUrl: c.imageUrl,
      imageUrlSmall: c.imageUrlSmall,
      qty: qtyCounts.get(c.ygoprodeckId) ?? 1,
    }));

    return NextResponse.json({ cards });
  } catch (error) {
    console.error("[GET /api/drafts/[slug]/pool]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
