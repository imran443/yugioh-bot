import { NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";

const CACHE_DIR = process.env.CARD_IMAGE_CACHE_DIR ?? "./data/card-images";
const YGOPRODECK_IMAGE_URL = "https://images.ygoprodeck.com/images/cards";
const YGOPRODECK_SMALL_URL = "https://images.ygoprodeck.com/images/cards_small";

async function getCachedImage(
  passcode: string,
  size: "full" | "small"
): Promise<Buffer> {
  await mkdir(CACHE_DIR, { recursive: true });

  const filename = size === "small" ? `${passcode}-small.jpg` : `${passcode}.jpg`;
  const cachePath = join(CACHE_DIR, filename);

  try {
    return await readFile(cachePath);
  } catch {
    const baseUrl = size === "small" ? YGOPRODECK_SMALL_URL : YGOPRODECK_IMAGE_URL;
    const url = `${baseUrl}/${passcode}.jpg`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch card image: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(cachePath, buffer);
    return buffer;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ passcode: string }> }
) {
  try {
    const { passcode } = await params;
    const { searchParams } = new URL(request.url);
    const size = searchParams.get("size") === "small" ? "small" : "full";

    const image = await getCachedImage(passcode, size);

    return new Response(image.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (error) {
    console.error("[api/cards/image] error:", error);
    return NextResponse.json(
      { error: "Failed to load card image" },
      { status: 500 }
    );
  }
}
