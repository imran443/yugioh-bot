import { finishDraft } from "@/lib/draft-terminal-api";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return finishDraft(params);
}
