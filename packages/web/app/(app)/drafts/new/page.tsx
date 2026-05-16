import { CreateDraftForm } from "@/components/draft/create-draft-form";

export default function NewDraftPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 2xl:max-w-none 2xl:px-10">
      <h1 className="mb-6 font-heading text-2xl text-text-primary">Create New Draft</h1>
      <CreateDraftForm />
    </div>
  );
}