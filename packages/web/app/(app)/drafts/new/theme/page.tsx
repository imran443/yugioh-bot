import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { themeDraftsEnabled } from "@/lib/theme-drafts";
import { DraftFrame } from "@/components/draft/draft-frame";
import { NewDraftLead } from "@/components/draft/create/new-lead";
import { CreateThemeDraftForm } from "@/components/draft/create-theme-draft-form";

// The Discord flag is read per request on the server; the client forms only receive it.
export const dynamic = "force-dynamic";

export default function NewThemeDraftPage() {
  // Closed: an old link or bookmark lands on the draft chooser instead of a dead end.
  if (!themeDraftsEnabled()) redirect("/drafts/new");
  const discordEnabled = env.discordBotEnabled;
  return (
    <DraftFrame
      back={{ href: "/drafts/new", label: "New draft" }}
      title="New theme draft"
      sub="You add the themes at the Theme Table."
    >
      <NewDraftLead
        pieces={["Create", "Then add themes at the table"]}
        note="Each player drafts alone from their own theme. One cube per archetype."
      />
      <CreateThemeDraftForm discordEnabled={discordEnabled} themeDraftsEnabled />
    </DraftFrame>
  );
}
