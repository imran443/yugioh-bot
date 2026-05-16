import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createDraftService, createCardCatalogService } from "@yugidraft/shared/services";
import type { CardSummary } from "@/lib/card-types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { setNames?: string[]; customCardIds?: number[] };
  const setNames = Array.isArray(body.setNames) ? body.setNames.filter((s): s is string => typeof s === "string") : [];
  const customCardIds = Array.isArray(body.customCardIds)
    ? body.customCardIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
    : [];

  const db = getDb();
  const drafts = createDraftService(db);
  const catalog = createCardCatalogService(db);

  const existingCustomCardIds = new Set(catalog.findByIds(customCardIds).map((card) => card.ygoprodeckId));
  const missingCustomCardIds = customCardIds.filter((id) => !existingCustomCardIds.has(id));

  if (missingCustomCardIds.length > 0) {
    await catalog.syncDraftPool({
      setNames: [],
      customCardIds: missingCustomCardIds,
      includeNames: [],
      excludeNames: [],
    });
  }

  const resolvedIds = drafts.resolvePoolCardIds({
    setNames,
    customCardIds,
  });

  const cards: CardSummary[] = catalog.findByIds([...new Set(resolvedIds)]).map((c) => ({
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
  }));

  const present = new Set(cards.map((c) => c.id));
  const unknownIds = customCardIds.filter((id) => !present.has(id));

  return NextResponse.json({ cards, unknownIds });
}
