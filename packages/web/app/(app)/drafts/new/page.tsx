import Link from "next/link";
import { Layers, Sparkles } from "lucide-react";

export default function NewDraftPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-2 font-heading text-2xl text-text-primary">New Draft</h1>
      <p className="mb-6 text-sm text-text-secondary">Choose the kind of draft you want to run.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/drafts/new/cube"
          className="group rounded-xl border border-border bg-surface p-5 transition hover:border-accent-primary"
        >
          <Layers className="mb-3 h-6 w-6 text-accent-primary" />
          <h2 className="font-display text-lg text-text-primary">Cube Draft</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Classic booster-style draft. Players pass packs built from your sets and passcodes.
          </p>
        </Link>

        <Link
          href="/drafts/new/theme"
          className="group rounded-xl border border-border bg-surface p-5 transition hover:border-accent-primary"
        >
          <Sparkles className="mb-3 h-6 w-6 text-accent-gold" />
          <h2 className="font-display text-lg text-text-primary">Theme Draft</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Each player drafts privately from their own archetype/theme pool into their own deck.
          </p>
        </Link>
      </div>
    </div>
  );
}
