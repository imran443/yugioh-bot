import { CreateTournamentForm } from "@/components/tournament/create-tournament-form";

export default function NewTournamentPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 font-heading text-2xl text-text-primary">Create New Tournament</h1>
      <CreateTournamentForm />
    </div>
  );
}