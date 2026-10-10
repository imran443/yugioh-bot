import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { svButtonClass } from "@/components/sheet";
import { DraftFrame } from "@/components/draft/draft-frame";
import { NewDraftLead } from "@/components/draft/create/new-lead";
import { themeDraftsEnabled } from "@/lib/theme-drafts";
import styles from "@/components/draft/create/create.module.css";

// The theme draft flag is read per request on the server.
export const dynamic = "force-dynamic";

/** Fixed, well-known cards for the fans. They load through the existing card image route. */
const CUBE_FAN = [55144522, 77585513, 44095762];
const THEME_FAN = [62962630, 44362883, 87746184];

function Fan({ ids }: { ids: number[] }) {
  return (
    <span className={styles.fan} aria-hidden="true">
      {ids.map((id) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={id} src={`/api/cards/${id}/image?size=small`} alt="" loading="lazy" width={70} height={102} />
      ))}
    </span>
  );
}

export default function NewDraftPage() {
  // Only one kind is open, so there is nothing to choose. Go straight to its setup.
  if (!themeDraftsEnabled()) redirect("/drafts/new/cube");
  return (
    <DraftFrame
      back={{ href: "/drafts", label: "All drafts" }}
      title="New draft"
      sub="You can't switch after the draft is made."
    >
      <NewDraftLead pieces={["Pick a kind", "Then set it up"]} />
      <div className={styles.choose}>
        <Link className={styles.kind} href="/drafts/new/cube">
          <Fan ids={CUBE_FAN} />
          <span className={styles.kt}>Cube draft</span>
          <span className={styles.kp}>
            Everyone opens packs from one shared pool and passes them around the table. A classic booster draft.
          </span>
          <ul className={styles.facts}>
            <li>One pool, built from sets, archetypes and passcodes</li>
            <li>Packs pass left, then right</li>
            <li>40 to 60 cards each</li>
          </ul>
          <span className={styles.defaults}>Starts at 40 cards each, 3 packs of 15, 45 s a pick</span>
          <span className={`${svButtonClass("ghost")} ${styles.go}`}>
            Set up a cube draft
            <ChevronRight size={16} aria-hidden="true" />
          </span>
        </Link>
        <Link className={styles.kind} data-k="theme" href="/drafts/new/theme">
          <Fan ids={THEME_FAN} />
          <span className={styles.kt}>Theme draft</span>
          <span className={styles.kp}>
            Each player drafts alone from their own archetype. Every pick offers a few cards from your theme, so decks
            come out like structure decks.
          </span>
          <ul className={styles.facts}>
            <li>One theme per player, claimed in the lobby or dealt at random</li>
            <li>No passing, everyone picks at once</li>
            <li>Main deck first, then the Extra deck</li>
          </ul>
          <span className={styles.defaults}>Starts at 40 main and 15 Extra deck picks, 3 choices a pick, 45 s a pick</span>
          <span className={`${svButtonClass("ghost")} ${styles.go}`}>
            Set up a theme draft
            <ChevronRight size={16} aria-hidden="true" />
          </span>
        </Link>
      </div>
    </DraftFrame>
  );
}
