import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCardCatalogService } from "@yugidraft/shared/services";

type SnapshotCard = {
  ygoprodeckId: number;
  name: string;
  type: string;
  frameType: string;
  effectText: string;
  atk?: number;
  def?: number;
  attribute?: string;
  level?: number;
  imageUrl: string;
  imageUrlSmall: string;
  cardSets: Array<{ set_name: string }>;
};

const sourceSets = [
  "Legend of Blue Eyes White Dragon",
  "Metal Raiders",
  "Spell Ruler",
];

const outputPath = join(process.cwd(), "scripts", "data", "draft-catalog-legendary.json");

async function main() {
  const db = new Database(":memory:");

  db.exec(`
    create table if not exists card_catalog (
      ygoprodeck_id integer primary key not null,
      name text not null,
      type text not null,
      frame_type text not null,
      effect_text text,
      atk integer,
      def integer,
      attribute text,
      level integer,
      image_url text not null,
      image_url_small text not null,
      card_sets_json text not null,
      cached_at text not null
    );
  `);

  const catalog = createCardCatalogService(db);
  const cards = await catalog.syncDraftPool({
    setNames: sourceSets,
    includeNames: [],
    excludeNames: [],
  });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    sourceSets,
    cards: cards
      .map<SnapshotCard>((card) => ({
        ygoprodeckId: card.ygoprodeckId,
        name: card.name,
        type: card.type,
        frameType: card.frameType,
        effectText: card.effectText,
        atk: card.atk,
        def: card.def,
        attribute: card.attribute,
        level: card.level,
        imageUrl: card.imageUrl,
        imageUrlSmall: card.imageUrlSmall,
        cardSets: card.cardSets,
      }))
      .sort((a, b) => a.ygoprodeckId - b.ygoprodeckId),
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`Wrote ${snapshot.cards.length} cards to ${outputPath}`);
}

void main();
