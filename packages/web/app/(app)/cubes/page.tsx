import { CubesLibraryList } from "@/components/cubes/cubes-library-list";

export default function CubesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-text-primary sm:text-3xl">Cubes</h1>
        <p className="mt-2 text-sm text-text-secondary">
          Build reusable card pools — seed from an archetype, import passcodes, or start blank. Use them in shared cube
          drafts and Theme Drafts.
        </p>
      </div>
      <CubesLibraryList />
    </div>
  );
}
