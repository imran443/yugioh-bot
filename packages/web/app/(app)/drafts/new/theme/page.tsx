import { CreateThemeDraftForm } from "@/components/draft/create-theme-draft-form";

export default function NewThemeDraftPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 font-heading text-2xl text-text-primary">Create Theme Draft</h1>
      <CreateThemeDraftForm />
    </div>
  );
}
