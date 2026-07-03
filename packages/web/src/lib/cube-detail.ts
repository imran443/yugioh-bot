import type { CubePools } from "@yugidraft/shared/types";
import type { CardCatalogService, CubeService } from "@yugidraft/shared/services";
import type { CardSummary } from "@/lib/card-types";

/**
 * Build the editor-facing payload for a cube: its split pools plus resolved
 * catalog card details (CardSummary) for every card id in either pool.
 */
export function buildCubeCards(
  pools: CubePools,
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

export function cubeDetail(cubeId: number, cubes: CubeService, catalog: CardCatalogService) {
  const pools = cubes.getCubePools(cubeId);
  return { pools, cards: buildCubeCards(pools, catalog) };
}
