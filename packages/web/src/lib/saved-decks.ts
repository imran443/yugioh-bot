import { NextResponse } from "next/server";
import type { SavedDeck } from "@yugidraft/shared/duels";
import {
  createPlayerService,
  createSavedDeckService,
  createTournamentRegistrationService,
  deckRegistrationMark,
  SavedDeckServiceError,
  type DeckRegistration,
  type DeckRegistrationMark,
  type SavedDeckService,
} from "@yugidraft/shared/services";
import { requireWebAccess } from "@/lib/web-access";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { callDuelHost, requireDuelActor } from "@/lib/duel-host";

export type SavedDeckActor =
  | { ok: true; guildId: string; ownerUserId: number; discordUserId: string | null; decks: SavedDeckService }
  | { ok: false; response: NextResponse };

export async function requireSavedDeckActor(): Promise<SavedDeckActor> {
  const actor = await requireWebAccess();
  if (!actor.ok) return actor;
  const guildId = env.discordGuildId;
  if (!guildId) {
    return { ok: false, response: NextResponse.json({ error: "Guild is not configured" }, { status: 500 }) };
  }
  return {
    ok: true,
    guildId,
    ownerUserId: actor.userId,
    discordUserId: actor.discordUserId,
    decks: createSavedDeckService(getDb()),
  };
}

export function parseSavedDeckId(raw: string): number | NextResponse {
  if (!/^\d+$/.test(raw)) {
    return NextResponse.json({ error: "Invalid deck id" }, { status: 400 });
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid deck id" }, { status: 400 });
  }
  return id;
}

export async function readSavedDeckBody(
  request: Request,
): Promise<{ ok: true; name: unknown; mode: unknown; deck: unknown } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: NextResponse.json({ error: "Expected a deck object" }, { status: 400 }) };
  }
  const record = body as { name?: unknown; mode?: unknown; deck?: unknown };
  return { ok: true, name: record.name, mode: record.mode, deck: record.deck };
}

/** Library and import writes share this check; reads never validate or change old decks. */
export async function checkSavedDeckMaster(mode: unknown, deck: unknown): Promise<
  { ok: true } | { ok: false; response: NextResponse }
> {
  if (mode !== "domain" || !deck || typeof deck !== "object" || Array.isArray(deck)) return { ok: true };
  const code = (deck as { deckMaster?: unknown }).deckMaster;
  // The saved-deck service reports shape errors and permits unfinished decks.
  if (code === undefined || typeof code !== "number" || !Number.isInteger(code) || code < 1 || code > 0xffff_ffff) return { ok: true };
  const actor = await requireDuelActor();
  if (!actor.ok) return actor;
  const result = await callDuelHost({
    op: "validate-deck-master", guildId: actor.guildId, playerId: actor.playerId, mode: "domain",
    deck: { main: [], extra: [], side: [], deckMaster: code },
  });
  if (!result.ok) return result;
  if ((result.data as { ok?: unknown } | null)?.ok !== true) {
    return { ok: false, response: NextResponse.json({ error: "Invalid engine response" }, { status: 502 }) };
  }
  return { ok: true };
}

export function savedDeckErrorResponse(error: unknown) {
  if (error instanceof SavedDeckServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[api/decks]", error);
  return NextResponse.json({ error: "Failed to process deck request" }, { status: 500 });
}

/** A saved deck as the decks API returns it: the stored deck plus the tournament it is registered for, if any. */
export type SavedDeckWithRegistration = SavedDeck & { registration: DeckRegistrationMark | null };

/** The player's registered decks for pending and active tournaments (empty when they have no player row yet). */
export function loadDeckRegistrations(guildId: string, ownerUserId: number): DeckRegistration[] {
  const db = getDb();
  const player = createPlayerService(db).findByGuildAndUser(guildId, ownerUserId);
  return player ? createTournamentRegistrationService(db).deckRegistrations(player.id, guildId) : [];
}

export function withRegistration(deck: SavedDeck, registrations: readonly DeckRegistration[]): SavedDeckWithRegistration {
  return { ...deck, registration: deckRegistrationMark(registrations, { savedDeckId: deck.id }) };
}
