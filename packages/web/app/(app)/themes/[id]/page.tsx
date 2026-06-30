import { redirect } from "next/navigation";

export default async function ThemeEditorRedirectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/cubes/${id}`);
}
