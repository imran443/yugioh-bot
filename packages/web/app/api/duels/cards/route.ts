import { cardAdmissionContext, type CardAdmissionContext } from "@/lib/card-admission-context";
import { NextRequest, NextResponse } from "next/server";
import { createCardCatalogService } from "@yugidraft/shared/services";
import type { DeckCardInfo, DuelCardInfo } from "@yugidraft/shared/duels";
import { getDb } from "@/lib/db";
import { readDuelControl, callDuelHost, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";

export const runtime = "nodejs";

let catalog: ReturnType<typeof createCardCatalogService> | undefined;
function cardCatalog() {
  // Artwork identity comes from the host; catalog lookups only read cached rows.
  return catalog ??= createCardCatalogService(getDb(), { identityCatalog: new Map() });
}

function hasName(code: number, name: string | undefined) {
  return !!name?.trim() && name.trim() !== `Card ${code}`;
}

function withCatalogCardText<T extends DuelCardInfo>(cards: T[]): T[] {
  const incomplete = cards.filter(card => !hasName(card.code, card.name) || !card.description?.trim());
  if (!incomplete.length) return cards;
  const ids = [...new Set(incomplete.flatMap(card => [card.code, card.canonicalPasscode ?? card.code]))];
  const cachedCards = new Map(cardCatalog().findByIds(ids).map(card => [card.ygoprodeckId, card]));
  return cards.map(card => {
    const cached = cachedCards.get(card.code) ?? cachedCards.get(card.canonicalPasscode ?? card.code);
    return {
      ...card,
      name: !hasName(card.code, card.name) && cached && hasName(cached.ygoprodeckId, cached.name) ? cached.name : card.name,
      description: !card.description?.trim() && cached?.effectText?.trim() ? cached.effectText : card.description,
    };
  });
}

export async function GET(request: NextRequest) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;

  const query = request.nextUrl.searchParams.get("q") ?? "";
  const slug = request.nextUrl.searchParams.get("slug") ?? undefined;
  let fork = false;
  let control: ReturnType<typeof readDuelControl>;
  try {
    const room = slug ? actor.duels.room(slug, actor.guildId, actor.playerId) : undefined;
    control = readDuelControl(request, room, "cards");
    fork = room?.session.kind === "replay-fork";
  }
  catch (error) { return duelErrorResponse(error); }
  const result = await callDuelHost({
    op: "cards",
    slug,
    guildId: actor.guildId,
    playerId: actor.playerId, ...(actor.userId !== undefined ? { userId: actor.userId } : {}), ...control,
    query,
  });
  if (!result.ok) return result.response;
  if (fork && slug) {
    try { actor.duels.room(slug, actor.guildId, actor.playerId); }
    catch (error) { return duelErrorResponse(error); }
  }
  const data = result.data as { cards: DuelCardInfo[] };
  return NextResponse.json({ ...data, cards: withCatalogCardText(data.cards) }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  let body: unknown;
  let context: CardAdmissionContext;
  try {
    body = await request.json();
    context = cardAdmissionContext(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const codes = body && typeof body === "object" && "codes" in body ? body.codes : null;
  if (!Array.isArray(codes) || codes.length > 1000
    || codes.some((code) => !Number.isSafeInteger(code) || code <= 0 || code > 0xffffffff)) {
    return NextResponse.json({ error: "Provide at most 1000 positive card passcodes" }, { status: 400 });
  }
  const ids = [...new Set<number>(codes)];
  const result = await callDuelHost({
    op: "card-details",
    guildId: actor.guildId,
    playerId: actor.playerId,
    codes: ids, ...context,
  });
  if (!result.ok) return result.response;
  const data = result.data as { cards: DeckCardInfo[]; missing: number[] };
  return NextResponse.json({ ...data, cards: withCatalogCardText(data.cards) });
}
