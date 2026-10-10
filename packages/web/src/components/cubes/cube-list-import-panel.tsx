"use client";

import * as React from "react";
import { ListFileButton } from "@/components/card-list-import/list-file-button";
import { ListImportReport } from "@/components/card-list-import/list-import-report";
import { Segmented, StatusLine, SvButton, svButtonClass } from "@/components/sheet";
import { loadedFileLine, type ListDiagnostics } from "@/lib/card-list-import";
import { CUBE_TYPE_LABELS, cubeTypeHint, offeredCubeTypes, type CubeDraftType } from "@/lib/cube-type";
import styles from "./cubes.module.css";

export interface ImportedCube extends ListDiagnostics {
  cube: { id: number; name: string };
  added: number;
  copies: number;
}

/**
 * Makes a new cube from a card list: a name, a type, then names, passcodes or YDK text, typed, pasted or loaded
 * from a file. The cube and its cards are saved together; if nothing in the list is a card, no cube is made.
 * A file only fills the box, and Create is one more click.
 */
export function CubeListImportPanel({
  defaultName,
  defaultType = "any",
  fixedType,
  themeDraftsEnabled = false,
  onCreated,
  onCancel,
}: {
  defaultName: string;
  defaultType?: CubeDraftType;
  /** Set when the screen decides the type (a theme draft needs theme cubes); the type picker is then hidden. */
  fixedType?: CubeDraftType;
  /** The server says theme drafts are open. Closed, the type picker offers no theme cube. Default closed. */
  themeDraftsEnabled?: boolean;
  onCreated: (result: ImportedCube) => void | Promise<void>;
  onCancel: () => void;
}) {
  const ids = React.useId();
  const [name, setName] = React.useState(defaultName);
  const [type, setType] = React.useState<CubeDraftType>(fixedType ?? defaultType);
  const [text, setText] = React.useState("");
  const [fileLine, setFileLine] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<Partial<ListDiagnostics> | null>(null);

  const create = async () => {
    if (busy) return;
    if (name.trim() === "") {
      setError("Name the cube first.");
      return;
    }
    if (text.trim() === "") {
      setError("Load a file or paste a card list first.");
      return;
    }
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch("/api/cubes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "list", name: name.trim(), importText: text, draftType: fixedType ?? type }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ImportedCube> & { error?: string };
      if (!res.ok || !data.cube) {
        setError(data.error ?? "Couldn't create the cube.");
        // A list with no cards still says which lines it skipped.
        if (data.unknown || data.corrected || data.lookupLimited) setReport({ unknown: data.unknown, corrected: data.corrected, lookupLimited: data.lookupLimited });
        return;
      }
      await onCreated({
        cube: data.cube,
        added: data.added ?? 0,
        copies: data.copies ?? 0,
        unknown: data.unknown ?? [],
        corrected: data.corrected ?? [],
        ...(data.lookupLimited ? { lookupLimited: true as const } : {}),
        ...(data.movedToMain ? { movedToMain: data.movedToMain } : {}),
      });
    } catch {
      setError("Couldn't create the cube. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.newCube} aria-label="Import a list as a new cube">
      <h2>Import a list</h2>
      <div className={styles.importField}>
        <label className="label" htmlFor={`${ids}-name`}>
          Cube name
        </label>
        <input
          id={`${ids}-name`}
          className="input"
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
      </div>
      {!fixedType && (
        <div className={styles.importField}>
          <Segmented
            label="Cube type"
            value={type}
            disabled={busy}
            options={offeredCubeTypes(themeDraftsEnabled).map((value) => ({ value, label: CUBE_TYPE_LABELS[value] }))}
            onChange={setType}
          />
          <p className="hint">{cubeTypeHint(type, themeDraftsEnabled)} You can change this later.</p>
        </div>
      )}
      <div className={styles.importField}>
        <label className="label" htmlFor={`${ids}-list`}>
          Card list
        </label>
        <textarea
          id={`${ids}-list`}
          className="input"
          rows={7}
          value={text}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value);
            setFileLine(null);
          }}
          placeholder={"3 Dark Hole\nShooting Star Dragon\n46986414\n\nOr paste a whole .ydk file"}
          style={{ height: "auto", padding: "10px 12px", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 13 }}
        />
        <p className="hint">
          Card names or passcodes, one per line. A number before a name is its copies, like 3 Dark Hole. Without one, a card gets 1
          copy. Section titles are skipped.
        </p>
      </div>
      <div className={styles.newActs}>
        <ListFileButton
          buttonClassName={svButtonClass("quiet")}
          inputClassName={styles.fileInput}
          disabled={busy}
          onLoaded={(loaded, fileName) => {
            setText(loaded);
            setFileLine(loadedFileLine(fileName, loaded));
            setError(null);
            setReport(null);
          }}
          onError={(message) => setError(message)}
        />
      </div>
      {fileLine && <p className="hint">Loaded {fileLine}. Check it, then create the cube.</p>}
      {error && (
        <div role="alert">
          <StatusLine tone="block">{error}</StatusLine>
          {report && <ListImportReport {...report} />}
        </div>
      )}
      <div className={styles.newActs}>
        <SvButton variant="primary" disabled={busy} onClick={() => void create()}>
          Create cube from list
        </SvButton>
        <SvButton variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </SvButton>
      </div>
    </section>
  );
}
