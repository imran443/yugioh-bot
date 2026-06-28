import type Database from "better-sqlite3";
import type { Card } from "../types/index.js";

type CardSet = {
  set_name: string;
};

type YgoprodeckSetInfo = {
  set_name: string;
  set_code: string;
  num_of_cards: number;
};

type YgoprodeckCard = {
  id: number;
  name: string;
  type: string;
  frameType: string;
  desc?: string;
  atk?: number;
  def?: number;
  attribute?: string;
  level?: number;
  archetype?: string;
  card_images: Array<{
    image_url: string;
    image_url_small: string;
  }>;
  card_sets?: CardSet[];
};

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: globalThis.RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

export type CardCatalogCard = Card;

export type SyncDraftPoolInput = {
  setNames: string[];
  customCardIds?: number[];
  includeNames: string[];
  excludeNames: string[];
};

const YGOPRODECK_API_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const YGOPRODECK_CARDSETS_URL = "https://db.ygoprodeck.com/api/v7/cardsets.php";
const YGOPRODECK_ARCHETYPES_URL = "https://db.ygoprodeck.com/api/v7/archetypes.php";
const EXTRA_DECK_FRAME_TYPES = new Set(["fusion", "synchro", "xyz", "link"]);

function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

export function isExtraDeckFrame(card: { frameType: string; type: string }) {
  return (
    EXTRA_DECK_FRAME_TYPES.has(card.frameType) ||
    card.type.includes("Fusion Monster") ||
    card.type.includes("Synchro Monster") ||
    card.type.includes("XYZ Monster") ||
    card.type.includes("Xyz Monster") ||
    card.type.includes("Link Monster")
  );
}

function isExtraDeckCard(card: YgoprodeckCard) {
  return isExtraDeckFrame(card);
}

function mapCard(row: any): CardCatalogCard {
  return {
    ygoprodeckId: row.ygoprodeck_id,
    name: row.name,
    type: row.type,
    frameType: row.frame_type,
    effectText: row.effect_text ?? "",
    atk: row.atk ?? undefined,
    def: row.def ?? undefined,
    attribute: row.attribute ?? undefined,
    level: row.level ?? undefined,
    imageUrl: row.image_url,
    imageUrlSmall: row.image_url_small,
    cardSets: JSON.parse(row.card_sets_json),
    cachedAt: row.cached_at,
    archetype: row.archetype ?? undefined,
  };
}

export function createCardCatalogService(
  db: Database.Database,
  options: { fetch?: FetchLike } = {},
) {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const fetchCardsWith = async (params: Record<string, string>) => {
    const url = new URL(YGOPRODECK_API_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetchImpl(url);

    if (!response.ok) {
      throw new Error(`YGOPRODeck request failed for ${new URLSearchParams(params).toString()}`);
    }

    const payload = (await response.json()) as { data?: YgoprodeckCard[] };
    return payload.data ?? [];
  };

  const fetchCards = (searchParam: "cardset" | "id" | "name" | "fname", value: string) =>
    fetchCardsWith({ [searchParam]: value });

  const upsertCard = db.prepare(
    `
      insert into card_catalog (
        ygoprodeck_id,
        name,
        type,
        frame_type,
        effect_text,
        atk,
        def,
        attribute,
        level,
        image_url,
        image_url_small,
        card_sets_json,
        cached_at,
        archetype
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(ygoprodeck_id) do update set
        name = excluded.name,
        type = excluded.type,
        frame_type = excluded.frame_type,
        effect_text = excluded.effect_text,
        atk = excluded.atk,
        def = excluded.def,
        attribute = excluded.attribute,
        level = excluded.level,
        image_url = excluded.image_url,
        image_url_small = excluded.image_url_small,
        card_sets_json = excluded.card_sets_json,
        cached_at = excluded.cached_at,
        archetype = excluded.archetype
    `,
  );

  const upsertCards = db.transaction((cards: YgoprodeckCard[]) => {
    const cachedAt = new Date().toISOString();

    for (const card of cards) {
      const [image] = card.card_images;

      if (!image) {
        continue;
      }

      upsertCard.run(
        card.id,
        card.name,
        card.type,
        card.frameType,
        card.desc ?? "",
        card.atk ?? null,
        card.def ?? null,
        card.attribute ?? null,
        card.level ?? null,
        image.image_url,
        image.image_url_small,
        JSON.stringify(card.card_sets ?? []),
        cachedAt,
        card.archetype ?? null,
      );
    }
  });

  const findByIds = (ids: number[]): CardCatalogCard[] => {
    if (ids.length === 0) {
      return [];
    }

    const rows = db
      .prepare(
        `
          select * from card_catalog
          where ygoprodeck_id in (${ids.map(() => "?").join(", ")})
        `,
      )
      .all(...ids);
    const cardsById = new Map(rows.map((row: any) => [row.ygoprodeck_id, mapCard(row)]));

    return ids.map((id) => cardsById.get(id)).filter((card): card is CardCatalogCard => card !== undefined);
  };

  return {
    async syncDraftPool(input: SyncDraftPoolInput) {
      const fetchedSets = await Promise.all(input.setNames.map((setName) => fetchCards("cardset", setName)));
      const fetchedCustomCards = await Promise.all(
        (input.customCardIds ?? []).map((cardId) => fetchCards("id", String(cardId))),
      );
      const fetchedIncludes = await Promise.all(
        input.includeNames.map((cardName) => fetchCards("name", cardName)),
      );
      const excludedNames = new Set(input.excludeNames.map(normalizeName));
      const seenIds = new Set<number>();
      const cardsToCache: YgoprodeckCard[] = [];

      for (const card of [...fetchedSets.flat(), ...fetchedCustomCards.flat(), ...fetchedIncludes.flat()]) {
        if (seenIds.has(card.id) || excludedNames.has(normalizeName(card.name)) || isExtraDeckCard(card)) {
          continue;
        }

        seenIds.add(card.id);
        cardsToCache.push(card);
      }

      upsertCards(cardsToCache);

      return findByIds(cardsToCache.map((card) => card.id));
    },

    async syncByArchetype(
      archetype: string,
      opts: { banlist?: string } = {},
    ): Promise<{ main: CardCatalogCard[]; extra: CardCatalogCard[] }> {
      const params: Record<string, string> = { archetype };
      if (opts.banlist) {
        params.banlist = opts.banlist;
      }

      const cards = await fetchCardsWith(params);
      upsertCards(cards);

      const cached = findByIds(cards.map((card) => card.id));
      const extraIds = new Set(cards.filter(isExtraDeckCard).map((card) => card.id));

      return {
        main: cached.filter((card) => !extraIds.has(card.ygoprodeckId)),
        extra: cached.filter((card) => extraIds.has(card.ygoprodeckId)),
      };
    },

    async syncStaples(opts: { banlist?: string } = {}): Promise<CardCatalogCard[]> {
      const params: Record<string, string> = { staple: "yes" };
      if (opts.banlist) {
        params.banlist = opts.banlist;
      }

      const cards = await fetchCardsWith(params);
      const mainOnly = cards.filter((card) => !isExtraDeckCard(card));
      upsertCards(mainOnly);
      return findByIds(mainOnly.map((card) => card.id));
    },

    async syncGenericExtra(
      opts: { banlist?: string; types?: ("xyz" | "synchro" | "link")[] } = {},
    ): Promise<CardCatalogCard[]> {
      const types = opts.types ?? ["xyz", "synchro", "link"];
      const typeParam: Record<"xyz" | "synchro" | "link", string> = {
        xyz: "XYZ Monster",
        synchro: "Synchro Monster",
        link: "Link Monster",
      };

      const orderedIds: number[] = [];
      const seen = new Set<number>();
      for (const type of types) {
        const params: Record<string, string> = { type: typeParam[type] };
        if (opts.banlist) {
          params.banlist = opts.banlist;
        }
        const cards = await fetchCardsWith(params);
        const extraOnly = cards.filter(isExtraDeckCard);
        upsertCards(extraOnly);
        for (const card of extraOnly) {
          if (!seen.has(card.id)) {
            seen.add(card.id);
            orderedIds.push(card.id);
          }
        }
      }

      // findByIds preserves the requested id order, keeping XYZ (first type) first.
      return findByIds(orderedIds);
    },

    async syncCardById(id: number): Promise<CardCatalogCard | undefined> {
      const [card] = await fetchCards("id", String(id));
      if (!card) {
        return undefined;
      }
      // Keep Extra Deck cards — themes need them for the extra pool.
      upsertCards([card]);
      return findByIds([card.id])[0];
    },

    async syncCardByName(name: string) {
      const [card] = await fetchCards("name", name);
      if (!card || isExtraDeckCard(card)) {
        return undefined;
      }

      upsertCards([card]);
      return findByIds([card.id])[0];
    },

    async syncCardsByFuzzyName(name: string) {
      const cards = await fetchCards("fname", name);
      const nonExtra = cards.filter((card) => !isExtraDeckCard(card));
      upsertCards(nonExtra);
      return findByIds(nonExtra.map((card) => card.id));
    },

    listSets(query?: string): Array<{ setName: string; setCode: string; cardCount: number }> {
      const hasQuery = query && query.trim().length > 0;

      const sql = hasQuery
        ? `select set_name, set_code, card_count from card_sets where lower(set_name) like lower(?) order by set_name limit 25`
        : `select set_name, set_code, card_count from card_sets order by set_name limit 25`;

      const rows = hasQuery ? db.prepare(sql).all(`%${query.trim()}%`) : db.prepare(sql).all();

      return (rows as Array<{ set_name: string; set_code: string; card_count: number }>).map((row) => ({
        setName: row.set_name,
        setCode: row.set_code ?? "",
        cardCount: row.card_count ?? 0,
      }));
    },

    async syncSets(): Promise<string[]> {
      const response = await fetchImpl(YGOPRODECK_CARDSETS_URL);

      if (!response.ok) {
        throw new Error("YGOPRODeck cardsets request failed");
      }

      const payload = (await response.json()) as YgoprodeckSetInfo[];
      const syncedAt = new Date().toISOString();

      const insert = db.prepare(
        `insert or replace into card_sets (set_name, set_code, card_count, synced_at) values (?, ?, ?, ?)`
      );

      db.transaction(() => {
        for (const set of payload) {
          insert.run(set.set_name, set.set_code, set.num_of_cards, syncedAt);
        }
      })();

      return payload.map((s) => s.set_name);
    },

    async listArchetypes(query?: string): Promise<string[]> {
      const cachedCount = (
        db.prepare("select count(*) as n from archetypes").get() as { n: number }
      ).n;

      if (cachedCount === 0) {
        const response = await fetchImpl(YGOPRODECK_ARCHETYPES_URL);
        if (!response.ok) {
          throw new Error("YGOPRODeck archetypes request failed");
        }
        const payload = (await response.json()) as Array<{ archetype_name: string }>;
        const syncedAt = new Date().toISOString();
        const insert = db.prepare(
          "insert or replace into archetypes (name, synced_at) values (?, ?)",
        );
        db.transaction(() => {
          for (const { archetype_name } of payload) {
            insert.run(archetype_name, syncedAt);
          }
        })();
      }

      const hasQuery = query && query.trim().length > 0;
      const rows = hasQuery
        ? db
            .prepare("select name from archetypes where lower(name) like lower(?) order by name")
            .all(`%${query.trim()}%`)
        : db.prepare("select name from archetypes order by name").all();

      return (rows as Array<{ name: string }>).map((row) => row.name);
    },

    findByIds,

    async getSetPreview(setName: string): Promise<{ name: string; cardCount: number; cached: boolean; sampleCards: CardCatalogCard[] }> {
      const setRow = db.prepare("select card_count from card_sets where set_name = ?").get(setName) as { card_count: number } | undefined;

      const sampleRows = db.prepare(`
        select * from card_catalog
        where ygoprodeck_id in (
          select cc.ygoprodeck_id
          from card_catalog cc, json_each(cc.card_sets_json) as je
          where je.value->>'set_name' = ?
          limit 6
        )
      `).all(setName) as any[];

      if (sampleRows.length > 0 && setRow?.card_count) {
        return {
          name: setName,
          cardCount: setRow.card_count,
          cached: true,
          sampleCards: sampleRows.map(mapCard),
        };
      }

      const fetched = await fetchCards("cardset", setName);
      if (fetched.length === 0) {
        return { name: setName, cardCount: 0, cached: false, sampleCards: [] };
      }

      const nonExtraDeck = fetched.filter((c) => !isExtraDeckCard(c));
      const toCache = nonExtraDeck.length > 0 ? nonExtraDeck : fetched;
      upsertCards(toCache);

      const sample = toCache.slice(0, 6).map((c) => {
        const [image] = c.card_images;
        return {
          ygoprodeckId: c.id,
          name: c.name,
          type: c.type,
          frameType: c.frameType,
          effectText: c.desc ?? "",
          atk: c.atk,
          def: c.def,
          attribute: c.attribute,
          level: c.level,
          imageUrl: image?.image_url ?? "",
          imageUrlSmall: image?.image_url_small ?? "",
          cardSets: (c.card_sets ?? []).map((cs: any) => cs.set_name ?? cs),
          cachedAt: new Date().toISOString(),
        } as CardCatalogCard;
      });

      return {
        name: setName,
        cardCount: fetched.length,
        cached: false,
        sampleCards: sample,
      };
    },
  };
}

export type CardCatalogService = ReturnType<typeof createCardCatalogService>;
