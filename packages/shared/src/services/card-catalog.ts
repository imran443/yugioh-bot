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
  includeNames: string[];
  excludeNames: string[];
};

const YGOPRODECK_API_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const YGOPRODECK_CARDSETS_URL = "https://db.ygoprodeck.com/api/v7/cardsets.php";
const EXTRA_DECK_FRAME_TYPES = new Set(["fusion", "synchro", "xyz", "link"]);

function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

function isExtraDeckCard(card: YgoprodeckCard) {
  return (
    EXTRA_DECK_FRAME_TYPES.has(card.frameType) ||
    card.type.includes("Fusion Monster") ||
    card.type.includes("Synchro Monster") ||
    card.type.includes("XYZ Monster") ||
    card.type.includes("Xyz Monster") ||
    card.type.includes("Link Monster")
  );
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
  };
}

export function createCardCatalogService(
  db: Database.Database,
  options: { fetch?: FetchLike } = {},
) {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const fetchCards = async (searchParam: "cardset" | "name", value: string) => {
    const url = new URL(YGOPRODECK_API_URL);
    url.searchParams.set(searchParam, value);

    const response = await fetchImpl(url);

    if (!response.ok) {
      throw new Error(`YGOPRODeck request failed for ${searchParam}=${value}`);
    }

    const payload = (await response.json()) as { data?: YgoprodeckCard[] };
    return payload.data ?? [];
  };

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
        cached_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        cached_at = excluded.cached_at
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
      const fetchedIncludes = await Promise.all(
        input.includeNames.map((cardName) => fetchCards("name", cardName)),
      );
      const excludedNames = new Set(input.excludeNames.map(normalizeName));
      const seenIds = new Set<number>();
      const cardsToCache: YgoprodeckCard[] = [];

      for (const card of [...fetchedSets.flat(), ...fetchedIncludes.flat()]) {
        if (seenIds.has(card.id) || excludedNames.has(normalizeName(card.name)) || isExtraDeckCard(card)) {
          continue;
        }

        seenIds.add(card.id);
        cardsToCache.push(card);
      }

      upsertCards(cardsToCache);

      return findByIds(cardsToCache.map((card) => card.id));
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
