import { CardPoolEditor } from "@/components/cubes/card-pool-editor";

export default function NewCubePage() {
  return (
    <div className="mx-auto max-w-7xl">
      <CardPoolEditor mode="create" />
    </div>
  );
}
