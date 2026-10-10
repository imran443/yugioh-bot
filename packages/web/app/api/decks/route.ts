import { NextResponse } from "next/server";
import type { SavedDeck } from "@yugidraft/shared/duels";
import { SavedDeckServiceError } from "@yugidraft/shared/services";
import {
  checkSavedDeckMaster,
  loadDeckRegistrations,
  readSavedDeckBody,
  requireSavedDeckActor,
  savedDeckErrorResponse,
  withRegistration,
} from "@/lib/saved-decks";
import { backfillDraftDecks } from "@/lib/draft-decks";
import { checkDraftDeckWrite, readDraftId, registerDraftDeck } from "./draft-deck";

export const runtime = "nodejs";

export async function GET() {
  const actor = await requireSavedDeckActor();
  if (!actor.ok) return actor.response;
  try {
    // Draft decks are saved when a draft ends; this saves any a finished draft is missing.
    backfillDraftDecks(actor.guildId, actor.ownerUserId);
    const registrations = loadDeckRegistrations(actor.guildId, actor.ownerUserId);
    return NextResponse.json({
      decks: actor.decks.list(actor.guildId, actor.ownerUserId).map((deck) => withRegistration(deck, registrations)),
    });
  } catch (error) {
    return savedDeckErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const actor = await requireSavedDeckActor();
  if (!actor.ok) return actor.response;

  const draftId = await readDraftId(request);
  if (!draftId.ok) return draftId.response;
  const body = await readSavedDeckBody(request);
  if (!body.ok) return body.response;

  try {
    const master = await checkSavedDeckMaster(body.mode, body.deck);
    if (!master.ok) return master.response;
    if (draftId.draftId !== undefined) {
      // One deck per draft: the client switches to PUT with the id we return.
      const existing = actor.decks.findByDraft(actor.guildId, actor.ownerUserId, draftId.draftId);
      if (existing) {
        return NextResponse.json(
          { error: "You already have a deck for this draft", deckId: existing.id },
          { status: 409 },
        );
      }
      const checked = await checkDraftDeckWrite(actor.guildId, actor.ownerUserId, draftId.draftId, body.deck);
      if (!checked.ok) return checked.response;
      let deck: SavedDeck;
      try {
        deck = actor.decks.create(actor.guildId, actor.ownerUserId, {
          name: body.name,
          mode: body.mode,
          deck: checked.deck,
          draftId: draftId.draftId,
        });
      } catch (error) {
        // A second request (a double click) saved the draft deck after the lookup above;
        // the unique index refused this insert. Hand back its id so the client updates it.
        if (error instanceof SavedDeckServiceError && error.status === 409) {
          const winner = actor.decks.findByDraft(actor.guildId, actor.ownerUserId, draftId.draftId);
          if (winner) return NextResponse.json({ error: error.message, deckId: winner.id }, { status: 409 });
        }
        throw error;
      }
      const warning = registerDraftDeck(checked.draft, deck);
      const shown = withRegistration(deck, loadDeckRegistrations(actor.guildId, actor.ownerUserId));
      return NextResponse.json(warning ? { deck: shown, warning } : { deck: shown }, { status: 201 });
    }
    const deck = actor.decks.create(actor.guildId, actor.ownerUserId, {
      name: body.name,
      mode: body.mode,
      deck: body.deck,
    });
    return NextResponse.json({ deck: withRegistration(deck, []) }, { status: 201 });
  } catch (error) {
    return savedDeckErrorResponse(error);
  }
}
