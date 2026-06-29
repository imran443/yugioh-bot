import { Suspense } from "react";
import { ThemeEditor } from "@/components/themes/theme-editor";

export default async function ThemeEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const themeId = Number.parseInt(id, 10);

  return (
    <div className="mx-auto max-w-[1800px] px-2 sm:px-4">
      <Suspense fallback={<p className="text-sm text-text-secondary">Loading theme...</p>}>
        <ThemeEditor themeId={themeId} />
      </Suspense>
    </div>
  );
}
