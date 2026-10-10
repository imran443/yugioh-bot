import { Suspense } from "react";
import { CubeEditor } from "@/components/cubes/cube-editor";
import { PageFrameFallback } from "@/components/decks/page-frame";
import { themeDraftsEnabled } from "@/lib/theme-drafts";

// The theme draft flag is read per request on the server; the editor only receives it.
export const dynamic = "force-dynamic";

export default async function CubeEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cubeId = Number.parseInt(id, 10);

  return (
    <Suspense
      fallback={
        <PageFrameFallback title="Cube" label="Loading cube..." />
      }
    >
      <CubeEditor cubeId={cubeId} themeDraftsEnabled={themeDraftsEnabled()} />
    </Suspense>
  );
}
