import type Database from "better-sqlite3";

type CardSet = {
  set_name: string;
};

type YgoprodeckCard = {
  id: number;
  name: string;
  type: string;
  frameType: string;
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

export type CardCatalogCard = {
  ygoprodeckId: number;
  name: string;
  type: string;
  frameType: string;
  imageUrl: string;
  imageUrlSmall: string;
  cardSets: CardSet[];
  cachedAt: string;
};

export type SyncDraftPoolInput = {
  setNames: string[];
  includeNames: string[];
  excludeNames: string[];
};

const YGOPRODECK_API_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
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
        image_url,
        image_url_small,
        card_sets_json,
        cached_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(ygoprodeck_id) do update set
        name = excluded.name,
        type = excluded.type,
        frame_type = excluded.frame_type,
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

    findByIds,
  };
}
