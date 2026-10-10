import { env } from "@/lib/env";
import { themeDraftsEnabled } from "@/lib/theme-drafts";
import { CreateDraftForm } from "@/components/draft/create-draft-form";
import { WorkbenchFrame } from "@/components/draft/setup/workbench";

// The Discord flag is read per request on the server; the client forms only receive it.
export const dynamic = "force-dynamic";

export default function NewCubeDraftPage() {
  const discordEnabled = env.discordBotEnabled;
  return (
    <WorkbenchFrame
      // With one kind of draft open, /drafts/new sends you here, so Back goes to the list.
      back={themeDraftsEnabled() ? { href: "/drafts/new", label: "New draft" } : { href: "/drafts", label: "All drafts" }}
      title="New cube draft"
      sub="You get a lobby and an invite link."
    >
      <CreateDraftForm discordEnabled={discordEnabled} />
    </WorkbenchFrame>
  );
}
