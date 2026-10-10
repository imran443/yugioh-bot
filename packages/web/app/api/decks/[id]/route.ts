import { NextResponse } from "next/server";
import {
  checkSavedDeckMaster,
  loadDeckRegistrations,
  parseSavedDeckId,
  readSavedDeckBody,
  requireSavedDeckActor,
  savedDeckErrorResponse,
  withRegistration,
} from "@/lib/saved-decks";
import { getDb } from "@/lib/db";
import { normalizeDraftDeck } from "@/lib/draft-deck-codes";
import { findDraftDeckContext } from "../../drafts/draft-deck-pool";
import { checkDraftDeckWrite, readDraftId, registerDraftDeck } from "../draft-deck";

export const runtime = "nodejs";

async function ownedDeckContext(params: Promise<{ id: string }>) {
  const actor = await requireSavedDeckActor();
  if (!actor.ok) return actor;
  const { id: raw } = await params;
  const id = parseSavedDeckId(raw);
  if (id instanceof NextResponse) return { ok: false as const, response: id };
  return { ok: true as const, id, actor };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await ownedDeckContext(params);
  if (!ctx.ok) return ctx.response;
  try {
    const deck = ctx.actor.decks.get(ctx.id, ctx.actor.guildId, ctx.actor.ownerUserId);
    if (deck.draftId != null) {
      const found = findDraftDeckContext(getDb(), ctx.actor.guildId, ctx.actor.ownerUserId, { id: deck.draftId });
      if (!found.ok) return found.response;
      const mapped = await normalizeDraftDeck({ guildId: ctx.actor.guildId, playerId: found.draft.playerId, deck: deck.deck });
      // Reads stay available when the host cannot map ids; writes still require a valid mapping.
      if (mapped.ok) deck.deck = mapped.deck;
    }
    return NextResponse.json({ deck: withRegistration(deck, loadDeckRegistrations(ctx.actor.guildId, ctx.actor.ownerUserId)) });
  } catch (error) {
    return savedDeckErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await ownedDeckContext(params);
  if (!ctx.ok) return ctx.response;

  const bodyDraftId = await readDraftId(request);
  if (!bodyDraftId.ok) return bodyDraftId.response;
  const body = await readSavedDeckBody(request);
  if (!body.ok) return body.response;

  try {
    // A deck saved for a draft always keeps its pool check, with or without
    // draftId in the body.
    const stored = ctx.actor.decks.get(ctx.id, ctx.actor.guildId, ctx.actor.ownerUserId).draftId ?? null;
    if (stored !== null && bodyDraftId.draftId !== undefined && bodyDraftId.draftId !== stored) {
      return NextResponse.json({ error: "This deck belongs to another draft" }, { status: 400 });
    }
    const master = await checkSavedDeckMaster(body.mode, body.deck);
    if (!master.ok) return master.response;
    const draftId = stored ?? bodyDraftId.draftId;
    if (draftId !== undefined) {
      const checked = await checkDraftDeckWrite(ctx.actor.guildId, ctx.actor.ownerUserId, draftId, body.deck);
      if (!checked.ok) return checked.response;
      const deck = ctx.actor.decks.update(ctx.id, ctx.actor.guildId, ctx.actor.ownerUserId, {
        name: body.name,
        mode: body.mode,
        deck: checked.deck,
        draftId,
      });
      const warning = registerDraftDeck(checked.draft, deck);
      const shown = withRegistration(deck, loadDeckRegistrations(ctx.actor.guildId, ctx.actor.ownerUserId));
      return NextResponse.json(warning ? { deck: shown, warning } : { deck: shown });
    }
    const deck = ctx.actor.decks.update(ctx.id, ctx.actor.guildId, ctx.actor.ownerUserId, {
      name: body.name,
      mode: body.mode,
      deck: body.deck,
    });
    return NextResponse.json({ deck: withRegistration(deck, loadDeckRegistrations(ctx.actor.guildId, ctx.actor.ownerUserId)) });
  } catch (error) {
    return savedDeckErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await ownedDeckContext(params);
  if (!ctx.ok) return ctx.response;
  try {
    // Ownership first (404), so a guessed id tells nothing about other players' tournaments.
    ctx.actor.decks.get(ctx.id, ctx.actor.guildId, ctx.actor.ownerUserId);
    // The tournament keeps a copy of a registered deck, but the panel follows the saved deck id,
    // so deleting it would leave a deck that plays and is not shown. The player picks another
    // deck first.
    const tournament = getDb()
      .prepare(
        `select t.name from tournament_participants tp
         inner join tournaments t on t.id = tp.tournament_id
         where tp.saved_deck_id = ? and t.status not in ('completed', 'cancelled')
         order by t.id limit 1`,
      )
      .get(ctx.id) as { name: string } | undefined;
    if (tournament) {
      return NextResponse.json(
        { error: `This deck is registered for the tournament "${tournament.name}". Register another deck there before you delete it.` },
        { status: 409 },
      );
    }
    ctx.actor.decks.delete(ctx.id, ctx.actor.guildId, ctx.actor.ownerUserId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return savedDeckErrorResponse(error);
  }
}
