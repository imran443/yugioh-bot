"use client";

import { CardPoolEditor } from "@/components/cubes/card-pool-editor";

export function CubeEditor({ poolId }: { poolId: number }) {
  return <CardPoolEditor mode="edit" poolId={poolId} />;
}
