import { CubeEditor } from "@/components/cubes/cube-editor";

export default async function CubeEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const poolId = Number.parseInt(id, 10);

  return (
    <div className="mx-auto max-w-7xl">
      <CubeEditor poolId={poolId} />
    </div>
  );
}
