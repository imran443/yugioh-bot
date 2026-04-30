import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: globalThis.RequestInit,
) => Promise<Pick<Response, "ok" | "arrayBuffer">>;

export type DraftImageCard = {
  ygoprodeckId: number;
  imageUrl: string;
  imageUrlSmall?: string;
};

const COLUMNS = 4;
const ROWS = 2;
const CARD_WIDTH = 100;
const CARD_HEIGHT = 145;

function createNumberOverlay(number: number) {
  return Buffer.from(`
    <svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
      <rect x="6" y="6" width="26" height="26" rx="13" fill="rgba(0, 0, 0, 0.72)" />
      <text
        x="19"
        y="25"
        text-anchor="middle"
        font-family="Arial, sans-serif"
        font-size="16"
        font-weight="700"
        fill="#ffffff"
      >${number}</text>
    </svg>
  `);
}

export function createDraftImageService({
  cacheDir,
  fetch = globalThis.fetch,
}: {
  cacheDir: string;
  fetch?: FetchLike;
}) {
  const fetchImpl = fetch;

  const getCachedImage = async (card: DraftImageCard) => {
    await mkdir(cacheDir, { recursive: true });

    const cachePath = join(cacheDir, `${card.ygoprodeckId}.png`);

    try {
      return await readFile(cachePath);
    } catch {
      const response = await fetchImpl(card.imageUrlSmall ?? card.imageUrl);

      if (!response.ok) {
        throw new Error(`Card image request failed for ${card.ygoprodeckId}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const normalized = await sharp(buffer).resize(CARD_WIDTH, CARD_HEIGHT).png().toBuffer();
      await writeFile(cachePath, normalized);
      return normalized;
    }
  };

  return {
    async renderNumberedGrid(cards: DraftImageCard[]) {
      if (cards.length !== COLUMNS * ROWS) {
        throw new Error("Draft image grid requires exactly 8 cards");
      }

      const composites = await Promise.all(
        cards.flatMap(async (card, index) => {
          const left = (index % COLUMNS) * CARD_WIDTH;
          const top = Math.floor(index / COLUMNS) * CARD_HEIGHT;
          const image = await getCachedImage(card);

          return [
            { input: image, left, top },
            { input: createNumberOverlay(index + 1), left, top },
          ];
        }),
      );

      const buffer = await sharp({
        create: {
          width: COLUMNS * CARD_WIDTH,
          height: ROWS * CARD_HEIGHT,
          channels: 4,
          background: "#000000",
        },
      })
        .composite(composites.flat())
        .png()
        .toBuffer();

      return {
        filename: "draft-picks.png",
        buffer,
      };
    },
  };
}

export type DraftImageService = ReturnType<typeof createDraftImageService>;
