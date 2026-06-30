import { Suspense } from "react";
import { CubeEditor } from "@/components/cubes/cube-editor";

export default async function CubeEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cubeId = Number.parseInt(id, 10);

  return (
    <div className="mx-auto max-w-[1800px] px-2 sm:px-4">
      <Suspense fallback={<p className="text-sm text-text-secondary">Loading cube...</p>}>
        <CubeEditor cubeId={cubeId} />
      </Suspense>
    </div>
  );
}
