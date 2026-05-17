import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createDraftService, createCardCatalogService } from "@yugidraft/shared/services";
import { toCardCounts } from "@/lib/custom-card-pool";
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

  const resolvedIds = drafts.resolvePoolCardIds({
    setNames,
    customCardIds,
  });
  // resolvedIds is the materialized-cube multiset (baseline + additive custom).
  // Collapse to one entry per distinct card but keep the copy count as qty so
  // the preview shows the true number of copies the draft will use.
  const counts = toCardCounts(resolvedIds);

  const cards: CardSummary[] = catalog.findByIds([...counts.keys()]).map((c) => ({
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
    qty: counts.get(c.ygoprodeckId) ?? 1,
  }));

  const present = new Set(cards.map((c) => c.id));
  const unknownIds = customCardIds.filter((id) => !present.has(id));

  return NextResponse.json({ cards, unknownIds });
}
