import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { CARD_BACK_SVG, CardFetchError, fetchCardImageResource, trustedCardImageUrl } from "./card-fetch.js";

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: globalThis.RequestInit,
) => Promise<Pick<Response, "ok" | "arrayBuffer"> & Partial<Pick<Response, "status" | "headers" | "body">>>;

export type DraftImageCard = {
  ygoprodeckId: number;
  imageUrl: string;
  imageUrlSmall?: string;
};

export type DraftImageCardWithLabel = DraftImageCard & {
  label: string;
};

const COLUMNS = 4;
const ROWS = 2;
const CARD_WIDTH = 100;
const CARD_HEIGHT = 145;

const CARD_FULL_WIDTH = 240;
const CARD_FULL_HEIGHT = 350;
const MAX_CARD_IMAGE_BYTES = 5 * 1024 * 1024;

export class CardImageValidationError extends Error {}

/** Decode the complete image before keeping upstream bytes in a durable cache. */
export async function validateCardImage(buffer: Buffer): Promise<Buffer> {
  if (buffer.length > MAX_CARD_IMAGE_BYTES) throw new CardImageValidationError("Card image exceeds 5 MiB");
  try {
    const jpeg = buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const webp = buffer.subarray(0, 4).equals(Buffer.from("RIFF")) && buffer.subarray(8, 12).equals(Buffer.from("WEBP"));
    if (!jpeg && !png && !webp) throw new Error("Unsupported card image format");
    const image = sharp(buffer);
    const { format } = await image.metadata();
    if (format !== "jpeg" && format !== "png" && format !== "webp") throw new Error("Unsupported card image format");
    await image.stats();
  } catch (cause) {
    throw new CardImageValidationError("Invalid card image", { cause });
  }
  return buffer;
}

/** Bound the download even when Content-Length is absent or understates the body. */
export async function readCardImageResponse(
  response: Pick<Response, "arrayBuffer"> & Partial<Pick<Response, "headers" | "body">>,
): Promise<Buffer> {
  if (Number(response.headers?.get("Content-Length")) > MAX_CARD_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new CardImageValidationError("Card image exceeds 5 MiB");
  }
  // Custom fetch adapters may only expose arrayBuffer; real HTTP responses stream.
  if (!response.body) return validateCardImage(Buffer.from(await response.arrayBuffer()));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CARD_IMAGE_BYTES) throw new CardImageValidationError("Card image exceeds 5 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return validateCardImage(Buffer.concat(chunks, length));
}

function createNumberOverlay(number: number, width: number, height: number) {
  return Buffer.from(`
    <svg width="${width}" height="${height}">
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

  const getImage = async (card: DraftImageCard, full: boolean) => {
    const cachePath = join(cacheDir, `${card.ygoprodeckId}${full ? "-full" : ""}.png`);
    try { return await readFile(cachePath); } catch { /* Fetch only a missing image. */ }
    const width = full ? CARD_FULL_WIDTH : CARD_WIDTH;
    const height = full ? CARD_FULL_HEIGHT : CARD_HEIGHT;
    try {
      const fallback = `https://images.ygoprodeck.com/images/${full ? "cards" : "cards_small"}/${card.ygoprodeckId}.jpg`;
      const url = trustedCardImageUrl(full ? card.imageUrl : card.imageUrlSmall ?? card.imageUrl, fallback);
      const { image: buffer, fallbackError } = await fetchCardImageResource(url, card.ygoprodeckId, fetchImpl, readCardImageResponse);
      if (!buffer) throw fallbackError ?? new CardFetchError(1, 404);
      const normalized = await sharp(buffer).resize(width, height, { fit: "cover", position: "center" }).png().toBuffer();
      try { await mkdir(cacheDir, { recursive: true }); await writeFile(cachePath, normalized); } catch { /* A full disk must not stop a pick. */ }
      return normalized;
    } catch {
      // Never persist a placeholder under a card ID. A later request can recover.
      return sharp(Buffer.from(CARD_BACK_SVG)).resize(width, height).png().toBuffer();
    }
  };
  const getCachedImage = (card: DraftImageCard) => getImage(card, false);
  const getCachedFullImage = (card: DraftImageCard) => getImage(card, true);

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
            { input: createNumberOverlay(index + 1, CARD_WIDTH, CARD_HEIGHT), left, top },
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

    async renderCardImages(cards: DraftImageCardWithLabel[]) {
      const results = await Promise.all(
        cards.map(async (card) => {
          const image = await getCachedFullImage(card);
          const overlay = createNumberOverlay(Number(card.label), CARD_FULL_WIDTH, CARD_FULL_HEIGHT);
          const buffer = await sharp(image)
            .composite([{ input: overlay, left: 0, top: 0 }])
            .png()
            .toBuffer();

          return {
            filename: `draft-card-${card.ygoprodeckId}.png`,
            buffer,
          };
        }),
      );

      return results;
    },

    async renderPoolCards(cards: DraftImageCard[]) {
      const results = await Promise.all(
        cards.map(async (card) => {
          const buffer = await getCachedFullImage(card);

          return {
            filename: `draft-card-${card.ygoprodeckId}.png`,
            buffer,
          };
        }),
      );

      return results;
    },
  };
}

export type DraftImageService = ReturnType<typeof createDraftImageService>;
