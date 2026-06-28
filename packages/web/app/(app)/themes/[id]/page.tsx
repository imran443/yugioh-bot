import { ThemeEditor } from "@/components/themes/theme-editor";

export default async function ThemeEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const themeId = Number.parseInt(id, 10);

  return (
    <div className="mx-auto max-w-7xl">
      <ThemeEditor themeId={themeId} />
    </div>
  );
}
