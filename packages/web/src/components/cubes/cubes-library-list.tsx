"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Plus, Trash2 } from "lucide-react";
import { FloorList, FloorRow, Segmented, StatusLine, SvButton, Zone } from "@/components/sheet";
import { CUBE_TYPE_LABELS, cubeTypeHint, offeredCubeTypes, type CubeDraftType } from "@/lib/cube-type";
import { PageFrame } from "@/components/decks/page-frame";
import { ListImportReport } from "@/components/card-list-import/list-import-report";
import { listAddedLine } from "@/lib/card-list-import";
import { CubeListImportPanel, type ImportedCube } from "./cube-list-import-panel";
import { isDraftTemplate, nextCubeName, type AddTab, type CubeSummary } from "./library-model";
import styles from "./cubes.module.css";

const MAX_SET_NAMES = 4;

function DeleteConfirm({
  cube,
  busy,
  onDelete,
  onKeep,
}: {
  cube: CubeSummary;
  busy: boolean;
  onDelete: () => void;
  onKeep: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => ref.current?.querySelector<HTMLElement>("[data-keep]")?.focus(), []);
  return (
    <div ref={ref} className={styles.confirm} role="alertdialog" aria-label={`Delete ${cube.name}`}>
      <span>Delete {cube.name} for everyone on the server?</span>
      <span className={styles.confirmActs}>
        <SvButton variant="danger" disabled={busy} onClick={onDelete}>
          Delete
        </SvButton>
        <SvButton variant="ghost" disabled={busy} onClick={onKeep} data-keep="">
          Keep
        </SvButton>
      </span>
    </div>
  );
}

function CubeRow({
  cube,
  confirming,
  busy,
  onAskDelete,
  onDelete,
  onKeep,
}: {
  cube: CubeSummary;
  confirming: boolean;
  busy: boolean;
  onAskDelete: () => void;
  onDelete: () => void;
  onKeep: () => void;
}) {
  const template = isDraftTemplate(cube);
  const sets = cube.setNames ?? [];

  const actions = confirming ? (
    <DeleteConfirm cube={cube} busy={busy} onDelete={onDelete} onKeep={onKeep} />
  ) : (
    <div className={styles.acts}>
      {!template && (
        <Link className={`sv-btn quiet ${styles.openBtn}`} href={`/cubes/${cube.id}`} aria-label={`Open ${cube.name}`}>
          Open
        </Link>
      )}
      <button className={styles.trash} type="button" aria-label={`Delete ${cube.name}`} disabled={busy} onClick={onAskDelete}>
        <Trash2 size={18} aria-hidden="true" />
      </button>
    </div>
  );

  if (template) {
    return (
      <FloorRow className={styles.row}>
        <div className={styles.main}>
          <p className={styles.name}>{cube.name}</p>
          <p className={styles.facts}>
            <span>Draft template</span>
            <span>{sets.length} {sets.length === 1 ? "set" : "sets"}</span>
          </p>
          <p className={`${styles.facts} ${styles.setNames}`}>
            {sets.slice(0, MAX_SET_NAMES).map((set) => <span key={set}>{set}</span>)}
            {sets.length > MAX_SET_NAMES ? <span>+{sets.length - MAX_SET_NAMES} more</span> : null}
          </p>
          <p className={styles.tmplNote}>
            Used by <code>/draft</code>. Booster sets, not a pool, so there are no cards to edit.
          </p>
        </div>
        {actions}
      </FloorRow>
    );
  }

  return (
    <FloorRow className={styles.row}>
      <div className={styles.main}>
        <p className={styles.name}>
          <Link className={styles.openLink} href={`/cubes/${cube.id}`}>
            {cube.name}
          </Link>
        </p>
        <p className={styles.facts}>
          {cube.archetype ? <span>Seeded from <b>{cube.archetype}</b></span> : <span>Built by hand</span>}
          {cube.banlist ? <span>{cube.banlist} banlist</span> : null}
          {cube.draftType && cube.draftType !== "any" ? <span>{CUBE_TYPE_LABELS[cube.draftType]}</span> : null}
        </p>
        <p className={styles.counts}>
          <span>Main <b>{cube.mainCount}</b> cards</span>
          <span>Extra <b>{cube.extraCount}</b> cards</span>
        </p>
      </div>
      {actions}
    </FloorRow>
  );
}

export function CubesLibraryList() {
  const router = useRouter();
  const [cubes, setCubes] = React.useState<CubeSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  // The API says whether theme drafts are open. Until it answers they are closed.
  const [themeDraftsEnabled, setThemeDraftsEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<number | null>(null);
  // The "what is this cube for" step that comes before a cube is made.
  const [chooser, setChooser] = React.useState<{ tab?: AddTab } | null>(null);
  const [newType, setNewType] = React.useState<CubeDraftType>("any");
  // "Import a list": the form, then what the import did (the cube stays here so its diagnostics can be read).
  const [importing, setImporting] = React.useState(false);
  const [imported, setImported] = React.useState<ImportedCube | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    fetch("/api/cubes")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data: { cubes: CubeSummary[]; themeDraftsEnabled?: boolean }) => {
        setCubes(data.cubes ?? []);
        setThemeDraftsEnabled(data.themeDraftsEnabled === true);
        setLoading(false);
      })
      .catch(() => {
        setLoadFailed(true);
        setLoading(false);
      });
  }, []);

  React.useEffect(() => load(), [load]);

  const deleteCube = async (id: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cubes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to delete cube.");
        return;
      }
      setCubes((cur) => cur.filter((c) => c.id !== id));
      setConfirmId(null);
    } finally {
      setBusy(false);
    }
  };

  const create = async (body: Record<string, unknown>, tab?: AddTab) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cubes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { cube?: { id: number }; error?: string };
      if (!res.ok || !data.cube) {
        setError(data.error ?? "Failed to create cube.");
        return;
      }
      router.push(`/cubes/${data.cube.id}${tab ? `?add=${tab}` : ""}`);
    } finally {
      setBusy(false);
    }
  };

  // New cube: ask what it is for first, then create a blank, auto-named one (no name
  // collisions) and jump into its editor, where the user names it and builds the pool.
  const askType = (tab?: AddTab) => {
    setImporting(false);
    setChooser({ tab });
  };
  const askImport = () => {
    setChooser(null);
    setImported(null);
    setImporting(true);
  };
  const importDone = async (result: ImportedCube) => {
    setImporting(false);
    setImported(result);
    load();
  };
  const createChosen = () => {
    const tab = chooser?.tab;
    void create({ kind: "blank", name: nextCubeName(cubes.map((c) => c.name)), draftType: newType }, tab);
  };

  return (
    <PageFrame
      title="Cubes"
      sub={!loading && !loadFailed && cubes.length > 0 ? `${cubes.length} ${cubes.length === 1 ? "cube" : "cubes"}` : undefined}
      actions={
        <>
          <SvButton variant="ghost" disabled={busy || loading} onClick={askImport}>
            <FileText size={16} aria-hidden="true" />
            Import a list
          </SvButton>
          <SvButton variant="primary" disabled={busy || loading} onClick={() => askType()}>
            <Plus size={16} aria-hidden="true" />
            New cube
          </SvButton>
        </>
      }
    >
      <p className={styles.lede}>
        {themeDraftsEnabled
          ? "Reusable card pools for cube drafts and theme drafts. Anyone can use them; only the creator can edit one."
          : "Reusable card pools for cube drafts. Anyone can use them; only the creator can edit one."}
      </p>

      {chooser && (
        <section className={styles.newCube} aria-label="New cube">
          <h2>What is this cube for?</h2>
          <Segmented
            label="Cube type"
            value={newType}
            disabled={busy}
            options={offeredCubeTypes(themeDraftsEnabled).map((value) => ({ value, label: CUBE_TYPE_LABELS[value] }))}
            onChange={setNewType}
          />
          <p className="hint">{cubeTypeHint(newType, themeDraftsEnabled)} You can change this later.</p>
          <div className={styles.newActs}>
            <SvButton variant="primary" disabled={busy} onClick={createChosen}>
              Create cube
            </SvButton>
            <SvButton variant="quiet" disabled={busy} onClick={() => setChooser(null)}>
              Cancel
            </SvButton>
          </div>
        </section>
      )}

      {importing && (
        <CubeListImportPanel
          defaultName={nextCubeName(cubes.map((c) => c.name))}
          themeDraftsEnabled={themeDraftsEnabled}
          onCreated={importDone}
          onCancel={() => setImporting(false)}
        />
      )}

      {imported && (
        <section className={styles.importResult} aria-label="Imported cube" role="status">
          <p>
            Created <b>{imported.cube.name}</b>. {listAddedLine(imported.added, imported.copies)}
          </p>
          <ListImportReport {...imported} />
          <div className={styles.newActs}>
            <SvButton as="a" variant="primary" href={`/cubes/${imported.cube.id}`}>
              Open cube
            </SvButton>
            <SvButton variant="quiet" onClick={() => setImported(null)}>
              Dismiss
            </SvButton>
          </div>
        </section>
      )}

      {error && (
        <div role="alert">
          <StatusLine tone="block">{error}</StatusLine>
        </div>
      )}

      {loading ? (
        <ul className={styles.skeleton} aria-busy="true" aria-label="Loading cubes">
          {[46, 38].map((w) => (
            <li key={w}>
              <span className="sk" style={{ width: `${w}%`, height: 14 }} />
              <span className="sk" style={{ width: `${w + 24}%` }} />
            </li>
          ))}
        </ul>
      ) : loadFailed ? (
        <div role="alert" className={styles.alert}>
          <StatusLine tone="block">
            <b>Couldn&apos;t load your cubes.</b> Check your connection and try again.
          </StatusLine>
          <SvButton variant="quiet" onClick={load}>
            Retry
          </SvButton>
        </div>
      ) : cubes.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyZones} aria-hidden="true">
            <Zone state="empty" size="md" />
            <Zone state="empty" size="md" />
            <Zone state="empty" size="md" />
          </span>
          <div>
            <h2>No cubes yet</h2>
            <p>
              A cube is a pool you draft from. Start from an archetype, import a list of card names or passcodes, or pick cards
              one at a time.
            </p>
            <div className={styles.emptyActs}>
              <SvButton variant="ghost" disabled={busy} onClick={() => askType("archetype")}>
                From an archetype
              </SvButton>
              <SvButton variant="ghost" disabled={busy} onClick={askImport}>
                From a card list
              </SvButton>
              <SvButton variant="quiet" disabled={busy} onClick={() => askType()}>
                Blank cube
              </SvButton>
            </div>
          </div>
        </div>
      ) : (
        <FloorList aria-label="Cubes">
          {cubes.map((cube) => (
            <CubeRow
              key={cube.id}
              cube={cube}
              confirming={confirmId === cube.id}
              busy={busy}
              onAskDelete={() => setConfirmId(cube.id)}
              onDelete={() => void deleteCube(cube.id)}
              onKeep={() => setConfirmId(null)}
            />
          ))}
        </FloorList>
      )}
    </PageFrame>
  );
}
