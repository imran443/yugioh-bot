import { CreateDraftForm } from "@/components/draft/create-draft-form";

export default function NewDraftPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 font-heading text-2xl text-text-primary">Create New Draft</h1>
      <CreateDraftForm />
    </div>
  );
}