import type { ThemePools } from "@yugidraft/shared/types";
import type { CardCatalogService, ThemesService } from "@yugidraft/shared/services";
import type { CardSummary } from "@/lib/card-types";

/**
 * Build the editor-facing payload for a theme: its split pools plus resolved
 * catalog card details (CardSummary) for every card id in either pool.
 */
export function buildThemeCards(
  pools: ThemePools,
  catalog: CardCatalogService,
): CardSummary[] {
  const ids = [...pools.main, ...pools.extra].map((c) => c.catalogCardId);
  return catalog.findByIds(ids).map((c) => ({
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
  }));
}

export function themeDetail(themeId: number, themes: ThemesService, catalog: CardCatalogService) {
  const pools = themes.getThemePools(themeId);
  return { pools, cards: buildThemeCards(pools, catalog) };
}
