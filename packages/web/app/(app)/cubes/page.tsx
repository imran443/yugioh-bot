import Link from "next/link";
import { MyCubesList } from "@/components/cubes/my-cubes-list";
import { Button } from "@/components/ui/button";

export default function CubesPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-2xl text-text-primary sm:text-3xl">My Cubes</h1>
          <p className="mt-2 text-sm text-text-secondary">Open a saved card pool to import, review, and edit its cards.</p>
        </div>
        <Link href="/cubes/new">
          <Button variant="primary">Create Card Pool</Button>
        </Link>
      </div>
      <MyCubesList />
    </div>
  );
}
