import Link from "next/link";
import { Trophy, Layers, Swords } from "lucide-react";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-bg-deep text-text-primary">
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        <div className="mb-10 text-center">
          <h1 className="font-display text-3xl text-text-primary sm:text-4xl">
            Yu-Gi-Oh! Tournament Manager
          </h1>
          <p className="mt-3 text-text-secondary">
            Manage tournaments, track brackets, and draft with your Discord server
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <Link
            href="/tournaments"
            className="group flex flex-col items-center rounded-xl border border-border bg-surface p-8 text-center motion-safe:transition-colors hover:border-accent-primary/30 hover:bg-bg-elevated"
          >
            <Trophy className="mb-4 h-12 w-12 text-accent-gold" />
            <h2 className="font-body text-xl font-semibold text-text-primary">
              Tournaments
            </h2>
            <p className="mt-2 text-sm text-text-secondary">
              View active brackets, report matches, and check standings
            </p>
          </Link>

          <div className="flex flex-col items-center rounded-xl border border-border bg-surface p-8 text-center opacity-60">
            <Layers className="mb-4 h-12 w-12 text-accent-primary" />
            <h2 className="font-body text-xl font-semibold text-text-primary">
              Drafts
            </h2>
            <p className="mt-2 text-sm text-text-secondary">
              Join drafts via Discord and pick cards in real-time
            </p>
          </div>
        </div>

        <div className="mt-10 rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-4 flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
            <Swords className="h-5 w-5 text-accent-primary" />
            How it works
          </h2>
          <ul className="space-y-3 text-text-secondary">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-xs font-bold text-accent-primary">
                1
              </span>
              <span>
                Create tournaments and drafts in Discord with{" "}
                <code className="rounded bg-bg-elevated px-1.5 py-0.5 text-sm text-text-primary">
                  /event create
                </code>{" "}
                and{" "}
                <code className="rounded bg-bg-elevated px-1.5 py-0.5 text-sm text-text-primary">
                  /draft create
                </code>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-xs font-bold text-accent-primary">
                2
              </span>
              <span>
                Join events from Discord and get deep links to the web dashboard
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-xs font-bold text-accent-primary">
                3
              </span>
              <span>
                Track brackets, report match results, and view standings here
              </span>
            </li>
          </ul>
        </div>
      </div>
    </main>
  );
}
