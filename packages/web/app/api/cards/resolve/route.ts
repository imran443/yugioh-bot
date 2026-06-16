import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createDraftService, createCardCatalogService } from "@yugidraft/shared/services";
import type { CardSummary } from "@/lib/card-types";

export const runtime = "nodejs";

function toCardSummary(c: {
  ygoprodeckId: number;
  name: string;
  type: string;
  frameType: string;
  attribute?: string;
  level?: number;
  effectText: string;
  atk?: number;
  def?: number;
  imageUrl: string;
  imageUrlSmall: string;
}): CardSummary {
  return {
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
  };
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    setNames?: string[];
    customCardIds?: number[];
    cardName?: string;
    fuzzyName?: string;
  };
  const setNames = Array.isArray(body.setNames) ? body.setNames.filter((s): s is string => typeof s === "string") : [];
  const customCardIds = Array.isArray(body.customCardIds)
    ? body.customCardIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
    : [];
  const cardName = typeof body.cardName === "string" ? body.cardName.trim() : "";
  const fuzzyName = typeof body.fuzzyName === "string" ? body.fuzzyName.trim() : "";

  const db = getDb();
  const drafts = createDraftService(db);
  const catalog = createCardCatalogService(db);

  if (cardName) {
    const card = await catalog.syncCardByName(cardName);
    if (!card) {
      return NextResponse.json({ error: `No card found for "${cardName}".` }, { status: 404 });
    }

    return NextResponse.json({ cards: [toCardSummary(card)], unknownIds: [] });
  }

  if (fuzzyName) {
    const cards = await catalog.syncCardsByFuzzyName(fuzzyName);
    return NextResponse.json({ cards: cards.map(toCardSummary), unknownIds: [] });
  }

  await catalog.syncDraftPool({
    setNames,
    customCardIds,
    includeNames: [],
    excludeNames: [],
  });

  const resolvedIds = drafts.resolvePoolCardIds({
    setNames,
    customCardIds,
  });

  const cards: CardSummary[] = catalog.findByIds([...new Set(resolvedIds)]).map(toCardSummary);

  const present = new Set(cards.map((c) => c.id));
  const unknownIds = customCardIds.filter((id) => !present.has(id));

  return NextResponse.json({ cards, unknownIds });
}
